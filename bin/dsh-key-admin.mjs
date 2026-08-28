#!/usr/bin/env node
// DSH 密钥管理面板（dsh-key-admin）。
//
// 它存在的理由：模型密钥不能在 DSH 自己的 WebUI 里填。那个页面跑在 dsh 容器里，
// 填进去的密钥就落在容器内，被提示注入的 Agent 一条 cat 就能读到。但"只能在安装
// 向导里填"也不合理——换密钥、加供应商、改模型清单都得回到终端。
//
// 所以面板是一个独立容器，和 broker 一样在 dsh 容器摸不到的地方：
//   * 它挂着 data/broker（读写，用来改 keys.json）和 data/dsh（读写，用来写 DSH 侧配置）；
//   * 它只在 dsh-key-admin 这张网络上，dsh 容器不在其中，跨网桥流量被 Docker 自己拦掉；
//   * 宿主端口默认只发布在 127.0.0.1，要远程用就自己开 SSH 隧道；
//   * 所有 /api 请求都要 Bearer 令牌，连续猜错会指数级锁定（暴力破解拿不到东西）。
//
// 它写的 keys.json 与安装向导写的是同一份文件、同一套语义；broker 每 5 秒按 mtime
// 热加载，DSH 的 settings.yaml / .credentials.yaml 也是热加载，所以改完不用重启任何容器。

import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { fetchUpstreamModels } from './dsh-upstream-models.mjs'
import {
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_BLOCKED_HOSTS,
  EgressPolicyError,
  normalizeEgressPolicy,
  parseDeploymentEgressMode,
  parseEgressPolicyText,
  parseProxyEgressMode,
  serializeEgressPolicy,
} from './dsh-egress-policy.mjs'
import {
  DEFAULT_LOCKOUT,
  attemptDelayMs,
  emptyLockoutState,
  lockoutRemainingSeconds,
  registerFailure,
  registerSuccess,
} from './dsh-privileged-policy.mjs'
import {
  AdminInputError,
  API_SHAPES,
  DEFAULT_BASE_URLS,
  DEFAULT_PANEL_THINKING_LEVELS,
  THINKING_LEVELS,
  baseUrlLooksUnversioned,
  defaultShapeOf,
  findUpstream,
  looksLikeCatalogRoute,
  mergeUpstream,
  normalizeName,
  normalizeUpstreamInput,
  readDocument,
  removeUpstream,
  seedPayload,
  serializeDocument,
  toBrokerEntry,
  toUpstreamView,
} from './dsh-key-admin-policy.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.DSH_KEY_ADMIN_PORT ?? 8090)
const BIND = process.env.DSH_KEY_ADMIN_BIND ?? '0.0.0.0'
const CONFIG_PATH = process.env.DSH_KEY_ADMIN_CONFIG ?? '/etc/dsh-broker/keys.json'
const TOKEN_PATH = process.env.DSH_KEY_ADMIN_TOKEN ?? '/etc/dsh-broker/admin.token'
const DSH_HOME = process.env.DSH_KEY_ADMIN_DSH_HOME ?? '/data/dsh'
const SEED_SCRIPT = process.env.DSH_KEY_ADMIN_SEED ?? path.join(HERE, 'seed-dsh-model-settings.mjs')
const WEB_ROOT = process.env.DSH_KEY_ADMIN_WEB ?? path.join(HERE, 'dsh-key-admin-web')
const BROKER_BASE = process.env.DSH_KEY_ADMIN_BROKER_BASE ?? 'http://dsh-key-broker:8080'
const PLACEHOLDER = process.env.DSH_KEY_ADMIN_PLACEHOLDER ?? 'dsh-broker-placeholder'
const UPSTREAM_TIMEOUT_MS = Number(process.env.DSH_KEY_ADMIN_UPSTREAM_TIMEOUT_MS ?? 20_000)
const SEED_TIMEOUT_MS = Number(process.env.DSH_KEY_ADMIN_SEED_TIMEOUT_MS ?? 120_000)
// 凭据巡检间隔。0 或负数关闭；见 scrubCredentials 上面那段说明。
const SCRUB_INTERVAL_MS = Number(process.env.DSH_KEY_ADMIN_SCRUB_INTERVAL_MS ?? 30_000)
// 出站策略文件（面板可写，dsh-egress 只读挂同一份）。空串 = 这台部署没有这个功能。
const EGRESS_POLICY_PATH = (process.env.DSH_KEY_ADMIN_EGRESS_POLICY ?? '/etc/dsh-egress/policy.json').trim()
// 当前部署形态：open 时策略文件存在也不生效（那种部署根本没有 dsh-egress 容器）。
const DEPLOYMENT_EGRESS_MODE = (() => {
  try {
    return parseDeploymentEgressMode(process.env.DSH_EGRESS_MODE, 'open')
  } catch {
    return 'open'
  }
})()
const BODY_LIMIT = 256 * 1024

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
])

let lockout = emptyLockoutState()
let tokenDigest = null

function log(event) {
  // 审计日志只记元数据：动作、上游名、结果。密钥、令牌和请求体都不进日志。
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n')
}

function loadToken() {
  let raw
  try {
    raw = fs.readFileSync(TOKEN_PATH, 'utf8')
  } catch (error) {
    throw new Error('读不到面板令牌 ' + TOKEN_PATH + '：' + error.message)
  }
  const token = raw.trim()
  if (token.length < 16) {
    throw new Error('面板令牌太短（至少 16 个字符）：' + TOKEN_PATH)
  }
  tokenDigest = createHash('sha256').update(token, 'utf8').digest()
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function presentedToken(request) {
  const header = String(request.headers.authorization ?? '')
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim())
  if (match) return match[1].trim()
  return String(request.headers['x-dsh-admin-token'] ?? '').trim()
}

/**
 * 令牌校验。摘要比对 + timingSafeEqual：长度不同也不提前返回，别让响应时间变成
 * 一个"猜对了几个字符"的旁路。连续失败按 dsh-root 那套指数锁定处理。
 */
async function authorize(request) {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const locked = lockoutRemainingSeconds(lockout, nowSeconds)
  if (locked > 0) {
    return { ok: false, status: 429, message: '令牌连续错误次数过多，请等 ' + locked + ' 秒后再试。' }
  }
  const presented = presentedToken(request)
  const digest = createHash('sha256').update(presented, 'utf8').digest()
  if (presented !== '' && timingSafeEqual(digest, tokenDigest)) {
    lockout = registerSuccess()
    return { ok: true }
  }
  await delay(attemptDelayMs(lockout, DEFAULT_LOCKOUT))
  lockout = registerFailure(lockout, nowSeconds, DEFAULT_LOCKOUT)
  log({ event: 'auth-failed', remote: request.socket.remoteAddress ?? '' })
  return { ok: false, status: 401, message: '令牌不对。宿主上看一眼：cat data/broker/admin.token' }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(body)
}

function sendStatic(response, entry) {
  let body
  try {
    body = fs.readFileSync(path.join(WEB_ROOT, entry.file))
  } catch (error) {
    sendJson(response, 500, { ok: false, message: '读不到面板资源 ' + entry.file + '：' + error.message })
    return
  }
  response.writeHead(200, {
    'content-type': entry.type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // 页面不加载任何外部资源，也不需要内联脚本：把两件事都在策略里关掉。
    'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new AdminInputError('请求体太大', 413))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new AdminInputError('请求体不是合法 JSON：' + error.message))
      }
    })
    request.on('error', reject)
  })
}

function readConfigText() {
  try {
    return fs.readFileSync(CONFIG_PATH, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw new AdminInputError('读不到 ' + CONFIG_PATH + '：' + error.message, 500)
  }
}

/** 原子写 + 0600。写坏这份文件等于让 broker 拿不到密钥，所以绝不原地改。 */
function writeDocument(document) {
  const text = serializeDocument(document)
  const temporary = CONFIG_PATH + '.tmp.' + process.pid
  fs.writeFileSync(temporary, text, { mode: 0o600 })
  try {
    fs.chmodSync(temporary, 0o600)
    fs.renameSync(temporary, CONFIG_PATH)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // 临时文件删不掉不影响正确性。
    }
    throw new AdminInputError('写不了 ' + CONFIG_PATH + '：' + error.message, 500)
  }
}

/**
 * 写 DSH 配置之前先确认那两个文件是普通文件。
 *
 * 这不是洁癖：data/dsh 是 dsh 容器可写的目录，而这个容器里跑的是一个可以执行任意
 * 命令的 Agent。它要是把 settings.yaml 换成一个指向 /etc/dsh-broker/keys.json 的
 * 符号链接，seed 脚本"读旧配置再合并写回"这一步就会把密钥文件的内容读出来、写进
 * 一个 dsh 容器能读的文件里——密钥代理直接白搭。所以见到不是普通文件就拒绝动手。
 */
function assertSeedTargetsSane() {
  for (const name of ['settings.yaml', '.credentials.yaml']) {
    const file = path.join(DSH_HOME, name)
    let stats
    try {
      stats = fs.lstatSync(file)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw new AdminInputError('看不了 ' + file + '：' + error.message, 500)
    }
    if (!stats.isFile()) {
      throw new AdminInputError(
        file + ' 不是普通文件（符号链接或目录）。面板不会顺着它写下去：'
        + '容器内的进程可以用这种链接把密钥文件的内容诱导进一个自己能读的文件。'
        + '请在宿主上检查这个路径，删掉之后重试。',
        500,
      )
    }
  }
}

/**
 * 把 keys.json 里的非秘密事实写进 DSH 自己的配置（settings.yaml / .credentials.yaml）。
 * 复用安装器那个脚本，不重写一份：格式契约只该有一个实现。密钥不进载荷。
 */
function spawnSeed(document) {
  if (!fs.existsSync(SEED_SCRIPT)) {
    return Promise.resolve({
      skipped: true,
      failed: false,
      output: '',
      warnings: '',
      error: '找不到 ' + SEED_SCRIPT + '，这次只改了密钥配置，没有写 DSH 侧的模型设置。',
    })
  }
  // 这一步失败不该把"保存密钥"也一起判失败：密钥已经写进 keys.json 了，把原因
  // 当成 seed 的错误回给页面，比丢一个 500 更有用。
  try {
    assertSeedTargetsSane()
  } catch (error) {
    return Promise.resolve({ skipped: true, failed: true, output: '', warnings: '', error: error.message })
  }
  const payload = JSON.stringify(seedPayload(document, BROKER_BASE, PLACEHOLDER))
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SEED_SCRIPT, '--home', DSH_HOME], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, SEED_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const finish = (failed, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // stderr 即使退出码为 0 也要带回去：seed 脚本把"这个上游没写进 DSH 配置"
      // （例如自建网关一个模型 id 都没填）当成警告，退出码仍然是 0。只看 failed
      // 的话，页面会显示"已保存"而 DSH 那边根本没多出这条供应商。
      resolve({ skipped: false, failed, output: stdout, warnings: stderr.trim(), error })
    }
    child.on('error', (error) => finish(true, error.message))
    child.on('close', (code) => finish(code !== 0, code === 0 ? '' : (stderr.trim() || ('seed 退出码 ' + code))))
    child.stdin.end(payload)
  })
}

// seed 会读旧配置再整份写回，两个并发实例互相覆盖就会丢字段（保存和巡检都会触发它），
// 所以排成一条队列。
let seedChain = Promise.resolve()
function runSeed(document) {
  const next = seedChain.then(() => spawnSeed(document), () => spawnSeed(document))
  seedChain = next.then(() => undefined, () => undefined)
  return next
}

// 上一次巡检过后 .credentials.yaml 的 mtime：没变就跳过这一轮。
let scrubbedMtimeMs = -1

/**
 * 凭据巡检：把 .credentials.yaml 里代理托管路由的引用换回占位串。
 *
 * 为什么要定时做而不是只在保存时做：DSH 自己的 WebUI「设置 - 模型」页把密钥框渲染成
 * type=password，浏览器的密码管理器会往同源的这类输入框里自动填一个保存过的密码，
 * 用户在那页上改任何东西点保存，那个值就明文落进 .credentials.yaml —— 而这个文件属主
 * 是 dsh，容器里的 Agent 读得到。代理托管的上游本来就不需要容器里有真密钥（代理会剥掉
 * 客户端凭证再注入自己那把），所以这里发现非占位串就换掉，并在日志里点名提醒轮换。
 * 判据在 planSeed 里：只动 baseURL 正好指向本部署代理的路由，用户自己加的直连供应商不碰。
 */
async function scrubCredentials() {
  const file = path.join(DSH_HOME, '.credentials.yaml')
  let stats
  try {
    stats = fs.statSync(file)
  } catch {
    return
  }
  // 文件没动过就不必再跑一遍 seed（它每次都要起一个 node 进程）。
  if (stats.mtimeMs === scrubbedMtimeMs) return
  const seed = await runSeed(readDocument(readConfigText()))
  try {
    scrubbedMtimeMs = fs.statSync(file).mtimeMs
  } catch {
    scrubbedMtimeMs = -1
  }
  if (seed.failed || seed.skipped) {
    log({ event: 'scrub', failed: Boolean(seed.failed), error: seed.error ?? '' })
    return
  }
  // 只有真回收到东西才记一条：否则每次用户在 WebUI 里改设置都会刷一行无意义的日志。
  if (String(seed.output ?? '').includes('换回占位串')) {
    log({ event: 'scrub', reclaimed: true })
    process.stdout.write(String(seed.output).trimEnd() + '\n')
  }
}

// --- 容器出站策略 ---
//
// 这份文件决定 dsh 容器出网时哪些域名放得过去。它和密钥没关系，但归在同一个面板里：
// 两者都是"只有宿主上的人能改、容器里的 Agent 摸不到"的配置，而面板本来就是那唯一
// 一个既能写宿主文件、又不在 dsh 网络上的容器。
//
// open ↔ 隔离（blocklist / allowlist）的切换不在这里：那要改 compose 叠加，只能在宿主上
// 重跑安装器。allowlist ↔ blocklist 与两份清单的增删改都是热的，代理 5 秒内跟上。
function readEgressPolicy() {
  if (EGRESS_POLICY_PATH === '') return { available: false, exists: false, policy: normalizeEgressPolicy({}), error: '' }
  let text
  try {
    text = fs.readFileSync(EGRESS_POLICY_PATH, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      // 目录在但文件还没写过：这是全新部署的正常状态，给一份默认策略让页面能直接编辑。
      const available = fs.existsSync(path.dirname(EGRESS_POLICY_PATH))
      return {
        available,
        exists: false,
        // 默认策略跟着部署形态走（open 部署按 allowlist 显示，那种部署里 mode 本来不生效），
        // 黑名单由 normalizeEgressPolicy 补成内置隧道清单。
        policy: normalizeEgressPolicy({ mode: parseProxyEgressMode(DEPLOYMENT_EGRESS_MODE) }),
        error: available ? '' : EGRESS_POLICY_PATH + ' 所在目录没有挂进面板容器，先在宿主上重跑一次安装器。',
      }
    }
    return { available: false, exists: false, policy: normalizeEgressPolicy({}), error: '读不到 ' + EGRESS_POLICY_PATH + '：' + error.message }
  }
  try {
    return { available: true, exists: true, policy: parseEgressPolicyText(text), error: '' }
  } catch (error) {
    // 文件被手改坏了：如实报出来，同时给一份默认策略，别让页面白屏。
    return {
      available: true,
      exists: true,
      policy: normalizeEgressPolicy({ mode: parseProxyEgressMode(DEPLOYMENT_EGRESS_MODE) }),
      error: String(error && error.message) + '（代理仍在用上一份规则，这里保存一次就能修好）',
    }
  }
}

function writeEgressPolicy(policy) {
  if (EGRESS_POLICY_PATH === '') {
    throw new AdminInputError('这台部署没有出站策略文件（DSH_KEY_ADMIN_EGRESS_POLICY 是空的）。', 400)
  }
  const text = serializeEgressPolicy(policy)
  const temporary = EGRESS_POLICY_PATH + '.tmp.' + process.pid
  try {
    // 0644：dsh-egress 以另一个 UID 只读挂载这份文件，必须读得到。它不是秘密。
    fs.writeFileSync(temporary, text, { mode: 0o644 })
    fs.chmodSync(temporary, 0o644)
    fs.renameSync(temporary, EGRESS_POLICY_PATH)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // 临时文件删不掉不影响正确性。
    }
    throw new AdminInputError('写不了 ' + EGRESS_POLICY_PATH + '：' + error.message
      + '（目录要挂进面板容器才能改，先在宿主上重跑一次安装器）', 500)
  }
}

function egressState() {
  const current = readEgressPolicy()
  return {
    deploymentMode: DEPLOYMENT_EGRESS_MODE,
    policyPath: EGRESS_POLICY_PATH,
    available: current.available,
    exists: current.exists,
    error: current.error,
    policy: current.policy,
    // 内置清单给页面用：白名单里这些源始终放行（append 模式），黑名单可以一键恢复默认。
    builtinAllow: Array.from(DEFAULT_ALLOWED_HOSTS),
    builtinBlock: DEFAULT_BLOCKED_HOSTS.map((entry) => ({ host: entry.host, note: entry.note })),
  }
}

async function saveEgressHandler(body) {
  let policy
  try {
    policy = normalizeEgressPolicy(body?.policy ?? body)
  } catch (error) {
    if (error instanceof EgressPolicyError) throw new AdminInputError(error.message, 400)
    throw error
  }
  writeEgressPolicy(policy)
  log({
    event: 'egress-save',
    mode: policy.mode,
    allow: policy.allow.filter((entry) => entry.enabled).length,
    block: policy.block.filter((entry) => entry.enabled).length,
  })
  const notes = ['dsh-egress 每 5 秒按修改时间热加载这份策略：allowlist 与 blocklist 之间的切换、清单的增删改都不用重启容器。']
  if (DEPLOYMENT_EGRESS_MODE === 'open') {
    notes.push('当前部署是 open：容器直连外网，根本不经过 dsh-egress，所以这份策略暂时不生效。'
      + '要让它生效，在宿主上重跑 ./install.sh，出站那一问选 blocklist 或 allowlist。')
  }
  if (policy.mode === 'blocklist') {
    notes.push('blocklist 只挡清单里的域名，自建域名的隧道挡不住；要真正收口就用 allowlist。')
  }
  return { ok: true, egress: egressState(), brokerReload: notes.join('\n') }
}

async function fetchModels(record) {
  const found = await fetchUpstreamModels(record, { timeoutMs: UPSTREAM_TIMEOUT_MS })
  if (found.ok) {
    log({ event: 'models', upstream: record.name, endpoint: found.endpoint, count: found.models.length })
    return found
  }
  // 拉不到不是错误路径的终点：很多自建网关根本不实现 /models，手写模型 id 一样能用。
  throw new AdminInputError('拉不到模型列表，直接在下面手写模型 id 也可以。' + found.message, 502)
}

function stateResponse() {
  const document = readDocument(readConfigText())
  const defaultShapes = {}
  for (const name of Object.keys(DEFAULT_BASE_URLS)) defaultShapes[name] = defaultShapeOf(name)
  return {
    ok: true,
    brokerBase: BROKER_BASE,
    configPath: CONFIG_PATH,
    dshHome: DSH_HOME,
    apiShapes: Object.entries(API_SHAPES).map(([id, shape]) => ({ id, label: shape.label })),
    defaultBaseUrls: { ...DEFAULT_BASE_URLS },
    defaultShapes,
    thinkingLevels: [...THINKING_LEVELS],
    defaultThinkingLevels: [...DEFAULT_PANEL_THINKING_LEVELS],
    upstreams: document.upstreams.map((entry) => toUpstreamView(entry)),
    egress: egressState(),
  }
}

const RELOAD_NOTE = 'dsh-key-broker 每 5 秒按修改时间热加载 keys.json，DSH 的 settings.yaml 也是热加载：两边都不用重启容器。'

/**
 * 保存前替目录外的网关向上游问一次：模型清单，以及 base_url 到底该不该带版本段。
 *
 * 两件事都不是"省一次点击"，而是没有它这条上游根本用不了：
 *   1) DSH 对目录外的路由要求至少一个模型，缺了就拒绝整条路由，而被拒绝的结果是
 *      "页面上不多出任何卡片、也不报错"。
 *   2) base_url 少写一个 /v1 时，面板这边看不出问题——modelsRequestCandidates 会同时试
 *      /models 和 /v1/models，第二个能成。可 DSH 走代理发的是 /responses、
 *      /chat/completions、/models，一个版本段都不补，于是全落在上游的根路径上，
 *      换回来 403 或 404，页面上显示成"API key is invalid"。
 *
 * 拉不到就照原样保存，让提示去说明为什么 DSH 那边还没这条供应商。
 */
async function withDiscoveredModels(record) {
  const needsModels = record.models.length === 0
  // 模型清单齐了、base_url 也带着版本段，就没有任何要问上游的事。
  if (looksLikeCatalogRoute(record.name) || (!needsModels && !baseUrlLooksUnversioned(record.shape, record.baseUrl))) {
    return { record, discovery: '' }
  }
  try {
    const found = await fetchModels(record)
    const notes = []
    let fixed = record
    if (found.suggestedBaseUrl) {
      fixed = { ...fixed, baseUrl: found.suggestedBaseUrl }
      notes.push('base_url 少了版本段，已改成 ' + found.suggestedBaseUrl
        + '：模型列表只在带版本段的地址上才有，而 DSH 发请求时不会自己补这一段——'
        + '不改的话面板里能拉到清单，网页里一发请求就是 403 或"API key is invalid"。')
    }
    if (needsModels) {
      const models = found.models.slice(0, 200)
      fixed = { ...fixed, models }
      notes.push('已从 ' + found.endpoint + ' 拉到 ' + models.length + ' 个模型 id（目录外的上游必须有模型清单，'
        + '所以保存时自动拉了一次）。不想要这么多就在模型清单里删掉再保存。')
    }
    return { record: fixed, discovery: notes.join('\n') }
  } catch (error) {
    const reason = error instanceof AdminInputError ? error.message : String(error && error.message)
    if (!needsModels) {
      // 模型清单是用户自己写的，留着；只是 base_url 没法验证，如实说一句。
      return { record, discovery: 'base_url 没带版本段，想验证一下却拉不到模型列表：' + reason
        + ' 如果网页里报 403 或"API key is invalid"，先给 base_url 补上 /v1 再试。' }
    }
    return {
      record,
      discovery: '这个上游不在 DSH 内置目录里，而模型清单是空的，自动拉取也没成功：' + reason
        + ' 请在模型清单里手写至少一个模型 id 再保存，否则 DSH 不会多出这条供应商。',
    }
  }
}

async function saveUpstream(body) {
  const before = readDocument(readConfigText())
  const name = normalizeName(body?.name)
  const rename = typeof body?.rename === 'string' && body.rename.trim() !== '' ? normalizeName(body.rename) : ''
  // 改名时密钥要从旧那条上继承，否则"只改个名字"会被当成"新上游没填密钥"。
  const existing = findUpstream(before, name) ?? (rename !== '' ? findUpstream(before, rename) : undefined)
  const discovered = await withDiscoveredModels(normalizeUpstreamInput(body, existing))
  const record = discovered.record
  let next = mergeUpstream(before, toBrokerEntry(record))
  const renamed = rename !== '' && rename !== record.name && findUpstream(next, rename) !== undefined
  if (renamed) next = removeUpstream(next, rename)
  writeDocument(next)
  log({ event: 'save', upstream: record.name, shape: record.shape, models: record.models.length, renamedFrom: renamed ? rename : '' })
  const seed = await runSeed(next)
  const notes = [RELOAD_NOTE]
  if (discovered.discovery !== '') notes.push(discovered.discovery)
  if (renamed) notes.push('上游 ' + rename + ' 已被改名成 ' + record.name + '；DSH 侧那条旧供应商要自己在 WebUI 里删。')
  // baseUrl / models 回给页面：保存时可能被自动改过，表单里必须跟着变，否则用户下一次
  // 保存又会把旧值写回去。
  return { ok: true, name: record.name, baseUrl: record.baseUrl, models: record.models, brokerReload: notes.join('\n'), seed }
}

async function deleteUpstreamHandler(body) {
  const before = readDocument(readConfigText())
  const name = normalizeName(body?.name)
  const next = removeUpstream(before, name)
  writeDocument(next)
  log({ event: 'delete', upstream: name })
  const seed = await runSeed(next)
  return {
    ok: true,
    name,
    brokerReload: [
      '密钥已从 keys.json 删除。' + RELOAD_NOTE,
      'DSH 的 settings.yaml 里那条供应商不会被自动删掉（那是用户自己的配置），需要在 DSH 的「设置 → 模型」里删。',
    ].join('\n'),
    seed,
  }
}

async function modelsHandler(body) {
  const document = readDocument(readConfigText())
  const name = normalizeName(body?.name)
  const rename = typeof body?.rename === 'string' && body.rename.trim() !== '' ? normalizeName(body.rename) : ''
  const existing = findUpstream(document, name) ?? (rename !== '' ? findUpstream(document, rename) : undefined)
  const record = normalizeUpstreamInput(body, existing)
  return fetchModels(record)
}

async function seedHandler() {
  const document = readDocument(readConfigText())
  const seed = await runSeed(document)
  log({ event: 'seed', upstreams: document.upstreams.length, failed: seed.failed })
  return { ok: true, brokerReload: RELOAD_NOTE, seed }
}

async function handle(request, response) {
  const pathname = String(request.url ?? '/').split('?')[0]

  if (request.method === 'GET' && pathname === '/healthz') {
    response.writeHead(204)
    response.end()
    return
  }
  if (request.method === 'GET' && STATIC_FILES.has(pathname)) {
    sendStatic(response, STATIC_FILES.get(pathname))
    return
  }
  if (!pathname.startsWith('/api/')) {
    sendJson(response, 404, { ok: false, message: '没有这个地址：' + pathname })
    return
  }

  const auth = await authorize(request)
  if (!auth.ok) {
    request.resume()
    sendJson(response, auth.status, { ok: false, message: auth.message })
    return
  }

  if (request.method === 'GET' && pathname === '/api/state') {
    sendJson(response, 200, stateResponse())
    return
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, message: '这个地址只接受 POST' })
    return
  }
  const body = await readBody(request)
  if (pathname === '/api/upstreams') {
    sendJson(response, 200, await saveUpstream(body))
    return
  }
  if (pathname === '/api/upstreams/delete') {
    sendJson(response, 200, await deleteUpstreamHandler(body))
    return
  }
  if (pathname === '/api/models') {
    sendJson(response, 200, await modelsHandler(body))
    return
  }
  if (pathname === '/api/seed') {
    sendJson(response, 200, await seedHandler())
    return
  }
  if (pathname === '/api/egress') {
    sendJson(response, 200, await saveEgressHandler(body))
    return
  }
  sendJson(response, 404, { ok: false, message: '没有这个地址：' + pathname })
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    const status = error instanceof AdminInputError ? error.status : 500
    const message = error instanceof AdminInputError ? error.message : '面板内部错误，详见容器日志。'
    if (!(error instanceof AdminInputError)) log({ event: 'error', message: String(error && error.message) })
    request.resume()
    if (!response.headersSent) sendJson(response, status, { ok: false, message })
    else response.end()
  })
})

server.headersTimeout = 30_000
server.requestTimeout = 300_000
server.keepAliveTimeout = 30_000

function shutdown(signal) {
  log({ event: 'shutdown', signal })
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}

try {
  loadToken()
} catch (error) {
  process.stderr.write('[dsh-key-admin] ' + error.message + '\n')
  process.exit(78)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.listen(PORT, BIND, () => {
  log({ event: 'listening', port: PORT, bind: BIND, config: CONFIG_PATH, dshHome: DSH_HOME })
  if (!(SCRUB_INTERVAL_MS > 0)) return
  const tick = () => {
    scrubCredentials().catch((error) => log({ event: 'scrub', failed: true, error: String(error && error.message) }))
  }
  tick()
  setInterval(tick, SCRUB_INTERVAL_MS).unref()
})
