// 多用户模式集成冒烟：开放注册、邀请码门槛、注册限速、登录后的实例联动
// （ensure + 就绪轮询）、auth_request 返回实例名以驱动 nginx 选上游。
//
// 用一个假的实例编排服务替代真实 dsh-instances，以便确定性地控制「创建中 / 已就绪 /
// 不可达」三种状态，并断言认证网关发出的调用参数。

import assert from 'node:assert/strict'
import { RECOVERY, looksLikeRecoveryCode, totpCodeAtStep } from '../bin/dsh-auth-policy.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-multiuser-'))
const ROOT_PASSWORD = 'multi-root-pass-42'
const INSTANCES_TOKEN = 'instances-token-multiuser'.padEnd(48, 'y')

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

// ---------------------------------------------------------------- 假编排服务
const instancesCalls = []
let instancesReady = false
let instancesMode = 'ok'

function startFakeInstances(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${INSTANCES_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end('{"ok":false,"code":"unauthorized"}')
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      instancesCalls.push({ path: url.pathname, search: url.search, body })
      const reply = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (instancesMode === 'unreachable') return reply(500, { ok: false })
      if (url.pathname === '/status') {
        return reply(200, {
          ok: true,
          watermark: 'normal',
          onlineCount: 1,
          idleTimeoutMs: 1_800_000,
          memoryMbPerInstance: 200,
          instances: [{ uid: 100000, name: 'dsh-u1', running: true, ready: true, status: 'running', usedBytes: 1024, quota: { allowed: true, percent: 0.001, level: 'ok' } }],
        })
      }
      if (url.pathname === '/instances/delete') {
        return reply(200, { ok: true, purged: body.purge === true })
      }
      if (url.pathname === '/instances/ensure') {
        return reply(200, { ok: true, name: `dsh-u${body.uid - 100000 + 1}`, status: 'created' })
      }
      if (url.pathname === '/instances/state') {
        return reply(200, { ok: true, uid: Number(url.searchParams.get('uid')), running: true, ready: instancesReady, status: 'running' })
      }
      return reply(404, { ok: false, code: 'not_found' })
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

async function waitFor(url, check) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (check(response)) return response
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`not ready: ${url}`)
}

const instancesPort = await freePort()
const instancesServer = await startFakeInstances(instancesPort)
const authPort = await freePort()
const tokenFile = path.join(sandbox, 'instances.token')
fs.writeFileSync(tokenFile, `${INSTANCES_TOKEN}\n`, { mode: 0o600 })

const child = spawn(process.execPath, [path.join(root, 'bin', 'dsh-auth.mjs')], {
  env: {
    ...process.env,
    DSH_AUTH_LISTEN: `127.0.0.1:${authPort}`,
    DSH_AUTH_STATE: path.join(sandbox, 'auth', 'state.json'),
    DSH_AUTH_TOTP_KEY: path.join(sandbox, 'auth', 'totp.key'),
    DSH_AUTH_WEB_DIR: path.join(root, 'bin', 'dsh-auth-web'),
    DSH_AUTH_INITIAL_PASSWORD: ROOT_PASSWORD,
    DSH_MULTI_USER: 'on',
    DSH_AUTH_MAX_REGISTRATIONS_PER_IP: '8',
    DSH_INSTANCES_URL: `http://127.0.0.1:${instancesPort}`,
    DSH_INSTANCES_TOKEN_FILE: tokenFile,
    DSH_ADMIN_INSTANCE_NAME: 'dsh-admin',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

const base = `http://127.0.0.1:${authPort}`
const post = (url, body, jar = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base, ...(Object.keys(jar).length ? { cookie: cookieHeader(jar) } : {}) },
  body: JSON.stringify(body),
})
function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
}
function cookiesFrom(response) {
  const jar = {}
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(';')
    const index = pair.indexOf('=')
    if (index > 0) jar[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim())
  }
  return jar
}

try {
  await waitFor(`${base}/api/auth/status`, (r) => r.ok)

  // ---- 多用户模式：注册可用 ----
  const status = await (await fetch(`${base}/api/auth/status`)).json()
  assert.equal(status.multiUser, true, 'multi-user mode reported')
  assert.equal(status.adminPanel, true, 'multi-user mode has an admin panel')
  assert.equal(status.workspace, true, 'multi-user mode always has a workspace behind the entry')

  // ---- 页面：注册路由与唤醒等待界面必须存在 ----
  const registerPage = await fetch(`${base}/register`)
  assert.equal(registerPage.status, 200, '/register serves the auth page')
  const pageHtml = await registerPage.text()
  assert.ok(pageHtml.includes('id="step-register"'), 'register step is present')
  assert.ok(pageHtml.includes('id="step-waking"'), 'instance wake-up step is present')
  assert.ok(pageHtml.includes('id="submit-passkey"'), 'passkey sign-in entry is present')
  assert.ok(pageHtml.includes('id="do-logout"'), 'signed-in state offers a way out')
  const accountPage = await fetch(`${base}/account`)
  assert.equal(accountPage.status, 200, 'the account page is served')
  const accountHtml = await accountPage.text()
  // 页面本身只是宿主：真正的界面来自容器外的 /account-panel.js（同一份实现也用在管理面板与插件里）
  assert.ok(accountHtml.includes('/account-panel.js'), 'the account page loads the shared panel')
  assert.ok(accountHtml.includes('DSHAccountPanel.mount'), 'the account page mounts the shared panel')
  const panelSource = await (await fetch(`${base}/account-panel.js`)).text()
  assert.ok(panelSource.includes('window.DSHAccountPanel'), 'the panel script is served by the gateway')
  for (const section of ['password.title', 'totp.title', 'passkey.title', 'sessions.title']) {
    assert.ok(panelSource.includes(section), `the panel implements the ${section} section`)
  }
  assert.ok(pageHtml.includes('id="go-workspace"'), 'signed-in state links to the workspace')
  assert.ok(pageHtml.includes('id="go-admin"'), 'signed-in state links to the admin panel')
  assert.ok(/if \(body && body\.instance\)/.test(pageHtml), 'a ready account is taken straight to its workspace')
  assert.ok(pageHtml.includes('/api/auth/register'), 'page posts to the register endpoint')
  assert.ok(pageHtml.includes('/api/auth/instance'), 'page polls instance readiness')
  assert.ok(!/window\.location\.replace\(\s*['"]\/['"]\s*\)/.test(pageHtml), 'no redirect loop back to /')

  const register = await post(`${base}/api/auth/register`, { username: 'alice', password: 'alice-pass-1234' })
  assert.equal(register.status, 201, `registration succeeds: ${stderr}`)
  const registered = await register.json()
  assert.equal(registered.username, 'alice')
  assert.equal(registered.instance, 'dsh-u1', 'first registered account gets the first instance slot')

  // 校验：用户名规则、密码强度、重复名
  assert.equal((await post(`${base}/api/auth/register`, { username: 'ab', password: 'goodpass1234' })).status, 400, 'short username rejected')
  assert.equal((await post(`${base}/api/auth/register`, { username: 'bad name', password: 'goodpass1234' })).status, 400, 'invalid username rejected')
  const weak = await post(`${base}/api/auth/register`, { username: 'bobby', password: 'alllettersonly' })
  assert.equal(weak.status, 400, 'weak password rejected')
  assert.equal((await weak.json()).code, 'weak_password')
  assert.equal((await post(`${base}/api/auth/register`, { username: 'alice', password: 'another-pass-99' })).status, 409, 'duplicate username rejected')
  assert.equal((await post(`${base}/api/auth/register`, { username: 'ALICE', password: 'another-pass-99' })).status, 409, 'duplicate check is case-insensitive')

  // 注册限速统计的是「新建账户数」，成功注册同样计入额度
  const second = await post(`${base}/api/auth/register`, { username: 'bobby', password: 'bobby-pass-1234' })
  assert.equal(second.status, 201, 'second account allowed within the quota')
  const third = await post(`${base}/api/auth/register`, { username: 'carol', password: 'carol-pass-1234' })
  assert.equal(third.status, 201, 'third account allowed within the quota')
  const limited = await post(`${base}/api/auth/register`, { username: 'dave', password: 'dave-pass-12345' })
  assert.equal(limited.status, 429, `registration is rate limited once the quota is used: ${stderr}`)
  assert.ok((await limited.json()).retryAfter > 0, 'rate limit reports a retry window')

  // ---- 登录：注册账户触发实例确保，未就绪时给出等待态 ----
  const login = await post(`${base}/api/auth/login`, { username: 'alice', password: 'alice-pass-1234' })
  assert.equal(login.status, 200, `registered account can sign in: ${stderr}`)
  const loginBody = await login.json()
  assert.equal(loginBody.user.role, 'user', 'registered accounts are plain users')
  assert.equal(loginBody.instance, 'dsh-u1', 'login reports the account instance')
  assert.equal(loginBody.ready, false, 'login must not claim readiness while the container is still starting')
  const ensureCall = instancesCalls.find((c) => c.path === '/instances/ensure')
  assert.ok(ensureCall, 'login triggered instance ensure')
  assert.equal(ensureCall.body.uid, 100000, 'ensure carries the allocated uid')
  assert.equal(ensureCall.body.username, 'alice')
  assert.ok(instancesCalls.some((c) => c.path === '/instances/state'), 'readiness is confirmed by a state query, not by ensure success')

  // 实例已就绪后登录：应直接给出 ready
  instancesReady = true
  const readyLogin = await post(`${base}/api/auth/login`, { username: 'alice', password: 'alice-pass-1234' })
  assert.equal((await readyLogin.json()).ready, true, 'login reports readiness once the instance serves')
  instancesReady = false

  // 就绪轮询：假服务报告未就绪 → 等待页应继续等待
  const jar = cookiesFrom(login)
  const notReady = await (await fetch(`${base}/api/auth/instance`, { headers: { cookie: cookieHeader(jar) } })).json()
  assert.equal(notReady.ready, false, 'poll reports not ready while the container starts')
  assert.equal(notReady.instance, 'dsh-u1')

  instancesReady = true
  const ready = await (await fetch(`${base}/api/auth/instance`, { headers: { cookie: cookieHeader(jar) } })).json()
  assert.equal(ready.ready, true, 'poll reports ready once the container serves')

  // ---- auth_request 必须给出实例名，nginx 才能选上游 ----
  const verify = await fetch(`${base}/__dsh_auth/verify`, { headers: { cookie: cookieHeader(jar) } })
  assert.equal(verify.status, 204)
  assert.equal(verify.headers.get('x-dsh-instance'), 'dsh-u1', 'verify names the per-user instance')
  assert.equal(verify.headers.get('x-dsh-role'), 'user')

  // ---- root 走管理员工作台，不经过编排服务 ----
  const rootLogin = await post(`${base}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
  assert.equal(rootLogin.status, 200)
  assert.equal((await rootLogin.json()).instance, 'dsh-admin', 'root is bound to the admin workspace')
  const rootJar = cookiesFrom(rootLogin)
  const rootVerify = await fetch(`${base}/__dsh_auth/verify`, { headers: { cookie: cookieHeader(rootJar) } })
  assert.equal(rootVerify.headers.get('x-dsh-instance'), 'dsh-admin')
  assert.equal(rootVerify.headers.get('x-dsh-role'), 'root')

  // ---- 编排服务不可达：不得谎报就绪，也不得阻断登录 ----
  instancesMode = 'unreachable'
  const stillLogsIn = await post(`${base}/api/auth/login`, { username: 'alice', password: 'alice-pass-1234' })
  assert.equal(stillLogsIn.status, 200, 'auth still works when the orchestrator is down')
  assert.equal((await stillLogsIn.json()).ready, false, 'an unreachable orchestrator is never reported as ready')

  // ---- 邀请码门槛：错码拒绝、对码通过且用掉即作废 ----
  const invitePort = await freePort()
  const inviteState = path.join(sandbox, 'invite')
  const invite = spawn(process.execPath, [path.join(root, 'bin', 'dsh-auth.mjs')], {
    env: {
      ...process.env,
      DSH_AUTH_LISTEN: `127.0.0.1:${invitePort}`,
      DSH_AUTH_STATE: path.join(inviteState, 'state.json'),
      DSH_AUTH_TOTP_KEY: path.join(inviteState, 'totp.key'),
      DSH_AUTH_WEB_DIR: path.join(root, 'bin', 'dsh-auth-web'),
      DSH_AUTH_INITIAL_PASSWORD: ROOT_PASSWORD,
      DSH_MULTI_USER: 'on',
      DSH_REGISTER_GATE: 'invite',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  try {
    const inviteBase = `http://127.0.0.1:${invitePort}`
    await waitFor(`${inviteBase}/api/auth/status`, (r) => r.ok)
    const invitePost = (body) => fetch(`${inviteBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: inviteBase },
      body: JSON.stringify(body),
    })
    const codeFile = path.join(inviteState, 'invite-code')
    assert.ok(fs.existsSync(codeFile), 'bootstrap seeds an invite code when the gate is on')
    const code = fs.readFileSync(codeFile, 'utf8').trim()
    assert.ok(code.length >= 8, 'seeded invite code has enough entropy')
    assert.equal((await invitePost({ username: 'noCode', password: 'nocode-pass-123' })).status, 403, 'missing invite code rejected')
    assert.equal((await invitePost({ username: 'badCode', password: 'badcode-pass-12', inviteCode: 'WRONG-CODE' })).status, 403, 'wrong invite code rejected')
    const accepted = await invitePost({ username: 'invited', password: 'invited-pass-12', inviteCode: code })
    assert.equal(accepted.status, 201, `correct invite code accepted: ${stderr}`)
    const reuse = await invitePost({ username: 'second', password: 'second-pass-123', inviteCode: code })
    assert.equal(reuse.status, 403, 'invite code is single-use')
  } finally {
    invite.kill()
  }

  // ---- 管理面：仅 root 可达，且带完整守卫 ----
  // 上一节把编排服务置为不可达，这里恢复，否则实例视图会因为编排故障而 502。
  instancesMode = 'ok'
  // 管理面板的页面与它的接口同一套权限：root 能拿到，普通用户被送回工作台（下面紧接着断言）
  const rootForPage = await post(`${base}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
  const rootPageJar = cookiesFrom(rootForPage)
  const adminPage = await fetch(`${base}/admin`, { headers: { cookie: cookieHeader(rootPageJar) } })
  assert.equal(adminPage.status, 200, '/admin serves the panel page to root')
  const adminHtml = await adminPage.text()
  for (const id of ['users-body', 'audit-body', 'instances-body']) {
    assert.ok(adminHtml.includes(`id="${id}"`), `admin page has ${id}`)
  }
  assert.ok(adminHtml.includes('dsh_auth_csrf'), 'admin page reads the double-submit CSRF cookie')
  // 模型开放用卡片式开关（.pick + aria-pressed）而不是裸 checkbox；第三列是竖排的
  // 全选/取消全选/保存三个按钮。这几条钉住的是「界面的结构契约」：批量操作与提交必须
  // 在同一列，卡片状态必须用 aria-pressed 表达（读屏与视觉一致）。
  assert.ok(adminHtml.includes("'admin.models.selectAll'"), 'the model-access column offers select-all')
  assert.ok(adminHtml.includes("'admin.models.selectNone'"), 'the model-access column offers clear-all')
  assert.ok(adminHtml.includes('className = \'pick\''), 'model upstreams render as clickable cards')
  assert.ok(adminHtml.includes('setAttribute(\'aria-pressed\''), 'card state is exposed through aria-pressed')
  assert.ok(adminHtml.includes('className = \'column-actions\''), 'the action buttons stack in their own column')

  // 普通用户访问管理接口必须 403
  const userJar = cookiesFrom(login)

  // 页面本身也要挡住：否则普通用户会拿到一个每个请求都失败的界面外壳
  const userAdminPage = await fetch(`${base}/admin`, { redirect: 'manual', headers: { cookie: cookieHeader(userJar) } })
  assert.equal(userAdminPage.status, 302, 'a plain user is redirected away from the admin page')
  assert.equal(userAdminPage.headers.get('location'), '/', 'the redirect sends them back to the workspace entry')
  // 而未登录者同样拿不到
  assert.equal((await fetch(`${base}/admin`, { redirect: 'manual' })).status, 302, 'an anonymous request is redirected too')

  const userAdmin = await fetch(`${base}/api/admin/users`, { headers: { cookie: cookieHeader(userJar) } })
  assert.equal(userAdmin.status, 403, 'plain users cannot read the admin API')
  const userWrite = await fetch(`${base}/api/admin/users/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: cookieHeader(userJar), 'x-csrf-token': loginBody.csrfToken },
    body: JSON.stringify({ username: 'alice', status: 'disabled' }),
  })
  assert.equal(userWrite.status, 403, 'plain users cannot use the admin API')

  // root 登录
  const rootLoginAdmin = await post(`${base}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
  const adminJar = cookiesFrom(rootLoginAdmin)
  const adminBody = await rootLoginAdmin.json()
  const adminHeaders = { origin: base, cookie: cookieHeader(adminJar), 'x-csrf-token': adminBody.csrfToken }
  const adminWrite = (path, payload) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...adminHeaders }, body: JSON.stringify(payload),
  })

  const list = await fetch(`${base}/api/admin/users`, { headers: { cookie: cookieHeader(adminJar) } })
  assert.equal(list.status, 200, 'root can read the admin API')
  const listBody = await list.json()
  assert.ok(listBody.users.length >= 3, 'registered accounts are listed')
  const alice = listBody.users.find((u) => u.username === 'alice')
  assert.equal(alice.role, 'user')
  assert.equal(alice.status, 'enabled')
  assert.equal(alice.instance, 'dsh-u1', 'admin view maps the account to its instance')
  assert.ok(Number.isInteger(alice.uid), 'admin view exposes the allocated uid')
  assert.ok(!JSON.stringify(listBody).includes('passwordHash'), 'admin API never exposes password material')

  // 不能停用自己
  const selfDisable = await adminWrite('/api/admin/users/status', { username: 'root', status: 'disabled' })
  assert.equal(selfDisable.status, 409, 'an administrator cannot disable their own account')
  assert.equal((await selfDisable.json()).code, 'cannot_modify_self')

  // 停用他人：会话立即失效
  const disable = await adminWrite('/api/admin/users/status', { username: 'alice', status: 'disabled' })
  assert.equal(disable.status, 200, `disabling a user works: ${stderr}`)
  assert.equal((await disable.json()).user.status, 'disabled')
  assert.equal((await fetch(`${base}/__dsh_auth/verify`, { headers: { cookie: cookieHeader(userJar) } })).status, 401, 'disabling an account revokes its sessions')
  assert.equal((await post(`${base}/api/auth/login`, { username: 'alice', password: 'alice-pass-1234' })).status, 401, 'a disabled account cannot sign in')

  // 重新启用后可登录
  assert.equal((await adminWrite('/api/admin/users/status', { username: 'alice', status: 'enabled' })).status, 200)
  assert.equal((await post(`${base}/api/auth/login`, { username: 'alice', password: 'alice-pass-1234' })).status, 200, 're-enabled account can sign in')

  // 重置密码：返回一次性新口令，旧口令失效
  const reset = await adminWrite('/api/admin/users/password', { username: 'alice' })
  assert.equal(reset.status, 200, 'password reset works')
  const resetBody = await reset.json()
  assert.equal(resetBody.generated, true, 'a random password is generated when none is supplied')
  assert.ok(typeof resetBody.password === 'string' && resetBody.password.length >= 12, 'generated password meets the length rule')
  assert.equal((await post(`${base}/api/auth/login`, { username: 'alice', password: 'alice-pass-1234' })).status, 401, 'the old password stops working')
  assert.equal((await post(`${base}/api/auth/login`, { username: 'alice', password: resetBody.password })).status, 200, 'the new password works')

  // 管理员不能重置自己的口令（避免把自己锁在外面）
  assert.equal((await adminWrite('/api/admin/users/password', { username: 'root' })).status, 409, 'an administrator cannot reset their own password from the panel')

  // 审计：管理动作必须留痕
  const audit = await (await fetch(`${base}/api/admin/audit?limit=200`, { headers: { cookie: cookieHeader(adminJar) } })).json()
  const actions = audit.entries.map((entry) => entry.action)
  for (const expected of ['admin.user.status', 'admin.user.password', 'register', 'login']) {
    assert.ok(actions.includes(expected), `audit records ${expected}`)
  }
  assert.ok(!JSON.stringify(audit.entries).includes(resetBody.password), 'audit must never contain a generated password')

  // 删除账户
  const remove = await adminWrite('/api/admin/users/delete', { username: 'carol', purge: true })
  assert.equal(remove.status, 200, 'deleting a user works')
  const afterDelete = await (await fetch(`${base}/api/admin/users`, { headers: { cookie: cookieHeader(adminJar) } })).json()
  assert.ok(!afterDelete.users.some((u) => u.username === 'carol'), 'the deleted account is gone')

  // 实例视图透传编排服务的数据
  const instances = await fetch(`${base}/api/admin/instances`, { headers: { cookie: cookieHeader(adminJar) } })
  assert.equal(instances.status, 200, 'instance overview is available to root')

  // 运行时设置与固化都要经网关转发，并且必须是管理员 + CSRF。
  // 注意 userJar 的会话在「管理员重置口令」时已被 authVersion 级联作废（那正是该级联
  // 要保证的事），所以普通用户请求会以 401 被拒；401/403 都是拒绝，断言只要求非成功。
  // 未带 CSRF 的管理员请求必须 403，那一条不受会话状态影响。
  const settingsNoCsrf = await fetch(`${base}/api/admin/instances/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: cookieHeader(adminJar) },
    body: JSON.stringify({ idleTimeoutSeconds: 900 }),
  })
  assert.equal(settingsNoCsrf.status, 403, 'changing runtime settings requires CSRF')

  const settingsByUser = await fetch(`${base}/api/admin/instances/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: cookieHeader(userJar), 'x-csrf-token': loginBody.csrfToken },
    body: JSON.stringify({ idleTimeoutSeconds: 900 }),
  })
  assert.ok(
    [401, 403].includes(settingsByUser.status),
    `a normal user may not change runtime settings (got ${settingsByUser.status})`,
  )

  const pinByUser = await fetch(`${base}/api/admin/instances/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: cookieHeader(userJar), 'x-csrf-token': loginBody.csrfToken },
    body: JSON.stringify({ uid: 100000, pinned: true }),
  })
  assert.ok(
    [401, 403].includes(pinByUser.status),
    `a normal user may not pin instances (got ${pinByUser.status})`,
  )

  // ---- 单用户模式：注册端点必须不存在 ----
  const singlePort = await freePort()
  const single = spawn(process.execPath, [path.join(root, 'bin', 'dsh-auth.mjs')], {
    env: {
      ...process.env,
      DSH_AUTH_LISTEN: `127.0.0.1:${singlePort}`,
      DSH_AUTH_STATE: path.join(sandbox, 'single', 'state.json'),
      DSH_AUTH_TOTP_KEY: path.join(sandbox, 'single', 'totp.key'),
      DSH_AUTH_WEB_DIR: path.join(root, 'bin', 'dsh-auth-web'),
      DSH_AUTH_INITIAL_PASSWORD: ROOT_PASSWORD,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  try {
    await waitFor(`http://127.0.0.1:${singlePort}/api/auth/status`, (r) => r.ok)
    const singleRegister = await fetch(`http://127.0.0.1:${singlePort}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${singlePort}` },
      body: JSON.stringify({ username: 'someone', password: 'someone-pass-1' }),
    })
    assert.equal(singleRegister.status, 404, 'registration is absent in single-admin mode')
    // 管理面在单管理员模式下不存在：页面与接口一起 404，而不是给一个空壳
    const singleAdmin = await fetch(`http://127.0.0.1:${singlePort}/admin`, { redirect: 'manual' })
    assert.equal(singleAdmin.status, 404, 'the admin page does not exist in single-admin mode')
    // ---- 恢复码：开启两步验证时必须交付，且验证器丢失后真的能用 ----
    // 这是「开了两步验证又丢验证器」的唯一退路，所以既要交付，也要能登录、只能用一次、可轮换。
    // 这里用单管理员实例的 root 账户：不依赖注册配额，同时覆盖「单用户模式同样可用」。
    {
      const singleBase = `http://127.0.0.1:${singlePort}`
      const singlePost = (url, body, jar) => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: singleBase, ...(jar ? { cookie: cookieHeader(jar) } : {}) },
        body: JSON.stringify(body),
      })
      const withCsrf = (jar, extra = {}) => ({ 'content-type': 'application/json', origin: singleBase, cookie: cookieHeader(jar), 'x-csrf-token': jar.dsh_auth_csrf, ...extra })

      const login = await singlePost(`${singleBase}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
      assert.equal(login.status, 200, 'root signs in on the single-admin instance')
      const jar = cookiesFrom(login)

      const setup = await fetch(`${singleBase}/api/auth/totp/setup`, {
        method: 'POST',
        headers: withCsrf(jar),
        body: JSON.stringify({ currentPassword: ROOT_PASSWORD }),
      })
      const enrollment = await setup.json()
      assert.equal(setup.status, 200, 'TOTP enrollment starts')
      assert.ok(enrollment.otpauthQrDataUri?.startsWith('data:image/svg+xml;base64,'), 'enrollment hands back a scannable QR code')

      const confirm = await fetch(`${singleBase}/api/auth/totp/confirm`, {
        method: 'POST',
        headers: withCsrf(jar),
        body: JSON.stringify({ challenge: enrollment.challenge, code: totpCodeAtStep(enrollment.secret, Math.floor(Date.now() / 1000 / 30)) }),
      })
      const armed = await confirm.json()
      assert.equal(confirm.status, 200, 'the code is accepted')
      // 交付：这一步不给出恢复码，用户就再也没有退路
      assert.equal(armed.recoveryCodes.length, RECOVERY.count, 'confirming hands over the recovery codes')
      for (const code of armed.recoveryCodes) assert.ok(looksLikeRecoveryCode(code), `${code} has the documented shape`)
      assert.equal(armed.pending, true, 'the code only arms the enrolment')

      // 关键安全性质：还没点「完成」时两步验证**没有**生效。
      // 否则没保存恢复码的人会在不知不觉中被保护起来，验证器一丢就永久进不去。
      const beforeActivate = await singlePost(`${singleBase}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
      assert.equal(beforeActivate.status, 200, 'sign-in still succeeds')
      assert.equal(Boolean((await beforeActivate.clone().json()).secondFactor), false, 'two-step verification must not be active before Done')

      const activated = await fetch(`${singleBase}/api/auth/totp/activate`, { method: 'POST', headers: withCsrf(jar), body: '{}' })
      assert.equal(activated.status, 200, 'Done activates two-step verification')

      const afterActivate = await singlePost(`${singleBase}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
      assert.equal(Boolean((await afterActivate.json()).secondFactor), true, 'a second factor is demanded once activated')

      const activatedSession = await (await fetch(`${singleBase}/api/auth/session`, { headers: { cookie: cookieHeader(jar) } })).json()
      assert.equal(activatedSession.user.totpEnabled, true, 'the account reports two-step verification as enabled')

      // 验证器丢失：只用密码 + 一个恢复码登录
      const second = await singlePost(`${singleBase}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
      const challenge = (await second.json()).secondFactor
      assert.ok(challenge, 'a second factor is demanded after the password')
      const recovered = await singlePost(`${singleBase}/api/auth/login/totp`, { challenge: challenge.challenge, code: armed.recoveryCodes[0] })
      assert.equal(recovered.status, 200, 'a recovery code signs the user in when the authenticator is gone')
      const recoveredJar = cookiesFrom(recovered)

      const session = await (await fetch(`${singleBase}/api/auth/session`, { headers: { cookie: cookieHeader(recoveredJar) } })).json()
      assert.equal(session.user.recoveryCodesLeft, RECOVERY.count - 1, 'a used recovery code is consumed')

      // 用过的码不能重放
      const third = await singlePost(`${singleBase}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
      const replay = await singlePost(`${singleBase}/api/auth/login/totp`, {
        challenge: (await third.json()).secondFactor.challenge,
        code: armed.recoveryCodes[0],
      })
      assert.equal(replay.status, 401, 'a consumed recovery code cannot be replayed')

      // 轮换必须有有效第二因素
      const noFactor = await fetch(`${singleBase}/api/auth/totp/recovery/regenerate`, {
        method: 'POST',
        headers: withCsrf(recoveredJar),
        body: JSON.stringify({ currentPassword: ROOT_PASSWORD, code: '000000' }),
      })
      assert.equal(noFactor.status, 401, 'rotation refuses without a valid second factor')
      const wrongPassword = await fetch(`${singleBase}/api/auth/totp/recovery/regenerate`, {
        method: 'POST',
        headers: withCsrf(recoveredJar),
        body: JSON.stringify({ currentPassword: 'not-the-password-1', code: armed.recoveryCodes[1] }),
      })
      assert.equal(wrongPassword.status, 401, 'rotation refuses without the current password')

      const rotated = await fetch(`${singleBase}/api/auth/totp/recovery/regenerate`, {
        method: 'POST',
        headers: withCsrf(recoveredJar),
        body: JSON.stringify({ currentPassword: ROOT_PASSWORD, code: armed.recoveryCodes[1] }),
      })
      const next = await rotated.json()
      assert.equal(rotated.status, 200, 'the codes can be rotated in place')
      assert.equal(next.recoveryCodes.length, RECOVERY.count, 'rotation hands over a fresh set')

      // 轮换必须保住执行者自己的会话。authVersion 是「让全部会话失效」的级联开关，
      // 早先这里误加了 +1，用户点完「重新生成恢复码」就被弹回登录页。
      const stillValid = await fetch(`${singleBase}/api/auth/session`, { headers: { cookie: cookieHeader(recoveredJar) } })
      assert.equal(stillValid.status, 200, 'rotating recovery codes must not sign the operator out')

      // 轮换后旧码全部失效，新码可用
      const fourth = await singlePost(`${singleBase}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
      const stale = await singlePost(`${singleBase}/api/auth/login/totp`, {
        challenge: (await fourth.json()).secondFactor.challenge,
        code: armed.recoveryCodes[2],
      })
      assert.equal(stale.status, 401, 'codes from before the rotation stop working')

      const fifth = await singlePost(`${singleBase}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
      const fresh = await singlePost(`${singleBase}/api/auth/login/totp`, {
        challenge: (await fifth.json()).secondFactor.challenge,
        code: next.recoveryCodes[0],
      })
      assert.equal(fresh.status, 200, 'a freshly rotated code works')
    }

  } finally {
    single.kill()
  }

  console.log('dsh-auth multiuser smoke: ok')
} finally {
  child.kill()
  instancesServer.close()
  fs.rmSync(sandbox, { recursive: true, force: true })
}
