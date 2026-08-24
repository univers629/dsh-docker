import { existsSync, appendFileSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
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
      upstreamCommit: typeof metadata.upstreamCommit === 'string' ? metadata.upstreamCommit : 'unknown',
      patchsetHash: typeof metadata.patchsetHash === 'string' ? metadata.patchsetHash : 'unknown',
      builtAt: typeof metadata.builtAt === 'string' ? metadata.builtAt : 'unknown',
    },
    system: {
      debianVersion: readTextFileSync('/etc/debian_version'),
      nodeVersion: process.version,
      pythonVersion: await commandVersion('python3', ['--version']),
    },
    update: updateStatus(),
  }
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

function nodeExecutable() {
  if (process.argv0 && process.argv0.startsWith('/') && existsSync(process.argv0)) return process.argv0
  return process.execPath
}

function restartLaunch() {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\\.(?:js|ts)|dsh)$/.test(entry)) {
    return {
      file: nodeExecutable(),
      args: [...process.execArgv, entry, ...process.argv.slice(2)],
      cwd: process.cwd(),
    }
  }
  return { file: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)], cwd: process.cwd() }
}

function scheduleRestart() {
  const launch = restartLaunch()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = join(tmpdir(), `dsh-docker-control-${stamp}.out.log`)
  const errPath = join(tmpdir(), `dsh-docker-control-${stamp}.err.log`)
  const out = openSync(outPath, 'a')
  const err = openSync(errPath, 'a')
  const helper = spawn(nodeExecutable(), ['-e', `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const file = ${JSON.stringify(launch.file)}
const args = ${JSON.stringify(launch.args)}
const cwd = ${JSON.stringify(launch.cwd)}
const outPath = ${JSON.stringify(outPath)}
const errPath = ${JSON.stringify(errPath)}
setTimeout(() => {
  try {
    const out = fs.openSync(outPath, 'a')
    const err = fs.openSync(errPath, 'a')
    const child = spawn(file, args, { cwd, detached: true, stdio: ['ignore', out, err], env: process.env })
    child.on('error', e => { try { fs.appendFileSync(errPath, '[dsh-docker-control] ' + e.message + '\\n') } catch {} })
    child.unref()
  } catch (e) {
    try { fs.appendFileSync(errPath, '[dsh-docker-control] ' + String(e) + '\\n') } catch {}
  }
}, 1200)
`], { detached: true, stdio: ['ignore', out, err], env: process.env })
  helper.unref()
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
  return { boot: BOOT_ID, pid: process.pid, helperPid: helper.pid, logOut: outPath, logErr: errPath }
}

export function apply(ctx) {
  const webServer = ctx.webServer
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
    handler: (request, response) => {
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
        sendJson(response, 202, { ok: true, ...scheduleRestart() })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
