// docker-control 插件里的账户分区：静态断言。
//
// 账户界面本身不在插件里——它是容器外 dsh-auth 提供的 /account-panel.js，由插件在运行时
// 加载并挂载。这里断言的就是这个「宿主」关系，以及几条不能被后续改动破坏的边界。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const client = fs.readFileSync(path.join(root, 'dsh-home', 'docker-control', 'client', 'client.js'), 'utf8')
const panel = fs.readFileSync(path.join(root, 'bin', 'dsh-auth-web', 'account-panel.js'), 'utf8')

// --- 插件侧：注册分区，且只在有认证网关时才注册 ---
assert.ok(client.includes("id: 'dsh-account'"), 'the account section registers into the settings slots')
assert.ok(client.includes("name: 'settings.section'"), 'it uses the settings.section slot')
assert.ok(client.includes('SafeAccountSection'), 'the section is wrapped in an error boundary like the other sections')
assert.ok(client.includes('function probeAuthGateway()'), 'the plugin probes the gateway before registering')
assert.ok(
  /probeAuthGateway\(\)\.then\(status => \{\s*\n\s*if \(disposed \|\| status === null\) return/.test(client),
  'the section is only registered when the gateway answers',
)

// --- 插件侧：界面来自容器外，且这是刻意的 ---
assert.ok(client.includes("const ACCOUNT_PANEL_PATH = '/account-panel.js'"), 'the panel is loaded from the gateway, not bundled here')
assert.ok(client.includes('window.DSHAccountPanel'), 'the plugin mounts the shared panel')
assert.ok(client.includes('function loadAccountPanel()'), 'the panel script is loaded once')
assert.ok(
  !client.includes("'/api/auth/password'"),
  'the plugin must not implement credential forms itself: that code would live inside the container',
)

// --- 插件侧：管理员的账户设置不在这里，只给面板入口 ---
assert.ok(client.includes("status.multiUser === true && session.user && session.user.role === 'root'"), 'root in multi-user mode is routed to the panel')
assert.ok(client.includes("window.open('/admin'"), 'the admin panel is opened as a link')
for (const forbidden of ["'/api/admin/users'", "'/api/admin/users/status'", "'/api/admin/users/delete'"]) {
  assert.ok(!client.includes(forbidden), `the container must not render management of other accounts (${forbidden})`)
}

// --- 面板侧：接口契约 ---
for (const endpoint of [
  "'/api/auth/session'",
  "'/api/auth/password'",
  "'/api/auth/totp/setup'",
  "'/api/auth/totp/confirm'",
  "'/api/auth/totp/disable'",
  "'/api/auth/passkeys'",
  "'/api/auth/passkey/register/begin'",
  "'/api/auth/passkey/register/finish'",
  "'/api/auth/passkey/delete'",
  "'/api/auth/sessions'",
  "'/api/auth/sessions/revoke'",
]) {
  assert.ok(panel.includes(endpoint), `the panel calls ${endpoint}`)
}
assert.ok(panel.includes("readCookie(CSRF_COOKIE)") || panel.includes('readCookie('), 'writes carry the double-submit CSRF token')
assert.ok(panel.includes("'x-csrf-token'"), 'the token travels in the X-CSRF-Token header the gateway expects')

// --- 面板侧：敏感操作要求重新验证当前密码 ---
for (const operation of ['currentPassword: pwCurrent.value', 'currentPassword: offPassword.value', 'currentPassword: passkeyPassword.value']) {
  assert.ok(panel.includes(operation), `sensitive operation re-authenticates: ${operation}`)
}

// --- 面板侧：布局不能把控件挤在一行，且必须给出二维码 ---
assert.ok(panel.includes('.ap-row'), 'rows put the description left and the control right')
assert.ok(panel.includes('.ap-field input'), 'inputs take a full line of their own')
assert.ok(!panel.includes('grid-template-columns: repeat(3'), 'no three-across layout that squeezes inputs')
assert.ok(panel.includes('otpauthQrDataUri'), 'the TOTP setup renders the QR code the gateway returns')
assert.ok(panel.includes("el('img')"), 'the QR code is rendered as an image, not injected as markup')
assert.ok(panel.includes('pendingTotp.secret'), 'the secret stays available for manual entry')

// --- 面板侧：中英双语 ---
for (const key of ['password.title', 'totp.title', 'passkey.title', 'sessions.title']) {
  const occurrences = panel.split(`'${key}':`).length - 1
  assert.ok(occurrences >= 2, `${key} must exist in both dictionaries, found ${occurrences}`)
}

console.log('dsh-docker-control account smoke: ok')
