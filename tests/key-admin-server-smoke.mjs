import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// dsh-key-admin 的端到端冒烟：真起一个进程，按浏览器的方式打它。
//
// 重点核的不是"页面能不能显示"，而是这三条：
//   1. 没有令牌打不动 /api，猜错会被指数级锁定（面板持有全部真实密钥）；
//   2. 交给 seed 脚本的载荷里没有密钥（那个脚本写的是 dsh 容器能读到的文件）；
//   3. 上游报错时回给浏览器的文本里不含密钥。
// 上游那一跳用一个必然解析失败的域名，所以这个测试不需要网络也不会打到真实上游。

const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'dsh-key-admin-'))
const configPath = join(work, 'keys.json')
const tokenPath = join(work, 'admin.token')
const seedPayloadPath = join(work, 'seed-payload.json')
const egressPolicyPath = join(work, 'egress-policy.json')
const seedScript = join(work, 'stub-seed.mjs')
const dshHome = join(work, 'dsh')
const token = randomBytes(24).toString('hex')
const realKey = 'sk-live-' + randomBytes(8).toString('hex')
const port = 19300 + Math.floor(Math.random() * 400)

mkdirSync(dshHome, { recursive: true })
writeFileSync(tokenPath, token + '\n', { mode: 0o600 })
// seed 的替身：把收到的载荷原样落盘，让测试能断言"密钥没进来"。
writeFileSync(seedScript, [
  "import { writeFileSync } from 'node:fs'",
  "import process from 'node:process'",
  "const chunks = []",
  "process.stdin.on('data', (chunk) => chunks.push(chunk))",
  "process.stdin.on('end', () => {",
  "  writeFileSync(process.env.STUB_SEED_OUT, Buffer.concat(chunks).toString('utf8'))",
  "  process.stdout.write('    - stub：已写入 ' + process.argv.slice(2).join(' ') + '\\n')",
  "})",
].join('\n'))

const server = spawn(process.execPath, [join(root, 'bin/dsh-key-admin.mjs')], {
  env: {
    ...process.env,
    DSH_KEY_ADMIN_PORT: String(port),
    DSH_KEY_ADMIN_BIND: '127.0.0.1',
    DSH_KEY_ADMIN_CONFIG: configPath,
    DSH_KEY_ADMIN_TOKEN: tokenPath,
    DSH_KEY_ADMIN_DSH_HOME: dshHome,
    DSH_KEY_ADMIN_SEED: seedScript,
    DSH_KEY_ADMIN_WEB: join(root, 'bin/dsh-key-admin-web'),
    DSH_KEY_ADMIN_UPSTREAM_TIMEOUT_MS: '8000',
    DSH_KEY_ADMIN_EGRESS_POLICY: egressPolicyPath,
    // 部署形态给 blocklist：面板要照这个给默认策略，保存时也不该提示「当前是 open」。
    DSH_EGRESS_MODE: 'blocklist',
    STUB_SEED_OUT: seedPayloadPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (chunk) => {
  serverLog += chunk
})
server.stderr.on('data', (chunk) => {
  serverLog += chunk
})

const base = 'http://127.0.0.1:' + port
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function call(path, { method = 'GET', body, auth = token } = {}) {
  const headers = {}
  if (auth !== null) headers.authorization = 'Bearer ' + auth
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = null
  }
  return { status: response.status, headers: response.headers, text, payload }
}

function fail(message) {
  server.kill('SIGKILL')
  process.stderr.write(serverLog + '\n')
  throw new Error(message)
}

try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await fetch(base + '/healthz')
      if (health.status === 204) {
        ready = true
        break
      }
    } catch {
      // 还没监听。
    }
    await sleep(100)
  }
  if (!ready) fail('dsh-key-admin 没有在 6 秒内监听 ' + port)

  // --- 静态资源 ---
  const index = await call('/', { auth: null })
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type') ?? '', /text\/html/)
  assert.match(index.headers.get('content-security-policy') ?? '', /script-src 'self'/)
  assert.equal(index.headers.get('cache-control'), 'no-store')
  assert.match(index.text, /DSH 密钥管理面板/)
  const app = await call('/app.js', { auth: null })
  assert.equal(app.status, 200)
  assert.match(app.headers.get('content-type') ?? '', /javascript/)

  // --- 令牌 ---
  const anonymous = await call('/api/state', { auth: null })
  assert.equal(anonymous.status, 401, '没有令牌必须打不动 /api')
  assert.equal(anonymous.payload.ok, false)

  const state = await call('/api/state')
  assert.equal(state.status, 200)
  assert.deepEqual(state.payload.upstreams, [], 'keys.json 还不存在时要按"没有上游"处理')
  assert.equal(state.payload.brokerBase, 'http://dsh-key-broker:8080')
  assert.deepEqual(state.payload.apiShapes.map((shape) => shape.id), ['any', 'chat', 'responses', 'messages', 'gemini'])
  assert.equal(state.payload.defaultBaseUrls.deepseek, 'https://api.deepseek.com')
  assert.equal(state.payload.defaultShapes.anthropic, 'messages')
  // 面板的推理强度是勾选框，档位全集和默认勾选都由服务端给：前端只有兜底常量，
  // 少了这两个字段页面就会退回兜底、和后端的合法档位悄悄分叉。
  assert.deepEqual(state.payload.thinkingLevels, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(state.payload.defaultThinkingLevels, ['off', 'low', 'medium', 'high', 'max'])

  // --- 保存一个上游 ---
  const saved = await call('/api/upstreams', {
    method: 'POST',
    body: {
      name: 'deepseek',
      shape: '',
      baseUrl: '',
      key: realKey,
      models: 'deepseek-v4-flash, deepseek-v4-pro',
      extraHeaders: [{ name: 'originator', value: 'cedex_cli_rs' }, { name: 'User-Agent', value: 'codex_cli_rs/0.101.0' }],
      requestsPerMinute: '20',
      dailyRequestBudget: '',
    },
  })
  assert.equal(saved.status, 200, saved.text)
  assert.equal(saved.payload.name, 'deepseek')
  assert.equal(saved.payload.seed.failed, false, saved.text)
  assert.match(saved.payload.seed.output, /stub：已写入 --home/)
  assert.equal(saved.text.includes(realKey), false, '响应里不能出现密钥')

  const document = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(document.version, 1)
  assert.equal(document.upstreams.length, 1)
  assert.equal(document.upstreams[0].key, realKey, '真实密钥要落进 keys.json')
  assert.equal(document.upstreams[0].baseUrl, 'https://api.deepseek.com', '内置默认 base_url 要自动补上')
  assert.deepEqual(document.upstreams[0].extraHeaders, { originator: 'cedex_cli_rs', 'user-agent': 'codex_cli_rs/0.101.0' })
  assert.equal(document.upstreams[0].requestsPerMinute, 20)
  assert.deepEqual(document.upstreams[0].dsh, { api: 'any', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  if (process.platform !== 'win32') {
    assert.equal(statSync(configPath).mode & 0o777, 0o600, 'keys.json 必须是 0600')
  }

  const seedPayload = JSON.parse(readFileSync(seedPayloadPath, 'utf8'))
  assert.equal(readFileSync(seedPayloadPath, 'utf8').includes(realKey), false, 'seed 载荷里不能有密钥')
  assert.deepEqual(seedPayload.upstreams, [{
    name: 'deepseek',
    shape: 'any',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    // 面板没填推理强度，所以是空数组：seed 那边把它理解成"不声明"，模型页也就没有强度菜单。
    reasoningEfforts: [],
  }])
  assert.equal(seedPayload.placeholder, 'dsh-broker-placeholder')
  assert.equal(seedPayload.brokerBase, 'http://dsh-key-broker:8080')

  // 页面重新拉状态时只看到指纹，看不到密钥。
  const listed = await call('/api/state')
  assert.equal(listed.text.includes(realKey), false)
  assert.equal(listed.payload.upstreams[0].hasKey, true)
  assert.match(listed.payload.upstreams[0].keyFingerprint, /^[0-9a-f]{8}$/)
  assert.deepEqual(listed.payload.upstreams[0].extraHeaders, [
    { name: 'originator', value: 'cedex_cli_rs' },
    { name: 'user-agent', value: 'codex_cli_rs/0.101.0' },
  ])

  // 只改配额、不重填密钥。
  const updated = await call('/api/upstreams', {
    method: 'POST',
    body: { name: 'deepseek', shape: 'any', baseUrl: 'https://api.deepseek.com', key: '', models: '', dailyRequestBudget: '500' },
  })
  assert.equal(updated.status, 200, updated.text)
  const afterUpdate = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(afterUpdate.upstreams[0].key, realKey, '密钥留空必须沿用已存的那把')
  assert.equal(afterUpdate.upstreams[0].dailyRequestBudget, 500)
  assert.deepEqual(afterUpdate.upstreams[0].dsh.models, [])

  // --- 拒绝非法输入 ---
  const insecure = await call('/api/upstreams', {
    method: 'POST',
    body: { name: 'gw', baseUrl: 'http://api.example.com', key: 'k' },
  })
  assert.equal(insecure.status, 400)
  assert.match(insecure.payload.message, /https/)
  const forbiddenHeader = await call('/api/upstreams', {
    method: 'POST',
    body: { name: 'gw', baseUrl: 'https://api.example.com', key: 'k', extraHeaders: [{ name: 'authorization', value: 'Bearer x' }] },
  })
  assert.equal(forbiddenHeader.status, 400)
  const missingGateway = await call('/api/upstreams', { method: 'POST', body: { name: 'b-ai', key: 'k' } })
  assert.equal(missingGateway.status, 400, '自建网关没填 base_url 必须报错')
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).upstreams.length, 1, '被拒的请求不能改动 keys.json')

  // --- 拉模型列表：上游不可达时的错误必须干净 ---
  const models = await call('/api/models', {
    method: 'POST',
    body: { name: 'unreachable', baseUrl: 'https://api.invalid/v1', key: realKey, shape: 'chat' },
  })
  assert.equal(models.status, 502, models.text)
  assert.match(models.payload.message, /拉不到模型列表/)
  assert.equal(models.text.includes(realKey), false, '上游错误信息里不能带出密钥')

  // --- 删除 ---
  const removed = await call('/api/upstreams/delete', { method: 'POST', body: { name: 'deepseek' } })
  assert.equal(removed.status, 200, removed.text)
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).upstreams, [])
  const missing = await call('/api/upstreams/delete', { method: 'POST', body: { name: 'deepseek' } })
  assert.equal(missing.status, 404)

  assert.equal(existsSync(join(dshHome, 'settings.yaml')), false, '替身 seed 不写文件，这里只确认没人偷偷写')

  // --- 出站策略 ---
  //
  // 面板是唯一能写这份策略的地方（dsh 容器没挂这个目录），所以读、写、拒非法条目
  // 三条都要钉住：写坏了等于「以为在挡、其实全放行」。
  const egressBefore = (await call('/api/state')).payload.egress
  assert.equal(egressBefore.deploymentMode, 'blocklist')
  assert.equal(egressBefore.policyPath, egressPolicyPath)
  assert.equal(egressBefore.available, true, '目录在就应该可写')
  assert.equal(egressBefore.exists, false, '还没保存过，文件不该存在')
  assert.equal(egressBefore.error, '')
  // 文件还没写过时给的默认策略：模式跟着部署形态，黑名单补成内置隧道清单。
  assert.equal(egressBefore.policy.mode, 'blocklist')
  assert.equal(egressBefore.policy.allow.length, 0)
  assert.equal(egressBefore.policy.block.length, egressBefore.builtinBlock.length)
  assert.ok(egressBefore.builtinAllow.includes('deb.debian.org'))
  assert.ok(egressBefore.builtinBlock.some((entry) => entry.host === '*.trycloudflare.com'))

  const egressSaved = await call('/api/egress', {
    method: 'POST',
    body: {
      policy: {
        mode: 'allowlist',
        allow: [{ host: 'Search.Example.com', note: '搜索' }],
        block: [{ host: '*.ngrok.io', enabled: false }],
      },
    },
  })
  assert.equal(egressSaved.status, 200, egressSaved.text)
  assert.match(egressSaved.payload.brokerReload, /热加载/)
  const egressFile = JSON.parse(readFileSync(egressPolicyPath, 'utf8'))
  assert.equal(egressFile.version, 1)
  assert.equal(egressFile.mode, 'allowlist')
  assert.deepEqual(egressFile.allow, [{ host: 'search.example.com', enabled: true, note: '搜索' }])
  // 取消勾选的条目要留在文件里（下次还能勾回来），只是不进代理的规则。
  assert.equal(egressFile.block.length, 1)
  assert.equal(egressFile.block[0].enabled, false)
  assert.equal((await call('/api/state')).payload.egress.exists, true)

  // 非法域名一律 400，且不落盘。
  const egressBad = await call('/api/egress', {
    method: 'POST',
    body: { policy: { mode: 'allowlist', allow: [{ host: 'bad_host.com' }], block: [] } },
  })
  assert.equal(egressBad.status, 400, egressBad.text)
  assert.equal(JSON.parse(readFileSync(egressPolicyPath, 'utf8')).mode, 'allowlist')
  const egressBadMode = await call('/api/egress', {
    method: 'POST',
    body: { policy: { mode: 'nonsense', allow: [], block: [] } },
  })
  assert.equal(egressBadMode.status, 400, egressBadMode.text)

  // --- 暴力破解 ---
  //
  // 每次失败先延迟再计数，连续 5 次进入指数锁定。这一段会真的等，所以放最后。
  const started = Date.now()
  let lockedStatus = 0
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wrong = await call('/api/state', { auth: 'wrong-' + attempt })
    lockedStatus = wrong.status
    if (wrong.status === 429) break
  }
  assert.equal(lockedStatus, 429, '连续猜错令牌必须被锁定')
  assert.ok(Date.now() - started > 3000, '每次失败都应该有延迟，别让面板变成在线爆破靶子')
  const lockedOut = await call('/api/state')
  assert.equal(lockedOut.status, 429, '锁定期内即使令牌正确也要拒绝')

  assert.equal(serverLog.includes(realKey), false, '容器日志里不能出现密钥')
  assert.match(serverLog, /"event":"auth-failed"/)
} finally {
  server.kill('SIGKILL')
  rmSync(work, { recursive: true, force: true })
}

console.log('key-admin server smoke: ok')
