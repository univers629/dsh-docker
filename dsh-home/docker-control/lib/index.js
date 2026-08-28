import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, basename } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

export const name = 'dsh-docker-control'
export const inject = ['webServer']

const require = createRequire(import.meta.url)
let yaml
try { yaml = require('yaml') } catch {}
const SETTINGS_FILE = join(process.env.DSH_HOME ?? '/data/dsh', 'settings.yaml')
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_REQUEST_BYTES = MAX_CONFIG_BYTES * 6 + 4096
const execFileAsync = promisify(execFile)

class ConfigValidationError extends Error {}
class RequestBodyError extends Error {}
let configWriteTail = Promise.resolve()

const BOOT_ID = `${Date.now()}-${process.pid}`
let updateLaunchPending = false

function dshAppDir() {
  return process.env.DSH_APP_DIR ?? '/app/dsh'
}

function updateStateDir() {
  return process.env.DSH_UPDATE_STATE ?? join(process.env.DSH_HOME ?? '/data/dsh', 'update')
}

function updateExecutable() {
  return process.env.DSH_UPDATE_EXECUTABLE ?? '/usr/local/bin/update-dsh'
}

function restartExecutable() {
  return process.env.DSH_RESTART_EXECUTABLE ?? '/usr/local/bin/restart-dsh'
}

function readJsonFileSync(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function readTextFileSync(file, fallback = 'unknown') {
  try {
    const text = readFileSync(file, 'utf8').trim()
    return text || fallback
  } catch {
    return fallback
  }
}

function updateStatus() {
  return readJsonFileSync(join(updateStateDir(), 'status.json'), {
    state: 'idle',
    message: '',
    updatedAt: null,
  })
}

function updateLockHeld() {
  const lockDir = join(updateStateDir(), '.lock')
  if (!existsSync(lockDir)) return false
  const pid = Number.parseInt(readTextFileSync(join(lockDir, 'pid'), ''), 10)
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function updateRunning() {
  return updateLaunchPending || updateLockHeld()
}

async function commandVersion(command, args) {
  try {
    const result = await execFileAsync(command, args, { timeout: 5000, windowsHide: true })
    return `${result.stdout || ''}${result.stderr || ''}`.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

async function dshInfo() {
  const metadata = readJsonFileSync(join(dshAppDir(), 'DSH-BUILD-METADATA.json'), {})
  return {
    ok: true,
    dsh: {
      version: typeof metadata.version === 'string' ? metadata.version : 'unknown',
      package: typeof metadata.package === 'string' ? metadata.package : npmPackage(),
      source: typeof metadata.source === 'string' ? metadata.source : 'npm',
      patchsetHash: typeof metadata.patchsetHash === 'string' ? metadata.patchsetHash : 'unknown',
      installedAt: typeof metadata.installedAt === 'string' ? metadata.installedAt : 'unknown',
    },
    system: {
      debianVersion: readTextFileSync('/etc/debian_version'),
      nodeVersion: process.version,
      pythonVersion: await commandVersion('python3', ['--version']),
    },
    update: updateStatus(),
    websocketKeepalive: wsKeepalive,
  }
}

// ---------------------------------------------------------------------------
// 下行 WebSocket 保活
//
// Cloudflare、DPanel 之类的外层反代会回收空闲 WebSocket，而浏览器 JS 发不了 ping
// 这种控制帧，所以保活只能由源站做。这段逻辑原来是打在
// @deepseek-ai/dsh-client-connection 产物上的文本补丁，锚点是 handleUpgrade 里那一
// 段 AbortController 代码——上游改动一个字符就整条失效。搬到插件里之后，依赖面从
// "那一段代码的字面形状"缩小到"ws 仍然叫 ws、仍然有 handleUpgrade"。
//
// 之所以能在插件里做到：DSH 的下行 WebSocket 用的是普通的 ws 包
// （client-connection 里 new WebSocketServer({ noServer: true })），而 ws 是 CJS，
// 所以 createRequire + NODE_PATH 拿到的就是 client-connection 自己在用的那一份
// require.cache 条目，包装 prototype 上的 handleUpgrade 对它同样生效。
// ---------------------------------------------------------------------------

const WS_KEEPALIVE_INTERVAL_MS = Number(process.env.DSH_WS_KEEPALIVE_INTERVAL_MS) || 25_000
// client-connection 导出了这两个常量；能 import 到就用导出值，import 不到才退回
// 字面量。/info 会如实报告用的是哪一种，免得上游改名之后保活静默失效。
const WS_DOWNLINK_FALLBACK_PATHS = ['/api/events.mux', '/api/events.host']

let wsKeepalive = { state: 'pending', detail: '尚未安装' }

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function downlinkPaths() {
  try {
    const connection = await import('@deepseek-ai/dsh-client-connection')
    const exported = [connection.MUX_EVENTS_PATH, connection.HOST_EVENTS_PATH]
      .filter((value) => typeof value === 'string' && value.startsWith('/'))
    if (exported.length === 2) return { paths: new Set(exported), source: 'exported' }
  } catch {}
  return { paths: new Set(WS_DOWNLINK_FALLBACK_PATHS), source: 'fallback' }
}

function isDownlinkUpgrade(request, paths) {
  const target = request?.url
  if (typeof target !== 'string' || target === '') return false
  try {
    return paths.has(new URL(target, 'http://127.0.0.1').pathname)
  } catch {
    return false
  }
}

// 每 25s 发一次 ping；上一轮的 pong 没回来就直接 terminate，否则半开连接会一直
// 占着 pump。计时器 unref，免得它把进程留住。
function attachKeepalive(websocket) {
  let receivedPong = true
  websocket.on('pong', () => { receivedPong = true })
  const timer = setInterval(() => {
    if (websocket.readyState !== 1) return
    if (!receivedPong) {
      websocket.terminate()
      return
    }
    receivedPong = false
    try {
      websocket.ping()
    } catch {
      websocket.terminate()
    }
  }, WS_KEEPALIVE_INTERVAL_MS)
  timer.unref()
  const stop = () => clearInterval(timer)
  websocket.once('close', stop)
  websocket.once('error', stop)
}

// 返回一个 disposer，交给 ctx.effect。安装过程要读模块，是异步的，所以先把
// disposer 交出去，装好之后再把真正的还原逻辑挂进去；期间被卸载就不再安装。
function installWebSocketKeepalive() {
  let active = true
  let restore = () => {}

  void (async () => {
    let WebSocketServer
    try {
      ;({ WebSocketServer } = require('ws'))
      if (typeof WebSocketServer?.prototype?.handleUpgrade !== 'function') {
        throw new Error('ws 没有可包装的 handleUpgrade')
      }
    } catch (error) {
      wsKeepalive = { state: 'unavailable', detail: `拿不到 ws 模块：${errorMessage(error)}` }
      return
    }

    const { paths, source } = await downlinkPaths()
    if (!active) return

    const original = WebSocketServer.prototype.handleUpgrade
    const patched = function (request, socket, head, callback) {
      return original.call(this, request, socket, head, (websocket, ...rest) => {
        if (active && isDownlinkUpgrade(request, paths)) attachKeepalive(websocket)
        return callback(websocket, ...rest)
      })
    }
    WebSocketServer.prototype.handleUpgrade = patched
    restore = () => {
      // 只在还是我们那一份时还原，避免把后装的其它包装一起掀掉。
      if (WebSocketServer.prototype.handleUpgrade === patched) {
        WebSocketServer.prototype.handleUpgrade = original
      }
    }
    wsKeepalive = {
      state: 'active',
      detail: `每 ${Math.round(WS_KEEPALIVE_INTERVAL_MS / 1000)}s 发一次 ping`,
      intervalMs: WS_KEEPALIVE_INTERVAL_MS,
      paths: [...paths],
      pathSource: source,
    }
  })()

  return () => {
    active = false
    restore()
    wsKeepalive = { state: 'pending', detail: '已卸载' }
  }
}

const LATEST_CHECK_TTL_MS = 60_000
let latestCache = null

function npmPackage() {
  return process.env.DSH_NPM_PACKAGE ?? '@deepseek-ai/dsh'
}

function npmRegistry() {
  return (process.env.DSH_NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
}

function npmDistTag() {
  return process.env.DSH_NPM_TAG ?? 'latest'
}

// 运行时就是上游发布在 npm 上的预构建包，所以“有没有更新”等于 registry 上
// 该 dist-tag 的版本和已安装版本是否一致——不需要比对上游提交。
async function remoteVersion() {
  const url = `${npmRegistry()}/${npmPackage().replace('/', '%2f')}`
  const response = await fetch(url, {
    cache: 'no-store',
    // 精简 manifest：完整 packument 有几 MB，这里只需要 dist-tags。
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) {
    throw new Error(`npm registry 返回 ${response.status} / npm registry returned ${response.status}`)
  }
  const manifest = JSON.parse(await response.text())
  const version = manifest?.['dist-tags']?.[npmDistTag()]
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`npm registry 上没有 ${npmDistTag()} 版本 / the npm registry has no ${npmDistTag()} release`)
  }
  return version
}

async function latestDshInfo(force) {
  if (!force && latestCache !== null && Date.now() - latestCache.at < LATEST_CHECK_TTL_MS) return latestCache.value
  const latest = await remoteVersion()
  const metadata = readJsonFileSync(join(dshAppDir(), 'DSH-BUILD-METADATA.json'), {})
  const current = typeof metadata.version === 'string' ? metadata.version : 'unknown'
  const value = {
    ok: true,
    package: npmPackage(),
    registry: npmRegistry(),
    tag: npmDistTag(),
    checkedAt: new Date().toISOString(),
    latest: { version: latest },
    current: { version: current },
    // null = 已安装版本未知（手工装出来的运行时），页面只展示两个版本，不给结论。
    updateAvailable: current === 'unknown' ? null : latest !== current,
  }
  latestCache = { at: Date.now(), value }
  return value
}

function spawnDshUpdate() {
  const stateDir = updateStateDir()
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = join(stateDir, `update-${stamp}.out.log`)
  const errPath = join(stateDir, `update-${stamp}.err.log`)
  const out = openSync(outPath, 'a')
  const err = openSync(errPath, 'a')
  const child = spawn(updateExecutable(), [], {
    cwd: dshAppDir(),
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env,
  })
  updateLaunchPending = true
  const clearPending = () => { updateLaunchPending = false }
  child.once('error', clearPending)
  child.once('exit', clearPending)
  const pendingTimer = setTimeout(clearPending, 10000)
  pendingTimer.unref?.()
  child.unref()
  return { pid: child.pid, logOut: basename(outPath), logErr: basename(errPath) }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(value))
}

function configRevision(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function readConfig() {
  let text = ''
  try {
    text = await readFile(SETTINGS_FILE, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return { text, revision: configRevision(text) }
}

function validateConfig(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ConfigValidationError('配置文件超过 1 MiB 限制 / configuration file exceeds the 1 MiB limit')
  }
  if (typeof yaml?.parseDocument !== 'function' || typeof yaml?.isMap !== 'function') {
    throw new Error('YAML 解析器不可用，已拒绝保存 / YAML parser unavailable; save rejected')
  }
  const document = yaml.parseDocument(text, { prettyErrors: true, strict: true, uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new ConfigValidationError(document.errors[0].message)
  }
  if (document.contents !== null && !yaml.isMap(document.contents)) {
    throw new ConfigValidationError('配置文件根节点必须是对象 / configuration root must be an object')
  }
}

async function writeConfig(text) {
  validateConfig(text)
  const directory = join(process.env.DSH_HOME ?? '/data/dsh')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.settings.yaml.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, SETTINGS_FILE)
  } catch (error) {
    try { await unlink(temporary) } catch {}
    throw error
  }
  return { text, revision: configRevision(text) }
}

async function readRequestBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_REQUEST_BYTES) {
      throw new RequestBodyError('请求正文过大 / request body too large')
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestBodyError('请求正文必须是有效的 JSON / request body must be valid JSON')
  }
}

function queueConfigWrite(task) {
  const result = configWriteTail.then(task, task)
  configWriteTail = result.catch(() => {})
  return result
}

function trustedLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (request.headers.forwarded !== undefined
    || request.headers['x-forwarded-for'] !== undefined
    || request.headers['x-real-ip'] !== undefined) return false
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

// restart-dsh check 的退出码：0 = Supervisor 与 DSH 子进程都在，3 = Supervisor 在但
// 当前没有子进程（刚退出，或正处在重启 backoff 窗口），其它 = Supervisor 不在。
// 只有最后一种才是"重启不了"。3 以前会被当成错误抛给面板，于是按钮报
// "Command failed: restart-dsh check … DSH child process is not running"，
// 而实际上 Supervisor 正在把 DSH 拉起来。
async function supervisorState(executable) {
  try {
    await execFileAsync(executable, ['check'], { timeout: 5000, windowsHide: true })
    return 'running'
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 3) return 'starting'
    throw error
  }
}

async function scheduleRestart() {
  const executable = restartExecutable()
  if (!existsSync(executable)) {
    throw new Error('容器内没有 DSH Supervisor 重启程序 / DSH supervisor restart helper is not installed')
  }
  const state = await supervisorState(executable)
  if (state === 'starting') {
    return { boot: BOOT_ID, pid: process.pid, helperPid: null, supervisor: state }
  }
  const helper = spawn(executable, ['request', '1'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    windowsHide: true,
  })
  helper.unref()
  return { boot: BOOT_ID, pid: process.pid, helperPid: helper.pid, supervisor: state }
}

export function apply(ctx) {
  const webServer = ctx.webServer
  // 保活要在第一个 upgrade 到达之前把 prototype 包好。插件 apply 发生在启动期，
  // 浏览器连上来总在这之后，所以这个顺序是够的。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => installWebSocketKeepalive(), 'dsh-docker-control: WebSocket keepalive')
  } else {
    installWebSocketKeepalive()
  }
  webServer.register({
    kind: 'exact',
    path: '/dsh-docker-control/info',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      if (!trustedLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: 'DSH 信息仅允许已认证的回环请求 / DSH info requires an authenticated loopback request' })
        return
      }
      try {
        sendJson(response, 200, await dshInfo())
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/dsh-docker-control/update/status',
    handler: (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      if (!trustedLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: '更新状态仅允许已认证的回环请求 / update status requires an authenticated loopback request' })
        return
      }
      sendJson(response, 200, { ...updateStatus(), ok: true, running: updateRunning() })
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/dsh-docker-control/update/latest',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      if (!trustedLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: '更新检查仅允许已认证的回环请求 / update checks require an authenticated loopback request' })
        return
      }
      // Explicit user gesture only: the settings page never checks on mount,
      // so this endpoint is never hit by simply opening settings.
      const force = new URL(request.url, 'http://127.0.0.1').searchParams.get('force') === '1'
      try {
        sendJson(response, 200, await latestDshInfo(force))
      } catch (error) {
        sendJson(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/dsh-docker-control/update',
    handler: (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!trustedLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: '更新仅允许已认证的回环请求 / update requires an authenticated loopback request' })
        return
      }
      if (!existsSync(updateExecutable())) {
        sendJson(response, 503, { ok: false, error: '容器内没有 DSH 更新程序 / DSH updater is not installed in this container' })
        return
      }
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        sendJson(response, 503, { ok: false, error: 'DSH 更新需要容器内 root / DSH updates require container root' })
        return
      }
      if (updateRunning()) {
        sendJson(response, 409, { ok: false, error: '已有一个 DSH 更新任务正在执行 / a DSH update is already running' })
        return
      }
      try {
        sendJson(response, 202, { ok: true, ...spawnDshUpdate() })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/dsh-docker-control/config',
    handler: async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'PUT') {
        response.writeHead(405, { allow: 'GET, PUT' })
        response.end()
        return
      }
      if (!trustedLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: '配置编辑仅允许已认证的回环请求 / config editing requires an authenticated loopback request' })
        return
      }
      try {
        if (request.method === 'GET') {
          sendJson(response, 200, { ok: true, ...await readConfig() })
          return
        }
        const body = await readRequestBody(request)
        const text = typeof body.text === 'string' ? body.text : null
        const expected = typeof body.revision === 'string' ? body.revision : null
        if (text === null || expected === null) {
          sendJson(response, 400, { ok: false, error: '配置文本和修订版本均为必填项 / configuration text and revision are required' })
          return
        }
        const result = await queueConfigWrite(async () => {
          const current = await readConfig()
          if (expected !== current.revision) {
            return {
              status: 409,
              body: { ok: false, conflict: true, error: '配置文件已被其他进程修改，请重新读取后再保存 / configuration changed elsewhere; reload before saving', ...current },
            }
          }
          return { status: 200, body: { ok: true, ...(await writeConfig(text)) } }
        })
        sendJson(response, result.status, result.body)
      } catch (error) {
        const status = error instanceof ConfigValidationError ? 422 : error instanceof RequestBodyError ? 400 : 500
        sendJson(response, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/dsh-docker-control/status',
    handler: (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      sendJson(response, 200, { ok: true, boot: BOOT_ID })
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/dsh-docker-control/restart',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!trustedLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: '重启仅允许已认证的回环请求 / restart requires an authenticated loopback request' })
        return
      }
      try {
        sendJson(response, 202, { ok: true, ...await scheduleRestart() })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
