// 账户安全面板（共享模块）。
//
// 三个宿主共用这一份实现：
//   * 独立页面 /account —— 所有用户都能用的兜底入口
//   * 管理面板 /admin 的「账户安全」标签页 —— 管理员的安全设置放在面板里
//   * docker-control 插件的「账户」设置分区 —— 用户在工作台里直接管理
//
// 样式自带（ap- 前缀），不依赖宿主的 CSS：插件的设置面板与独立页面用的是完全不同的
// 样式表，靠宿主类名会让两边长得不一样。布局约定与 DSH 的设置界面一致：
//   分区 = 标题 + 说明 + 若干「说明在左、动作在右」的行，需要输入时字段独占整行。
//
// 调用：window.DSHAccountPanel.mount(container, { lang, onSignOut })
;(() => {
  const CSRF_COOKIE = 'dsh_auth_csrf'
  const STYLE_ID = 'dsh-account-panel-style'

  const CSS = `
    .ap-root { display: flex; flex-direction: column; gap: 22px; max-width: 620px; }
    .ap-section { display: flex; flex-direction: column; gap: 10px; }
    .ap-section > h3 { margin: 0; font-size: 13.5px; font-weight: 600; }
    .ap-section > p.ap-hint { margin: 0; font-size: 12px; line-height: 1.65; opacity: .68; }
    .ap-rows { display: flex; flex-direction: column; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 12px; overflow: hidden; }
    .ap-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 14px; font-size: 12.5px; }
    .ap-row + .ap-row { border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
    .ap-row-text { min-width: 0; }
    .ap-row-text strong { display: block; font-weight: 500; }
    .ap-row-text small { display: block; margin-top: 3px; font-size: 11.5px; opacity: .62; word-break: break-all; }
    .ap-row-control { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
    .ap-fields { display: flex; flex-direction: column; gap: 12px; }
    .ap-field { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
    .ap-field > span { opacity: .78; }
    /* 输入框尺寸引用宿主的同一套 token（--control-*），使账户安全区的字段与
       管理面板的运行设置、人机验证字段完全一致；变量不存在时退回同值默认。 */
    .ap-field input {
      width: 100%; box-sizing: border-box;
      height: var(--control-height, 44px);
      padding: 0 var(--control-pad-x, 14px);
      font: inherit; font-size: var(--control-font, 14.5px);
      border-radius: var(--control-radius, 12px);
      border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
      background: color-mix(in srgb, currentColor 4%, transparent); color: inherit;
    }
    .ap-field input:focus { outline: 2px solid color-mix(in srgb, #4d6bfe 55%, transparent); outline-offset: 1px; border-color: transparent; }
    .ap-field input.ap-otp { letter-spacing: .4em; text-align: center; max-width: 180px; }
    .ap-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .ap-qr { display: flex; align-items: flex-start; gap: 16px; }
    .ap-qr img { width: 168px; height: 168px; image-rendering: pixelated; border-radius: 10px; background: #fff; padding: 8px; box-sizing: border-box; }
    .ap-qr-text { min-width: 0; display: flex; flex-direction: column; gap: 6px; font-size: 11.5px; }
    .ap-qr-text code { display: block; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .ap-codes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
    .ap-recovery { display: flex; flex-direction: column; gap: 12px; }
    .ap-recovery > h3 { margin: 0; font-size: 13.5px; font-weight: 600; }
    .ap-warning { display: flex; gap: 9px; align-items: flex-start; padding: 11px 13px; border-radius: 10px; font-size: 12px; line-height: 1.65; border: 1px solid color-mix(in srgb, #e0a44a 45%, transparent); background: color-mix(in srgb, #e0a44a 12%, transparent); }
    .ap-warning svg { flex: 0 0 auto; margin-top: 1px; }
    .ap-recovery .ap-codes span { padding: 8px 10px; font-size: 12.5px; letter-spacing: .06em; user-select: all; }
    .ap-ack { display: flex; align-items: center; gap: 9px; font-size: 12.5px; cursor: pointer; padding: 5px 8px; margin: 0 -5px; border-radius: 8px; transition: background 150ms var(--ease-out, ease-out); }
    .ap-ack:hover { background: color-mix(in srgb, currentColor 7%, transparent); }
    .ap-ack input { position: absolute; opacity: 0; width: 19px; height: 19px; margin: 0; cursor: pointer; }
    /* 自绘复选框：与 app.css 的 .check 同一视觉语言（面板样式自带，不依赖宿主 CSS） */
    .ap-ack input::before {
      content: ""; display: block; width: 19px; height: 19px;
      border-radius: 6px; background: transparent;
      border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
      transition: background 150ms var(--ease-out, ease-out), border-color 150ms var(--ease-out, ease-out);
    }
    .ap-ack input::after {
      content: ""; position: absolute; left: 5px; top: 5.5px;
      width: 5px; height: 9px;
      border-right: 2px solid #fff; border-bottom: 2px solid #fff;
      transform: rotate(45deg) scale(0);
      transition: transform 150ms var(--ease-out, ease-out);
    }
    .ap-ack input:checked::before { background: var(--brand, #4d6bfe); border-color: var(--brand, #4d6bfe); }
    .ap-ack input:checked::after { transform: rotate(45deg) scale(1); }
    .ap-copy-state { font-size: 11.5px; opacity: .7; }
    .ap-codes span { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; padding: 5px 7px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 7px; text-align: center; }
    .ap-note { font-size: 12px; line-height: 1.6; }
    .ap-local { font-size: 12px; line-height: 1.6; margin-top: 2px; }
    .ap-local.is-error { color: #ff8f8f; }
    .ap-local.is-ok { color: #7ee0a8; }
    .ap-local:empty { display: none; }
    .ap-actions button[disabled] { opacity: .55; cursor: default; }
    .ap-note.is-error { color: #ff8f8f; }
    .ap-note.is-ok { color: #7ee0a8; }
    .ap-pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); opacity: .85; }
    .ap-pill--warn { border-color: color-mix(in srgb, #e0a44a 55%, transparent); color: #e8b567; opacity: 1; }
    .ap-local.is-warn { color: #e8b567; }
    .ap-loading { font-size: 12.5px; opacity: .65; }
  `

  const I18N = {
    zh: {
      loading: '正在读取账户状态…', failed: '操作未完成', network: '无法连接到服务器。',
      username: '账户', role: '角色', singleUser: '单管理员',
      'password.title': '登录密码', 'password.hint': '至少 6 位；更长、混合字母数字符号会更安全，但不强制。修改后会注销全部登录。',
      'password.current': '当前密码', 'password.next': '新密码', 'password.confirm': '确认新密码',
      'password.submit': '修改密码', 'password.required': '请填写当前密码与新密码。',
      'password.mismatch': '两次输入的新密码不一致。', 'password.wrong': '当前密码不正确。',
      'password.weak': '密码至少 6 位。', 'password.unchanged': '新密码不能与当前密码相同。',
      'totp.title': '两步验证（TOTP）', 'totp.hint': '用验证器 App 扫描下方二维码，或手动输入密钥。开启时会一次性给出恢复码。',
      'totp.state': '当前状态', 'totp.on': '已开启', 'totp.off': '未开启', 'totp.start': '开启两步验证',
      'totp.scan': '用验证器扫描',
      'totp.noQr': '二维码未能生成，请手动输入下面的密钥。', 'totp.secret': '密钥（手动输入用）', 'totp.uri': 'otpauth 地址',
      'totp.code': '验证器当前显示的 6 位验证码', 'totp.confirm': '确认并开启', 'totp.cancel': '取消',
      'totp.disable': '关闭两步验证', 'totp.disableHint': '关闭属于安全降级：需要当前密码与一个有效验证码，成功后全部会话会被撤销。',
      'totp.codeOrRecovery': '验证码或恢复码',       'totp.enabled': '两步验证已开启。',
      'totp.pendingNow': '验证码已确认。请先保存下面的恢复码并勾选确认，再点「完成」——在那之前两步验证尚未启用。',
      'totp.statePending': '需完成设置',
      'totp.pendingHint': '待确认：保存恢复码并点「完成」后才会启用',
      'totp.pendingSetupHint': '两步验证已预备但尚未启用，请保存恢复码并点「完成」完成设置。',
      'totp.pendingLost': '上一次登记尚未完成，恢复码已不再显示。请重新开始。',
      'totp.startOver': '重新开始',
      'totp.startOverDone': '已清除未完成的登记，可以重新开启。',
      'totp.enabledNow': '两步验证已启用。',
      'totp.enrolExpired': '这次登记已超时，请重新开始。',
      'totp.enrolMissing': '没有待完成的登记，请重新开始。',
      'totp.codeWrong': '验证码不正确。', 'totp.recoveryLeft': '剩余恢复码 {n} 个',
      'recovery.title': '恢复码（只显示这一次）',
      'recovery.warning': '验证器丢失、换机或无法使用时的唯一退路。这些码只显示这一次，离开本页后无法再查看。请立刻抄写或下载到离线位置，不要截图后留在聊天工具里。',
      'recovery.ack': '我已把恢复码保存到安全的地方，并明白它不会再显示。',
      'recovery.copy': '复制全部', 'recovery.download': '下载为文本', 'recovery.done': '完成',
      'recovery.copied': '已复制到剪贴板。',
      'totp.recoverySaved': '恢复码已保存。两步验证保持开启。', 'recovery.copyFailed': '复制失败，请手动选中后复制。',
      'working': '处理中…',
      'totp.needSixDigits': '请输入验证器当前显示的 6 位数字验证码。',
      'totp.recoveryRotated': '恢复码已重新生成，旧码全部失效。',
      'totp.regenerate': '重新生成恢复码',
      'totp.regenerateHint': '恢复码用掉或丢失时在这里轮换：需要当前密码与一个有效验证码（或旧恢复码），生成后旧的立即全部失效。',
      'totp.recoveryOnce': '恢复码只显示这一次，请立即保存到离线位置：',
      'passkey.title': '通行密钥（Passkey）', 'passkey.hint': '用设备指纹、面容或系统 PIN 登录，可抵抗钓鱼。',
      'passkey.unavailable': '当前部署未启用通行密钥（需要固定 HTTPS 域名）。',
      'passkey.empty': '还没有添加通行密钥。', 'passkey.name': '名称', 'passkey.namePlaceholder': '例如 MacBook 指纹',
      'passkey.nameRequired': '请先给它起个名字。', 'passkey.add': '添加通行密钥',
      'passkey.added': '通行密钥已添加。', 'passkey.removed': '通行密钥已删除。', 'passkey.failed': '通行密钥操作未完成。',
      'passkey.cancelled': '已取消通行密钥验证。', 'passkey.createdAt': '添加于 {time}',
      'passkey.lastUsed': '最近使用 {time}', 'passkey.neverUsed': '尚未使用',
      'delete': '删除', 'deleteNeedsPassword': '添加或删除时验证当前密码',
      'sessions.title': '登录会话', 'sessions.hint': '这些是仍然有效的登录。发现不认识的来源就吊销它。',
      'sessions.current': '当前会话', 'sessions.revoke': '吊销', 'sessions.revoked': '已吊销该会话。',
      'sessions.revokeOthers': '退出其他所有设备', 'sessions.revokedOthers': '已退出其他设备。',
    },
    en: {
      loading: 'Reading account state…', failed: 'The operation did not complete', network: 'Cannot reach the server.',
      username: 'Account', role: 'Role', singleUser: 'single administrator',
      'password.title': 'Sign-in password', 'password.hint': 'At least 6 characters; longer passwords mixing letters, digits and symbols are safer, but none of that is enforced. Changing it signs out every session.',
      'password.current': 'Current password', 'password.next': 'New password', 'password.confirm': 'Confirm new password',
      'password.submit': 'Change password', 'password.required': 'Enter the current and the new password.',
      'password.mismatch': 'The two new passwords do not match.', 'password.wrong': 'The current password is incorrect.',
      'password.weak': 'Use at least 6 characters.', 'password.unchanged': 'The new password must differ from the current one.',
      'totp.title': 'Two-step verification (TOTP)', 'totp.hint': 'Scan the code with your authenticator app, or enter the secret manually. Enabling it shows one-time recovery codes.',
      'totp.state': 'Status', 'totp.on': 'enabled', 'totp.off': 'not enabled', 'totp.start': 'Enable two-factor authentication',
      'totp.scan': 'Scan with your authenticator',
      'totp.noQr': 'The QR code could not be rendered; enter the secret below manually.', 'totp.secret': 'Secret (for manual entry)', 'totp.uri': 'otpauth URI',
      'totp.code': 'The 6-digit code your authenticator shows', 'totp.confirm': 'Confirm and enable', 'totp.cancel': 'Cancel',
      'totp.disable': 'Disable two-step verification', 'totp.disableHint': 'Disabling is a security downgrade: it needs the current password and a valid code, and revokes every session.',
      'totp.codeOrRecovery': 'Code or recovery code',       'totp.enabled': 'Two-step verification is on.',
      'totp.pendingNow': 'Code confirmed. Save the recovery codes below and tick the box, then press Done — until then two-step verification is not active.',
      'totp.statePending': 'Setup incomplete',
      'totp.pendingHint': 'Pending: it activates only after you save the codes and press Done',
      'totp.pendingSetupHint': 'Two-step verification is armed but not active yet; save the recovery codes and press Done to finish.',
      'totp.pendingLost': 'The previous enrolment was never completed and its recovery codes can no longer be shown. Please start over.',
      'totp.startOver': 'Start over',
      'totp.startOverDone': 'The unfinished enrolment was cleared; you can enable it again.',
      'totp.enabledNow': 'Two-step verification is now active.',
      'totp.enrolExpired': 'This enrolment expired. Please start over.',
      'totp.enrolMissing': 'There is no enrolment waiting to be completed. Please start over.',
      'totp.codeWrong': 'That code is not valid.', 'totp.recoveryLeft': '{n} recovery codes left',
      'recovery.title': 'Recovery codes (shown once)',
      'recovery.warning': 'Your only way back in if the authenticator is lost, replaced or unavailable. These codes are shown once and cannot be viewed again after you leave this page. Write them down or download them to an offline location now.',
      'recovery.ack': 'I have stored the recovery codes safely and understand they will not be shown again.',
      'recovery.copy': 'Copy all', 'recovery.download': 'Download as text', 'recovery.done': 'Done',
      'recovery.copied': 'Copied to the clipboard.',
      'totp.recoverySaved': 'Recovery codes saved. Two-step verification stays enabled.', 'recovery.copyFailed': 'Copy failed; select the codes and copy them manually.',
      'working': 'Working…',
      'totp.needSixDigits': 'Enter the 6-digit code your authenticator is showing.',
      'totp.recoveryRotated': 'Recovery codes regenerated; the previous set no longer works.',
      'totp.regenerate': 'Regenerate recovery codes',
      'totp.regenerateHint': 'Rotate the codes when they are used up or lost: it needs the current password and a valid code (or an old recovery code). Previous codes stop working immediately.',
      'totp.recoveryOnce': 'Recovery codes are shown once. Save them somewhere offline now:',
      'passkey.title': 'Passkeys', 'passkey.hint': 'Sign in with a device PIN, fingerprint or face; resistant to phishing.',
      'passkey.unavailable': 'Passkeys are not enabled on this deployment (a fixed HTTPS domain is required).',
      'passkey.empty': 'No passkeys yet.', 'passkey.name': 'Name', 'passkey.namePlaceholder': 'e.g. MacBook fingerprint',
      'passkey.nameRequired': 'Give it a name first.', 'passkey.add': 'Add a passkey',
      'passkey.added': 'Passkey added.', 'passkey.removed': 'Passkey deleted.', 'passkey.failed': 'The passkey operation did not complete.',
      'passkey.cancelled': 'Passkey verification was cancelled.', 'passkey.createdAt': 'added {time}',
      'passkey.lastUsed': 'last used {time}', 'passkey.neverUsed': 'never used',
      'delete': 'Delete', 'deleteNeedsPassword': 'Current password to add or delete',
      'sessions.title': 'Sessions', 'sessions.hint': 'These sign-ins are still valid. Revoke any you do not recognise.',
      'sessions.current': 'current session', 'sessions.revoke': 'Revoke', 'sessions.revoked': 'Session revoked.',
      'sessions.revokeOthers': 'Sign out other devices', 'sessions.revokedOthers': 'Signed out the other devices.',
    },
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }

  function readCookie(name) {
    try {
      const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'))
      return match ? decodeURIComponent(match[1]) : ''
    } catch {
      return ''
    }
  }

  function decodeBase64Url(value) {
    const binary = atob(String(value).replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes.buffer
  }

  function encodeBase64Url(buffer) {
    let binary = ''
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function serializeCredential(credential) {
    const response = credential.response
    const out = {
      id: credential.id,
      rawId: encodeBase64Url(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
      response: { clientDataJSON: encodeBase64Url(response.clientDataJSON) },
    }
    if ('attestationObject' in response) {
      out.response.attestationObject = encodeBase64Url(response.attestationObject)
      out.response.transports = (response.getTransports && response.getTransports()) || []
    } else {
      out.response.authenticatorData = encodeBase64Url(response.authenticatorData)
      out.response.signature = encodeBase64Url(response.signature)
      out.response.userHandle = response.userHandle ? encodeBase64Url(response.userHandle) : null
    }
    return out
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function section(title, hint) {
    const wrapper = el('section', 'ap-section')
    wrapper.appendChild(el('h3', null, title))
    if (hint) wrapper.appendChild(el('p', 'ap-hint', hint))
    const rows = el('div', 'ap-rows')
    const fields = el('div', 'ap-fields')
    const actions = el('div', 'ap-actions')
    return { wrapper, rows, fields, actions, append(...nodes) { for (const node of nodes) wrapper.appendChild(node) } }
  }

  function row(title, detail, control) {
    const line = el('div', 'ap-row')
    const text = el('div', 'ap-row-text')
    text.appendChild(el('strong', null, title))
    if (detail) text.appendChild(el('small', null, detail))
    line.appendChild(text)
    if (control) {
      const box = el('div', 'ap-row-control')
      box.appendChild(control)
      line.appendChild(box)
    }
    return line
  }

  function field(label, input) {
    const wrap = el('label', 'ap-field')
    wrap.appendChild(el('span', null, label))
    wrap.appendChild(input)
    return wrap
  }

  // 按钮工厂：管理面板与账户面板同属数据操作界面，全部用行内 mini 尺寸——
  // 50px 的登录页大按钮在这里会压过表格与行操作，且与「停用/删除」的 mini 不一致。
  // primary（实心蓝，表单主操作）与 danger（红描边，破坏性）靠颜色区分语义，不靠尺寸。
  function button(label, onClick, variant = 'secondary') {
    const className = variant === 'primary' ? 'mini mini--primary'
      : variant === 'danger' ? 'mini mini--danger'
        : 'mini'
    const node = el('button', className, label)
    node.type = 'button'
    node.addEventListener('click', onClick)
    return node
  }
  const primary = (label, onClick) => button(label, onClick, 'primary')
  const danger = (label, onClick) => button(label, onClick, 'danger')

  /**
   * 挂载账户面板。
   * @param {HTMLElement} container 承载元素。
   * @param {{lang?: string}} [options] 选项。
   * @returns {Promise<{reload: Function}>} 句柄。
   */
  async function mount(container, options = {}) {
    ensureStyle()
    const lang = options.lang || (String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en')
    const t = (key) => I18N[lang][key] ?? I18N.en[key] ?? key
    const fill = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key))

    let csrf = readCookie(CSRF_COOKIE)
    let user = null
    let capabilities = {}
    let sessions = []
    let passkeys = []
    let pendingTotp = null
    let recoveryCodes = null
    // 这批恢复码是否需要「完成」来真正启用两步验证。
    // 开通流程需要；轮换恢复码时账户早已启用，点「完成」只是收起这一块。
    let recoveryNeedsActivation = false

    container.textContent = ''
    const root = el('div', 'ap-root')
    const alertError = el('div', 'ap-note is-error')
    const alertInfo = el('div', 'ap-note is-ok')
    container.appendChild(root)

    function error(message) {
      alertError.textContent = message
      alertError.style.display = ''
      alertInfo.style.display = 'none'
    }
    function info(message, extra) {
      alertInfo.textContent = message || ''
      if (extra) alertInfo.appendChild(extra)
      alertInfo.style.display = ''
      alertError.style.display = 'none'
    }
    function clearAlerts() {
      alertError.style.display = 'none'
      alertInfo.style.display = 'none'
    }

    /** 在分区内就地显示结果，同时保留顶部那行（顶部可能不在视野内）。 */
    function localNote(node, message, kind) {
      node.textContent = message
      node.className = 'ap-local' + (kind ? ' is-' + kind : '')
    }

    /** 请求进行中：按钮进入忙碌态，让「点了有没有反应」一目了然。 */
    async function withBusy(nodes, labels, action) {
      const previous = nodes.map((node) => node.textContent)
      nodes.forEach((node, index) => { node.disabled = true; node.textContent = labels[index] ?? previous[index] })
      try {
        return await action()
      } finally {
        nodes.forEach((node, index) => { node.disabled = false; node.textContent = previous[index] })
      }
    }
    alertError.style.display = 'none'
    alertInfo.style.display = 'none'

    async function api(path, method = 'GET', body) {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      let parsed = {}
      try { parsed = await response.json() } catch { parsed = {} }
      return { ok: response.ok, status: response.status, body: parsed }
    }

    function formatTime(value) {
      if (!value) return '—'
      try { return new Date(value).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') } catch { return '—' }
    }

    // ---- 输入控件（常驻，避免每次重渲染丢焦点）----
    const pwCurrent = el('input'); pwCurrent.type = 'password'; pwCurrent.autocomplete = 'current-password'
    const pwNext = el('input'); pwNext.type = 'password'; pwNext.autocomplete = 'new-password'
    const pwConfirm = el('input'); pwConfirm.type = 'password'; pwConfirm.autocomplete = 'new-password'
    const totpCode = el('input', 'ap-otp'); totpCode.inputMode = 'numeric'; totpCode.maxLength = 6; totpCode.placeholder = '······'
    // 只保留数字：否则粘贴「123 456」这类会被截成 6 位、校验必然失败，用户却看不出错在哪
    totpCode.addEventListener('input', () => {
      const digits = totpCode.value.replace(/[^0-9]/g, '').slice(0, 6)
      if (digits !== totpCode.value) totpCode.value = digits
    })
    const setupPassword = el('input'); setupPassword.type = 'password'; setupPassword.autocomplete = 'current-password'
    const offPassword = el('input'); offPassword.type = 'password'; offPassword.autocomplete = 'current-password'
    const offCode = el('input')
    const passkeyName = el('input'); passkeyName.placeholder = t('passkey.namePlaceholder')
    const passkeyPassword = el('input'); passkeyPassword.type = 'password'; passkeyPassword.autocomplete = 'current-password'

    // ---- 身份 ----
    const identity = section(t('username'), null)
    const identityRows = el('div', 'ap-rows')
    identity.append(identityRows)

    // ---- 密码 ----
    const password = section(t('password.title'), t('password.hint'))
    const passwordFields = el('div', 'ap-fields')
    passwordFields.append(field(t('password.current'), pwCurrent), field(t('password.next'), pwNext), field(t('password.confirm'), pwConfirm))
    const passwordActions = el('div', 'ap-actions')
    passwordActions.appendChild(primary(t('password.submit'), () => changePassword()))
    password.append(passwordFields, passwordActions)

    // ---- 恢复码（阻断式）----
    // 它是「验证器丢了之后的唯一退路」，因此不能是一行会被下个动作冲掉的提示：
    // 单独成区、给出警告、必须勾选确认才能离开。
    const recovery = el('section', 'ap-recovery')
    recovery.appendChild(el('h3', null, t('recovery.title')))
    const recoveryWarning = el('div', 'ap-warning')
    recoveryWarning.appendChild(el('span', null, '⚠'))
    recoveryWarning.appendChild(el('span', null, t('recovery.warning')))
    recovery.appendChild(recoveryWarning)
    const recoveryGrid = el('div', 'ap-codes')
    recovery.appendChild(recoveryGrid)
    const recoveryAck = el('input'); recoveryAck.type = 'checkbox'
    const recoveryAckLabel = el('label', 'ap-ack')
    const recoveryAckText = el('span', null, t('recovery.ack'))
    recoveryAckLabel.append(recoveryAck, recoveryAckText)
    recovery.appendChild(recoveryAckLabel)
    const recoveryActions = el('div', 'ap-actions')
    // 「完成」不再只是收起这一块：它是唯一会真正启用两步验证的动作，
    // 且必须先勾选「已保存恢复码」——否则用户可能在没保存的情况下被保护起来，
    // 验证器一丢就永久进不去。
    const recoveryDone = primary(t('recovery.done'), async () => {
      clearAlerts()
      // 只有开通流程才需要（也应该）调用 activate。轮换之后两步验证已经启用，
      // 再调一次会被服务端以 totp_already_enabled 拒绝，界面就落成「操作未完成」。
      if (recoveryNeedsActivation) {
        const result = await withBusy([recoveryDone], [t('working')], () => api('/api/auth/totp/activate', 'POST', {}))
        if (!result.ok) {
          const message = result.body.code === 'enrolment_expired' ? t('totp.enrolExpired')
            : result.body.code === 'no_pending_enrolment' ? t('totp.enrolMissing')
              : t('failed')
          localNote(totpNote, message, 'error')
          return error(message)
        }
        recoveryNeedsActivation = false
        recoveryCodes = null
        renderRecovery()
        await refresh()
        localNote(totpNote, t('totp.enabledNow'), 'ok')
        return
      }
      // 轮换：只收起这一块，账户状态不变
      recoveryCodes = null
      renderRecovery()
      localNote(totpNote, t('totp.recoverySaved'), 'ok')
    })
    recoveryDone.disabled = true
    const recoveryCopy = button(t('recovery.copy'), async () => {
      try {
        await navigator.clipboard.writeText(recoveryCodes.join('\n'))
        info(t('recovery.copied'))
      } catch {
        error(t('recovery.copyFailed'))
      }
    })
    const recoveryDownload = button(t('recovery.download'), () => {
      const blob = new Blob([`DeepSeek Harness recovery codes for ${user.username}\n\n${recoveryCodes.join('\n')}\n`], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const link = el('a')
      link.href = url
      link.download = 'dsh-recovery-codes.txt'
      link.click()
      URL.revokeObjectURL(url)
    })
    recoveryActions.append(recoveryCopy, recoveryDownload, recoveryDone)
    recovery.appendChild(recoveryActions)
    recoveryAck.addEventListener('change', () => { recoveryDone.disabled = !recoveryAck.checked })

    // ---- 两步验证 ----
    // rows/extras/fields/actions 由 section() 创建但不会自动进 DOM，必须显式挂载。
    // 早先这里漏了这一步，于是这一段只剩标题与说明：按钮和二维码都不显示。
    const totp = section(t('totp.title'), t('totp.hint'))
    const totpExtras = el('div')
    // 操作行：每行右侧自带按钮。原先「关闭两步验证 / 重新生成恢复码」只是标题+说明，
    // 按钮被放在另一个区域，看起来像能点却点不动。
    const totpActionRows = el('div', 'ap-rows')
    // 就地提示：用户盯着按钮时，页面顶部那行提示可能已经在视野之外
    const totpNote = el('div', 'ap-local')
    // 恢复码区块就放在这个分区里、紧挨着触发它的按钮——不再搬到面板最顶上，
    // 否则用户点完还得往上滚才能看到结果。
    totp.append(totp.rows, totpExtras, totp.fields, totp.actions, totpActionRows, recovery, totpNote)

    // ---- 通行密钥 ----
    const passkey = section(t('passkey.title'), capabilities.passkeyAvailable === false ? t('passkey.unavailable') : t('passkey.hint'))
    const passkeyRows = el('div', 'ap-rows')
    const passkeyFields = el('div', 'ap-fields')
    passkeyFields.append(field(t('passkey.name'), passkeyName), field(t('deleteNeedsPassword'), passkeyPassword))
    const passkeyActions = el('div', 'ap-actions')
    passkeyActions.appendChild(primary(t('passkey.add'), () => addPasskey()))
    passkey.append(passkeyRows, passkeyFields, passkeyActions)

    // ---- 会话 ----
    const sessionsSection = section(t('sessions.title'), t('sessions.hint'))
    const sessionRows = el('div', 'ap-rows')
    const sessionActions = el('div', 'ap-actions')
    sessionActions.appendChild(button(t('sessions.revokeOthers'), () => revokeOthers()))
    sessionsSection.append(sessionRows, sessionActions)

    root.append(alertError, alertInfo, identity.wrapper, password.wrapper, totp.wrapper, passkey.wrapper, sessionsSection.wrapper)
    // 恢复码区块平时隐藏（display:none），生成/轮换后由 renderRecovery 就地显示在两步验证区内
    recovery.style.display = 'none'

    // ---- 行为 ----
    async function changePassword() {
      clearAlerts()
      if (!pwCurrent.value || !pwNext.value) return error(t('password.required'))
      if (pwNext.value !== pwConfirm.value) return error(t('password.mismatch'))
      const result = await api('/api/auth/password', 'POST', { currentPassword: pwCurrent.value, newPassword: pwNext.value })
      if (result.ok) return window.location.replace('/login?reason=password')
      if (result.body.code === 'weak_password') return error(t('password.weak'))
      if (result.body.code === 'invalid_credentials') return error(t('password.wrong'))
      if (result.body.code === 'password_unchanged') return error(t('password.unchanged'))
      error(t('failed'))
    }

    async function startTotp() {
      clearAlerts()
      localNote(totpNote, '')
      const password = setupPassword.value
      if (!password) return error(t('password.required'))
      const startButton = totp.actions.querySelector('button')
      const result = await withBusy([startButton], [t('working')], () =>
        api('/api/auth/totp/setup', 'POST', { currentPassword: password }))
      if (!result.ok) {
        localNote(totpNote, result.body.code === 'invalid_credentials' ? t('password.wrong') : t('failed'), 'error')
        return error(result.body.code === 'invalid_credentials' ? t('password.wrong') : t('failed'))
      }
      pendingTotp = result.body
      recoveryCodes = null
      renderTotp()
    }

    async function confirmTotp() {
      clearAlerts()
      localNote(totpNote, '')
      if (!/^[0-9]{6}$/.test(totpCode.value)) {
        localNote(totpNote, t('totp.needSixDigits'), 'error')
        return error(t('totp.needSixDigits'))
      }
      const confirmButton = totp.actions.querySelector('button')
      const result = await withBusy([confirmButton], [t('working')], () =>
        api('/api/auth/totp/confirm', 'POST', { challenge: pendingTotp.challenge, code: totpCode.value.trim() }))
      if (!result.ok) {
        const message = result.body.code === 'invalid_second_factor' ? t('totp.codeWrong') : t('failed')
        localNote(totpNote, message, 'error')
        return error(message)
      }
      pendingTotp = null
      totpCode.value = ''
      recoveryCodes = result.body.recoveryCodes || []
      // 服务端此时只是「预备」好，必须靠「完成」才真正启用
      recoveryNeedsActivation = true
      await refresh()
      localNote(totpNote, t('totp.pendingNow'), 'ok')
      // 恢复码区块放在面板最前面，本身就是「必须先处理」的位置\n      renderRecovery()
    }

    /** 轮换恢复码：需要当前密码 + 一个有效第二因素。 */
    async function regenerateRecovery() {
      clearAlerts()
      localNote(totpNote, '')
      const regenerateButton = [...totp.wrapper.querySelectorAll('button')].find((node) => node.textContent === t('totp.regenerate'))
      const result = await withBusy(regenerateButton ? [regenerateButton] : [], [t('working')], () =>
        api('/api/auth/totp/recovery/regenerate', 'POST', {
          currentPassword: offPassword.value,
          code: offCode.value.trim(),
        }))
      if (!result.ok) {
        const message = result.body.code === 'invalid_credentials' ? t('password.wrong')
          : result.body.code === 'invalid_second_factor' ? t('totp.codeWrong')
            : t('failed')
        localNote(totpNote, message, 'error')
        return error(message)
      }
      localNote(totpNote, t('totp.recoveryRotated'), 'ok')
      offPassword.value = ''
      offCode.value = ''
      recoveryCodes = result.body.recoveryCodes || []
      // 轮换时账户已启用：这批码只是展示，不需要（也不能）再启用一次
      recoveryNeedsActivation = false
      await refresh()
      renderRecovery()
    }

    async function disableTotp() {
      clearAlerts()
      localNote(totpNote, '')
      const result = await api('/api/auth/totp/disable', 'POST', { currentPassword: offPassword.value, code: offCode.value.trim() })
      if (result.ok) return window.location.replace('/login?reason=security')
      if (result.body.code === 'invalid_credentials') return error(t('password.wrong'))
      if (result.body.code === 'invalid_second_factor') return error(t('totp.codeWrong'))
      error(t('failed'))
    }

    async function addPasskey() {
      clearAlerts()
      if (!passkeyName.value.trim()) return error(t('passkey.nameRequired'))
      // 新增通行密钥是改凭据，必须再认证：与删除通行密钥共用同一行的当前密码框。
      // 服务端在 begin 阶段校验密码后才签发 challenge，因此 finish 不再重复询问。
      if (!passkeyPassword.value) return error(t('password.required'))
      try {
        const begin = await api('/api/auth/passkey/register/begin', 'POST', { currentPassword: passkeyPassword.value })
        if (!begin.ok) {
          return error(
            begin.body.code === 'passkey_unavailable' ? t('passkey.unavailable')
              : begin.body.code === 'invalid_credentials' ? t('password.wrong')
              : t('failed'),
          )
        }
        const publicKey = {
          ...begin.body.publicKey,
          challenge: decodeBase64Url(begin.body.publicKey.challenge),
          user: { ...begin.body.publicKey.user, id: decodeBase64Url(begin.body.publicKey.user.id) },
          excludeCredentials: (begin.body.publicKey.excludeCredentials || []).map((item) => ({ ...item, id: decodeBase64Url(item.id) })),
        }
        const credential = await navigator.credentials.create({ publicKey })
        const finish = await api('/api/auth/passkey/register/finish', 'POST', {
          challenge: begin.body.challenge,
          name: passkeyName.value.trim(),
          response: serializeCredential(credential),
        })
        if (!finish.ok) return error(t('passkey.failed'))
        passkeyName.value = ''
        passkeyPassword.value = ''
        info(t('passkey.added'))
        await refresh()
      } catch (thrown) {
        error(thrown && thrown.name === 'NotAllowedError' ? t('passkey.cancelled') : t('passkey.failed'))
      }
    }

    async function removePasskey(id) {
      clearAlerts()
      if (!passkeyPassword.value) return error(t('password.required'))
      const result = await api('/api/auth/passkey/delete', 'POST', { id, currentPassword: passkeyPassword.value })
      if (!result.ok) return error(result.body.code === 'invalid_credentials' ? t('password.wrong') : t('failed'))
      info(t('passkey.removed'))
      await refresh()
    }

    async function revokeSession(id) {
      clearAlerts()
      const result = await api('/api/auth/sessions/revoke', 'POST', { id })
      if (!result.ok) return error(t('failed'))
      info(t('sessions.revoked'))
      await refresh()
    }

    async function revokeOthers() {
      clearAlerts()
      const result = await api('/api/auth/sessions/revoke', 'POST', { all: true })
      if (!result.ok) return error(t('failed'))
      info(fill('sessions.revokedOthers', { n: result.body.removed ?? 0 }))
      await refresh()
    }

    /**
     * 渲染恢复码区块。只有刚生成/轮换出来时才出现；确认后即从界面上移除
     * （码不再保存在面板里，避免被后续操作重新显示出来）。
     *
     * 位置固定在两步验证分区内，紧挨着触发它的按钮：用户点完就能看到结果，不必往上滚。
     */
    function renderRecovery() {
      const active = Array.isArray(recoveryCodes) && recoveryCodes.length > 0
      recovery.style.display = active ? '' : 'none'
      recoveryGrid.textContent = ''
      recoveryAck.checked = false
      recoveryDone.disabled = true
      if (!active) return
      for (const code of recoveryCodes) recoveryGrid.appendChild(el('span', null, code))
    }

    function renderIdentity() {
      identityRows.textContent = ''
      identityRows.appendChild(row(t('username'), null, el('span', 'ap-pill', user.username)))
      identityRows.appendChild(row(t('role'), null, el('span', 'ap-pill', capabilities.multiUser === false ? `${user.role} · ${t('singleUser')}` : user.role)))
    }

    function renderTotp() {
      totp.rows.textContent = ''
      totpExtras.textContent = ''
      totp.fields.textContent = ''
      totp.actions.textContent = ''
      totpActionRows.textContent = ''
      const enabled = user.totpEnabled === true

      totp.rows.appendChild(row(
        t('totp.state'),
        enabled ? `${t('totp.on')} · ${fill('totp.recoveryLeft', { n: user.recoveryCodesLeft ?? 0 })}` : t('totp.off'),
        null,
      ))

      if (!enabled && user.totpPending) {
        // 已确认验证码但还没点「完成」：两步验证尚未启用。
        // 恢复码明文只在确认那一次到手，因此「手上还有码」才允许继续完成；
        // 否则只能重新开始（清掉服务端的半成品），免得用户在没码的情况下被保护起来。
        // 两种情况下都要给出醒目的「需完成设置」标记——用户可能已经离开过页面，
        // 再次回来时更需要知道这个账户处在什么状态。
        const hasCodes = Array.isArray(recoveryCodes) && recoveryCodes.length > 0
        const control = el('div', 'ap-row-control')
        control.appendChild(el('span', 'ap-pill ap-pill--warn', t('totp.statePending')))
        if (!hasCodes) {
          control.appendChild(button(t('totp.startOver'), async () => {
            clearAlerts()
            const result = await api('/api/auth/totp/cancel', 'POST', {})
            if (!result.ok) return error(t('failed'))
            await refresh()
            localNote(totpNote, t('totp.startOverDone'), 'ok')
          }))
        }
        totp.rows.appendChild(row(t('totp.state'), hasCodes ? t('totp.pendingHint') : t('totp.pendingLost'), control))
        localNote(totpNote, t('totp.pendingSetupHint'), 'warn')
        return
      }

      // 不在待确认状态时清掉那行警告，避免它残留
      if (totpNote.className === 'ap-local is-warn') localNote(totpNote, '')

      if (enabled) {
        // 已开启：两个安全操作各占一行，按钮就在行内右侧；共用同一组
        // 「当前密码 + 验证码或恢复码」输入。
        totp.fields.append(field(t('password.current'), offPassword), field(t('totp.codeOrRecovery'), offCode))
        totpActionRows.appendChild(row(
          t('totp.regenerate'),
          t('totp.regenerateHint'),
          danger(t('totp.regenerate'), () => regenerateRecovery()),
        ))
        totpActionRows.appendChild(row(
          t('totp.disable'),
          t('totp.disableHint'),
          danger(t('totp.disable'), () => disableTotp()),
        ))
        return
      }

      if (!pendingTotp) {
        // 未开启：先要当前密码，再签发密钥与二维码
        totp.fields.appendChild(field(t('password.current'), setupPassword))
        totp.actions.appendChild(primary(t('totp.start'), () => startTotp()))
        return
      }

      // 已签发，等待用户用验证器扫码并回填验证码
      const picture = el('div', 'ap-qr')
      if (pendingTotp.otpauthQrDataUri) {
        const image = el('img')
        image.alt = t('totp.scan')
        image.src = pendingTotp.otpauthQrDataUri
        picture.appendChild(image)
      } else {
        picture.appendChild(el('div', 'ap-note', t('totp.noQr')))
      }
      const text = el('div', 'ap-qr-text')
      text.appendChild(el('strong', null, t('totp.secret')))
      text.appendChild(el('code', null, pendingTotp.secret))
      text.appendChild(el('strong', null, t('totp.uri')))
      text.appendChild(el('code', null, pendingTotp.otpauthUri))
      picture.appendChild(text)
      totpExtras.appendChild(picture)
      totp.fields.appendChild(field(t('totp.code'), totpCode))
      totp.actions.append(
        button(t('totp.confirm'), () => confirmTotp()),
        button(t('totp.cancel'), () => { pendingTotp = null; setupPassword.value = ''; renderTotp() }),
      )
    }

    function renderPasskeys() {
      passkeyRows.textContent = ''
      if (passkeys.length === 0) {
        passkeyRows.appendChild(row(t('passkey.empty'), null, null))
        return
      }
      for (const passkey_ of passkeys) {
        const detail = `${fill('passkey.createdAt', { time: formatTime(passkey_.createdAt) })} · ${passkey_.lastUsedAt ? fill('passkey.lastUsed', { time: formatTime(passkey_.lastUsedAt) }) : t('passkey.neverUsed')}`
        passkeyRows.appendChild(row(passkey_.name || passkey_.id.slice(0, 12), detail, danger(t('delete'), () => removePasskey(passkey_.id))))
      }
    }

    function renderSessions() {
      sessionRows.textContent = ''
      for (const session of sessions) {
        const title = `${session.ip || '—'}${session.current ? ` · ${t('sessions.current')}` : ''}`
        const detail = `${session.loginMethod} · ${formatTime(session.lastSeenAt)}`
        const control = session.current ? el('span', 'ap-pill', t('sessions.current')) : danger(t('sessions.revoke'), () => revokeSession(session.id))
        sessionRows.appendChild(row(title, detail, control))
      }
    }

    async function refresh() {
      const [session, sessionList, passkeyList, status] = await Promise.all([
        api('/api/auth/session'),
        api('/api/auth/sessions'),
        api('/api/auth/passkeys'),
        api('/api/auth/status'),
      ])
      if (!session.ok) {
        // 会话失效时说明原因，否则用户只会看到自己突然被弹回登录页
        window.location.replace('/login?redirect=/account&reason=session')
        return
      }
      user = session.body.user
      capabilities = status.ok ? status.body : {}
      sessions = sessionList.ok ? (sessionList.body.sessions || []) : []
      passkeys = passkeyList.ok ? (passkeyList.body.passkeys || []) : []
      csrf = readCookie(CSRF_COOKIE) || csrf
      const passkeyEnabled = capabilities.passkeyAvailable === true
      passkey.fields.style.display = passkeyEnabled ? '' : 'none'
      passkey.actions.style.display = passkeyEnabled ? '' : 'none'
      renderIdentity()
      renderTotp()
      renderPasskeys()
      renderSessions()
      renderRecovery()
    }

    await refresh()
    return { reload: refresh }
  }

  window.DSHAccountPanel = { mount }
})()
