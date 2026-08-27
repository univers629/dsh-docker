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
function runSeed(document) {
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
    upstreams: document.upstreams.map((entry) => toUpstreamView(entry)),
  }
}

const RELOAD_NOTE = 'dsh-key-broker 每 5 秒按修改时间热加载 keys.json，DSH 的 settings.yaml 也是热加载：两边都不用重启容器。'

/**
 * 目录外的网关一个模型 id 都没有时，替用户去上游问一次。
 *
 * 这不是省一次点击：DSH 对目录外的路由要求至少一个模型，缺了就拒绝整条路由，而被拒绝的
 * 结果是"页面上不多出任何卡片、也不报错"。面板本来就持有密钥、也本来就有拉取按钮，
 * 所以保存时顺手拉一次，比让用户先猜到要点哪个按钮现实得多。拉不到就照原样保存，
 * 让 seed 的警告去说明为什么 DSH 那边还没这条供应商。
 */
async function withDiscoveredModels(record) {
  if (record.models.length > 0 || looksLikeCatalogRoute(record.name)) return { record, discovery: '' }
  try {
    const found = await fetchModels(record)
    const models = found.models.slice(0, 200)
    return {
      record: { ...record, models },
      discovery: '已从 ' + found.endpoint + ' 拉到 ' + models.length + ' 个模型 id（目录外的上游必须有模型清单，'
        + '所以保存时自动拉了一次）。不想要这么多就在模型清单里删掉再保存。',
    }
  } catch (error) {
    return {
      record,
      discovery: '这个上游不在 DSH 内置目录里，而模型清单是空的，自动拉取也没成功：'
        + (error instanceof AdminInputError ? error.message : String(error && error.message))
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
  return { ok: true, name: record.name, models: record.models, brokerReload: notes.join('\n'), seed }
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
})
