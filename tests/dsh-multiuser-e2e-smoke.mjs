// 多用户入口的端到端验证：用真实容器跑起 nginx 入口 + dsh-auth + 两个实例存根，
// 验证 auth_request 真的按会话身份把请求路由到不同上游。
//
// 这里刻意不使用完整 DSH 镜像（构建代价高且与本测试要验证的链路无关）：实例端用
// 一个只回显自身名字的 HTTP 存根，只要响应里出现对应实例名，就证明请求确实落到了
// 正确的上游。若 docker 不可用则明确跳过，不伪装成通过。

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dockerBin = process.env.DSH_DOCKER_BIN ?? 'docker'
const NODE_IMAGE = process.env.DSH_NODE_IMAGE ?? 'docker.m.daocloud.io/library/node:24-trixie-slim'
const NGINX_IMAGE = process.env.DSH_NGINX_IMAGE ?? 'docker.m.daocloud.io/library/nginx:1.27-alpine'

function docker(args, options = {}) {
  return execFileSync(dockerBin, args, { encoding: 'utf8', timeout: options.timeout ?? 180_000, stdio: options.stdio ?? 'pipe' })
}

try {
  docker(['--version'])
} catch {
  console.log('dsh-multiuser e2e smoke: skipped (docker CLI unavailable)')
  process.exit(0)
}
try {
  docker(['image', 'inspect', NODE_IMAGE])
} catch {
  console.log('dsh-multiuser e2e smoke: skipped (node image not present locally)')
  process.exit(0)
}

const suffix = Math.random().toString(36).slice(2, 8)
const network = `dsh-e2e-${suffix}`
const authName = `dsh-auth-${suffix}`
const ingressName = `dsh-ingress-${suffix}`
const userInstance = `dsh-u1-${suffix}`
const adminInstance = `dsh-admin-${suffix}`
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-'))
const ROOT_PASSWORD = 'e2e-root-pass-2026'
const INSTANCES_TOKEN = 'e2e-instances-token'.padEnd(48, 'z')

// 实例存根：回显自身实例名，便于断言请求落到了哪个上游。
const stubScript = 'const http=require("node:http");const name=process.env.STUB_NAME;http.createServer((req,res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("INSTANCE="+name+" PATH="+req.url)}).listen(3080)'

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// 假编排服务：在宿主上运行，容器通过 host.docker.internal 访问。
const instancesPort = await freePort()
const instancesServer = http.createServer((req, res) => {
  if ((req.headers.authorization ?? '') !== `Bearer ${INSTANCES_TOKEN}`) {
    res.writeHead(401)
    return res.end('{}')
  }
  const url = new URL(req.url, 'http://localhost')
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (url.pathname === '/instances/ensure' || url.pathname === '/instances/state') {
      return res.end(JSON.stringify({ ok: true, running: true, ready: true, status: 'running' }))
    }
    res.end('{"ok":true}')
  })
})
await new Promise((resolve) => instancesServer.listen(instancesPort, '0.0.0.0', resolve))

const ingressPort = await freePort()
const tokenFile = path.join(sandbox, 'instances.token')
fs.writeFileSync(tokenFile, `${INSTANCES_TOKEN}\n`, { mode: 0o600 })
const confFile = path.join(sandbox, 'nginx.conf')
fs.writeFileSync(confFile, fs.readFileSync(path.join(root, 'nginx', 'dsh-multiuser.conf'), 'utf8'))

const cleanup = []
function track(name) {
  cleanup.push(name)
  return name
}

async function waitForIngress(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (response.status === 204) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  const logs = docker(['logs', ingressName], { stdio: ['ignore', 'pipe', 'pipe'] })
  const authLogs = docker(['logs', authName], { stdio: ['ignore', 'pipe', 'pipe'] })
  throw new Error(`ingress did not become ready:\n-- ingress --\n${logs}\n-- auth --\n${authLogs}`)
}

/**
 * 等认证网关真正可用。
 *
 * `/healthz` 由入口无条件返回，不能代表认证链路已就绪；而认证网关首次启动要跑两次
 * Argon2id（dummy hash 与 root 口令哈希），冷容器里可能耗时数十秒，必须等到
 * /api/auth/status 有响应才能开始断言，否则会把「还没起来」误判成配置错误。
 */
async function waitForAuthGateway(base, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/auth/status`)
      if (response.ok) return
    } catch {
      /* gateway still starting */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  const authLogs = docker(['logs', authName], { stdio: ['ignore', 'pipe', 'pipe'] })
  throw new Error(`auth gateway did not become ready:\n${authLogs}`)
}

try {
  docker(['network', 'create', network])

  // 用户实例与管理员实例存根。
  // 容器名带随机后缀以便并发安全，但 nginx 配置里的上游名是固定的 dsh-u1 / dsh-admin，
  // 因此必须同时挂上对应的网络别名。
  for (const [name, label] of [[userInstance, 'dsh-u1'], [adminInstance, 'dsh-admin']]) {
    track(name)
    docker(['run', '-d', '--name', name, '--network', network, '--network-alias', label, '--hostname', label,
      '-e', `STUB_NAME=${label}`, '--entrypoint', 'node', NODE_IMAGE, '-e', stubScript])
  }

  // 认证网关（同样需要对上配置里的 dsh-auth 别名）
  track(authName)
  docker(['run', '-d', '--name', authName, '--network', network, '--network-alias', 'dsh-auth',
    '-v', `${path.join(root, 'bin')}:/opt:ro`,
    '-v', `${tokenFile}:/tmp/auth/instances.token:ro`,
    '-e', 'DSH_AUTH_LISTEN=0.0.0.0:8091',
    '-e', 'DSH_AUTH_STATE=/tmp/auth/state.json',
    '-e', 'DSH_AUTH_TOTP_KEY=/tmp/auth/totp.key',
    '-e', 'DSH_AUTH_WEB_DIR=/opt/dsh-auth-web',
    '-e', `DSH_AUTH_INITIAL_PASSWORD=${ROOT_PASSWORD}`,
    '-e', 'DSH_MULTI_USER=on',
    '-e', `DSH_INSTANCES_URL=http://host.docker.internal:${instancesPort}`,
    '-e', 'DSH_INSTANCES_TOKEN_FILE=/tmp/auth/instances.token',
    '--add-host', 'host.docker.internal:host-gateway',
    '--entrypoint', 'node', NODE_IMAGE, '/opt/dsh-auth.mjs'])

  // 七层入口
  track(ingressName)
  docker(['run', '-d', '--name', ingressName, '--network', network,
    '-p', `127.0.0.1:${ingressPort}:3080`,
    '-v', `${confFile}:/conf/nginx.conf:ro`,
    '--entrypoint', 'sh', NGINX_IMAGE, '-c',
    [
      'adduser -D -u 1000 dsh 2>/dev/null || true',
      'mkdir -p /usr/local/share/dsh-pwa',
      // 配置里已声明 daemon off，命令行不能重复传，否则 nginx 报 duplicate directive
      'exec nginx -c /conf/nginx.conf',
    ].join(' && ')])

  await waitForIngress(ingressPort)
  const base = `http://127.0.0.1:${ingressPort}`
  await waitForAuthGateway(base)

  // ---- 未登录：入口必须把人送到登录页，而不是放行 ----
  const anonymous = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(anonymous.status, 302, 'anonymous access is redirected')
  assert.match(anonymous.headers.get('location') ?? '', /^\/login\?redirect=/, 'anonymous access goes to the login page with a return path')

  // 登录页来自认证网关
  const loginPage = await fetch(`${base}/login`)
  assert.equal(loginPage.status, 200, 'the login page is served through the ingress')
  assert.ok((await loginPage.text()).includes('DeepSeek'), 'login page content reached the client')

  // ---- 注册一个普通账户（多用户模式）----
  const register = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'e2euser', password: 'e2euser-pass-12' }),
  })
  assert.equal(register.status, 201, `registration works through the ingress: ${await register.text()}`)

  // ---- 普通账户登录后必须被路由到自己的实例 ----
  const userLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'e2euser', password: 'e2euser-pass-12' }),
  })
  assert.equal(userLogin.status, 200, 'user login succeeds through the ingress')
  const userCookie = (userLogin.headers.getSetCookie() ?? [])[0]?.split(';')[0]
  assert.ok(userCookie, 'login issued a session cookie')

  const userHome = await fetch(`${base}/`, { headers: { cookie: userCookie } })
  assert.equal(userHome.status, 200, 'an authenticated request is proxied to the instance')
  const userBody = await userHome.text()
  assert.match(userBody, /INSTANCE=dsh-u1/, `the user request must land on their own instance, got: ${userBody.slice(0, 120)}`)
  assert.ok(!userBody.includes('dsh-admin'), 'the user request must never reach the admin workspace')

  // ---- root 必须被路由到管理工作台 ----
  const rootLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'root', password: ROOT_PASSWORD }),
  })
  assert.equal(rootLogin.status, 200, 'root login succeeds')
  const rootCookie = (rootLogin.headers.getSetCookie() ?? [])[0]?.split(';')[0]
  const rootHome = await fetch(`${base}/`, { headers: { cookie: rootCookie } })
  const rootBody = await rootHome.text()
  assert.match(rootBody, /INSTANCE=dsh-admin/, `root must land on the admin workspace, got: ${rootBody.slice(0, 120)}`)

  // ---- 伪造会话令牌不得放行 ----
  const forged = await fetch(`${base}/`, { headers: { cookie: 'dsh_auth_session=forged-token-value' }, redirect: 'manual' })
  assert.equal(forged.status, 302, 'a forged session cookie is rejected and redirected to login')

  console.log('dsh-multiuser e2e smoke: ok')
} finally {
  for (const name of cleanup.reverse()) {
    try {
      docker(['rm', '-f', name])
    } catch { /* already gone */ }
  }
  try {
    docker(['network', 'rm', network])
  } catch { /* already gone */ }
  instancesServer.close()
  fs.rmSync(sandbox, { recursive: true, force: true })
}
