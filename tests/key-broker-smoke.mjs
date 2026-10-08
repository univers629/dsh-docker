import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BrokerConfigError,
  BrokerPolicyError,
  DEFAULT_ALLOWED_PATH_PREFIXES,
  STRIPPED_REQUEST_HEADERS,
  assertMethod,
  collectSecrets,
  createStreamRedactor,
  emptyUsageState,
  isBlockedHost,
  isPathAllowed,
  normalizeUpstreamPath,
  parseBrokerConfig,
  redactHeaders,
  redactSecrets,
  registerUsage,
  resolveRoute,
  usageDecision,
} from '../bin/dsh-key-broker-policy.mjs'

const TEST_KEY = 'sk-test-broker-0123456789abcdefghij'

// --- 配置解析：默认拒绝，任何能让代理去访问别处的写法都要报错 ---
const validConfig = parseBrokerConfig({
  version: 1,
  upstreams: [
    { name: 'deepseek', baseUrl: 'https://api.deepseek.com', key: TEST_KEY },
    {
      name: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      key: 'AIza-test-key-0123456789',
      headerName: 'x-goog-api-key',
      headerTemplate: '{key}',
      allowedPathPrefixes: ['/v1beta/models'],
      dailyRequestBudget: 100,
      requestsPerMinute: 10,
    },
  ],
})
assert.deepEqual([...validConfig.upstreams.keys()], ['deepseek', 'gemini'])
assert.equal(validConfig.upstreams.get('deepseek').headerName, 'authorization')
assert.equal(validConfig.upstreams.get('deepseek').headerValue, `Bearer ${TEST_KEY}`)
assert.equal(validConfig.upstreams.get('deepseek').port, 443)
assert.deepEqual(validConfig.upstreams.get('deepseek').allowedPathPrefixes, DEFAULT_ALLOWED_PATH_PREFIXES)
assert.equal(validConfig.upstreams.get('gemini').headerValue, 'AIza-test-key-0123456789')
assert.equal(validConfig.upstreams.get('deepseek').maxRequestBytes, 8 * 1024 * 1024)

const badConfigs = [
  {},
  { upstreams: [] },
  { version: 2, upstreams: [{ name: 'a', baseUrl: 'https://api.example.com', key: 'k' }] },
  { upstreams: [{ name: 'A B', baseUrl: 'https://api.example.com', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'http://api.example.com', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://user:pw@api.example.com', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://api.example.com?x=1', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://127.0.0.1', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://localhost', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://169.254.169.254', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://10.1.2.3', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://192.168.0.5', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://172.20.0.5', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://[::1]', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://metadata.google.internal', key: 'k' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://api.example.com', key: '' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://api.example.com', key: 'k', headerTemplate: 'Bearer static' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://api.example.com', key: 'k', headerName: 'bad header' }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://api.example.com', key: 'k', allowedPathPrefixes: [] }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://api.example.com', key: 'k', allowedPathPrefixes: ['v1'] }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://api.example.com', key: 'k', allowedPathPrefixes: ['/v1/../admin'] }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://api.example.com', key: 'k', dailyRequestBudget: -1 }] },
  { upstreams: [{ name: 'a', baseUrl: 'https://api.example.com', key: 'k', extraHeaders: { authorization: 'x' } }] },
  {
    upstreams: [
      { name: 'a', baseUrl: 'https://api.example.com', key: 'k' },
      { name: 'a', baseUrl: 'https://api2.example.com', key: 'k' },
    ],
  },
]
for (const candidate of badConfigs) {
  assert.throws(() => parseBrokerConfig(candidate), BrokerConfigError, `must reject ${JSON.stringify(candidate)}`)
}
assert.throws(() => parseBrokerConfig('{not json'), BrokerConfigError)

// --- 阻断地址：私网、环回、链路本地与云 metadata ---
for (const host of [
  '127.0.0.1', '127.10.0.1', '0.0.0.0', 'localhost', 'app.localhost',
  '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
  '100.64.0.1', '224.0.0.1', '[::1]', '[fd00::1]', 'fe80::1', 'metadata',
  'metadata.google.internal', '', '999.1.1.1',
]) {
  assert.equal(isBlockedHost(host), true, `${host} must be blocked`)
}
for (const host of ['api.deepseek.com', 'generativelanguage.googleapis.com', 'api.openai.com', '8.8.8.8']) {
  assert.equal(isBlockedHost(host), false, `${host} must be allowed`)
}

// --- 路径归一化与前缀白名单 ---
assert.equal(normalizeUpstreamPath('/v1/chat/completions'), '/v1/chat/completions')
assert.equal(normalizeUpstreamPath('/v1//chat///completions'), '/v1/chat/completions')
for (const path of [
  '/v1/../admin', '/../etc/passwd', '/v1/%2e%2e/admin', '/v1/%2E%2E/admin',
  '/v1/chat\\completions', 'v1/chat', '/v1/%zz', '/' + 'a'.repeat(4096),
]) {
  assert.throws(() => normalizeUpstreamPath(path), BrokerPolicyError, `must reject ${path}`)
}
assert.equal(isPathAllowed('/v1/chat/completions', ['/v1/chat/completions']), true)
assert.equal(isPathAllowed('/v1/chat/completions/stream', ['/v1/chat/completions']), true)
assert.equal(isPathAllowed('/v1/chat/completionsX', ['/v1/chat/completions']), false)
assert.equal(isPathAllowed('/v1/files', ['/v1/chat/completions']), false)

// --- 路由：客户端只能选上游和路径，选不了主机 ---
const route = resolveRoute('/u/deepseek/v1/chat/completions?stream=true', validConfig)
assert.equal(route.upstream.name, 'deepseek')
assert.equal(route.upstreamPath, '/v1/chat/completions')
assert.equal(route.query, 'stream=true')
for (const path of ['/', '/v1/chat/completions', '/u/', '/u/unknown/v1/models', '/u/gemini/v1/models', '/u/deepseek/v1/files']) {
  assert.throws(() => resolveRoute(path, validConfig), BrokerPolicyError, `must reject route ${path}`)
}
assert.equal(resolveRoute('/u/gemini/v1beta/models/x:generateContent', validConfig).upstream.name, 'gemini')
assert.equal(assertMethod('post'), 'POST')
for (const method of ['PUT', 'DELETE', 'PATCH', 'CONNECT', 'TRACE', 'OPTIONS', 'HEAD', '']) {
  assert.throws(() => assertMethod(method), BrokerPolicyError)
}

// --- 脱敏：密钥不得出现在日志或上游错误体里 ---
assert.deepEqual(collectSecrets(validConfig).includes(TEST_KEY), true)
const echoed = `{"error":"invalid key ${TEST_KEY}"}`
assert.equal(redactSecrets(echoed, collectSecrets(validConfig)).includes(TEST_KEY), false)
assert.match(redactSecrets(echoed, collectSecrets(validConfig)), /redacted/)

// 响应头同样要脱敏：上游把收到的凭据回显在某个头里并非不可能，而成功分支的响应体
// 走流式直通（不能缓冲），头是这一侧唯一还能就地处理的地方。
const echoSecrets = collectSecrets(validConfig)
const echoHeaders = {
  'x-echoed-key': TEST_KEY,
  'x-multi': [`first ${TEST_KEY}`, 'clean'],
  'content-length': 42,
  'x-note': 'no secret here',
}
const safeHeaders = redactHeaders(echoHeaders, echoSecrets)
assert.equal(JSON.stringify(safeHeaders).includes(TEST_KEY), false, '响应头里的密钥必须被抹掉')
assert.equal(safeHeaders['x-echoed-key'], '***redacted***')
assert.deepEqual(safeHeaders['x-multi'], ['first ***redacted***', 'clean'], '同名多值头逐个脱敏')
assert.equal(safeHeaders['content-length'], 42, '非字符串值原样保留')
assert.equal(safeHeaders['x-note'], 'no secret here', '不含密钥的头不受影响')
assert.equal(echoHeaders['x-echoed-key'], TEST_KEY, '不得就地改动入参')
assert.deepEqual(redactHeaders(undefined, echoSecrets), {}, '空头集合安全返回空对象')

// 流式脱敏：成功分支的响应体不缓冲，但密钥跨块出现也必须命中。
// 场景 1：密钥被分块边界切开；场景 2：多字节字符被边界截断后再拼回（不得产出替代符）；
// 场景 3：结尾的密钥由 flush 交还；场景 4：无密钥时字节原样通过。
const KEY = 'sk-stream-test-0123456789abcdef'
const collect = (parts) => {
  const redactor = createStreamRedactor([KEY])
  const out = []
  for (const part of parts) {
    const clean = redactor.push(Buffer.isBuffer(part) ? part : Buffer.from(part, 'utf8'))
    if (clean) out.push(clean)
  }
  const tail = redactor.flush()
  if (tail) out.push(tail)
  return Buffer.concat(out).toString('utf8')
}
const splitAt = (text, index) => [text.slice(0, index), text.slice(index)]

// 1) 密钥正好骑在边界上：两个分块各持一半。
{
  const full = `answer before ${KEY} answer after`
  const [left, right] = splitAt(full, 'answer before '.length + 10)
  const rebuilt = collect([left, right])
  assert.equal(rebuilt.includes(KEY), false, '跨块出现的密钥必须被抹掉')
  assert.match(rebuilt, /\*\*\*redacted\*\*\*/)
  assert.match(rebuilt, /answer before .*answer after/, '密钥前后的正文必须原样保留')
}
// 2) 多字节字符（中文 3 字节）被截断：边界两侧各自半个字符，拼回后不得产出替换符。
{
  const full = `结果：成功${KEY}完成`
  const bytes = Buffer.from(full, 'utf8')
  // 在“功”字的中间切开。
  const cut = Buffer.from('结果：成功', 'utf8').length - 1
  const rebuilt = collect([bytes.subarray(0, cut), bytes.subarray(cut)])
  assert.equal(rebuilt.includes(KEY), false, '多字节边界后的密钥必须被抹掉')
  assert.ok(!rebuilt.includes('\uFFFD'), `不得产出替换符：${JSON.stringify(rebuilt)}`)
  assert.match(rebuilt, /^结果：成功\*\*\*redacted\*\*\*完成$/)
}
// 3) 密钥出现在流的最后：flush 必须交还。
{
  const rebuilt = collect([`head ${KEY}`])
  assert.equal(rebuilt.includes(KEY), false, '结尾的密钥也要被抹掉')
  assert.equal(rebuilt, 'head ***redacted***')
}
// 4) 干净流：逐字节喂入，正文必须原样到达（脱敏器不得吞掉或改写字节）。
{
  const text = 'just a normal streaming answer 普通回答 123'
  const rebuilt = collect(text.split(''))
  assert.equal(rebuilt, text, '无密钥的流必须逐字节原样通过')
}
// 5) 空密钥集合：等价于直通。
{
  const redactor = createStreamRedactor([])
  const clean = redactor.push(Buffer.from('abc'))
  assert.equal(clean?.toString('utf8'), 'abc', '无密钥时不应扣住任何字节')
  assert.equal(redactor.flush(), null, '无密钥时 flush 不应再产出字节')
}

// --- 配额与限速 ---
const limited = validConfig.upstreams.get('gemini')
let state = emptyUsageState()
const now = Date.UTC(2026, 0, 2, 3, 4, 5)
for (let attempt = 0; attempt < limited.requestsPerMinute; attempt += 1) {
  assert.equal(usageDecision(state, limited, now).allowed, true)
  state = registerUsage(state, now, 'allow')
}
const throttled = usageDecision(state, limited, now)
assert.equal(throttled.allowed, false)
assert.equal(throttled.status, 429)
// 过一分钟后限速窗口重置，但日配额继续累计。
const nextMinute = now + 61_000
assert.equal(usageDecision(state, limited, nextMinute).allowed, true)
let dayState = { ...state, dayCount: limited.dailyRequestBudget, minuteStart: 0, minuteCount: 0 }
assert.equal(usageDecision(dayState, limited, nextMinute).allowed, false)
// 跨 UTC 日重置。
assert.equal(usageDecision(dayState, limited, now + 86_400_000 * 2).allowed, true)
// 未配置配额的上游不限速。
const unlimited = validConfig.upstreams.get('deepseek')
assert.equal(usageDecision({ ...emptyUsageState(), dayCount: 1e6, minuteCount: 1e6, minuteStart: now, day: '2026-01-02' }, unlimited, now).allowed, true)

assert.ok(STRIPPED_REQUEST_HEADERS.includes('authorization'))
assert.ok(STRIPPED_REQUEST_HEADERS.includes('x-api-key'))

// --- 端到端：起真实代理进程，验证放行/拒绝与“密钥绝不出现在任何响应或日志里” ---
// 授权功能加入后，每个 /u/ 调用都要凭实例令牌识别调用者（默认拒绝）：没有授权表时
// 一律 401。这里给测试令牌发放 probe 上游的授权，与真实部署里 dsh-auth 写出的
// broker-grants.json 同一形状（tokenDigest 由仓库自身的 brokerTokenDigest 计算）。
import { brokerTokenDigest } from '../bin/dsh-broker-grants.mjs'

const INSTANCE_TOKEN = 'test-instance-token-0123456789'
const brokerPath = fileURLToPath(new URL('../bin/dsh-key-broker.mjs', import.meta.url))
const sandbox = await mkdtemp(join(tmpdir(), 'dsh-broker-smoke-'))
const configPath = join(sandbox, 'keys.json')
const grantsPath = join(sandbox, 'grants.json')
const port = 20000 + Math.floor(Math.random() * 20000)
await writeFile(grantsPath, JSON.stringify({
  version: 1,
  users: {
    100000: { tokenDigest: brokerTokenDigest(INSTANCE_TOKEN), upstreams: ['probe'] },
  },
}))
await writeFile(configPath, JSON.stringify({
  version: 1,
  upstreams: [
    {
      name: 'probe',
      // .invalid 永远不会解析，所以测试不会真的把假密钥发到任何真实服务上。
      baseUrl: 'https://upstream.invalid',
      key: TEST_KEY,
      allowedPathPrefixes: ['/v1/chat/completions'],
      requestsPerMinute: 2,
    },
  ],
}))

const child = spawn(process.execPath, [brokerPath], {
  env: {
    ...process.env,
    DSH_BROKER_CONFIG: configPath,
    DSH_BROKER_GRANTS: grantsPath,
    DSH_BROKER_PORT: String(port),
    DSH_BROKER_BIND: '127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let brokerLog = ''
child.stdout.on('data', (chunk) => { brokerLog += chunk.toString() })
child.stderr.on('data', (chunk) => { brokerLog += chunk.toString() })

const base = `http://127.0.0.1:${port}`

// 裸 socket 请求：绕过 fetch 的 URL 归一化，直接把原始请求行发给代理。
const rawRequestStatus = (targetPort, requestLine, extraHeaders = [], body = '') => new Promise((resolve, reject) => {
  const socket = net.connect(targetPort, '127.0.0.1', () => {
    const headers = ['Host: 127.0.0.1', ...extraHeaders, 'Connection: close']
    if (!extraHeaders.some((line) => /^content-length:/i.test(line))) {
      headers.push(`Content-Length: ${Buffer.byteLength(body)}`)
    }
    socket.write(`${requestLine}\r\n${headers.join('\r\n')}\r\n\r\n${body}`)
  })
  let buffer = ''
  socket.setTimeout(10_000, () => socket.destroy(new Error('raw request timed out')))
  socket.on('data', (chunk) => { buffer += chunk.toString() })
  socket.on('error', reject)
  socket.on('close', () => {
    const match = /^HTTP\/1\.1 (\d{3})/.exec(buffer)
    if (!match) { reject(new Error(`no status line in response: ${buffer.slice(0, 200)}`)); return }
    resolve(Number(match[1]))
  })
})
const waitForListen = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const probe = await fetch(`${base}/healthz`)
      if (probe.status === 204) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`broker did not start: ${brokerLog}`)
}

try {
  await waitForListen()

  const status = await fetch(`${base}/status`)
  assert.equal(status.status, 200)
  const statusBody = await status.text()
  assert.equal(statusBody.includes(TEST_KEY), false, 'status must never expose the key')
  const statusJson = JSON.parse(statusBody)
  assert.deepEqual(statusJson.upstreams.map((entry) => entry.name), ['probe'])
  assert.equal(statusJson.upstreams[0].host, 'upstream.invalid')
  assert.equal(Object.keys(statusJson.upstreams[0]).includes('key'), false)

  // 未知上游、未放行路径、未放行方法都必须在触达上游之前就被拒。
  assert.equal((await fetch(`${base}/u/unknown/v1/chat/completions`, { method: 'POST' })).status, 404)
  assert.equal((await fetch(`${base}/u/probe/v1/files`, { method: 'POST' })).status, 403)
  assert.equal((await fetch(`${base}/u/probe/v1/chat/completions`, { method: 'DELETE' })).status, 405)
  assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST' })).status, 404)
  // fetch 会先按 URL 规范折叠 ../，所以用裸 socket 发一条未归一化的请求行，
  // 证明拒绝发生在服务端而不是客户端。
  const rawStatus = await rawRequestStatus(port, 'POST /u/probe/v1/%2e%2e/admin HTTP/1.1')
  assert.equal(rawStatus, 400, `raw traversal must be rejected by the broker, got ${rawStatus}`)
  const rawDotStatus = await rawRequestStatus(port, 'POST /u/probe/v1/../admin HTTP/1.1')
  assert.equal(rawDotStatus, 400, `raw dot traversal must be rejected by the broker, got ${rawDotStatus}`)

  // 客户端自带的 Authorization 会被剥掉，不会混进上游请求（这里上游不可达，
  // 关键是响应体里既没有真实密钥，也没有调用方的伪造凭据）。
  const upstreamFailure = await fetch(`${base}/u/probe/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer attacker-supplied',
      'x-dsh-instance-token': INSTANCE_TOKEN,
    },
    body: JSON.stringify({ model: 'probe', messages: [] }),
  })
  assert.equal(upstreamFailure.status, 502)
  const failureBody = await upstreamFailure.text()
  assert.equal(failureBody.includes(TEST_KEY), false)
  assert.equal(failureBody.includes('attacker-supplied'), false)

  // 未持令牌的调用必须被拒：授权功能默认拒绝一切未知调用者。
  const noToken = await fetch(`${base}/u/probe/v1/chat/completions`, { method: 'POST', body: '{}' })
  assert.equal(noToken.status, 401, 'caller without instance token is unknown')
  const badToken = await fetch(`${base}/u/probe/v1/chat/completions`, {
    method: 'POST',
    headers: { 'x-dsh-instance-token': `${INSTANCE_TOKEN}-wrong` },
    body: '{}',
  })
  assert.equal(badToken.status, 401, 'wrong instance token is unknown')

  // 第二次仍在配额内，第三次触发每分钟上限。
  await fetch(`${base}/u/probe/v1/chat/completions`, {
    method: 'POST', headers: { 'x-dsh-instance-token': INSTANCE_TOKEN }, body: '{}',
  }).then((r) => r.text())
  const throttledResponse = await fetch(`${base}/u/probe/v1/chat/completions`, {
    method: 'POST', headers: { 'x-dsh-instance-token': INSTANCE_TOKEN }, body: '{}',
  })
  assert.equal(throttledResponse.status, 429)

  // 声明的 content-length 超过上限时，代理必须在建立上游连接之前就拒绝。
  // 用裸 socket 发，因为 fetch 不允许伪造 content-length。
  const oversizeStatus = await rawRequestStatus(
    port,
    'POST /u/probe/v1/chat/completions HTTP/1.1',
    [`Content-Length: ${64 * 1024 * 1024}`, `X-DSH-Instance-Token: ${INSTANCE_TOKEN}`],
    '',
  )
  assert.ok([413, 429].includes(oversizeStatus), `unexpected oversize status ${oversizeStatus}`)

  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(brokerLog.includes(TEST_KEY), false, 'the audit log must never contain the key')
  assert.match(brokerLog, /"event":"listening"/)
  assert.match(brokerLog, /"event":"deny"/)
} finally {
  child.kill('SIGKILL')
  await rm(sandbox, { recursive: true, force: true })
}

// ---- 首次响应头的等待上限 ----
//
// 这个值覆盖的是「连接建立 + 上游开始回话」，不是 TCP 握手：推理模型要先想完才
// 输出，首字延迟十几秒是常态。定得太紧会把正常请求判成超时，而重试又可能再超时，
// 现象是「上游连接超时」反复出现而网络其实没问题。
{
  const broker = readFileSync(fileURLToPath(new URL('../bin/dsh-key-broker.mjs', import.meta.url)), 'utf8')
  const declared = broker.match(/const CONNECT_TIMEOUT_MS = Number\(process\.env\.DSH_BROKER_CONNECT_TIMEOUT_MS \?\? ([\d_]+)\)/)
  assert.ok(declared, 'broker 必须定义可配置的 CONNECT_TIMEOUT_MS')
  const defaultMs = Number(declared[1].replaceAll('_', ''))
  assert.ok(
    defaultMs >= 60_000,
    `首次响应头的等待上限至少 60 秒，实测推理上游首字延迟可到 19 秒（当前 ${defaultMs}ms）`,
  )
  // 流式读取上限要明显更宽：长回合可以跑几分钟。
  const stream = broker.match(/const UPSTREAM_TIMEOUT_MS = Number\(process\.env\.DSH_BROKER_UPSTREAM_TIMEOUT_MS \?\? ([\d_]+)\)/)
  assert.ok(stream, 'broker 必须定义可配置的 UPSTREAM_TIMEOUT_MS')
  assert.ok(
    Number(stream[1].replaceAll('_', '')) > defaultMs,
    '收到响应头之后的读取上限必须比首字等待更宽，否则长回合会被中途掐断',
  )
  // 收到响应头之后必须放宽，否则整个流式回合都受首字超时约束。
  assert.match(
    broker,
    /on\('response', \(\) => \{\s*upstreamRequest\.setTimeout\(UPSTREAM_TIMEOUT_MS\)/,
    '收到响应头后必须把超时放宽到流式上限',
  )
}

console.log('key broker smoke: ok')
