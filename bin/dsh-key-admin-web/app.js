// DSH 密钥管理面板的前端。
//
// 三个约定：
//   1. 令牌只放 sessionStorage，并且只以 Authorization 头发送。不用 cookie，因此
//      不存在 CSRF 面；地址栏里带 ?token= 的话会在读到之后立刻从 URL 里抹掉。
//   2. 页面上的所有文本都用 textContent 写，不拼 HTML 字符串。
//   3. 任何时候都不显示密钥：后端只回一个指纹，用来回答"这次填的是不是同一把"。

const TOKEN_KEY = 'dsh-key-admin-token'
const S = { token: '', state: null, editing: '', fetched: [] }

const byId = (id) => document.getElementById(id)

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
    if (view.reasoningEfforts.length > 0) bits.push('推理强度 ' + view.reasoningEfforts.join('/'))
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
  S.fetched = []
  byId('model-list').textContent = ''
  byId('form-title').textContent = view ? '编辑上游：' + view.name : '新增上游'
  byId('name').value = view ? view.name : ''
  byId('shape').value = view ? view.shape : 'any'
  byId('base-url').value = view ? view.baseUrl : ''
  byId('key').value = ''
  byId('models').value = view ? view.models.join(', ') : ''
  byId('reasoning').value = view ? view.reasoningEfforts.join(', ') : ''
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
    reasoningEfforts: byId('reasoning').value,
    baseUrl: byId('base-url').value.trim(),
    key: byId('key').value,
    rename: S.editing,
    models: byId('models').value,
    extraHeaders,
    // 两个限额框留空时发空串，后端把它当成"沿用 keys.json 里的现值"；要取消限制得填 0。
    requestsPerMinute: byId('rpm').value.trim(),
    dailyRequestBudget: byId('daily').value.trim(),
  }
}

function renderModelChoices(models) {
  S.fetched = models
  const box = byId('model-list')
  box.textContent = ''
  const chosen = new Set(byId('models').value.split(/[\s,]+/).filter((id) => id !== ''))
  for (const id of models) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = id
    input.checked = chosen.has(id)
    label.appendChild(input)
    const text = document.createElement('span')
    text.textContent = id
    label.appendChild(text)
    box.appendChild(label)
  }
}

function checkedModels() {
  const out = []
  for (const input of byId('model-list').querySelectorAll('input')) {
    if (input.checked) out.push(input.value)
  }
  return out
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
  byId('check-all').addEventListener('click', () => {
    for (const input of byId('model-list').querySelectorAll('input')) input.checked = true
  })
  byId('check-none').addEventListener('click', () => {
    for (const input of byId('model-list').querySelectorAll('input')) input.checked = false
  })
  byId('apply-models').addEventListener('click', () => {
    byId('models').value = checkedModels().join(', ')
    status('form-status', '已写入 ' + checkedModels().length + ' 个模型 id，别忘了保存。', '')
  })
  byId('fetch-models').addEventListener('click', () => guard('form-status', async () => {
    const payload = await api('/api/models', readForm())
    renderModelChoices(payload.models)
    // 拉取成功只说明"这个地址上有模型列表"，不代表 base_url 对：清单只在带版本段的地址上
    // 有，而 DSH 发请求时不补版本段。所以拉到之后顺手把 base_url 改对，否则用户看到的
    // 就是"面板能拉到模型、网页里一用就说密钥无效"。
    if (payload.suggestedBaseUrl) {
      byId('base-url').value = payload.suggestedBaseUrl
      status('form-status', '模型列表在 ' + payload.endpoint + '（' + payload.models.length + ' 个）。'
        + 'base_url 少了版本段，已替你改成 ' + payload.suggestedBaseUrl
        + '——DSH 发请求时不会自己补这一段，不改就会 403。勾选模型后记得保存。', 'good')
    } else {
      status('form-status', '上游 ' + payload.endpoint + ' 返回了 ' + payload.models.length + ' 个模型，勾选后点"把勾选的写进上面"。', 'good')
    }
    log(payload.models.join('\n') || '（上游没有返回任何模型 id）')
  }))
  byId('save').addEventListener('click', () => guard('form-status', async () => {
    const payload = await api('/api/upstreams', readForm())
    await refresh()
    S.editing = payload.name
    byId('form-title').textContent = '编辑上游：' + payload.name
    byId('key').value = ''
    // 保存时 base_url 和模型清单可能被自动改过，表单要跟着变，不然下一次保存会写回旧值。
    if (payload.baseUrl) byId('base-url').value = payload.baseUrl
    if (Array.isArray(payload.models) && payload.models.length > 0) byId('models').value = payload.models.join(', ')
    status('form-status', '已保存 ' + payload.name + '。', 'good')
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
