// dsh-auth 集成冒烟：真实启动 HTTP 服务，走完整登录/会话/CSRF/auth_request 流程。
// 对应 docs/auth-design.md §8 的集成层：T1 限速锁定、T2 防枚举、T4 CSRF、
// T3 会话失效（auth_version 级联）、auth_request 放行/拒绝。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { totpCodeAtStep, TOTP } from '../bin/dsh-auth-policy.mjs'
import { makeAuthenticator } from './helpers/synthetic-authenticator.mjs'

/** passkey 的固定公开 origin（与服务的 DSH_AUTH_PUBLIC_ORIGIN 一致）。 */
const PASSKEY_ORIGIN = 'https://dsh.example.com'
const PASSKEY_RPID = 'dsh.example.com'
/** 模拟 nginx 终止 TLS：passkey 相关请求都要带这个头。 */
const PROXY_HEADERS = { 'x-forwarded-proto': 'https' }

/** 用被测实现生成「当前」TOTP 码（服务端也按同一时刻判定，允许 ±1 步漂移）。 */
const totpCodeNow = (secret) => totpCodeAtStep(secret, Math.floor(Date.now() / 1000 / TOTP.periodSeconds))

/**
 * 等到下一个 TOTP 时间步。开通确认已经消费了当前步，防重放规则会拒绝同一窗口内的码——
 * 这是设计要的行为，所以测试必须跨步，而不是放宽服务端校验。
 */
async function waitForNextStep() {
  const period = TOTP.periodSeconds * 1000
  await new Promise((resolve) => setTimeout(resolve, period - (Date.now() % period) + 300))
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-it-'))

const ROOT_PASSWORD = 'integration-root-42'

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

async function waitForReady(port, child) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error('server did not become ready')
}

function cookiesFrom(response) {
  const raw = response.headers.getSetCookie?.() ?? []
  const jar = {}
  for (const entry of raw) {
    const [pair] = entry.split(';')
    const index = pair.indexOf('=')
    if (index > 0) jar[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim())
  }
  return jar
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
}

const port = await freePort()
const child = spawn(process.execPath, [path.join(root, 'bin', 'dsh-auth.mjs')], {
  env: {
    ...process.env,
    DSH_AUTH_LISTEN: `127.0.0.1:${port}`,
    DSH_AUTH_STATE: path.join(sandbox, 'auth', 'state.json'),
    DSH_AUTH_TOTP_KEY: path.join(sandbox, 'auth', 'totp.key'),
    DSH_AUTH_WEB_DIR: path.join(root, 'bin', 'dsh-auth-web'),
    DSH_AUTH_INITIAL_PASSWORD: ROOT_PASSWORD,
    DSH_AUTH_MAX_LOGIN_FAILURES: '5',
    DSH_AUTH_LOGIN_WINDOW_SECONDS: '900',
    // passkey 需要一个固定 HTTPS 公开地址；测试通过 x-forwarded-proto 模拟 nginx 终止 TLS
    DSH_AUTH_PUBLIC_ORIGIN: PASSKEY_ORIGIN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverStderr = ''
child.stderr.on('data', (chunk) => { serverStderr += chunk.toString() })

const base = `http://127.0.0.1:${port}`
const jsonPost = (url, body, jar = {}, extra = {}) => fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: base,
    ...(Object.keys(jar).length ? { cookie: cookieHeader(jar) } : {}),
    ...extra,
  },
  body: JSON.stringify(body),
  redirect: 'manual',
})

try {
  await waitForReady(port, child)

  // ---- status：未初始化状态已置位，单管理员模式不开注册 ----
  const status = await (await fetch(`${base}/api/auth/status`)).json()
  assert.equal(status.ok, true)
  assert.equal(status.initialized, true, 'bootstrap must run on first start')
  assert.equal(status.multiUser, false, 'single-admin mode by default')
  assert.equal(status.adminPanel, false, 'single-administrator mode has no admin panel to show')
  assert.equal(status.workspace, false, 'no workspace is declared unless the deployment says so')

  // ---- 静态登录页可访问且不含任何密钥 ----
  const page = await fetch(`${base}/login`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.ok(html.includes('DeepSeek'), 'login page must render')
  assert.ok(!html.includes(ROOT_PASSWORD), 'page must never embed credentials')

  // ---- 回归：`/` 不得返回登录页，否则与登录页的自动跳转互为终点 → 无限重定向（页面狂闪）----
  const rootResponse = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(rootResponse.status, 302, 'root must redirect, not serve the login page')
  assert.equal(rootResponse.headers.get('location'), '/login', 'root must redirect to /login')
  assert.ok(
    !/window\.location\.replace\(\s*['"]\/['"]\s*\)/.test(html),
    'login page must never auto-redirect to `/` (redirect-loop guard)',
  )
  assert.ok(html.includes('step-signedin'), 'login page must offer a signed-in state instead of looping')
  assert.ok(
    /\$\('go-workspace'\)\.addEventListener\('click'/.test(html),
    'workspace entry is user-initiated, not an automatic redirect',
  )
  assert.ok(
    /window\.location\.assign\(event\.currentTarget\.dataset\.target \|\| redirectTarget\(\) \|\| '\/'\)/.test(html),
    'the entry button goes to the requested target, falling back to the root',
  )

  // 自动跳转必须限次：否则入口侧判成未登录、网关侧判成已登录时会无限闪烁
  assert.ok(html.includes("const REDIRECT_MARK = 'dsh-login-redirect-at'"), 'the automatic redirect is rate-limited')
  assert.ok(
    /if \(target && !justBounced\(\)\)/.test(html),
    'the page stops auto-redirecting when it was just bounced back',
  )

  // ---- 路由裁剪：单管理员模式下注册/管理面必须 404 ----
  assert.equal((await fetch(`${base}/api/auth/register`)).status, 404, 'register pruned in single-admin mode')
  assert.equal((await fetch(`${base}/api/admin/users`)).status, 404, 'admin surface pruned')

  // ---- auth_request：未登录必须 401 ----
  assert.equal((await fetch(`${base}/__dsh_auth/verify`)).status, 401, 'anonymous verify must be 401')

  // ---- 错误凭据：统一 401，不泄露账户是否存在（T2）----
  const wrongUser = await jsonPost(`${base}/api/auth/login`, { username: 'nobody', password: 'whatever-1234' })
  assert.equal(wrongUser.status, 401)
  assert.equal((await wrongUser.json()).code, 'invalid_credentials')
  const wrongPass = await jsonPost(`${base}/api/auth/login`, { username: 'root', password: 'wrong-password-1' })
  assert.equal(wrongPass.status, 401)
  assert.equal((await wrongPass.json()).code, 'invalid_credentials', 'same code for unknown user and wrong password')

  // ---- 正确凭据：签发会话 + CSRF ----
  const login = await jsonPost(`${base}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
  assert.equal(login.status, 200, `login must succeed: ${serverStderr}`)
  const loginBody = await login.json()
  assert.equal(loginBody.ok, true)
  assert.equal(loginBody.user.role, 'root')
  assert.ok(loginBody.csrfToken && loginBody.csrfToken.length >= 32, 'csrf token issued')
  const jar = cookiesFrom(login)
  assert.ok(jar.dsh_auth_session, 'session cookie issued')

  // 会话不应以明文形式出现在响应体里
  assert.ok(!JSON.stringify(loginBody).includes(jar.dsh_auth_session), 'raw session token must not be echoed')

  // ---- auth_request：带会话放行并带身份头 ----
  const verify = await fetch(`${base}/__dsh_auth/verify`, { headers: { cookie: cookieHeader(jar) } })
  assert.equal(verify.status, 204, 'authenticated verify must be 204')
  assert.equal(verify.headers.get('x-dsh-user'), 'root')
  assert.equal(verify.headers.get('x-dsh-role'), 'root')

  // ---- session 端点 ----
  const session = await fetch(`${base}/api/auth/session`, { headers: { cookie: cookieHeader(jar) } })
  assert.equal(session.status, 200)
  assert.equal((await session.json()).user.username, 'root')

  // ---- CSRF：缺令牌必须 403（T4）----
  const noCsrf = await jsonPost(`${base}/api/auth/password`, { currentPassword: ROOT_PASSWORD, newPassword: 'brand-new-pass-9' }, jar)
  assert.equal(noCsrf.status, 403, 'write without csrf token must be rejected')
  assert.equal((await noCsrf.json()).code, 'csrf_failed')

  // ---- CSRF：跨源必须 403 ----
  const crossOrigin = await jsonPost(`${base}/api/auth/password`, { currentPassword: ROOT_PASSWORD, newPassword: 'brand-new-pass-9' }, jar, {
    'x-csrf-token': loginBody.csrfToken,
    origin: 'https://evil.example.com',
  })
  assert.equal(crossOrigin.status, 403, 'cross-origin write must be rejected')

  // ---- 弱密码必须拒绝 ----
  const weak = await jsonPost(`${base}/api/auth/password`, { currentPassword: ROOT_PASSWORD, newPassword: 'alllettersonly' }, jar, { 'x-csrf-token': loginBody.csrfToken })
  assert.equal(weak.status, 400)
  assert.equal((await weak.json()).code, 'weak_password')

  // ---- 改密成功 → auth_version 级联使旧会话失效（T3）----
  const changed = await jsonPost(`${base}/api/auth/password`, { currentPassword: ROOT_PASSWORD, newPassword: 'rotated-pass-77' }, jar, { 'x-csrf-token': loginBody.csrfToken })
  assert.equal(changed.status, 200, 'password change must succeed')
  const staleVerify = await fetch(`${base}/__dsh_auth/verify`, { headers: { cookie: cookieHeader(jar) } })
  assert.equal(staleVerify.status, 401, 'old session must die after password change')

  // 旧密码失效、新密码可用
  assert.equal((await jsonPost(`${base}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })).status, 401, 'old password must stop working')
  const relogin = await jsonPost(`${base}/api/auth/login`, { username: 'root', password: 'rotated-pass-77' })
  assert.equal(relogin.status, 200, 'new password must work')
  const jar2 = cookiesFrom(relogin)
  const csrf2 = (await relogin.json()).csrfToken

  // ---- 登出后会话失效 ----
  const logout = await jsonPost(`${base}/api/auth/logout`, {}, jar2)
  assert.equal(logout.status, 200)
  assert.equal((await fetch(`${base}/__dsh_auth/verify`, { headers: { cookie: cookieHeader(jar2) } })).status, 401, 'logout must revoke session')

  // ---- 状态库：明文密码绝不落盘；审计已记录登录与改密 ----
  const stateRaw = fs.readFileSync(path.join(sandbox, 'auth', 'state.json'), 'utf8')
  assert.ok(!stateRaw.includes('rotated-pass-77'), 'plaintext password must never be persisted')
  assert.ok(!stateRaw.includes(ROOT_PASSWORD), 'initial password must never be persisted')
  assert.ok(stateRaw.includes('$argon2id$'), 'password must be stored as argon2id PHC string')
  const state = JSON.parse(stateRaw)
  const actions = state.audit.map((entry) => `${entry.action}:${entry.result}`)
  assert.ok(actions.includes('bootstrap.root:ok'), 'bootstrap audited')
  assert.ok(actions.includes('login:ok'), 'successful login audited')
  assert.ok(actions.includes('login:failure'), 'failed login audited')
  assert.ok(actions.includes('password.change:ok'), 'password change audited')
  assert.ok(!JSON.stringify(state.audit).includes('rotated-pass-77'), 'audit must never contain secrets')

  // ---- T1：连续失败达到阈值后锁定，且正确密码也被拒 ----
  const lockPort = await freePort()
  const lockSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-lock-'))
  const lockChild = spawn(process.execPath, [path.join(root, 'bin', 'dsh-auth.mjs')], {
    env: {
      ...process.env,
      DSH_AUTH_LISTEN: `127.0.0.1:${lockPort}`,
      DSH_AUTH_STATE: path.join(lockSandbox, 'state.json'),
      DSH_AUTH_TOTP_KEY: path.join(lockSandbox, 'totp.key'),
      DSH_AUTH_WEB_DIR: path.join(root, 'bin', 'dsh-auth-web'),
      DSH_AUTH_INITIAL_PASSWORD: ROOT_PASSWORD,
      DSH_AUTH_MAX_LOGIN_FAILURES: '3',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let lockStderr = ''
  lockChild.stderr.on('data', (chunk) => { lockStderr += chunk.toString() })
  try {
    await waitForReady(lockPort, lockChild)
    const lockBase = `http://127.0.0.1:${lockPort}`
    const post = (body) => fetch(`${lockBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: lockBase },
      body: JSON.stringify(body),
    })
    for (let i = 0; i < 3; i++) assert.equal((await post({ username: 'root', password: `bad-${i}-password` })).status, 401)
    const blocked = await post({ username: 'root', password: ROOT_PASSWORD })
    assert.equal(blocked.status, 429, `must lock out after threshold: ${lockStderr}`)
    const blockedBody = await blocked.json()
    assert.equal(blockedBody.code, 'rate_limited')
    assert.ok(blockedBody.retryAfter > 0, 'retry-after must be reported')
  } finally {
    lockChild.kill()
    fs.rmSync(lockSandbox, { recursive: true, force: true })
  }

  // ---- TOTP 全生命周期（M2）----
  const totpAuth = (path, body, jar, csrf) => jsonPost(`${base}${path}`, body, jar, csrf ? { 'x-csrf-token': csrf } : {})
  // 用改密后的新会话重新登录，拿到可用的 jar/csrf
  const login3 = await jsonPost(`${base}/api/auth/login`, { username: 'root', password: 'rotated-pass-77' })
  assert.equal(login3.status, 200, 're-login for TOTP setup')
  const jar3 = cookiesFrom(login3)
  const csrf3 = (await login3.json()).csrfToken

  // 未登录 / 缺 CSRF 时不得签发密钥（带 Origin 以越过同源检查，真正检验会话判定）
  assert.equal((await jsonPost(`${base}/api/auth/totp/setup`, { currentPassword: 'rotated-pass-77' })).status, 401, 'totp setup requires session')
  const setupNoCsrf = await totpAuth('/api/auth/totp/setup', { currentPassword: 'rotated-pass-77' }, jar3)
  assert.equal(setupNoCsrf.status, 403, 'totp setup requires csrf')

  // 密码错误不得签发密钥
  const setupWrongPw = await totpAuth('/api/auth/totp/setup', { currentPassword: 'nope-12345678' }, jar3, csrf3)
  assert.equal(setupWrongPw.status, 401, 'totp setup verifies current password')

  // 正常开通第一步
  const setup = await totpAuth('/api/auth/totp/setup', { currentPassword: 'rotated-pass-77' }, jar3, csrf3)
  assert.equal(setup.status, 200, 'totp setup succeeds')
  const setupBody = await setup.json()
  assert.match(setupBody.secret, /^[A-Z2-7]{32}$/, 'secret is 32 base32 chars (20 bytes)')
  assert.match(setupBody.otpauthUri, /^otpauth:\/\/totp\/DSH%3Aroot\?/, 'otpauth uri issued')

  // 错误的确认码不得启用
  const badConfirm = await totpAuth('/api/auth/totp/confirm', { challenge: setupBody.challenge, code: '000000' }, jar3, csrf3)
  assert.equal(badConfirm.status, 401, 'wrong code must not enable TOTP')

  // 挑战是一次性的：上一步已消费，重放必须失败（T7 类重放语义）
  const replayConfirm = await totpAuth('/api/auth/totp/confirm', { challenge: setupBody.challenge, code: '000000' }, jar3, csrf3)
  assert.equal(replayConfirm.status, 401, 'consumed challenge must not be reusable')

  // 重新签发并用正确码启用
  const setup2 = await totpAuth('/api/auth/totp/setup', { currentPassword: 'rotated-pass-77' }, jar3, csrf3)
  const setup2Body = await setup2.json()
  const validCode = totpCodeNow(setup2Body.secret)
  const confirm = await totpAuth('/api/auth/totp/confirm', { challenge: setup2Body.challenge, code: validCode }, jar3, csrf3)
  assert.equal(confirm.status, 200, `totp confirm must succeed: ${serverStderr}`)
  const confirmBody = await confirm.json()
  assert.equal(confirmBody.recoveryCodes.length, 10, 'ten recovery codes issued once')
  assert.equal(confirmBody.pending, true, 'confirming only arms the enrolment')

  // 两阶段登记的关键安全性质：还没点「完成」时两步验证**没有**生效。
  // 否则没保存恢复码的人会在不知不觉中被保护起来，验证器一丢就永久进不去。
  const beforeDone = await jsonPost(`${base}/api/auth/login`, { username: 'root', password: 'rotated-pass-77' })
  assert.equal(beforeDone.status, 200, 'password sign-in still works before Done')
  assert.equal(Boolean((await beforeDone.json()).secondFactor), false, 'two-step verification must not be active before Done')

  // 界面上「完成」被勾选确认所约束；这里是它对应的接口
  const activate = await totpAuth('/api/auth/totp/activate', {}, jar3, csrf3)
  assert.equal(activate.status, 200, `activation must succeed: ${serverStderr}`)
  assert.equal((await totpAuth('/api/auth/totp/activate', {}, jar3, csrf3)).status, 409, 'activating twice is rejected')

  // 启用后：密码正确但无第二因子时不再直接建会话
  const needSecond = await jsonPost(`${base}/api/auth/login`, { username: 'root', password: 'rotated-pass-77' })
  assert.equal(needSecond.status, 200, 'first factor accepted')
  const needSecondBody = await needSecond.json()
  assert.ok(needSecondBody.secondFactor?.challenge, 'challenge issued instead of session')
  assert.ok(!needSecondBody.csrfToken, 'no session/csrf before second factor')

  // 第二因子错误 → 401；挑战已被消费
  const badSecond = await jsonPost(`${base}/api/auth/login/totp`, { challenge: needSecondBody.secondFactor.challenge, code: '000000' })
  assert.equal(badSecond.status, 401, 'wrong second factor rejected')

  // 用 TOTP 码完成登录（跨到下一时间步，避开开通时已消费的那一步）
  await waitForNextStep()
  const challenge2 = (await (await jsonPost(`${base}/api/auth/login`, { username: 'root', password: 'rotated-pass-77' })).json()).secondFactor.challenge
  const finish = await jsonPost(`${base}/api/auth/login/totp`, { challenge: challenge2, code: totpCodeNow(setup2Body.secret) })
  assert.equal(finish.status, 200, `second factor completes login: ${serverStderr}`)
  const jarTotp = cookiesFrom(finish)
  assert.equal((await fetch(`${base}/__dsh_auth/verify`, { headers: { cookie: cookieHeader(jarTotp) } })).status, 204, 'totp login yields a working session')

  // 恢复码也能登录（且消费即焚：第二次同码必须失败）
  const rc = confirmBody.recoveryCodes[0]
  const challenge3 = (await (await jsonPost(`${base}/api/auth/login`, { username: 'root', password: 'rotated-pass-77' })).json()).secondFactor.challenge
  const recoveryLogin = await jsonPost(`${base}/api/auth/login/totp`, { challenge: challenge3, code: rc })
  assert.equal(recoveryLogin.status, 200, 'recovery code logs in')
  const challenge4 = (await (await jsonPost(`${base}/api/auth/login`, { username: 'root', password: 'rotated-pass-77' })).json()).secondFactor.challenge
  const reuseRecovery = await jsonPost(`${base}/api/auth/login/totp`, { challenge: challenge4, code: rc })
  assert.equal(reuseRecovery.status, 401, 'recovery code is single-use')

  // 状态库里：TOTP 密钥必须是密文，恢复码只存哈希
  const totpState = JSON.parse(fs.readFileSync(path.join(sandbox, 'auth', 'state.json'), 'utf8'))
  const rootUser = totpState.users.find((u) => u.username === 'root')
  assert.ok(rootUser.totp.enabled, 'totp recorded as enabled')
  assert.equal(rootUser.totpPending, undefined, 'the pending enrolment is cleared once activated')
  assert.ok(!rootUser.totp.secret.includes(setup2Body.secret), 'sealed secret must not contain plaintext')
  assert.equal(rootUser.totp.recoveryHashes.length, 9, 'one recovery code consumed')
  assert.ok(!JSON.stringify(rootUser.totp.recoveryHashes).includes(rc), 'recovery codes stored as hashes only')

  // 关闭 TOTP：需密码 + 验证码，成功后撤销全部会话。
  // 这里全程用恢复码作为第二因子：TOTP 当前时间步可能已被前面的登录消费，恢复码是
  // 确定性的；顺带覆盖「恢复码可用于关闭安全设置」这条路径。
  const challenge5 = (await (await jsonPost(`${base}/api/auth/login`, { username: 'root', password: 'rotated-pass-77' })).json()).secondFactor.challenge
  const finish5 = await jsonPost(`${base}/api/auth/login/totp`, { challenge: challenge5, code: confirmBody.recoveryCodes[2] })
  assert.equal(finish5.status, 200, `recovery-code login must succeed: ${serverStderr}`)
  const csrf5 = (await finish5.json()).csrfToken
  const jar5 = cookiesFrom(finish5)
  assert.ok(jar5.dsh_auth_session, 'session established for disable')

  // 密码错误时不得关闭
  const disableWrongPw = await totpAuth('/api/auth/totp/disable', { currentPassword: 'nope-12345678', code: confirmBody.recoveryCodes[3] }, jar5, csrf5)
  assert.equal(disableWrongPw.status, 401, 'disable verifies current password')

  const disable = await totpAuth('/api/auth/totp/disable', { currentPassword: 'rotated-pass-77', code: confirmBody.recoveryCodes[3] }, jar5, csrf5)
  assert.equal(disable.status, 200, `totp disable must succeed: ${serverStderr}`)
  assert.equal((await fetch(`${base}/__dsh_auth/verify`, { headers: { cookie: cookieHeader(jar5) } })).status, 401, 'disabling TOTP revokes sessions')
  const afterDisable = await jsonPost(`${base}/api/auth/login`, { username: 'root', password: 'rotated-pass-77' })
  assert.equal(afterDisable.status, 200)
  assert.ok(!(await afterDisable.json()).secondFactor, 'password alone works again after disable')

  // ---- Passkey 全流程（KPanel 同构：库负责密码学，我们只写策略）----
  const passkeyStatus = await (await fetch(`${base}/api/auth/status`, { headers: PROXY_HEADERS })).json()
  assert.equal(passkeyStatus.passkeyAvailable, true, 'passkey available when a public https origin is configured')
  const noOriginStatus = await (await fetch(`${base}/api/auth/status`)).json()
  assert.equal(noOriginStatus.passkeyAvailable, false, 'passkey unavailable on a plain-http request')

  // 重新登录取得会话与 CSRF
  const pkLogin = await jsonPost(`${base}/api/auth/login`, { username: 'root', password: 'rotated-pass-77' })
  assert.equal(pkLogin.status, 200, 'password login works after TOTP was disabled')
  const pkJar = cookiesFrom(pkLogin)
  const pkCsrf = (await pkLogin.json()).csrfToken
  const pk = (path, body, extra = {}) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: cookieHeader(pkJar), 'x-csrf-token': pkCsrf, ...PROXY_HEADERS, ...extra },
    body: JSON.stringify(body),
  })

  // 未登录不得签发注册选项
  const anonBegin = await fetch(`${base}/api/auth/passkey/register/begin`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...PROXY_HEADERS }, body: '{}',
  })
  assert.equal(anonBegin.status, 401, 'passkey registration requires a session')

  // 缺 CSRF 不得签发
  const noCsrfBegin = await fetch(`${base}/api/auth/passkey/register/begin`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie: cookieHeader(pkJar), ...PROXY_HEADERS }, body: '{}',
  })
  assert.equal(noCsrfBegin.status, 403, 'passkey registration requires csrf')

  // 注册第一步
  const regBegin = await pk('/api/auth/passkey/register/begin', { currentPassword: 'rotated-pass-77' })
  assert.equal(regBegin.status, 200, `passkey register begin succeeds: ${serverStderr}`)
  const regBody = await regBegin.json()
  assert.ok(regBody.publicKey?.challenge, 'registration challenge issued')
  assert.equal(regBody.publicKey.rp.id, PASSKEY_RPID, 'rp id is the configured domain')
  assert.equal(regBody.publicKey.authenticatorSelection.userVerification, 'required', 'UV required')

  // 注册第二步（真实 ES256 attestation）
  const authenticator = makeAuthenticator({ rpId: PASSKEY_RPID, origin: PASSKEY_ORIGIN })
  const regFinishNoName = await pk('/api/auth/passkey/register/finish', { challenge: regBody.challenge, response: authenticator.attestation(regBody.publicKey.challenge) })
  assert.equal(regFinishNoName.status, 400, 'missing passkey name rejected')

  const regBegin2 = await pk('/api/auth/passkey/register/begin', { currentPassword: 'rotated-pass-77' })
  const regBody2 = await regBegin2.json()
  const regFinish = await pk('/api/auth/passkey/register/finish', {
    challenge: regBody2.challenge,
    name: 'MacBook 指纹',
    response: authenticator.attestation(regBody2.publicKey.challenge),
  })
  assert.equal(regFinish.status, 200, `passkey registration verifies: ${serverStderr}`)

  // 挑战单次消费：重复提交必须失败
  const regReplay = await pk('/api/auth/passkey/register/finish', {
    challenge: regBody2.challenge, name: '重放', response: authenticator.attestation(regBody2.publicKey.challenge),
  })
  assert.equal(regReplay.status, 401, 'registration challenge is single-use')

  // 列表可见，且不泄露公钥
  const list = await fetch(`${base}/api/auth/passkeys`, { headers: { cookie: cookieHeader(pkJar), ...PROXY_HEADERS } })
  const listBody = await list.json()
  assert.equal(listBody.passkeys.length, 1, 'one passkey stored')
  assert.equal(listBody.passkeys[0].name, 'MacBook 指纹')
  assert.ok(!JSON.stringify(listBody).includes('publicKey'), 'passkey list must not expose key material')

  // 登录第一步（不传用户名 → 可发现凭据）
  const authBegin = await fetch(`${base}/api/auth/passkey/login/begin`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...PROXY_HEADERS }, body: '{}',
  })
  assert.equal(authBegin.status, 200, 'passkey login begin succeeds without a username')
  const authBody = await authBegin.json()

  // 登录第二步
  const authFinish = await fetch(`${base}/api/auth/passkey/login/finish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...PROXY_HEADERS },
    body: JSON.stringify({ challenge: authBody.challenge, response: authenticator.assertion(authBody.publicKey.challenge) }),
  })
  assert.equal(authFinish.status, 200, `passkey login verifies: ${serverStderr}`)
  const pkSession = cookiesFrom(authFinish)
  assert.ok(pkSession.dsh_auth_session, 'passkey login yields a session')
  assert.equal((await fetch(`${base}/__dsh_auth/verify`, { headers: { cookie: cookieHeader(pkSession) } })).status, 204, 'passkey session passes auth_request')

  // 错误签名不得登录
  const authBegin2 = await (await fetch(`${base}/api/auth/passkey/login/begin`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...PROXY_HEADERS }, body: '{}',
  })).json()
  const badAuth = await fetch(`${base}/api/auth/passkey/login/finish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...PROXY_HEADERS },
    body: JSON.stringify({ challenge: authBegin2.challenge, response: authenticator.assertion(authBegin2.publicKey.challenge, { badSignature: true }) }),
  })
  assert.equal(badAuth.status, 401, 'tampered assertion rejected')

  // 删除需要密码
  const pkId = listBody.passkeys[0].id
  const delWrong = await pk('/api/auth/passkey/delete', { id: pkId, currentPassword: 'nope-12345678' })
  assert.equal(delWrong.status, 401, 'passkey delete verifies the current password')
  const del = await pk('/api/auth/passkey/delete', { id: pkId, currentPassword: 'rotated-pass-77' })
  assert.equal(del.status, 200, 'passkey delete succeeds')
  const listAfter = await (await fetch(`${base}/api/auth/passkeys`, { headers: { cookie: cookieHeader(pkJar), ...PROXY_HEADERS } })).json()
  assert.equal(listAfter.passkeys.length, 0, 'passkey removed')

  // 状态库中不得出现公钥以外的秘密，且公钥以 base64url 存储
  const pkState = JSON.parse(fs.readFileSync(path.join(sandbox, 'auth', 'state.json'), 'utf8'))
  assert.ok(!JSON.stringify(pkState).includes('"passkeys":[{"id"'), 'passkeys array emptied after delete')

  console.log('dsh-auth integration smoke: ok')
} finally {
  child.kill()
  fs.rmSync(sandbox, { recursive: true, force: true })
}
