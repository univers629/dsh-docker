// 人机验证：策略层 + 接口 + 登录流程的行为测试。
//
// 关键性质（比「能保存配置」重要得多）：
//   * 关闭时不拦截任何请求
//   * 开启时缺 token / token 无效一律拒绝（fail closed）
//   * 密钥只写不可读：接口永不回显明文或密文
//   * 密文解不开时必须拒绝，而不是放行
//   * provider 说「无效」与「问不到 provider」要能区分（否则运维无从下手）

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { CAPTCHA_PROVIDERS, isCaptchaProvider, openCaptchaSecret, sealCaptchaSecret, verifyCaptchaToken } from '../bin/dsh-auth-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-captcha-'))
const ROOT_PASSWORD = 'captcha-root-pass-1'

async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitFor(url, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (predicate(response)) return response
    } catch { /* 继续等 */ }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${url}`)
}

// ---- 1) 策略层 ----
{
  const key = Buffer.alloc(32, 3)
  assert.deepEqual(Object.keys(CAPTCHA_PROVIDERS).sort(), ['hcaptcha', 'recaptcha', 'turnstile'])
  assert.equal(isCaptchaProvider('turnstile'), true)
  assert.equal(isCaptchaProvider('nope'), false)

  const sealed = sealCaptchaSecret(key, 'super-secret')
  assert.notEqual(sealed, 'super-secret', 'the secret must not be stored in clear')
  assert.equal(openCaptchaSecret(key, sealed), 'super-secret')
  assert.equal(openCaptchaSecret(Buffer.alloc(32, 4), sealed), null, 'a different key must not open it')

  // 用途隔离：TOTP 的密文不能被人机验证解开（AAD 不同）
  const { sealTotpSecret } = await import('../bin/dsh-auth-policy.mjs')
  assert.equal(openCaptchaSecret(key, sealTotpSecret(key, 'JBSWY3DPEHPK3PXP')), null, 'TOTP ciphertext must not open as a captcha secret')

  const okFetch = async () => ({ ok: true, json: async () => ({ success: true }) })
  const rejectFetch = async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) })
  const downFetch = async () => { throw new TypeError('fetch failed') }
  const badStatus = async () => ({ ok: false, status: 502, json: async () => ({}) })

  assert.equal((await verifyCaptchaToken({ provider: 'turnstile', secret: 's', token: 't', fetchImpl: okFetch })).ok, true)
  const rejected = await verifyCaptchaToken({ provider: 'hcaptcha', secret: 's', token: 't', fetchImpl: rejectFetch })
  assert.equal(rejected.ok, false)
  assert.ok(rejected.reason.startsWith('rejected:'), 'a provider rejection names the error codes')
  const unreachable = await verifyCaptchaToken({ provider: 'recaptcha', secret: 's', token: 't', fetchImpl: downFetch })
  assert.equal(unreachable.ok, false)
  assert.ok(unreachable.reason.startsWith('unreachable:'), 'an unreachable provider is reported differently from a rejection')
  assert.equal((await verifyCaptchaToken({ provider: 'turnstile', secret: 's', token: 't', fetchImpl: badStatus })).reason, 'http_502')
  assert.equal((await verifyCaptchaToken({ provider: 'turnstile', secret: 's', token: '  ', fetchImpl: okFetch })).reason, 'no_token')
  assert.equal((await verifyCaptchaToken({ provider: 'turnstile', secret: '', token: 't', fetchImpl: okFetch })).reason, 'no_secret')
  assert.equal((await verifyCaptchaToken({ provider: 'x', secret: 's', token: 't', fetchImpl: okFetch })).reason, 'unsupported_provider')
  console.log('策略层：ok')
}

// ---- 2) 接口与登录流程 ----
const authPort = await freePort()
const child = spawn(process.execPath, [path.join(root, 'bin', 'dsh-auth.mjs')], {
  env: {
    ...process.env,
    DSH_AUTH_LISTEN: `127.0.0.1:${authPort}`,
    DSH_AUTH_STATE: path.join(sandbox, 'state.json'),
    DSH_AUTH_TOTP_KEY: path.join(sandbox, 'totp.key'),
    DSH_AUTH_WEB_DIR: path.join(root, 'bin', 'dsh-auth-web'),
    DSH_AUTH_INITIAL_PASSWORD: ROOT_PASSWORD,
    DSH_MULTI_USER: 'on',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

const base = `http://127.0.0.1:${authPort}`
const jarOf = (response) => {
  const jar = {}
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(';')
    const index = pair.indexOf('=')
    if (index > 0) jar[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim())
  }
  return jar
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
const post = (url, body, jar) => fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: base,
    ...(jar ? { cookie: cookieHeader(jar) } : {}),
    // 管理接口要求双提交 CSRF 令牌；登录/注册不要求，但带上无害
    ...(jar?.dsh_auth_csrf ? { 'x-csrf-token': jar.dsh_auth_csrf } : {}),
  },
  body: JSON.stringify(body),
})

try {
  await waitFor(`${base}/api/auth/status`, (r) => r.ok)

  // 默认关闭：status 说不需要验证，登录不带 token 也能过
  const statusOff = await (await fetch(`${base}/api/auth/status`)).json()
  assert.equal(statusOff.captcha.required, false, 'human verification is off by default')
  const rootLogin = await post(`${base}/api/auth/login`, { username: 'root', password: ROOT_PASSWORD })
  assert.equal(rootLogin.status, 200, 'sign-in works while human verification is off')
  const adminJar = jarOf(rootLogin)

  // 读配置：带 provider 列表，secret 只报是否已配置
  const config = await (await fetch(`${base}/api/admin/captcha`, { headers: { cookie: cookieHeader(adminJar) } })).json()
  assert.equal(config.ok, true)
  assert.equal(config.providers.length, 3, 'the provider list comes from the server')
  assert.equal(config.secretConfigured, false, 'no secret configured yet')
  assert.equal(config.active, false)

  // 半配置状态必须拒绝：开启但没密钥会让所有人登录失败
  const noSecret = await post(`${base}/api/admin/captcha`, { enabled: true, provider: 'turnstile', siteKey: 'site-key-1' }, adminJar)
  assert.equal(noSecret.status, 400, 'enabling without a secret is refused')
  assert.equal((await noSecret.json()).code, 'missing_secret')
  const noSiteKey = await post(`${base}/api/admin/captcha`, { enabled: true, provider: 'turnstile', siteKey: '', secret: 'sec-1' }, adminJar)
  assert.equal(noSiteKey.status, 400, 'enabling without a site key is refused')
  assert.equal((await noSiteKey.json()).code, 'missing_site_key')

  // 非 root 不能读也不能写
  const userRegister = await post(`${base}/api/auth/register`, { username: 'plain', password: 'plain-pass-1234' })
  assert.equal(userRegister.status, 201)
  const userLogin = await post(`${base}/api/auth/login`, { username: 'plain', password: 'plain-pass-1234' })
  const userJar = jarOf(userLogin)
  assert.equal((await fetch(`${base}/api/admin/captcha`, { headers: { cookie: cookieHeader(userJar) } })).status, 403, 'a plain user cannot read the settings')
  assert.equal((await post(`${base}/api/admin/captcha`, { enabled: true }, userJar)).status, 403, 'a plain user cannot change the settings')

  // 正常写入
  const saved = await post(`${base}/api/admin/captcha`, { enabled: true, provider: 'hcaptcha', siteKey: 'site-key-1', secret: 'server-secret-1' }, adminJar)
  assert.equal(saved.status, 200, `saving works: ${stderr}`)
  const savedBody = await saved.json()
  assert.equal(savedBody.enabled, true)
  assert.equal(savedBody.provider, 'hcaptcha')
  assert.equal(savedBody.secretConfigured, true)
  assert.equal(savedBody.active, true, 'a complete configuration is active')

  // 密钥绝不回显（明文或密文都不行）
  const afterSave = await (await fetch(`${base}/api/admin/captcha`, { headers: { cookie: cookieHeader(adminJar) } })).json()
  assert.equal(afterSave.secretConfigured, true)
  const serialized = JSON.stringify(afterSave)
  assert.ok(!serialized.includes('server-secret-1'), 'the settings API must never echo the secret')
  const stateText = fs.readFileSync(path.join(sandbox, 'state.json'), 'utf8')
  assert.ok(!stateText.includes('server-secret-1'), 'the secret must not be stored in clear')
  // 落盘的是密文，且能用主密钥还原
  const { loadOrCreateTotpKey } = await import('../bin/dsh-auth-store.mjs')
  const masterKey = loadOrCreateTotpKey(path.join(sandbox, 'totp.key'))
  const storedSecret = JSON.parse(stateText).setup.captcha.secret
  assert.equal(openCaptchaSecret(masterKey, storedSecret), 'server-secret-1', 'the stored secret is recoverable with the master key')

  // status 现在要求验证，并下发公开的 siteKey（但绝不含密钥）
  const statusOn = await (await fetch(`${base}/api/auth/status`)).json()
  assert.equal(statusOn.captcha.required, true)
  assert.equal(statusOn.captcha.provider, 'hcaptcha')
  assert.equal(statusOn.captcha.siteKey, 'site-key-1', 'the public site key is published so the page can render the widget')
  assert.ok(!JSON.stringify(statusOn).includes('server-secret-1'), 'the status payload must never contain the secret')

  // 开启后：不带 token 一律拒绝
  const noToken = await post(`${base}/api/auth/login`, { username: 'plain', password: 'plain-pass-1234' })
  assert.equal(noToken.status, 403, 'sign-in without a token is refused')
  assert.equal((await noToken.json()).code, 'captcha_failed')
  const registerNoToken = await post(`${base}/api/auth/register`, { username: 'another', password: 'another-pass-1234' })
  assert.equal(registerNoToken.status, 403, 'registration without a token is refused')

  // 带 token 时：真实 provider 不可达 → 仍然拒绝（fail closed），并说明原因
  const withToken = await post(`${base}/api/auth/login`, { username: 'plain', password: 'plain-pass-1234', captchaToken: 'whatever' })
  assert.equal(withToken.status, 403, 'an unverifiable token is refused')
  const withTokenBody = await withToken.json()
  assert.equal(withTokenBody.code, 'captcha_failed')
  assert.ok(typeof withTokenBody.reason === 'string' && withTokenBody.reason.length > 0, 'the reason is reported for operators')

  // 审计留痕
  const audit = await (await fetch(`${base}/api/admin/audit?limit=100`, { headers: { cookie: cookieHeader(adminJar) } })).json()
  assert.ok(audit.entries.some((entry) => entry.action === 'admin.captcha.update'), 'changing the settings is audited')
  assert.ok(!JSON.stringify(audit.entries).includes('server-secret-1'), 'the audit must never contain the secret')

  // 关闭后恢复放行
  const disabled = await post(`${base}/api/admin/captcha`, { enabled: false }, adminJar)
  assert.equal(disabled.status, 200)
  assert.equal((await post(`${base}/api/auth/login`, { username: 'plain', password: 'plain-pass-1234' })).status, 200, 'sign-in works again once disabled')

  console.log('接口与登录流程：ok')
} finally {
  child.kill()
  fs.rmSync(sandbox, { recursive: true, force: true })
}

// ---- 3) 前端：一次性 token 的生命周期 ----
//
// Turnstile 的 token 只能用一次：服务端拿去 Cloudflare 校验一次，之后无论那次请求
// 成功与否都作废。前端若把同一枚再送一次，Cloudflare 回 invalid-input-response，
// 而界面只显示一句笼统的「操作未完成」，从那条信息看不出是 token 复用。
//
// 所以两件事必须成立：取用即消费；提交失败后重挂 widget 拿新 token。
{
  const page = fs.readFileSync(path.join(root, 'bin', 'dsh-auth-web', 'index.html'), 'utf8')

  const taker = page.match(/function captchaTokenFor\(containerId\) \{[\s\S]*?\n  \}/)
  assert.ok(taker, 'index.html 必须定义 captchaTokenFor')
  assert.match(
    taker[0],
    /CAPTCHA\.tokens\[containerId\] = ''/,
    '取走 token 后必须立刻清空：留着它下次提交还会带上同一枚，必然被 Cloudflare 拒绝',
  )

  assert.match(page, /function refreshCaptchaWidget\(containerId\)/, '必须有一个重挂 widget 的函数')
  assert.match(
    page,
    /function refreshCaptchaWidget\(containerId\) \{[\s\S]*?renderCaptchaWidget\(containerId\)/,
    '重挂要真的重建 widget，否则拿不到新 token',
  )

  // 登录与注册的失败分支都要重挂；漏掉任一条，那条路径就会卡在「再点也没用」。
  const loginHandler = page.match(/\$\('step-credentials'\)\.addEventListener\('submit'[\s\S]*?\n  \}\)/)
  assert.ok(loginHandler, '必须能找到登录提交处理器')
  assert.match(loginHandler[0], /refreshCaptchaWidget\('captcha-login'\)/, '登录失败后必须重挂 widget')

  const registerHandler = page.match(/\$\('step-register'\)\.addEventListener\('submit'[\s\S]*?\n  \}\)/)
  assert.ok(registerHandler, '必须能找到注册提交处理器')
  assert.match(registerHandler[0], /refreshCaptchaWidget\('captcha-register'\)/, '注册失败后必须重挂 widget')

  // 取 token 会消费它，所以必须在本地校验之后才取：先取再校验会把好 token 白白作废。
  const registerBody = registerHandler[0]
  const takeAt = registerBody.indexOf('captchaTokenFor(')
  const requiredAt = registerBody.indexOf("t('register.errorRequired')")
  assert.ok(takeAt > -1 && requiredAt > -1, '注册处理器里两个关键步骤都要在')
  assert.ok(
    requiredAt < takeAt,
    '本地必填校验必须在取 token 之前：captchaTokenFor 会消费 token，先取等于白白作废一枚',
  )

  console.log('前端 token 生命周期：ok')
}

console.log('dsh-auth captcha smoke: ok')
