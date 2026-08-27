import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  AdminInputError,
  API_SHAPES,
  DEFAULT_BASE_URLS,
  defaultShapeOf,
  extractModelIds,
  inferShape,
  mergeUpstream,
  modelsRequestCandidates,
  normalizeExtraHeaders,
  normalizeModelIds,
  normalizeName,
  normalizeUpstreamInput,
  readDocument,
  removeUpstream,
  seedPayload,
  serializeDocument,
  toBrokerEntry,
  toUpstreamView,
} from '../bin/dsh-key-admin-policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const installSh = readFileSync(root + 'install.sh', 'utf8')

// --- 与 install.sh 的一致性 ---
//
// 面板和安装向导写的是同一份 keys.json。两边的形态表一旦分叉，同一个上游用两条路
// 配出来的行为就不一样（认证头、放行端点、默认 base_url），而这种分叉只会在用户
// 真的换了一条路配置时才暴露。所以这里直接从 install.sh 里把那几张表抽出来逐条比对。

function shellFunctionBody(name) {
  const start = installSh.indexOf('\n' + name + '() {')
  assert.notEqual(start, -1, 'install.sh 里找不到函数 ' + name)
  const end = installSh.indexOf('\n}', start)
  assert.notEqual(end, -1, 'install.sh 里 ' + name + ' 没有收尾')
  return installSh.slice(start, end)
}

/** 把 case "$1" in ... esac 抽成 { 模式: 值 }，模式里的 a|b 会展开成两条。 */
function shellCaseMap(name) {
  const body = shellFunctionBody(name)
  const map = {}
  for (const line of body.split('\n')) {
    const match = /^\s*([a-z0-9_|*-]+)\)\s*printf '%s' '([^']*)'\s*;;/.exec(line)
    if (!match) continue
    for (const pattern of match[1].split('|')) map[pattern] = match[2]
  }
  return map
}

const shellHeaderNames = shellCaseMap('broker_profile_header_name')
const shellHeaderTemplates = shellCaseMap('broker_profile_header_template')
const shellPaths = shellCaseMap('broker_profile_paths')
const shellExtraHeaders = shellCaseMap('broker_profile_headers')
const shellDefaultShapes = shellCaseMap('broker_default_profile')
const shellBaseUrls = shellCaseMap('model_default_base_url')

for (const [id, shape] of Object.entries(API_SHAPES)) {
  const expectedHeaderName = shellHeaderNames[id] ?? shellHeaderNames['*']
  const expectedTemplate = shellHeaderTemplates[id] ?? shellHeaderTemplates['*']
  const expectedPaths = (shellPaths[id] ?? shellPaths['*']).split(' ').filter((entry) => entry !== '')
  const expectedExtras = (shellExtraHeaders[id] ?? shellExtraHeaders['*'])
  assert.equal(shape.headerName, expectedHeaderName, id + ' 的认证头名与 install.sh 不一致')
  assert.equal(shape.headerTemplate, expectedTemplate, id + ' 的认证头模板与 install.sh 不一致')
  assert.deepEqual([...shape.pathPrefixes], expectedPaths, id + ' 的放行端点与 install.sh 不一致')
  const extras = Object.entries(shape.extraHeaders).map(([name, value]) => name + '=' + value).join(' ')
  assert.equal(extras, expectedExtras, id + ' 的形态自带请求头与 install.sh 不一致')
}
for (const [name, url] of Object.entries(DEFAULT_BASE_URLS)) {
  assert.equal(shellBaseUrls[name], url, name + ' 的默认 base_url 与 install.sh 不一致')
}
for (const name of Object.keys(shellBaseUrls)) {
  if (name === '*') continue
  assert.equal(DEFAULT_BASE_URLS[name], shellBaseUrls[name], 'install.sh 里的 ' + name + ' 没有出现在面板的默认表里')
}
for (const name of Object.keys(shellDefaultShapes)) {
  if (name === '*') continue
  assert.equal(defaultShapeOf(name), shellDefaultShapes[name], name + ' 的默认形态与 install.sh 不一致')
}
assert.equal(defaultShapeOf('b-ai'), shellDefaultShapes['*'])

// --- 输入校验 ---

const rejects = [
  { input: { name: 'A B', key: 'k', baseUrl: 'https://api.example.com' }, hint: '名字' },
  { input: { name: 'gw', key: 'k', baseUrl: 'http://api.example.com' }, hint: 'https' },
  { input: { name: 'gw', key: 'k', baseUrl: 'https://127.0.0.1' }, hint: '内网' },
  { input: { name: 'gw', key: 'k', baseUrl: 'https://api.example.com?x=1' }, hint: 'query' },
  { input: { name: 'gw', key: 'k', baseUrl: 'https://user:pw@api.example.com' }, hint: '凭据' },
  { input: { name: 'gw', key: '', baseUrl: 'https://api.example.com' }, hint: '空密钥' },
  { input: { name: 'gw', key: 'k', baseUrl: 'https://api.example.com', shape: 'nope' }, hint: '形态' },
  { input: { name: 'gw', key: 'k', baseUrl: 'https://api.example.com', models: 'bad id!' }, hint: '模型 id' },
]
for (const entry of rejects) {
  assert.throws(() => normalizeUpstreamInput(entry.input), AdminInputError, '应当拒绝：' + entry.hint)
}
// 自建网关没有内置 base_url，留空必须报错而不是猜一个域名出来。
assert.throws(() => normalizeUpstreamInput({ name: 'b-ai', key: 'k' }), AdminInputError)

// 认证类头一律不允许出现在额外请求头里：那等于让配置绕过密钥注入。
for (const name of ['authorization', 'x-api-key', 'cookie', 'content-length', 'connection']) {
  assert.throws(() => normalizeExtraHeaders([{ name, value: 'x' }], 'any'), AdminInputError, name)
}
assert.throws(() => normalizeExtraHeaders([{ name: 'x-goog-api-key', value: 'x' }], 'gemini'), AdminInputError)
// 形态自带的头重复填一次不算冲突，但也不会存第二份。
assert.deepEqual(normalizeExtraHeaders([{ name: 'anthropic-version', value: '2023-06-01' }], 'messages'), {})
// 用户真正要的那三个头（Codex 客户端）必须放行，大小写归一。
assert.deepEqual(
  normalizeExtraHeaders([
    { name: 'originator', value: 'cedex_cli_rs' },
    { name: 'version', value: '0.101.0' },
    { name: 'User-Agent', value: 'codex_cli_rs/0.101.0' },
  ], 'responses'),
  { originator: 'cedex_cli_rs', version: '0.101.0', 'user-agent': 'codex_cli_rs/0.101.0' },
)

assert.deepEqual(normalizeModelIds('a, b , a\nc'), ['a', 'b', 'c'])
assert.equal(normalizeName(' DeepSeek '), 'deepseek')

// --- keys.json 往返 ---

const record = normalizeUpstreamInput({
  name: 'b-ai',
  shape: 'responses',
  baseUrl: 'https://api.justwoker.icu/v1',
  key: 'sk-secret-value',
  models: 'claude-opus-5-thinking',
  extraHeaders: [{ name: 'originator', value: 'cedex_cli_rs' }],
  requestsPerMinute: '30',
})
const entry = toBrokerEntry(record)
assert.equal(entry.headerName, undefined, 'authorization 是 broker 默认值，不该写进 keys.json')
assert.deepEqual(entry.allowedPathPrefixes, ['/v1/responses', '/responses', '/v1/models', '/models'])
assert.deepEqual(entry.extraHeaders, { originator: 'cedex_cli_rs' })
assert.equal(entry.requestsPerMinute, 30)
assert.equal(entry.dailyRequestBudget, undefined)
assert.deepEqual(entry.dsh, { api: 'responses', models: ['claude-opus-5-thinking'] })

const view = toUpstreamView(entry)
assert.equal(view.hasKey, true)
assert.equal(Object.prototype.hasOwnProperty.call(view, 'key'), false, '视图里绝不能出现密钥')
assert.match(view.keyFingerprint, /^[0-9a-f]{8}$/)
assert.equal(JSON.stringify(view).includes('sk-secret-value'), false)

// 形态自带的头不会在页面上重复显示一遍。
const anthropic = toBrokerEntry(normalizeUpstreamInput({ name: 'anthropic', key: 'k' }))
assert.equal(anthropic.headerName, 'x-api-key')
assert.equal(anthropic.headerTemplate, '{key}')
assert.deepEqual(anthropic.extraHeaders, { 'anthropic-version': '2023-06-01' })
assert.deepEqual(toUpstreamView(anthropic).extraHeaders, [])

// 老配置（没有 dsh 字段）也要能显示出正确的形态。
assert.equal(inferShape({ headerName: 'x-api-key' }), 'messages')
assert.equal(inferShape({ headerName: 'x-goog-api-key' }), 'gemini')
assert.equal(inferShape({ allowedPathPrefixes: ['/v1/responses'] }), 'responses')
assert.equal(inferShape({ allowedPathPrefixes: ['/v1/chat/completions'] }), 'chat')
assert.equal(inferShape({}), 'any')

// 密钥留空 = 沿用已存的那把：改配额不该要求把密钥再抄一遍。
const kept = normalizeUpstreamInput({ name: 'b-ai', shape: 'responses', baseUrl: 'https://api.justwoker.icu/v1', models: 'x', dailyRequestBudget: '5' }, entry)
assert.equal(kept.key, 'sk-secret-value')

// --- 文档合并 ---

const empty = readDocument('')
assert.deepEqual(empty, { version: 1, upstreams: [] })
const one = mergeUpstream(empty, entry)
const twice = mergeUpstream(one, toBrokerEntry({ ...record, models: ['x'] }))
assert.equal(twice.upstreams.length, 1, '同名上游整条替换')
assert.deepEqual(twice.upstreams[0].dsh.models, ['x'])
assert.deepEqual(removeUpstream(twice, 'b-ai').upstreams, [])
assert.throws(() => removeUpstream(twice, 'nope'), AdminInputError)
assert.match(serializeDocument(twice), /^\{\n  "version": 1/)
assert.throws(() => readDocument('not json'), AdminInputError)

// 交给 seed 脚本的载荷里不能有密钥：那个脚本写的是 dsh 容器能读到的文件。
const payload = seedPayload(twice, 'http://dsh-key-broker:8080', 'dsh-broker-placeholder')
assert.deepEqual(payload.upstreams, [{ name: 'b-ai', shape: 'responses', models: ['x'] }])
assert.equal(JSON.stringify(payload).includes('sk-secret-value'), false)

// --- 模型列表 ---

assert.deepEqual(
  modelsRequestCandidates(record).map((candidate) => candidate.url),
  ['https://api.justwoker.icu/v1/models'],
  'base_url 已经带版本段时不该再拼一个 /v1',
)
assert.deepEqual(
  modelsRequestCandidates(normalizeUpstreamInput({ name: 'deepseek', key: 'k' })).map((candidate) => candidate.url),
  ['https://api.deepseek.com/models', 'https://api.deepseek.com/v1/models'],
)
const anthropicCandidates = modelsRequestCandidates(normalizeUpstreamInput({ name: 'anthropic', key: 'k' }))
assert.deepEqual(anthropicCandidates.map((candidate) => candidate.url), [
  'https://api.anthropic.com/v1/models',
  'https://api.anthropic.com/models',
])
assert.equal(anthropicCandidates[0].headers['x-api-key'], 'k')
assert.equal(anthropicCandidates[0].headers['anthropic-version'], '2023-06-01')
assert.equal(modelsRequestCandidates(record)[0].headers.authorization, 'Bearer sk-secret-value')

assert.deepEqual(extractModelIds({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5' }] }), ['gpt-5.5'])
assert.deepEqual(extractModelIds({ models: [{ name: 'models/gemini-3-pro' }] }), ['gemini-3-pro'])
assert.deepEqual(extractModelIds(['a', { id: 'b' }]), ['a', 'b'])
assert.deepEqual(extractModelIds({ error: 'nope' }), [])
assert.deepEqual(extractModelIds({ data: [{ id: 'bad id' }] }), [], '上游返回的垃圾 id 不能进 settings.yaml')

console.log('key-admin policy smoke: ok')
