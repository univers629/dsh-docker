// 账户面板的 DOM 行为测试：把面板真的挂到 DOM 上跑一遍。
//
// 为什么必须这样测：上一版 TOTP 那几个容器忘了 append，静态看代码毫无破绽、字符串断言也
// 通不过任何检查，但页面上就是「只有标题和说明，没有按钮也没有二维码」。只有真的渲染一次
// 才能看见这类缺失。这里用 jsdom 提供 DOM，用桩 fetch 提供网关响应。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../bin/package.json', import.meta.url))
const { JSDOM } = require('jsdom')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const panelSource = fs.readFileSync(path.join(root, 'bin', 'dsh-auth-web', 'account-panel.js'), 'utf8')

const QR_DATA_URI = 'data:image/svg+xml;base64,PHN2Zy8+'

/** 造一个 DOM 环境，并装上可编程的 fetch 桩。 */
function makeEnvironment(responses) {
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><head></head><body><div id="host"></div></body></html>', {
    url: 'https://dsh.example.com/account',
    runScripts: 'outside-only',
  })
  const context = dom.window
  const calls = []
  // 监视 window.prompt：面板不应该再用浏览器弹窗收密码
  let promptCalls = 0
  context.prompt = () => { promptCalls += 1; return null }
  context.fetch = async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`
    calls.push({ url, method: init.method ?? 'GET', body: init.body })
    const handler = responses[key] ?? responses[url]
    if (!handler) throw new Error(`unexpected request: ${key}`)
    // 必须 await：桩要能模拟「请求还在进行中」，否则忙碌态那一瞬间会被跳过
    const payload = await (typeof handler === 'function' ? handler(init) : handler)
    return {
      ok: payload.ok !== false,
      status: payload.status ?? (payload.ok === false ? 400 : 200),
      json: async () => payload.body ?? {},
    }
  }
  context.window.document.cookie = 'dsh_auth_csrf=test-csrf-token'
  // 面板脚本以 IIFE 形式挂在 window 上；jsdom 的 window 自带 window 与 globalThis 引用，
  // 不要再赋值（它们是只读 getter）。
  context.eval(panelSource)
  return {
    dom,
    context,
    calls,
    promptCount: () => promptCalls,
    callsFor: (path) => calls.filter((entry) => entry.url === path).length,
  }
}

const baseResponses = (overrides = {}) => ({
  'GET /api/auth/session': { body: { user: { id: 'u1', username: 'alice', role: 'user', totpEnabled: false, recoveryCodesLeft: 0, passkeyCount: 0 } } },
  'GET /api/auth/sessions': { body: { sessions: [{ id: 's1', current: true, loginMethod: 'password', ip: '203.0.113.7', lastSeenAt: Date.now() }] } },
  'GET /api/auth/passkeys': { body: { passkeys: [] } },
  'GET /api/auth/status': { body: { ok: true, multiUser: true, passkeyAvailable: false, workspace: true, adminPanel: true } },
  ...overrides,
})

// ---- 1) 每个分区都必须真的渲染出控件 ----
{
  const { context } = makeEnvironment(baseResponses())
  const host = context.document.getElementById('host')
  await context.window.DSHAccountPanel.mount(host, { lang: 'zh' })

  const headings = [...host.querySelectorAll('.ap-section > h3')].map((node) => node.textContent)
  for (const expected of ['登录密码', '两步验证（TOTP）', '通行密钥（Passkey）', '登录会话']) {
    assert.ok(headings.includes(expected), `the panel must render the ${expected} section`)
  }

  // 登录密码：三个输入框 + 一个提交按钮
  const passwordSection = [...host.querySelectorAll('.ap-section')].find((node) => node.querySelector('h3')?.textContent === '登录密码')
  assert.equal(passwordSection.querySelectorAll('input').length, 3, 'the password section renders three inputs')
  assert.ok([...passwordSection.querySelectorAll('button')].some((node) => node.textContent === '修改密码'), 'the password section renders its submit button')

  // 两步验证：这就是上一版缺失的地方——必须有输入框与按钮，而不只是标题与说明
  const totpSection = [...host.querySelectorAll('.ap-section')].find((node) => node.querySelector('h3')?.textContent.startsWith('两步验证'))
  // 恢复码区块也在这个分区内（平时隐藏），其中带一个勾选框，因此按类型断言而不是总数
  assert.equal(totpSection.querySelectorAll('input[type="password"]').length, 1, 'the TOTP section must render its password input')
  // 按钮文案是「动词 + 对象」，与 GitHub 的 "Enable two-factor authentication" 同形。
  // 旧文案「开始开启」是重复动词，这里显式禁止它回来（用拼接避免这行本身被批量替换改写）。
  const startButton = [...totpSection.querySelectorAll('button')].find((node) => node.textContent === '开启两步验证')
  assert.ok(startButton, 'the TOTP section must render its start button')
  const duplicatedVerbLabel = ['开始', '开启'].join('')
  assert.equal(
    [...totpSection.querySelectorAll('button')].some((node) => node.textContent === duplicatedVerbLabel),
    false,
    'the duplicated-verb label must not come back',
  )
  assert.ok(totpSection.textContent.includes('未开启'), 'the TOTP section shows the current state')

  // 通行密钥与登录会话也要有内容
  const passkeySection = [...host.querySelectorAll('.ap-section')].find((node) => node.querySelector('h3')?.textContent.startsWith('通行密钥'))
  assert.ok(passkeySection.textContent.includes('还没有添加通行密钥'), 'the passkey section lists its state')
  const sessionSection = [...host.querySelectorAll('.ap-section')].find((node) => node.querySelector('h3')?.textContent.startsWith('登录会话'))
  assert.ok(sessionSection.textContent.includes('203.0.113.7'), 'the session section lists the current session')
}

// ---- 2) 走完开通流程后必须出现二维码 ----
{
  const environment = makeEnvironment(baseResponses({
    'POST /api/auth/totp/setup': {
      body: { ok: true, secret: 'S6AKG6DQNTKUOLLITWVRZPDMGFV6Z4J7', otpauthUri: 'otpauth://totp/DSH:alice?secret=S6AKG6DQNTKUOLLITWVRZPDMGFV6Z4J7&issuer=DSH', otpauthQrDataUri: QR_DATA_URI, challenge: 'flow-token' },
    },
  }))
  const { context, calls } = environment
  const host = context.document.getElementById('host')
  await context.window.DSHAccountPanel.mount(host, { lang: 'zh' })

  const totpSection = [...host.querySelectorAll('.ap-section')].find((node) => node.querySelector('h3')?.textContent.startsWith('两步验证'))
  const passwordInput = totpSection.querySelector('input')
  passwordInput.value = 'current-password-1'
  ;[...totpSection.querySelectorAll('button')].find((node) => node.textContent === '开启两步验证').click()
  await new Promise((resolve) => setTimeout(resolve, 50))

  const setupCall = calls.find((call) => call.url === '/api/auth/totp/setup')
  assert.ok(setupCall, 'the password is submitted to the gateway')
  assert.equal(JSON.parse(setupCall.body).currentPassword, 'current-password-1', 'the typed password is the current password')
  assert.equal(environment.promptCount(), 0, 'the current password is collected inline, not through a browser prompt')

  const image = totpSection.querySelector('.ap-qr img')
  assert.ok(image, 'the TOTP setup must render the QR code image')
  assert.equal(image.src, QR_DATA_URI, 'the image is exactly what the gateway returned')
  assert.ok(totpSection.textContent.includes('S6AKG6DQNTKUOLLITWVRZPDMGFV6Z4J7'), 'the secret stays available for manual entry')
  assert.ok(totpSection.textContent.includes('otpauth://totp/'), 'the otpauth URI stays available too')
  assert.ok([...totpSection.querySelectorAll('button')].some((node) => node.textContent === '确认并开启'), 'the confirm button appears')
  assert.ok([...totpSection.querySelectorAll('button')].some((node) => node.textContent === '取消'), 'the cancel button appears')

  // 取消后回到未开启状态，且二维码消失
  ;[...totpSection.querySelectorAll('button')].find((node) => node.textContent === '取消').click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(totpSection.querySelector('.ap-qr'), null, 'cancelling removes the QR code')
  assert.ok([...totpSection.querySelectorAll('button')].some((node) => node.textContent === '开启两步验证'), 'cancelling restores the start button')
}

// ---- 3) 二维码渲染失败时必须给出兜底说明，而不是留一片空白 ----
{
  const { context } = makeEnvironment(baseResponses({
    'POST /api/auth/totp/setup': {
      body: { ok: true, secret: 'S6AKG6DQNTKUOLLITWVRZPDMGFV6Z4J7', otpauthUri: 'otpauth://totp/DSH:alice?secret=AA', otpauthQrDataUri: null, challenge: 'flow-token' },
    },
  }))
  const host = context.document.getElementById('host')
  await context.window.DSHAccountPanel.mount(host, { lang: 'zh' })
  const totpSection = [...host.querySelectorAll('.ap-section')].find((node) => node.querySelector('h3')?.textContent.startsWith('两步验证'))
  totpSection.querySelector('input').value = 'current-password-1'
  ;[...totpSection.querySelectorAll('button')].find((node) => node.textContent === '开启两步验证').click()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(totpSection.querySelector('.ap-qr img'), null, 'no image when the gateway could not render one')
  assert.ok(totpSection.textContent.includes('手动输入'), 'the user is told to enter the secret manually')
}

// ---- 4) 已开启时展示关闭入口，而不是开通入口 ----
{
  const { context } = makeEnvironment(baseResponses({
    'GET /api/auth/session': { body: { user: { id: 'u1', username: 'alice', role: 'user', totpEnabled: true, recoveryCodesLeft: 7, passkeyCount: 0 } } },
  }))
  const host = context.document.getElementById('host')
  await context.window.DSHAccountPanel.mount(host, { lang: 'zh' })
  const totpSection = [...host.querySelectorAll('.ap-section')].find((node) => node.querySelector('h3')?.textContent.startsWith('两步验证'))
  assert.ok(totpSection.textContent.includes('剩余恢复码 7 个'), 'the remaining recovery codes are shown')
  assert.ok([...totpSection.querySelectorAll('button')].some((node) => node.textContent === '关闭两步验证'), 'the disable button appears')
  assert.ok(![...totpSection.querySelectorAll('button')].some((node) => node.textContent === '开启两步验证'), 'the start button is gone')
}

// ---- 5) 恢复码必须是阻断式步骤：警告 + 勾选确认，且离开后不再显示 ----
{
  const RECOVERY = ['AAAAA-BBBBB-CCCCC', 'DDDDD-EEEEE-FFFFF', 'GGGGG-HHHHH-IIIII', 'JJJJJ-KKKKK-LLLLL']
  const environment = makeEnvironment(baseResponses({
    'POST /api/auth/totp/setup': {
      body: { ok: true, secret: 'S6AKG6DQNTKUOLLITWVRZPDMGFV6Z4J7', otpauthUri: 'otpauth://totp/DSH:alice?secret=AA', otpauthQrDataUri: QR_DATA_URI, challenge: 'flow-token' },
    },
    'POST /api/auth/totp/confirm': { body: { ok: true, pending: true, recoveryCodes: RECOVERY } },
    'POST /api/auth/totp/activate': { body: { ok: true } },
  }))
  const { context } = environment
  const host = context.document.getElementById('host')
  await context.window.DSHAccountPanel.mount(host, { lang: 'zh' })

  const totpSection = () => [...host.querySelectorAll('.ap-section')].find((node) => node.querySelector('h3')?.textContent.startsWith('两步验证'))
  totpSection().querySelector('input').value = 'current-password-1'
  ;[...totpSection().querySelectorAll('button')].find((node) => node.textContent === '开启两步验证').click()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const totpCodeInput = totpSection().querySelector('.ap-otp')
  totpCodeInput.value = '123456'
  ;[...totpSection().querySelectorAll('button')].find((node) => node.textContent === '确认并开启').click()
  await new Promise((resolve) => setTimeout(resolve, 80))

  const recovery = host.querySelector('.ap-recovery')
  assert.ok(recovery, 'the recovery block exists')
  assert.notEqual(recovery.style.display, 'none', 'the recovery block is shown after enabling two-step verification')
  // 位置：就在两步验证分区里，紧挨着触发它的按钮——用户点完不需要往上滚
  assert.ok(totpSection().contains(recovery), 'the recovery block lives inside the TOTP section, next to the button that produced it')
  assert.ok(!host.querySelector('.ap-root > .ap-recovery'), 'it is not hoisted to the top of the panel any more')

  // 警告文案：说清楚这是唯一退路、只显示这一次
  const warning = recovery.querySelector('.ap-warning')
  assert.ok(warning, 'a warning is shown')
  assert.ok(warning.textContent.includes('唯一退路'), 'the warning explains it is the only way back in')
  assert.ok(warning.textContent.includes('只显示这一次'), 'the warning says it is shown once')

  // 全部恢复码都列出来
  const shown = [...recovery.querySelectorAll('.ap-codes span')].map((node) => node.textContent)
  assert.deepEqual(shown, RECOVERY, 'every recovery code is listed')

  // 必须勾选确认才能关闭
  const ack = recovery.querySelector('.ap-ack input')
  const done = [...recovery.querySelectorAll('button')].find((node) => node.textContent === '完成')
  assert.ok(ack, 'an acknowledgement checkbox is required')
  assert.equal(done.disabled, true, 'the done button is disabled until acknowledged')
  ack.checked = true
  ack.dispatchEvent(new context.window.Event('change'))
  assert.equal(done.disabled, false, 'acknowledging enables the done button')

  // 提供复制与下载
  const labels = [...recovery.querySelectorAll('button')].map((node) => node.textContent)
  assert.ok(labels.includes('复制全部'), 'the codes can be copied')
  assert.ok(labels.includes('下载为文本'), 'the codes can be downloaded')

  // 点「完成」= 真正启用两步验证
  assert.ok(environment.callsFor('/api/auth/totp/activate') === 0, 'activation has not happened yet')
  done.click()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(environment.callsFor('/api/auth/totp/activate'), 1, 'Done calls the activation endpoint')
  assert.equal(recovery.style.display, 'none', 'after acknowledging, the block is gone for good')
}

// ---- 6) 已开启时提供恢复码轮换入口，且复用同一组验证输入 ----
{
  const ROTATED = ['MMMMM-NNNNN-OOOOO', 'PPPPP-QQQQQ-RRRRR']
  const environment = makeEnvironment(baseResponses({
    'GET /api/auth/session': { body: { user: { id: 'u1', username: 'alice', role: 'user', totpEnabled: true, recoveryCodesLeft: 0, passkeyCount: 0 } } },
    'POST /api/auth/totp/recovery/regenerate': { body: { ok: true, recoveryCodes: ROTATED } },
  }))
  const { context, calls } = environment
  const host = context.document.getElementById('host')
  await context.window.DSHAccountPanel.mount(host, { lang: 'zh' })

  const totpSection = [...host.querySelectorAll('.ap-section')].find((node) => node.querySelector('h3')?.textContent.startsWith('两步验证'))
  assert.ok(totpSection.textContent.includes('剩余恢复码 0 个'), 'the remaining count is shown')
  const regenerate = [...totpSection.querySelectorAll('button')].find((node) => node.textContent === '重新生成恢复码')
  assert.ok(regenerate, 'rotation is offered when codes are used up')

  const inputs = [...totpSection.querySelectorAll('input')]
  inputs[0].value = 'current-password-1'
  inputs[1].value = '123456'
  regenerate.click()
  await new Promise((resolve) => setTimeout(resolve, 80))

  const call = calls.find((entry) => entry.url === '/api/auth/totp/recovery/regenerate')
  assert.ok(call, 'rotation calls the gateway')
  const payload = JSON.parse(call.body)
  assert.equal(payload.currentPassword, 'current-password-1', 'rotation re-authenticates with the password')
  assert.equal(payload.code, '123456', 'rotation demands a second factor')
  const shown = [...host.querySelectorAll('.ap-recovery .ap-codes span')].map((node) => node.textContent)
  assert.deepEqual(shown, ROTATED, 'the rotated codes are shown in the blocking step')

  // 轮换之后账户**已经启用**：点「完成」只是收起这一块，不能再调 activate，
  // 否则服务端以 totp_already_enabled 拒绝，界面显示成「操作未完成」。
  const done = [...host.querySelectorAll('.ap-recovery button')].find((node) => node.textContent === '完成')
  const ack = host.querySelector('.ap-recovery .ap-ack input')
  assert.ok(done && ack, 'the blocking step offers acknowledge + Done')
  ack.checked = true
  ack.dispatchEvent(new context.window.Event('change'))
  done.click()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(environment.callsFor('/api/auth/totp/activate'), 0, 'Done must not call activate after a rotation')
  assert.equal(host.querySelector('.ap-recovery').style.display, 'none', 'the block is dismissed')
  const notes = [...host.querySelectorAll('.ap-local')].map((n) => n.textContent).filter(Boolean)
  assert.ok(notes.some((text) => text.includes('保持开启')), 'the user is told two-step verification stays enabled')
}

// ---- 7) 反馈必须出现在按钮旁边，而不是只在页面顶部 ----
// 用户在 DSH 设置面板里往下滚动看按钮时，页面顶部那行提示已经在视野之外，
// 于是「点了没反应」——这条断言锁住就地反馈与忙碌态。
{
  const environment = makeEnvironment(baseResponses({
    'POST /api/auth/totp/setup': {
      body: { ok: true, secret: 'S6AKG6DQNTKUOLLITWVRZPDMGFV6Z4J7', otpauthUri: 'otpauth://totp/DSH:alice?secret=AA', otpauthQrDataUri: QR_DATA_URI, challenge: 'flow-token' },
    },
    // 失败响应：code 要放在响应体里，面板读的是 body.code
    'POST /api/auth/totp/confirm': { ok: false, status: 401, body: { ok: false, code: 'invalid_second_factor' } },
  }))
  const { context } = environment
  const host = context.document.getElementById('host')
  await context.window.DSHAccountPanel.mount(host, { lang: 'zh' })
  const totpSection = () => [...host.querySelectorAll('.ap-section')].find((n) => n.querySelector('h3')?.textContent.startsWith('两步验证'))
  const byText = (scope, text) => [...scope.querySelectorAll('button')].find((n) => n.textContent === text)

  totpSection().querySelector('input').value = 'current-password-1'
  byText(totpSection(), '开启两步验证').click()
  await new Promise((r) => setTimeout(r, 50))

  // 校验码输入框只收数字：粘贴带空格的内容会被清成纯数字
  const otp = totpSection().querySelector('.ap-otp')
  otp.value = '12 34 56'
  otp.dispatchEvent(new context.window.Event('input'))
  assert.equal(otp.value, '123456', 'the code input keeps digits only')

  // 验证码不合法时就地提示，不发请求
  otp.value = '123'
  otp.dispatchEvent(new context.window.Event('input'))
  byText(totpSection(), '确认并开启').click()
  await new Promise((r) => setTimeout(r, 30))
  const local = totpSection().querySelector('.ap-local')
  assert.ok(local, 'the TOTP section carries an in-place message element')
  assert.ok(local.textContent.includes('6 位'), 'it explains that six digits are required')
  assert.equal(local.className.includes('is-error'), true, 'the in-place message is styled as an error')

  // 验证码被服务端拒绝时就地提示，紧挨着按钮
  otp.value = '000000'
  otp.dispatchEvent(new context.window.Event('input'))
  byText(totpSection(), '确认并开启').click()
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(local.textContent.includes('验证码不正确'), 'a rejected code is reported in place')
}

// ---- 8) 请求进行中按钮进入忙碌态 ----
{
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const environment = makeEnvironment(baseResponses({
    'POST /api/auth/totp/setup': async () => {
      await gate
      return { body: { ok: true, secret: 'S6AKG6DQNTKUOLLITWVRZPDMGFV6Z4J7', otpauthUri: 'otpauth://totp/x?secret=AA', otpauthQrDataUri: QR_DATA_URI, challenge: 'flow' } }
    },
  }))
  const { context } = environment
  const host = context.document.getElementById('host')
  await context.window.DSHAccountPanel.mount(host, { lang: 'zh' })
  const totpSection = [...host.querySelectorAll('.ap-section')].find((n) => n.querySelector('h3')?.textContent.startsWith('两步验证'))
  totpSection.querySelector('input').value = 'current-password-1'
  const start = [...totpSection.querySelectorAll('button')].find((n) => n.textContent === '开启两步验证')
  start.click()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(start.disabled, true, 'the button is disabled while the request is in flight')
  assert.equal(start.textContent, '处理中…', 'the button says what is happening')
  release()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(totpSection.querySelector('.ap-qr img')?.src, QR_DATA_URI, 'the QR code appears once the request settles')
}

// ---- 9) 安全操作行必须自带按钮，而不是只有标题与说明 ----
// 用户看到「关闭两步验证 / 重新生成恢复码」两行时以为能点，实际按钮在别处——
// 这条断言锁住「行内就有控件」。
{
  const environment = makeEnvironment(baseResponses({
    'GET /api/auth/session': { body: { user: { id: 'u1', username: 'alice', role: 'user', totpEnabled: true, recoveryCodesLeft: 4, passkeyCount: 0 } } },
  }))
  const { context } = environment
  const host = context.document.getElementById('host')
  await context.window.DSHAccountPanel.mount(host, { lang: 'zh' })
  const totpSection = [...host.querySelectorAll('.ap-section')].find((n) => n.querySelector('h3')?.textContent.startsWith('两步验证'))

  // 每一条有动作的行，行内必须有按钮
  const actionRows = [...totpSection.querySelectorAll('.ap-row')].filter((row) => row.querySelector('button'))
  const labels = actionRows.map((row) => row.querySelector('.ap-row-text strong')?.textContent)
  assert.ok(labels.includes('关闭两步验证'), 'the disable row carries its own button')
  assert.ok(labels.includes('重新生成恢复码'), 'the regenerate row carries its own button')
  for (const row of actionRows) {
    const title = row.querySelector('.ap-row-text strong').textContent
    assert.ok(
      [...row.querySelectorAll('button')].some((node) => node.textContent === title),
      `the ${title} row must contain a button with that label`,
    )
  }
  // 描述性说明仍在，用户知道这一步要什么
  assert.ok(totpSection.textContent.includes('需要当前密码'), 'the rows still explain what each action needs')
}

// ---- 10) 待确认状态必须醒目：这是「没保存恢复码就离开」的唯一提示 ----
{
  const environment = makeEnvironment(baseResponses({
    'GET /api/auth/session': { body: { user: { id: 'u1', username: 'alice', role: 'user', totpEnabled: false, totpPending: true, recoveryCodesLeft: 0, passkeyCount: 0 } } },
  }))
  const { context } = environment
  const host = context.document.getElementById('host')
  await context.window.DSHAccountPanel.mount(host, { lang: 'zh' })
  const totpSection = [...host.querySelectorAll('.ap-section')].find((n) => n.querySelector('h3')?.textContent.startsWith('两步验证'))

  const pill = totpSection.querySelector('.ap-pill--warn')
  assert.ok(pill, 'a warning-styled chip marks the pending enrolment')
  assert.equal(pill.textContent, '需完成设置', 'the chip says the setup is incomplete')
  const note = totpSection.querySelector('.ap-local.is-warn')
  assert.ok(note, 'a warning line spells out what is missing')
  assert.ok(note.textContent.includes('尚未启用'), 'it states that two-step verification is not active yet')
  // 待确认时不应出现「开始开启」，否则用户会以为可以从头再来
  assert.equal([...totpSection.querySelectorAll('button')].some((n) => n.textContent === '开启两步验证'), false, 'the start button is gone while pending')
}

// ---- 11) 服务端说 pending，但界面已无恢复码明文 → 只能重新开始 ----
{
  const environment = makeEnvironment(baseResponses({
    'GET /api/auth/session': { body: { user: { id: 'u1', username: 'alice', role: 'user', totpEnabled: false, totpPending: true, recoveryCodesLeft: 0, passkeyCount: 0 } } },
    'POST /api/auth/totp/cancel': { body: { ok: true, cancelled: true } },
  }))
  const { context, calls } = environment
  const host = context.document.getElementById('host')
  await context.window.DSHAccountPanel.mount(host, { lang: 'zh' })
  const totpSection = [...host.querySelectorAll('.ap-section')].find((n) => n.querySelector('h3')?.textContent.startsWith('两步验证'))
  const startOver = [...totpSection.querySelectorAll('button')].find((n) => n.textContent === '重新开始')
  assert.ok(startOver, 'a way to discard an unfinished enrolment is offered')
  assert.ok(totpSection.textContent.includes('恢复码已不再显示'), 'the user is told the codes can no longer be shown')
  startOver.click()
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(calls.some((entry) => entry.url === '/api/auth/totp/cancel'), 'starting over clears the pending state on the server')
}

// ---- 12) 管理面板的人机验证标签：读取填充、保存提交、密钥不回显 ----
{
  const adminHtml = fs.readFileSync(path.join(root, 'bin', 'dsh-auth-web', 'admin.html'), 'utf8')
  const dom = new JSDOM(adminHtml, { url: 'https://dsh.example.com/admin', runScripts: 'outside-only' })
  const context = dom.window
  context.document.cookie = 'dsh_auth_csrf=test-csrf-token'

  const calls = []
  const config = {
    ok: true,
    providers: [
      { id: 'turnstile', label: 'Cloudflare Turnstile', script: 'https://challenges.cloudflare.com/turnstile/v0/api.js' },
      { id: 'hcaptcha', label: 'hCaptcha', script: 'https://js.hcaptcha.com/1/api.js' },
      { id: 'recaptcha', label: 'reCAPTCHA v2', script: 'https://www.google.com/recaptcha/api.js' },
    ],
    enabled: true,
    provider: 'hcaptcha',
    siteKey: 'site-key-abc',
    secretConfigured: true,
    active: true,
  }
  context.fetch = async (url, init = {}) => {
    const target = new URL(url, 'https://dsh.example.com')
    calls.push({ url: target.pathname, method: init.method ?? 'GET', body: init.body })
    const payload = target.pathname === '/api/admin/captcha' && (init.method ?? 'GET') === 'GET' ? config : { ok: true }
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
  }
  context.eval(adminHtml.slice(adminHtml.indexOf('<script>') + 8, adminHtml.lastIndexOf('</script>')))

  // 切到人机验证标签
  const tab = context.document.querySelector('[data-tab="captcha"]')
  assert.ok(tab, 'the admin panel has a human-verification tab')
  tab.click()
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.ok(calls.some((entry) => entry.url === '/api/admin/captcha'), 'opening the tab reads the settings')
  const select = context.document.getElementById('captcha-provider')
  assert.equal(select.options.length, 3, 'the provider list is rendered from the server response')
  assert.equal(select.value, 'hcaptcha', 'the saved provider is selected')
  assert.equal(context.document.getElementById('captcha-site-key').value, 'site-key-abc', 'the site key is filled in')
  assert.equal(context.document.getElementById('captcha-enabled').checked, true, 'the enable switch reflects the saved state')
  // 密钥输入框永远是空的：服务端不回显，界面也不该伪造一个值
  assert.equal(context.document.getElementById('captcha-secret').value, '', 'the secret field starts empty')
  const secretState = context.document.getElementById('captcha-secret-state').textContent
  assert.ok(
    secretState.includes('已配置') || secretState.includes('configured'),
    `it says the secret is already configured, got: ${secretState}`,
  )

  // 保存：留空表示不修改，请求体里不应出现 secret
  const siteKeyInput = context.document.getElementById('captcha-site-key')
  siteKeyInput.value = 'site-key-updated'
  context.document.getElementById('captcha-save').click()
  await new Promise((resolve) => setTimeout(resolve, 60))
  const saveCall = calls.filter((entry) => entry.method === 'POST').at(-1)
  assert.ok(saveCall, 'saving posts to the settings endpoint')
  const payload = JSON.parse(saveCall.body)
  assert.equal(payload.siteKey, 'site-key-updated')
  assert.equal(payload.provider, 'hcaptcha')
  assert.equal('secret' in payload, false, 'an empty secret field means "keep the current one"')
}

console.log('dsh-account-panel dom smoke: ok')
