// DSH 密钥管理面板的前端。
//
// 三个约定：
//   1. 令牌只放 sessionStorage，并且只以 Authorization 头发送。不用 cookie，因此
//      不存在 CSRF 面；地址栏里带 ?token= 的话会在读到之后立刻从 URL 里抹掉。
//   2. 页面上的所有文本都用 textContent 写，不拼 HTML 字符串。
//   3. 任何时候都不显示密钥：后端只回一个指纹，用来回答"这次填的是不是同一把"。

const TOKEN_KEY = 'dsh-key-admin-token'
// rows 是模型清单表的全部状态：一条一个模型，带着它自己的勾选、能力与推理档位。
// 表里显示的行不等于要保存的行——只有 checked 的那些会写进 keys.json，这就是"左边
// 勾选框决定最后保存哪些模型"。
const S = { token: '', state: null, editing: '', rows: [], fetched: false }

const byId = (id) => document.getElementById(id)

// 服务端会在 /api/state 里给出档位全集（thinkingLevels），这里的常量只是它到达之前的
// 兜底，保持和 dsh-key-admin-policy.mjs（THINKING_LEVELS）一致。
const FALLBACK_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// 档位的中文注解，只用在提示里：真正的值（写进配置的那个字符串）永远是英文档位名。
const LEVEL_NOTES = {
  off: '不思考（不发任何推理参数；只勾它没有意义，至少再勾一个别的档位）',
  minimal: '最少的推理',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
}

const thinkingLevels = () => (S.state ? S.state.thinkingLevels : FALLBACK_THINKING_LEVELS)

function log(text) {
  byId('log').textContent = text
}

function status(node, text, kind) {
  const target = byId(node)
  target.textContent = text
  target.className = 'status' + (kind ? ' ' + kind : '')
}

async function api(path, body) {
  const headers = { authorization: 'Bearer ' + S.token }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  const text = await response.text()
  let payload = {}
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { message: text.slice(0, 400) }
    }
  }
  if (!response.ok) throw new Error(payload.message || ('HTTP ' + response.status))
  return payload
}

function shapeOptions() {
  const select = byId('shape')
  select.textContent = ''
  for (const shape of S.state.apiShapes) {
    const option = document.createElement('option')
    option.value = shape.id
    option.textContent = shape.id + ' — ' + shape.label
    select.appendChild(option)
  }
}

function headerRow(name, value) {
  const row = document.createElement('div')
  row.className = 'row'
  const nameField = document.createElement('label')
  nameField.className = 'field'
  const nameInput = document.createElement('input')
  nameInput.className = 'header-name'
  nameInput.placeholder = 'originator'
  nameInput.spellcheck = false
  nameInput.value = name || ''
  nameField.appendChild(nameInput)
  const valueField = document.createElement('label')
  valueField.className = 'field'
  const valueInput = document.createElement('input')
  valueInput.className = 'header-value'
  valueInput.placeholder = 'codex_cli_rs'
  valueInput.spellcheck = false
  valueInput.value = value || ''
  valueField.appendChild(valueInput)
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.textContent = '删除'
  remove.addEventListener('click', () => row.remove())
  row.appendChild(nameField)
  row.appendChild(valueField)
  row.appendChild(remove)
  return row
}

function renderList() {
  const list = byId('list')
  list.textContent = ''
  if (S.state.upstreams.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'hint'
    empty.textContent = '还没有任何上游。下面填一个：名字、base_url、密钥，其余都有默认值。'
    list.appendChild(empty)
    return
  }
  for (const view of S.state.upstreams) {
    const item = document.createElement('div')
    item.className = 'item'
    const left = document.createElement('div')
    const title = document.createElement('strong')
    title.textContent = view.name
    const meta = document.createElement('div')
    meta.className = 'meta'
    const bits = [view.shape, view.baseUrl]
    bits.push(view.models.length > 0 ? view.models.length + ' 个模型' : '模型清单沿用 DSH 内置目录')
    if (view.requestsPerMinute > 0) bits.push(view.requestsPerMinute + ' 次/分钟')
    if (view.dailyRequestBudget > 0) bits.push(view.dailyRequestBudget + ' 次/天')
    if (view.extraHeaders.length > 0) bits.push(view.extraHeaders.length + ' 个固定头')
    // 能力与档位是逐模型的，所以这里数的是"有几个模型声明过"，不再是一串共用的档位名：
    // 写出名字反而会让人以为整条上游都吃那几个档位。
    const withLevels = view.models.filter((model) => model.reasoningEfforts.length > 0).length
    if (withLevels > 0) bits.push(withLevels + ' 个模型声明了推理档位')
    const withImage = view.models.filter((model) => model.input.indexOf('image') !== -1).length
    if (withImage > 0) bits.push(withImage + ' 个模型吃图像')
    bits.push('密钥指纹 ' + (view.keyFingerprint || '无'))
    // 这条是“面板能拉到模型、DSH 网页里 403”的唯一可见线索：拉清单时面板会容错地
    // 试 /v1/models，缺版本段在这一侧完全看不出来。
    if (view.needsVersionSegment) bits.push('base_url 少版本段：点编辑再保存一次即可自动改对')
    meta.textContent = bits.join(' · ')
    left.appendChild(title)
    left.appendChild(meta)
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.textContent = '编辑'
    edit.addEventListener('click', () => fillForm(view))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'danger'
    remove.textContent = '删除'
    remove.addEventListener('click', () => deleteUpstream(view.name, 'auth-status'))
    const buttons = document.createElement('div')
    buttons.className = 'row-actions'
    buttons.appendChild(edit)
    buttons.appendChild(remove)
    item.appendChild(left)
    item.appendChild(buttons)
    list.appendChild(item)
  }
}

/**
 * 删除一个上游的密钥和配置。
 *
 * 列表里每条都带一个删除按钮，不用先点“编辑”：在 DSH 的模型页删掉那张卡片并不会
 * 动 keys.json（那是宿主上的文件，DSH 读不到），所以清掉残留的上游只能在这里做。
 */
function deleteUpstream(name, statusNode) {
  return guard(statusNode, async () => {
    if (name === '' || !window.confirm('删除上游 ' + name + ' 的密钥和配置？DSH 侧那条供应商要自己去 WebUI 删。')) return
    const payload = await api('/api/upstreams/delete', { name })
    await refresh()
    if (S.editing === name) fillForm(null)
    status(statusNode, '已删除 ' + name + '。', 'good')
    log(seedSummary(payload))
  })
}

function fillForm(view) {
  S.editing = view ? view.name : ''
  S.fetched = false
  byId('form-title').textContent = view ? '编辑上游：' + view.name : '新增上游'
  byId('name').value = view ? view.name : ''
  byId('shape').value = view ? view.shape : 'any'
  byId('base-url').value = view ? view.baseUrl : ''
  byId('key').value = ''
  byId('model-search').value = ''
  byId('model-manual').value = ''
  // 打开一条已存的上游：它的模型全在表里、全勾上。新建时表是空的——模型只能靠拉取或手写。
  setModelRows(view ? view.models : [], 'saved')
  byId('rpm').value = view ? String(view.requestsPerMinute) : '0'
  byId('daily').value = view ? String(view.dailyRequestBudget) : '0'
  byId('key-hint').textContent = view && view.hasKey
    ? '这个上游已有密钥（指纹 ' + view.keyFingerprint + '）。要换密钥就填新的，不换就留空。'
    : '新上游必须填一次密钥。'
  const headers = byId('headers')
  headers.textContent = ''
  if (view) {
    for (const header of view.extraHeaders) headers.appendChild(headerRow(header.name, header.value))
  }
  status('form-status', '', '')
  window.scrollTo({ top: byId('form-title').offsetTop - 20, behavior: 'smooth' })
}

function readForm() {
  const extraHeaders = []
  for (const row of byId('headers').querySelectorAll('.row')) {
    const name = row.querySelector('.header-name').value.trim()
    const value = row.querySelector('.header-value').value.trim()
    if (name === '' && value === '') continue
    extraHeaders.push({ name, value })
  }
  return {
    name: byId('name').value.trim(),
    shape: byId('shape').value,
    baseUrl: byId('base-url').value.trim(),
    key: byId('key').value,
    rename: S.editing,
    // 只有勾上的模型进这份清单：它同时是 keys.json 的模型清单和 DSH 那边的模型清单。
    models: checkedRows().map(recordFromRow),
    extraHeaders,
    // 两个限额框留空时发空串，后端把它当成"沿用 keys.json 里的现值"；要取消限制得填 0。
    requestsPerMinute: byId('rpm').value.trim(),
    dailyRequestBudget: byId('daily').value.trim(),
  }
}

// --- 模型清单与每个模型的能力、推理档位 ---
//
// 一次改动就够说明这里的形状：从前"模型清单"是一个文本框，"推理强度档位"挂在整条上游上，
// 两者分在两节。可档位本来就是逐模型的事实（同一个网关里 gpt-5 吃 reasoning_effort，
// 图像模型不吃），挂在上游上等于逼用户把不同口味的模型拆成两个上游。现在合成一张表：
// 一行一个模型，左边勾选框决定它要不要保存，右边是它自己的调用能力与档位。

function newRow(id, origin, checked) {
  return { id, name: '', vision: false, levels: {}, checked, origin }
}

/** keys.json / 接口里的模型记录 -> 表里的一行。 */
function rowFromRecord(record, origin, checked) {
  const row = newRow(record.id, origin, checked)
  row.name = record.name || ''
  row.vision = Array.isArray(record.input) && record.input.indexOf('image') !== -1
  for (const level of record.reasoningEfforts || []) row.levels[level] = true
  return row
}

/** 表里的行 -> 接口要的记录。没声明的字段一律不写：空数组在 pi-ai 那边就是"不声明"。 */
function recordFromRow(row) {
  const record = { id: row.id }
  if (row.vision) record.input = ['text', 'image']
  const levels = thinkingLevels().filter((level) => row.levels[level])
  if (levels.length > 0) record.reasoningEfforts = levels
  return record
}

/** 整张表替换成一份记录（打开某条上游、保存成功之后回填）。 */
function setModelRows(records, origin) {
  S.rows = (records || []).map((record) => rowFromRecord(record, origin, true))
  if (origin === 'fetched') S.fetched = true
  renderModelTable()
}

/**
 * 拉回来的清单 -> 表里的行。
 *
 * 两件事让"拉一次"不会毁掉已经填好的东西：
 *   1. 已经存在的 id 沿用原来的能力与档位（上游返回的信息里本来也没有这些）；
 *   2. 保存过、但这次上游没返回的 id 留在表里并标注出来——静默丢掉一个模型，
 *      用户只会在 DSH 里发现某个模型不见了，那时候早就想不起来是哪一步弄丢的；
 *   3. 取消过勾选的 id 保持不勾。"拉取"回答的是"上游有哪些模型"，不是"我要哪些"，
 *      所以它不能把用户刚做的取舍冲掉（冲掉了再点一次保存，模型就被悄悄加回去了）。
 * 前两种都只是"留在表里"，要不要留仍然由勾选框决定。
 */
function applyFetched(ids) {
  const previous = new Map(S.rows.map((row) => [row.id, row]))
  const rows = ids.map((id) => {
    const old = previous.get(id)
    if (old) {
      previous.delete(id)
      return { ...old, origin: 'fetched' }
    }
    return newRow(id, 'fetched', true)
  })
  const kept = S.rows.filter((row) => previous.has(row.id))
    .map((row) => ({ ...row, origin: 'missing' }))
  S.rows = rows.concat(kept)
  S.fetched = true
  renderModelTable()
  return { added: rows.length - kept.length, kept: kept.length, off: rows.filter((row) => !row.checked).length }
}

function visibleRows() {
  const query = byId('model-search').value.trim().toLowerCase()
  if (query === '') return S.rows
  return S.rows.filter((row) => row.id.toLowerCase().indexOf(query) !== -1)
}

const checkedRows = () => S.rows.filter((row) => row.checked)

function modelChip(text, on, locked, title, onToggle) {
  const label = document.createElement('label')
  label.className = 'mchip' + (on ? ' on' : '') + (locked ? ' locked' : '')
  label.title = title
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = on
  input.disabled = locked
  if (!locked) input.addEventListener('change', () => onToggle(input.checked))
  label.appendChild(input)
  const caption = document.createElement('span')
  caption.textContent = text
  label.appendChild(caption)
  return label
}

function renderModelTable() {
  const tbody = byId('model-rows')
  tbody.textContent = ''
  const rows = visibleRows()

  if (S.rows.length === 0 || rows.length === 0) {
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.className = 'empty'
    td.colSpan = 4
    td.textContent = S.rows.length === 0
      ? (S.fetched
        ? '上游没有返回任何模型 id。手写一个加进来，或者在下面直接保存——目录里的上游留空就是沿用内置清单。'
        : '还没有模型。点上面的「向上游拉取模型列表」，或者在下面手写一个 id 加进来。')
      : '没有匹配「' + byId('model-search').value.trim() + '」的模型。'
    tr.appendChild(td)
    tbody.appendChild(tr)
    renderModelCount()
    return
  }

  for (const row of rows) {
    const tr = document.createElement('tr')
    // 没勾上的行整体压暗：这张表里"会不会被保存"是最要紧的一件事，只靠最左边那个
    // 小方框要一行一行数。压暗只影响观感，勾选框本身照旧能点。
    if (!row.checked) tr.className = 'off'

    const ckCell = document.createElement('td')
    ckCell.className = 'ck'
    const ck = document.createElement('input')
    ck.type = 'checkbox'
    ck.checked = row.checked
    ck.title = '勾上才会保存进 keys.json 并写进 DSH'
    ck.addEventListener('change', () => {
      row.checked = ck.checked
      // 就地改类名而不是重画整张表：重画会把滚动位置和"刚点的那一行"一起弄丢。
      tr.classList.toggle('off', !row.checked)
      renderModelCount()
    })
    ckCell.appendChild(ck)
    tr.appendChild(ckCell)

    const nameCell = document.createElement('td')
    const idLine = document.createElement('div')
    idLine.className = 'mid'
    idLine.textContent = row.id
    nameCell.appendChild(idLine)
    if (row.name && row.name !== row.id) {
      const nameLine = document.createElement('div')
      nameLine.className = 'sub'
      nameLine.textContent = row.name
      nameCell.appendChild(nameLine)
    }
    if (row.origin === 'missing') {
      const missing = document.createElement('div')
      missing.className = 'missing'
      missing.textContent = '这次上游没返回它（保存会留着，不想要就取消勾选）'
      nameCell.appendChild(missing)
    }
    tr.appendChild(nameCell)

    const abilityCell = document.createElement('td')
    const ability = document.createElement('div')
    ability.className = 'chips'
    // 文本永远是通的：pi-ai 不声明 input 时的默认就是 text，所以这一颗只是把事实写出来，
    // 不给点。要声明的是"这个模型还吃图"——那才是需要写进配置的额外能力。
    ability.appendChild(modelChip('文本', true, true, '文本输入是默认能力，不用声明', () => {}))
    ability.appendChild(modelChip('图像', row.vision, false,
      '勾上 = 声明这个模型吃图像输入（写进 DSH 的 input: [text, image]）',
      (on) => { row.vision = on; renderModelTable() }))
    abilityCell.appendChild(ability)
    tr.appendChild(abilityCell)

    const levelCell = document.createElement('td')
    const chips = document.createElement('div')
    chips.className = 'chips'
    for (const level of thinkingLevels()) {
      chips.appendChild(modelChip(level, !!row.levels[level], false, LEVEL_NOTES[level] || level, (on) => {
        if (on) row.levels[level] = true
        else delete row.levels[level]
        renderModelTable()
      }))
    }
    if (thinkingLevels().every((level) => !row.levels[level])) {
      // 一行都不勾 = 不声明。这句话是整列的规则，不是这一行的状态：逐行写一遍会变成
      // 满屏重复，所以只在标题栏上说一次（见 index.html 的表头说明）。
      const undeclared = document.createElement('span')
      undeclared.className = 'sub undeclared'
      undeclared.textContent = '不声明'
      chips.appendChild(undeclared)
    }
    levelCell.appendChild(chips)
    tr.appendChild(levelCell)

    tbody.appendChild(tr)
  }
  renderModelCount()
}

function renderModelCount() {
  const checked = checkedRows().length
  const shown = visibleRows().length
  const parts = ['已选 ' + checked + '/' + S.rows.length]
  if (shown !== S.rows.length) parts.push('显示 ' + shown)
  byId('model-count').textContent = parts.join(' · ')
  const all = byId('model-toggle-all')
  all.checked = shown > 0 && visibleRows().every((row) => row.checked)
  all.indeterminate = !all.checked && checked > 0
  renderBulkLevels()
}

/** 批量操作只作用于勾选的模型；一个都没勾时作用于当前显示的全部。 */
function bulkTargets() {
  const selected = checkedRows()
  return selected.length > 0 ? selected : visibleRows()
}

function bulkNote() {
  const targets = bulkTargets()
  if (targets.length === 0) {
    status('form-status', '表里没有模型可以设置。', 'bad')
    return []
  }
  const selected = checkedRows().length > 0
  status('form-status', (selected ? '已作用于勾选的 ' : '没有勾选，已作用于当前显示的 ')
    + targets.length + ' 个模型，别忘了保存。', '')
  return targets
}

function applyBulkLevel(level, on) {
  const targets = bulkNote()
  if (targets.length === 0) return
  for (const row of targets) {
    if (on) row.levels[level] = true
    else delete row.levels[level]
  }
  renderModelTable()
}

/**
 * 批量档位药丸。亮着 = 目标里的每个模型都声明了这一档；点一下就是给目标加上／去掉它。
 * 它们跟着表格一起重画，所以"点完按钮变成亮的"这件事不需要另外记状态。
 */
function renderBulkLevels() {
  const box = byId('bulk-levels')
  box.textContent = ''
  const targets = bulkTargets()
  for (const level of thinkingLevels()) {
    const all = targets.length > 0 && targets.every((row) => row.levels[level])
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mchip' + (all ? ' on' : '')
    button.textContent = level
    button.title = '给勾选的模型加上 ' + level + '（' + (LEVEL_NOTES[level] || level) + '）；都加上之后再点就是取消'
    button.addEventListener('click', () => applyBulkLevel(level, !all))
    box.appendChild(button)
  }
}

function applyBulkVision(on) {
  const targets = bulkNote()
  if (targets.length === 0) return
  for (const row of targets) row.vision = on
  renderModelTable()
}

/** 手写一个模型 id：上游不实现 /models 时的唯一出路。 */
function addManualModel() {
  const input = byId('model-manual')
  const id = input.value.trim()
  if (id === '') return
  if (/[\s,'"\\]/.test(id)) {
    status('form-status', '模型 id 不能含空白、逗号、引号或反斜杠：' + id, 'bad')
    return
  }
  const existing = S.rows.find((row) => row.id === id)
  if (existing) {
    // 已经在表里就不再插一行：同一条 id 出现两次，保存时的记录会互相覆盖，
    // 而用户看到的只是"点了没反应"。
    existing.checked = true
    input.value = ''
    renderModelTable()
    status('form-status', id + ' 已经在清单里了，已替你勾上。', '')
    return
  }
  S.rows.push(newRow(id, 'manual', true))
  input.value = ''
  renderModelTable()
  status('form-status', '已加入 ' + id + '，别忘了保存。', '')
}

function seedSummary(payload) {
  const lines = []
  if (payload.brokerReload) lines.push(payload.brokerReload)
  if (payload.seed && payload.seed.output) lines.push(payload.seed.output.trim())
  // 警告要显示：退出码为 0 但某个上游被跳过时，只有这里说得出"DSH 那边没多出这条"。
  if (payload.seed && payload.seed.warnings) lines.push(payload.seed.warnings)
  if (payload.seed && payload.seed.failed) lines.push('[写 DSH 配置失败] ' + payload.seed.error)
  return lines.join('\n') || '完成。'
}

// --- 容器出站策略 ---
//
// 一条条目 = 勾选框（启停）+ 域名 + 备注 + 删除。勾选而不是直接删，是因为"临时放开一条
// 隧道域名"和"永久不管这条"是两回事，取消勾选保留了原因（备注）也保留了恢复的成本。
function entryRow(entry, placeholder) {
  const row = document.createElement('div')
  row.className = 'row'
  const toggle = document.createElement('input')
  toggle.type = 'checkbox'
  toggle.className = 'entry-enabled'
  toggle.checked = entry ? entry.enabled !== false : true
  toggle.title = '取消勾选 = 这条留着但不生效'
  const hostField = document.createElement('label')
  hostField.className = 'field'
  const host = document.createElement('input')
  host.className = 'entry-host'
  host.spellcheck = false
  host.autocomplete = 'off'
  host.placeholder = placeholder
  host.value = entry ? entry.host : ''
  hostField.appendChild(host)
  const noteField = document.createElement('label')
  noteField.className = 'field'
  const note = document.createElement('input')
  note.className = 'entry-note'
  note.spellcheck = false
  note.autocomplete = 'off'
  note.placeholder = '备注（可留空）'
  note.value = entry ? entry.note : ''
  noteField.appendChild(note)
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.textContent = '删除'
  remove.addEventListener('click', () => row.remove())
  row.appendChild(toggle)
  row.appendChild(hostField)
  row.appendChild(noteField)
  row.appendChild(remove)
  return row
}

function renderEntries(node, entries, placeholder) {
  const box = byId(node)
  box.textContent = ''
  for (const entry of entries) box.appendChild(entryRow(entry, placeholder))
}

function readEntries(node) {
  const out = []
  for (const row of byId(node).querySelectorAll('.row')) {
    const host = row.querySelector('.entry-host').value.trim()
    if (host === '') continue
    out.push({
      host,
      enabled: row.querySelector('.entry-enabled').checked,
      note: row.querySelector('.entry-note').value.trim(),
    })
  }
  return out
}

function renderEgress() {
  const egress = S.state.egress
  if (!egress) {
    byId('egress-panel').hidden = true
    return
  }
  byId('egress-panel').hidden = false
  byId('egress-mode').value = egress.policy.mode
  byId('egress-allow-mode').value = egress.policy.allowMode
  renderEntries('egress-allow', egress.policy.allow, 'search.example.com 或 *.example.com')
  renderEntries('egress-block', egress.policy.block, '*.example.com')
  const lines = []
  if (egress.deploymentMode === 'open') {
    lines.push('当前部署是 open：容器直接出网，不经过 dsh-egress，所以这份策略现在不生效。'
      + '要让它生效，在宿主上重跑 ./install.sh，出站那一问选 blocklist 或 allowlist。'
      + '（这两个模式之间的切换是热的，只有 open ↔ 隔离要重跑安装器。）')
  } else {
    lines.push('当前部署是 ' + egress.deploymentMode + '：容器出网只走 dsh-egress，这份策略立刻生效（代理 5 秒内跟上）。'
      + '要回到 open 得在宿主上重跑 ./install.sh。')
  }
  lines.push('策略文件：' + egress.policyPath + (egress.exists ? '' : '（还没写过，下面是默认值）'))
  if (egress.error) lines.push(egress.error)
  byId('egress-deployment').textContent = lines.join(' ')
}

async function refresh() {
  S.state = await api('/api/state')
  shapeOptions()
  renderList()
  renderEgress()
  status('auth-status', '已连接。密钥代理地址 ' + S.state.brokerBase + '，配置文件 ' + S.state.configPath + '。', 'good')
}

async function connect() {
  const value = byId('token').value.trim()
  if (value === '') {
    status('auth-status', '先填令牌。', 'bad')
    return
  }
  S.token = value
  try {
    await refresh()
    sessionStorage.setItem(TOKEN_KEY, value)
    byId('token').value = ''
    if (S.state.upstreams.length > 0) fillForm(null)
    else renderModelTable()
  } catch (error) {
    status('auth-status', String(error.message || error), 'bad')
  }
}

async function guard(node, action) {
  try {
    status(node, '处理中...', '')
    await action()
  } catch (error) {
    status(node, String(error.message || error), 'bad')
  }
}

function main() {
  const query = new URLSearchParams(window.location.search)
  const fromQuery = query.get('token')
  const stored = sessionStorage.getItem(TOKEN_KEY)
  if (fromQuery) {
    // 令牌不留在地址栏里：浏览器历史、书签和 Referer 都会带走它。
    window.history.replaceState(null, '', window.location.pathname)
  }
  const initial = fromQuery || stored || ''
  if (initial !== '') {
    byId('token').value = initial
    connect()
  }

  byId('save-token').addEventListener('click', connect)
  byId('token').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') connect()
  })
  byId('forget-token').addEventListener('click', () => {
    sessionStorage.removeItem(TOKEN_KEY)
    S.token = ''
    S.state = null
    byId('list').textContent = ''
    status('auth-status', '已忘记令牌。', '')
  })
  byId('new').addEventListener('click', () => fillForm(null))
  byId('add-header').addEventListener('click', () => byId('headers').appendChild(headerRow('', '')))
  byId('name').addEventListener('blur', () => {
    const name = byId('name').value.trim()
    if (!S.state || byId('base-url').value.trim() !== '') return
    const preset = S.state.defaultBaseUrls[name]
    if (preset) byId('base-url').value = preset
    const shape = S.state.defaultShapes[name]
    if (shape) byId('shape').value = shape
  })
  // --- 模型清单表 ---
  byId('model-search').addEventListener('input', () => renderModelTable())
  byId('model-toggle-all').addEventListener('change', (event) => {
    // 只作用于当前显示的行：搜着 "gpt" 时点全选框，不该把别的模型也一起勾上。
    for (const row of visibleRows()) row.checked = event.target.checked
    renderModelTable()
  })
  byId('model-select-none').addEventListener('click', () => {
    for (const row of visibleRows()) row.checked = false
    renderModelTable()
  })
  byId('model-invert').addEventListener('click', () => {
    for (const row of visibleRows()) row.checked = !row.checked
    renderModelTable()
  })
  byId('model-add').addEventListener('click', addManualModel)
  byId('model-manual').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addManualModel()
  })
  // 批量档位：一排档位药丸直接把档位打到"勾选的模型"（没勾选则打到当前显示的）身上。
  // 逐模型勾一遍 200 个不现实，但"这批模型都吃 low/medium/high"才是常见情况。
  // 它们是真的按钮，不是勾选框：点一下就是"给选中的这批加上这一档"，再点一下取消。
  renderBulkLevels()
  byId('bulk-levels-none').addEventListener('click', () => {
    const targets = bulkNote()
    if (targets.length === 0) return
    for (const row of targets) row.levels = {}
    renderModelTable()
  })
  byId('bulk-vision-on').addEventListener('click', () => applyBulkVision(true))
  byId('bulk-vision-off').addEventListener('click', () => applyBulkVision(false))
  byId('fetch-models').addEventListener('click', () => guard('form-status', async () => {
    const payload = await api('/api/models', readForm())
    const applied = applyFetched(payload.models)
    // 拉取成功只说明"这个地址上有模型列表"，不代表 base_url 对：清单只在带版本段的地址上
    // 有，而 DSH 发请求时不补版本段。所以拉到之后顺手把 base_url 改对，否则用户看到的
    // 就是"面板能拉到模型、网页里一用就说密钥无效"。
    const kept = (applied.kept > 0
      ? '其中 ' + applied.kept + ' 个是已保存、这次上游没返回的，留在表里并标了出来，不想要就取消勾选。'
      : '') + (applied.off > 0 ? '另外 ' + applied.off + ' 个你取消过勾选，保持没勾。' : '')
    if (payload.suggestedBaseUrl) {
      byId('base-url').value = payload.suggestedBaseUrl
      status('form-status', '模型列表在 ' + payload.endpoint + '（' + payload.models.length + ' 个）。'
        + 'base_url 少了版本段，已替你改成 ' + payload.suggestedBaseUrl
        + '——DSH 发请求时不会自己补这一段，不改就会 403。' + kept, 'good')
    } else {
      status('form-status', '上游 ' + payload.endpoint + ' 返回了 ' + payload.models.length
        + ' 个模型。' + kept, 'good')
    }
    log(payload.models.join('\n') || '（上游没有返回任何模型 id）')
  }))
  byId('save').addEventListener('click', () => guard('form-status', async () => {
    const payload = await api('/api/upstreams', readForm())
    await refresh()
    S.editing = payload.name
    byId('form-title').textContent = '编辑上游：' + payload.name
    byId('key').value = ''
    // 保存时 base_url 和模型清单可能被自动改过（补版本段、自动拉清单），表单要跟着变，
    // 不然下一次保存又会把旧值写回去。回填也用服务端那份：它才是真正落盘的内容。
    if (payload.baseUrl) byId('base-url').value = payload.baseUrl
    if (Array.isArray(payload.models)) setModelRows(payload.models, 'saved')
    // "已保存"只是说 keys.json 写进去了。模型清单在这张表里编辑之后，DSH 那边写不进去
    // 就等于这次编辑没生效，所以那种情况不能再报成一句干净的绿色成功。
    const seed = payload.seed ?? {}
    const warned = Boolean(seed.warnings)
    if (seed.failed) {
      status('form-status', '密钥已保存，但写 DSH 配置失败（见下方日志），模型清单还没生效。', 'bad')
    } else if (warned) {
      status('form-status', '已保存 ' + payload.name + '；DSH 那边有没写进去的上游，见下方日志。', 'bad')
    } else {
      status('form-status', '已保存 ' + payload.name + '。', 'good')
    }
    log(seedSummary(payload))
  }))
  byId('delete').addEventListener('click', () => deleteUpstream(byId('name').value.trim(), 'form-status'))
  byId('egress-allow-add').addEventListener('click', () => {
    byId('egress-allow').appendChild(entryRow(null, 'search.example.com 或 *.example.com'))
  })
  byId('egress-block-add').addEventListener('click', () => {
    byId('egress-block').appendChild(entryRow(null, '*.example.com'))
  })
  byId('egress-builtin').addEventListener('click', () => {
    const egress = S.state && S.state.egress
    if (!egress) return
    log('append 模式下始终放行的内置源（不用自己填）：\n' + egress.builtinAllow.join('\n'))
  })
  byId('egress-block-default').addEventListener('click', () => {
    const egress = S.state && S.state.egress
    if (!egress) return
    // 只补缺的，不动已有条目：用户取消过勾选或改过备注的那些要保留。
    const present = new Set(readEntries('egress-block').map((entry) => entry.host.toLowerCase()))
    let added = 0
    for (const builtin of egress.builtinBlock) {
      if (present.has(builtin.host.toLowerCase())) continue
      byId('egress-block').appendChild(entryRow({ host: builtin.host, enabled: true, note: builtin.note }, '*.example.com'))
      added += 1
    }
    status('egress-status', added > 0 ? '补了 ' + added + ' 条内置隧道域名，别忘了保存。' : '内置隧道域名都在清单里了。', '')
  })
  byId('egress-save').addEventListener('click', () => guard('egress-status', async () => {
    const payload = await api('/api/egress', {
      policy: {
        mode: byId('egress-mode').value,
        allowMode: byId('egress-allow-mode').value,
        allow: readEntries('egress-allow'),
        block: readEntries('egress-block'),
      },
    })
    S.state.egress = payload.egress
    renderEgress()
    status('egress-status', '出站策略已保存（模式 ' + payload.egress.policy.mode + '）。', 'good')
    log(payload.brokerReload || '完成。')
  }))
  byId('reseed').addEventListener('click', () => guard('auth-status', async () => {
    const payload = await api('/api/seed', {})
    await refresh()
    status('auth-status', '已重新写入 DSH 模型配置。', 'good')
    log(seedSummary(payload))
  }))
}

main()
