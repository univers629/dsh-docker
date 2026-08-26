// 以 root 运行的 DSH 特权代理。
//
// 容器里的 DSH 进程、Agent 会话和 Nginx worker 都以非 root 的 dsh 账户运行，
// 容器还带着 no-new-privileges 与 cap_drop: ALL 启动，因此 setuid sudo 在这里
// 根本无法提权。需要 root 的动作改为通过 /run/dsh-priv/helper.sock 提交给本代理：
//
//   apt        —— 按 dsh-privileged-policy.mjs 的白名单执行，默认不需要密码，
//                 这样 Agent 仍然可以自己安装 Debian 软件包。
//   update-dsh —— 容器内 DSH 更新器，WebUI 的“更新”按钮走这条路。
//   run        —— 任意 root 命令，必须提供容器 root 密码，并受失败锁定保护。
//
// 密码只在这里校验：/etc/shadow 和挂载进来的哈希文件都在 dsh 账户读不到的位置，
// 所以攻击者拿不到哈希做离线爆破，只能走这个带锁定的接口。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'

import {
  APT_EXECUTABLES,
  DEFAULT_LOCKOUT,
  PolicyError,
  attemptDelayMs,
  emptyLockoutState,
  findProtectedRemovals,
  lockoutRemainingSeconds,
  normalizeLockoutState,
  registerFailure,
  registerSuccess,
  validateAptCommand,
} from './dsh-privileged-policy.mjs'

const SOCKET_PATH = process.env.DSH_PRIVILEGED_SOCKET ?? '/run/dsh-priv/helper.sock'
const STATE_PATH = process.env.DSH_PRIVILEGED_STATE ?? '/run/dsh-priv/faillock.json'
const SHADOW_PATH = process.env.DSH_PRIVILEGED_SHADOW ?? '/etc/shadow'
const OPENSSL = process.env.DSH_PRIVILEGED_OPENSSL ?? '/usr/bin/openssl'
const UPDATER = process.env.DSH_PRIVILEGED_UPDATER ?? '/usr/local/lib/dsh/update-dsh.sh'
const RUN_USER = process.env.DSH_RUN_USER ?? 'dsh'
const APT_REQUIRES_PASSWORD = (process.env.DSH_PRIVILEGED_APT ?? 'nopasswd') === 'password'
const UPDATE_REQUIRES_PASSWORD = (process.env.DSH_PRIVILEGED_UPDATE ?? 'nopasswd') === 'password'
const MAX_REQUEST_BYTES = 64 * 1024
// 隔离模式（DSH_EGRESS_MODE=allowlist）下的出站代理。
//
// apt 走 /etc/apt/apt.conf.d/00-dsh-proxy 就够了，但 `dsh-root run` 执行的是任意
// root 命令（curl、wget、pip、npm……），这些只认环境变量。子进程环境是白名单式的
// 固定表，所以必须在这里显式加进去，否则隔离模式下 root 命令一律连不上外网。
//
// 代理地址不是凭据，放进来不扩大提权面；但它毕竟来自环境变量，所以先校验形态，
// 只接受 http://主机[:端口] 这一种写法，避免把奇怪的值透传给子进程。
const EGRESS_PROXY_URL = (() => {
  const raw = (process.env.DSH_EGRESS_PROXY_URL ?? '').trim()
  if (raw === '') return ''
  if (!/^http:\/\/[a-z0-9.-]+(:[0-9]{1,5})?\/?$/i.test(raw)) {
    process.stderr.write(`[dsh-priv] 忽略形态不合法的 DSH_EGRESS_PROXY_URL：${raw}\n`)
    return ''
  }
  return raw.replace(/\/$/, '')
})()

const EGRESS_NO_PROXY =
  process.env.NO_PROXY ??
  process.env.no_proxy ??
  'localhost,127.0.0.1,::1,dsh,dsh-key-broker,dsh-egress,dsh-ingress'

const EGRESS_ENVIRONMENT =
  EGRESS_PROXY_URL === ''
    ? {}
    : {
        // 大小写两套都给：curl 认小写，很多 Go/Java 工具只认大写。
        HTTP_PROXY: EGRESS_PROXY_URL,
        HTTPS_PROXY: EGRESS_PROXY_URL,
        ALL_PROXY: EGRESS_PROXY_URL,
        http_proxy: EGRESS_PROXY_URL,
        https_proxy: EGRESS_PROXY_URL,
        all_proxy: EGRESS_PROXY_URL,
        NO_PROXY: EGRESS_NO_PROXY,
        no_proxy: EGRESS_NO_PROXY,
        // undici/fetch 默认不读代理环境变量，Node 24 要靠这个开关。
        NODE_USE_ENV_PROXY: '1',
      }

const CHILD_ENVIRONMENT = {
  ...EGRESS_ENVIRONMENT,
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/root',
  LANG: 'C.UTF-8',
  DEBIAN_FRONTEND: 'noninteractive',
  DSH_HOME: process.env.DSH_HOME ?? '/data/dsh',
  DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? '/data/agents',
  DSH_APP_DIR: process.env.DSH_APP_DIR ?? '/app/dsh',
  DSH_UPDATE_STATE: process.env.DSH_UPDATE_STATE ?? '/data/dsh/update',
  DSH_NGINX_CONFIG: process.env.DSH_NGINX_CONFIG ?? '/usr/local/share/dsh/nginx.conf',
  DSH_RUN_USER: RUN_USER,
}

export const EXIT_DENIED = 126
export const EXIT_AUTH_FAILED = 125
export const EXIT_LOCKED = 124
export const EXIT_BUSY = 123
export const EXIT_UNAVAILABLE = 122

class RequestError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RequestError'
    this.code = code
  }
}

function log(message) {
  process.stderr.write(`[dsh-priv] ${message}\n`)
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function readLockoutState() {
  try {
    return normalizeLockoutState(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')))
  } catch {
    return emptyLockoutState()
  }
}

function writeLockoutState(state) {
  const temporary = `${STATE_PATH}.tmp.${process.pid}`
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, STATE_PATH)
}

function readRootHash() {
  const line = fs
    .readFileSync(SHADOW_PATH, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('root:'))
  return line ? line.split(':')[1] ?? '' : ''
}

function opensslCrypt(password, salt) {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENSSL, ['passwd', '-6', '-salt', salt, '-stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: CHILD_ENVIRONMENT.PATH },
    })
    let output = ''
    let failure = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      failure += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(output.trim())
      else reject(new Error(`openssl passwd 失败：${failure.trim() || code}`))
    })
    child.stdin.end(`${password}\n`)
  })
}

function equals(left, right) {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function authenticate(password) {
  const state = readLockoutState()
  const remaining = lockoutRemainingSeconds(state, nowSeconds())
  if (remaining > 0) {
    log(`密码校验被锁定，剩余 ${remaining} 秒`)
    throw new RequestError(EXIT_LOCKED, `root 密码校验已被锁定，请在 ${remaining} 秒后重试`)
  }

  const stored = readRootHash()
  if (!stored || stored.startsWith('!') || stored === '*' || stored === '') {
    throw new RequestError(
      EXIT_UNAVAILABLE,
      '容器 root 密码未设置，特权命令不可用；请在宿主机重新运行安装器并设置 root 密码',
    )
  }
  const parsed = /^\$6\$([^$]+)\$/.exec(stored)
  if (!parsed) {
    throw new RequestError(
      EXIT_UNAVAILABLE,
      '容器 root 口令哈希不是 sha512crypt，无法校验；请重新运行安装器设置 root 密码',
    )
  }
  if (typeof password !== 'string' || password.length === 0 || password.length > 512) {
    throw new RequestError(EXIT_AUTH_FAILED, '需要提供容器 root 密码')
  }

  // 每次尝试都先睡一段随着失败次数增长的时间，让在线爆破的速率始终远低于
  // 一次哈希校验的成本。
  await new Promise((resolve) => setTimeout(resolve, attemptDelayMs(state, DEFAULT_LOCKOUT)))

  const computed = await opensslCrypt(password, parsed[1])
  if (equals(computed, stored)) {
    writeLockoutState(registerSuccess())
    return
  }

  const next = registerFailure(state, nowSeconds(), DEFAULT_LOCKOUT)
  writeLockoutState(next)
  const locked = lockoutRemainingSeconds(next, nowSeconds())
  log(`root 密码校验失败（累计 ${next.failures} 次${locked > 0 ? `，已锁定 ${locked} 秒` : ''}）`)
  if (locked > 0) {
    throw new RequestError(EXIT_LOCKED, `root 密码连续错误次数过多，已锁定 ${locked} 秒`)
  }
  throw new RequestError(EXIT_AUTH_FAILED, 'root 密码错误')
}

function resolveRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new PolicyError('请求必须是 JSON 对象')
  }
  const action = request.action
  if (action === 'apt') {
    const resolved = validateAptCommand(String(request.command ?? ''), request.args ?? [])
    return {
      description: resolved.argv.join(' '),
      executable: resolved.executable,
      argv: resolved.argv,
      requiresPassword: APT_REQUIRES_PASSWORD,
      // 卸载类请求要在执行前多走一次 apt -s 模拟，见 findBlockedRemovalPlan。
      subcommand: resolved.subcommand,
      removal: resolved.removal === true,
    }
  }
  if (action === 'update-dsh') {
    const version = String(request.version ?? 'latest')
    if (!/^[A-Za-z0-9][A-Za-z0-9.@^~-]*$/.test(version)) {
      throw new PolicyError(`不是合法的 DSH 版本号：${version}`)
    }
    return {
      description: `update-dsh ${version}`,
      executable: UPDATER,
      argv: ['update-dsh', version],
      requiresPassword: UPDATE_REQUIRES_PASSWORD,
    }
  }
  if (action === 'run') {
    const argv = request.args
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== 'string' || value === '')) {
      throw new PolicyError('run 需要一个非空的命令数组')
    }
    if (argv.length > 256) {
      throw new PolicyError('run 参数过多')
    }
    return {
      description: `run ${argv.join(' ')}`,
      executable: argv[0],
      argv,
      requiresPassword: true,
    }
  }
  throw new PolicyError(`不支持的特权动作：${String(action)}`)
}

let busy = false

function send(socket, frame) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`)
}

function fail(socket, code, message) {
  send(socket, { t: 'err', code, message })
  socket.end()
}

// apt 自己的 -s / --dry-run：请求本身就只是模拟，不会改动系统，用不着再预检一遍。
const APT_SIMULATE_FLAGS = new Set(['-s', '--simulate', '--dry-run', '--just-print'])

// 用 `apt -s` 把卸载计划跑一遍，只收集 stdout。模拟模式不取 dpkg 锁、不落盘、不联网，
// 所以可以安全地放在真正执行之前；超时或非零退出都按“无法确认影响范围”处理。
function simulateApt(resolved) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.executable, ['-s', ...resolved.argv.slice(1)], {
      argv0: resolved.argv[0],
      cwd: '/',
      env: CHILD_ENVIRONMENT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('apt 模拟超时'))
    }, 60_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // apt 自己就拒绝了（比如 Essential 包、依赖冲突）：没有可执行的卸载计划，
      // 让真实命令去跑一遍好把原始报错原样交给调用方。
      if (code !== 0) resolve('')
      else resolve(`${stdout}\n${stderr}`)
    })
  })
}

// 返回这次卸载会连带摘掉的受保护包。策略层只能拒绝“显式点名”受保护包的请求，
// 拦不住 `apt-get purge -y <某个无害依赖>` 让 apt 级联把 Nginx 一起带走——那条路
// 只有把计划真正算一遍才看得见。
async function findBlockedRemovalPlan(resolved) {
  if (resolved.argv.some((argument) => APT_SIMULATE_FLAGS.has(argument))) return []
  return findProtectedRemovals(await simulateApt(resolved))
}
function runChild(socket, resolved) {
  return new Promise((resolve) => {
    const child = spawn(resolved.executable, resolved.argv.slice(1), {
      argv0: resolved.argv[0],
      cwd: '/',
      env: CHILD_ENVIRONMENT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => send(socket, { t: 'o', d: chunk.toString('base64') }))
    child.stderr.on('data', (chunk) => send(socket, { t: 'e', d: chunk.toString('base64') }))
    child.on('error', (error) => {
      send(socket, { t: 'err', code: EXIT_DENIED, message: `无法执行特权命令：${error.message}` })
      socket.end()
      resolve()
    })
    child.on('close', (code, signal) => {
      send(socket, { t: 'x', code: code ?? 0, signal: signal ?? null })
      socket.end()
      resolve()
    })
  })
}

async function handleRequest(socket, request) {
  let resolved
  try {
    resolved = resolveRequest(request)
  } catch (error) {
    log(`拒绝请求：${error.message}`)
    fail(socket, EXIT_DENIED, error.message)
    return
  }

  if (resolved.requiresPassword) {
    try {
      await authenticate(request.password)
    } catch (error) {
      if (error instanceof RequestError) {
        fail(socket, error.code, error.message)
        return
      }
      log(`密码校验异常：${error.message}`)
      fail(socket, EXIT_AUTH_FAILED, '无法校验 root 密码')
      return
    }
  }

  // 免密 apt 的最后一道闸：卸载类请求在动手之前先算清影响范围。挡不住的不是逃逸，
  // 而是“一条命令把自己住的房子拆了”——Nginx / openssl / mawk 被 purge 掉之后，
  // 已经在跑的进程还活着，直到下一次重启才起不来，排查成本极高。
  if (resolved.removal) {
    let blocked
    try {
      blocked = await findBlockedRemovalPlan(resolved)
    } catch (error) {
      const reason = `无法确认卸载影响范围，已拒绝：${error.message}`
      log(reason)
      fail(socket, EXIT_DENIED, reason)
      return
    }
    if (blocked.length > 0) {
      const reason = `apt ${resolved.subcommand} 会连带卸载容器运行时依赖，已拒绝：${blocked.join(' ')}`
      log(reason)
      fail(socket, EXIT_DENIED, reason)
      return
    }
  }

  if (busy) {
    fail(socket, EXIT_BUSY, '已有一个特权命令正在执行，请稍后重试')
    return
  }
  busy = true
  log(`执行：${resolved.description}`)
  try {
    await runChild(socket, resolved)
  } finally {
    busy = false
    log(`完成：${resolved.description}`)
  }
}

function handleConnection(socket) {
  socket.setNoDelay(true)
  let buffer = ''
  let handled = false
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    if (handled) return
    buffer += chunk.toString('utf8')
    if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
      handled = true
      fail(socket, EXIT_DENIED, '请求过大')
      return
    }
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    handled = true
    const line = buffer.slice(0, newline)
    let request
    try {
      request = JSON.parse(line)
    } catch {
      fail(socket, EXIT_DENIED, '请求不是合法的 JSON')
      return
    }
    handleRequest(socket, request).catch((error) => {
      log(`处理请求失败：${error.message}`)
      fail(socket, EXIT_DENIED, '特权代理内部错误')
    })
  })
}

function main() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    log('特权代理必须以 root 运行')
    process.exit(77)
  }

  let groupId = 0
  try {
    const entry = fs
      .readFileSync('/etc/group', 'utf8')
      .split('\n')
      .find((line) => line.startsWith(`${RUN_USER}:`))
    if (entry) groupId = Number(entry.split(':')[2])
  } catch {
    groupId = 0
  }

  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true })
  fs.chmodSync(path.dirname(SOCKET_PATH), 0o750)
  if (groupId > 0) fs.chownSync(path.dirname(SOCKET_PATH), 0, groupId)
  fs.rmSync(SOCKET_PATH, { force: true })

  const server = net.createServer(handleConnection)
  server.on('error', (error) => {
    log(`监听失败：${error.message}`)
    process.exit(1)
  })
  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o660)
    if (groupId > 0) fs.chownSync(SOCKET_PATH, 0, groupId)
    log(
      `已在 ${SOCKET_PATH} 就绪（apt ${APT_REQUIRES_PASSWORD ? '需要' : '无需'}密码，run 始终需要 root 密码，主机 ${os.hostname()}）`,
    )
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main()
