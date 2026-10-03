// 管理面板的渲染契约测试。
//
// 存在的理由：只用字符串检查源码（admin.html 里有没有 "column-actions"）无法发现
// 「创建了元素但忘了 append 进 DOM」这类错误——操作列的三个按钮曾经只存在于内存里，
// 单元格渲染成空白，而所有基于字符串的断言全部通过。只有真正用 jsdom 跑一遍页面、
// 再检查渲染后的 DOM，才看得见这类问题。
//
// 覆盖：
//   1. 模型开放页每行 4 个单元格，卡片列为 .pick[aria-pressed]，操作列有 3 个按钮
//   2. 实例页保留列是 .mini 按钮（不是 .pill 药丸），且能在固化/自动回收之间切换文案
//   3. 设置区两个输入框包装在 .input-wrap 里（与其它页面同一套控件外观）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../bin/package.json', import.meta.url))
const { JSDOM } = require('jsdom')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webDir = path.join(root, 'bin', 'dsh-auth-web')

/** 启动一个把网关接口打桩好的管理面板页面，返回 { dom, doc }。 */
async function bootPanel({ instances = [], models = [], available = [], registration = {} } = {}) {
  const html = fs.readFileSync(path.join(webDir, 'admin.html'), 'utf8')
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:8899/admin',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url) => {
        const u = String(url)
        let body = { ok: true }
        if (u.includes('/api/auth/session')) body = { user: { role: 'root', username: 'root' } }
        else if (u.includes('/api/admin/registration')) {
          body = { ok: true, registrationOpen: true, inviteRequired: false, inviteCode: '', ...registration }
        } else if (u.includes('/api/admin/model-access')) {
          body = { ok: true, brokerReachable: true, available, users: models }
        } else if (u.includes('/api/admin/instances')) {
          body = {
            ok: true,
            watermark: 'normal',
            onlineCount: instances.length,
            idleTimeoutMs: 1_800_000,
            memoryMbPerInstance: 200,
            settings: { idleTimeoutSeconds: 1800, memoryMb: 200 },
            defaults: { idleTimeoutSeconds: 1800, memoryMb: 200 },
            instances,
          }
        } else if (u.includes('/api/admin/users')) body = { ok: true, users: [] }
        else if (u.includes('/api/admin/audit')) body = { ok: true, entries: [] }
        return { ok: true, status: 200, json: async () => body }
      }
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 350))
  return { dom, doc: dom.window.document }
}

/** 切到某个标签页并等它的异步加载落地。 */
async function openTab(doc, name) {
  const tab = [...doc.querySelectorAll('.tabs button')].find((b) => b.dataset.tab === name)
  assert.ok(tab, `the ${name} tab exists`)
  tab.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
}

// ---- 1) 模型开放：卡片 + 三按钮操作列 ----
{
  const { doc } = await bootPanel({
    available: ['GPT 6 Luna', 'Claude Opus 5.5', 'DeepSeek V4'],
    models: [
      { username: 'alice', uid: 100000, role: 'user', status: 'enabled', allowedUpstreams: null },
      { username: 'bob', uid: 100001, role: 'user', status: 'enabled', allowedUpstreams: ['GPT 6 Luna'] },
    ],
  })
  await openTab(doc, 'models')

  const rows = doc.querySelectorAll('#models-body tr')
  assert.equal(rows.length, 2, 'both accounts appear')

  const first = rows[0]
  const cells = first.querySelectorAll('td')
  assert.equal(cells.length, 4, 'each row has four columns (user, status, cards, actions)')

  // 卡片列：每个上游一张卡，状态用 aria-pressed 表达
  const cards = cells[2].querySelectorAll('.pick')
  assert.equal(cards.length, 3, 'every upstream renders as a card')
  assert.equal(cells[2].querySelectorAll('[aria-pressed]').length, 3, 'card state is exposed via aria-pressed')
  assert.ok(cells[2].classList.contains('cell--cards'), 'the card cell opts out of nowrap so it can wrap')
  // 默认全开（allowedUpstreams === null）→ 三张卡都是 pressed
  assert.ok([...cards].every((c) => c.getAttribute('aria-pressed') === 'true'), 'a default account has every upstream pressed')

  // 操作列：三个按钮必须真的渲染进 DOM，而不只是被创建
  const column = cells[3].querySelector('.column-actions')
  assert.ok(column, 'the action column contains its button stack')
  const labels = [...column.querySelectorAll('button')].map((b) => b.textContent)
  assert.equal(labels.length, 3, 'the action column renders exactly three buttons')
  assert.ok(cells[3].classList.contains('cell--actions'), 'the action cell keeps its own width')

  // 点卡片能切换状态（局部状态，不需要往返）
  cards[0].click()
  assert.equal(cards[0].getAttribute('aria-pressed'), 'false', 'clicking a card toggles it off')
  cards[0].click()
  assert.equal(cards[0].getAttribute('aria-pressed'), 'true', 'clicking again toggles it back on')

  // 第二行只开了一个上游
  const secondCards = rows[1].querySelectorAll('.pick')
  const pressed = [...secondCards].filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.textContent)
  assert.deepEqual(pressed, ['GPT 6 Luna'], 'a specific allowance renders only its granted cards as pressed')
}

// ---- 2) 实例页：保留列是按钮，不是药丸 ----
{
  const { doc } = await bootPanel({
    instances: [
      { uid: 100000, name: 'dsh-u1', status: 'running', running: true, busy: false, pinned: false, usedBytes: 1024, lastSeenAt: Date.now() },
      { uid: 100001, name: 'dsh-u2', status: 'running', running: true, busy: true, pinned: true, usedBytes: 2048, lastSeenAt: Date.now() },
    ],
  })
  await openTab(doc, 'instances')

  const rows = doc.querySelectorAll('#instances-body tr')
  assert.equal(rows.length, 2, 'both instances appear')

  // 保留列（最后一格）只能有按钮，不能混用状态药丸——药丸是 999px 胶囊 + 11.5px 字，
  // 与同排的 .mini 按钮属于两套圆角与字号。
  const retentionCells = [...rows].map((r) => r.lastElementChild)
  for (const cell of retentionCells) {
    assert.ok(cell.querySelector('button.mini'), 'the retention cell holds a mini button')
    assert.equal(cell.querySelectorAll('.pill').length, 0, 'the retention cell must not mix in a status pill')
  }
  const texts = retentionCells.map((c) => c.querySelector('button').textContent)
  assert.equal(new Set(texts).size, 2, 'pinned and unpinned rows show different button labels')

  // 固化态用主色按钮表示，未固化用幽灵按钮
  const classes = retentionCells.map((c) => c.querySelector('button').className)
  assert.ok(classes.some((c) => c.includes('mini--primary')), 'a pinned instance is marked with the primary button')
  assert.ok(classes.some((c) => !c.includes('mini--primary')), 'an auto-reclaimed instance uses the plain button')
}

// ---- 3) 注册策略：两个独立开关，邀请码区按需出现 ----
{
  // 情形 A：开放注册 + 免邀请码 → 邀请码区隐藏（它不生效，显示会误导）
  const { doc } = await bootPanel({ registration: { registrationOpen: true, inviteRequired: false } })
  const openToggle = doc.getElementById('registration-open')
  const inviteToggle = doc.getElementById('invite-required')
  assert.ok(openToggle && inviteToggle, 'both registration switches render')
  assert.equal(openToggle.checked, true, 'registration defaults to open')
  assert.equal(inviteToggle.checked, false, 'an invite code is not required by default')
  assert.equal(inviteToggle.disabled, false, 'the invite switch is usable while registration is open')
  assert.equal(doc.getElementById('invite-block').style.display, 'none', 'the invite code block hides when no code is required')

  // 情形 B：要求邀请码 → 显示当前邀请码
  const withCode = await bootPanel({ registration: { registrationOpen: true, inviteRequired: true, inviteCode: 'ABCD1234EFGH5678' } })
  assert.equal(withCode.doc.getElementById('invite-block').style.display, '', 'the invite code block shows when a code is required')
  assert.equal(withCode.doc.getElementById('invite-value').textContent, 'ABCD1234EFGH5678', 'the current code is shown')

  // 情形 C：关闭注册 → 邀请码开关被禁用（此时它没有意义），但仍保留其值
  const closed = await bootPanel({ registration: { registrationOpen: false, inviteRequired: true, inviteCode: 'ZZZZ' } })
  assert.equal(closed.doc.getElementById('registration-open').checked, false, 'a closed policy renders unchecked')
  assert.equal(closed.doc.getElementById('invite-required').disabled, true, 'the invite switch is disabled while registration is closed')
  assert.equal(closed.doc.getElementById('invite-block').style.display, 'none', 'no invite code is offered while registration is closed')
}

// ---- 4) 设置区输入框与其它页面同一套控件外观 ----
{
  const { doc } = await bootPanel({ instances: [] })
  await openTab(doc, 'instances')
  for (const id of ['idle-timeout', 'instance-memory']) {
    const input = doc.getElementById(id)
    assert.ok(input, `${id} exists`)
    assert.ok(input.closest('.input-wrap'), `${id} is wrapped like every other field`)
  }
  // 保存按钮与输入框同高：靠 .mini--field 提升到 --control-height
  const save = doc.getElementById('settings-save')
  assert.ok(save, 'the settings save button exists')
  assert.ok(save.className.includes('mini--field'), 'the settings save button matches the input height')
  // 字段容器复用 .field（app.css 统一定义），而不是另写一套 gap 与字号
  assert.ok(doc.getElementById('idle-timeout').closest('.field'), 'the field container is the shared .field class')
  // 人机验证的保存按钮同样与输入框同高
  assert.ok(doc.getElementById('captcha-save').className.includes('mini--field'), 'the captcha save button matches the input height')
}

process.stdout.write('dsh-admin-panel render smoke: ok\n')
