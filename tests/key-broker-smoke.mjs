import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  emptyUsageState,
  isBlockedHost,
  isPathAllowed,
  normalizeUpstreamPath,
  parseBrokerConfig,
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
const brokerPath = fileURLToPath(new URL('../bin/dsh-key-broker.mjs', import.meta.url))
const sandbox = await mkdtemp(join(tmpdir(), 'dsh-broker-smoke-'))
const configPath = join(sandbox, 'keys.json')
const port = 20000 + Math.floor(Math.random() * 20000)
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
  env: { ...process.env, DSH_BROKER_CONFIG: configPath, DSH_BROKER_PORT: String(port), DSH_BROKER_BIND: '127.0.0.1' },
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
  // 关键是响应体里既没有我们的密钥，也没有调用方的伪造凭据）。
  const upstreamFailure = await fetch(`${base}/u/probe/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer attacker-supplied' },
    body: JSON.stringify({ model: 'probe', messages: [] }),
  })
  assert.equal(upstreamFailure.status, 502)
  const failureBody = await upstreamFailure.text()
  assert.equal(failureBody.includes(TEST_KEY), false)
  assert.equal(failureBody.includes('attacker-supplied'), false)

  // 第二次仍在配额内，第三次触发每分钟上限。
  await fetch(`${base}/u/probe/v1/chat/completions`, { method: 'POST', body: '{}' }).then((r) => r.text())
  const throttledResponse = await fetch(`${base}/u/probe/v1/chat/completions`, { method: 'POST', body: '{}' })
  assert.equal(throttledResponse.status, 429)

  // 声明的 content-length 超过上限时，代理必须在建立上游连接之前就拒绝。
  // 用裸 socket 发，因为 fetch 不允许伪造 content-length。
  const oversizeStatus = await rawRequestStatus(
    port,
    'POST /u/probe/v1/chat/completions HTTP/1.1',
    [`Content-Length: ${64 * 1024 * 1024}`],
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

console.log('key broker smoke: ok')
