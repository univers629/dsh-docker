import assert from 'node:assert/strict'
import {
  NATIVE_ROUTES,
  PROTOCOL_BY_API_SHAPE,
  SUPPORTED_ROUTE_PROTOCOLS,
  brokerRouteBaseUrl,
  deriveCredentialRef,
  isBrokerRouteBaseUrl,
  normalizeModelIds,
  piAiRoutePath,
  planProvider,
  planSeed,
} from '../bin/dsh-model-settings-policy.mjs'

// 目录快照的最小替身：只要 id 命中就算"目录路由"，字段结构和 seed 脚本从 pi-ai
// 导出的那份一致。
const catalog = {
  deepseek: { api: 'openai-completions', models: ['deepseek-v4-flash', 'deepseek-v4'] },
  google: { api: 'google-generative-ai', models: ['gemini-3-pro', 'gemini-3-flash'] },
}

// ---------------------------------------------------------------------------
// 凭据引用名：必须和 WebUI 自己派生的一致，否则用户在页面上填的真实密钥会落到
// 另一个引用上，页面显示"已配置"而请求还在用占位串。
// ---------------------------------------------------------------------------
assert.equal(deriveCredentialRef('deepseek'), 'DEEPSEEK_API_KEY')
assert.equal(deriveCredentialRef('my-gateway'), 'MY_GATEWAY_API_KEY')
assert.equal(deriveCredentialRef('a.b_c'), 'A_B_C_API_KEY')

// ---------------------------------------------------------------------------
// base_url 不带版本段：broker 的转发目标 = 上游 base_url 的路径 + 客户端路径，
// 这里多补一个 /v1 就会变成 /v1/v1/responses。
// ---------------------------------------------------------------------------
assert.equal(brokerRouteBaseUrl('http://dsh-key-broker:8080', 'deepseek'), 'http://dsh-key-broker:8080/u/deepseek')
assert.equal(brokerRouteBaseUrl('http://dsh-key-broker:8080/', 'mygw'), 'http://dsh-key-broker:8080/u/mygw')
assert.doesNotMatch(brokerRouteBaseUrl('http://dsh-key-broker:8080', 'mygw'), /\/v1$/)

assert.deepEqual(normalizeModelIds([' a ', 'a', '', null, 'b']), ['a', 'b'])

// 自定义路由只能声明这三种协议；表里其余形态都要落在这个集合里。
for (const [shape, protocol] of Object.entries(PROTOCOL_BY_API_SHAPE)) {
  if (protocol.length === 0) continue
  assert.ok(SUPPORTED_ROUTE_PROTOCOLS.includes(protocol), shape + ' 映射到了不支持的协议 ' + protocol)
}

// ---------------------------------------------------------------------------
// 目录路由：只覆盖 baseURL / apiKeyEnv，不写 api，也不写 models——目录里的模型
// 各自带着自己的协议，写死一个 api 就会把它们全按同一种协议对待。
// ---------------------------------------------------------------------------
const google = planProvider({ name: 'google', shape: 'any', models: [], brokerBase: 'http://b:8080', catalog })
assert.equal(google.ok, true)
assert.equal(google.source, 'catalog')
assert.equal(google.provider, 'google')
assert.deepEqual(google.path, ['llm-pi-ai', 'providers', 'google'])
assert.deepEqual(google.always, { baseURL: 'http://b:8080/u/google', apiKeyEnv: 'GOOGLE_API_KEY' })
assert.equal(google.credentialRef, 'GOOGLE_API_KEY')
assert.deepEqual(google.whenMissing, {})
assert.deepEqual(google.models, ['gemini-3-pro', 'gemini-3-flash'])

// 目录路由也可以收窄：用户填了模型 id 就只放这几个，但仍然只在字段缺失时写。
const narrowed = planProvider({ name: 'google', shape: 'any', models: ['gemini-3-pro'], brokerBase: 'http://b:8080', catalog })
assert.deepEqual(narrowed.whenMissing, { models: [{ id: 'gemini-3-pro' }] })
assert.deepEqual(narrowed.models, ['gemini-3-pro'])

// ---------------------------------------------------------------------------
// 第一方命名空间：deepseek 必须配置 llm-deepseek 本身，不能再建一条同名 pi-ai 路由
// ——两条都在的时候 WebUI 上就是两行 DeepSeek，而默认模型只指其中一行。
// ---------------------------------------------------------------------------
const deepseek = planProvider({ name: 'deepseek', shape: 'any', models: [], brokerBase: 'http://b:8080', catalog })
assert.equal(deepseek.ok, true)
assert.equal(deepseek.source, 'native')
assert.equal(deepseek.provider, 'deepseek-official')
assert.deepEqual(deepseek.path, ['llm-deepseek'])
// apiKeyEnv 不写：第一方 schema 的默认值就是 DEEPSEEK_API_KEY，也正是 WebUI 派生的那个。
assert.deepEqual(deepseek.always, { baseURL: 'http://b:8080/u/deepseek' })
assert.equal(deepseek.credentialRef, deriveCredentialRef('deepseek'))
assert.deepEqual(deepseek.whenMissing, {})
assert.deepEqual(deepseek.models, ['deepseek-v4-flash', 'deepseek-v4-pro'])
assert.deepEqual(deepseek.supersedes, piAiRoutePath('deepseek'))
// 明确列了模型 id 时才覆盖第一方那份清单。
const deepseekNarrowed = planProvider({ name: 'deepseek', shape: 'any', models: ['deepseek-v4-pro'], brokerBase: 'http://b:8080', catalog })
assert.deepEqual(deepseekNarrowed.whenMissing, { models: [{ id: 'deepseek-v4-pro' }] })
assert.deepEqual(deepseekNarrowed.models, ['deepseek-v4-pro'])
// 第一方路由的凭据引用名必须等于 WebUI 自己派生的那个，否则页面显示"已配置"而请求仍用占位串。
for (const [name, route] of Object.entries(NATIVE_ROUTES)) {
  assert.equal(route.credentialRef, deriveCredentialRef(name), name + ' 的凭据引用名与 WebUI 不一致')
}
// 只有指向本部署密钥代理的 baseURL 才算"安装器写的重复行"。
assert.equal(isBrokerRouteBaseUrl('http://b:8080/u/deepseek', 'deepseek'), true)
assert.equal(isBrokerRouteBaseUrl('http://b:8080/u/deepseek/', 'deepseek'), true)
assert.equal(isBrokerRouteBaseUrl('https://api.deepseek.com', 'deepseek'), false)

// ---------------------------------------------------------------------------
// 自定义路由：协议和模型 id 都必须显式给，少一样 pi-ai 会拒绝整个 namespace。
// ---------------------------------------------------------------------------
const gateway = planProvider({
  name: 'justwoker',
  shape: 'responses',
  models: ['claude-opus-5-thinking'],
  brokerBase: 'http://b:8080',
  catalog,
})
assert.equal(gateway.ok, true)
assert.equal(gateway.source, 'declared')
assert.equal(gateway.api, 'openai-responses')
assert.deepEqual(gateway.whenMissing, { api: 'openai-responses', models: [{ id: 'claude-opus-5-thinking' }] })

assert.equal(planProvider({ name: 'mygw', shape: 'chat', models: ['x'], brokerBase: 'http://b:8080', catalog }).api, 'openai-completions')
assert.equal(planProvider({ name: 'mygw', shape: 'messages', models: ['x'], brokerBase: 'http://b:8080', catalog }).api, 'anthropic-messages')
// 没选形态时按 OpenAI 兼容兜底：网关里最常见的就是 /chat/completions。
assert.equal(planProvider({ name: 'mygw', shape: '', models: ['x'], brokerBase: 'http://b:8080', catalog }).api, 'openai-completions')

// 目录外 + 没给模型 id：拒绝，并把补救命令写进原因里。
const noModels = planProvider({ name: 'mygw', shape: 'chat', models: [], brokerBase: 'http://b:8080', catalog })
assert.equal(noModels.ok, false)
assert.match(noModels.reason, /--model-id mygw=/)

// Gemini 协议只存在于内置目录路由上：自定义名字选 gemini 必须拒绝并指路 google。
const gemini = planProvider({ name: 'mygw', shape: 'gemini', models: ['gemini-3-pro'], brokerBase: 'http://b:8080', catalog })
assert.equal(gemini.ok, false)
assert.match(gemini.reason, /google/)
// 反过来，名字叫 google 时走目录，Gemini 就能用。
assert.equal(planProvider({ name: 'google', shape: 'gemini', models: [], brokerBase: 'http://b:8080', catalog }).ok, true)

// ---------------------------------------------------------------------------
// 整份规划：全新安装
// ---------------------------------------------------------------------------
const fresh = planSeed({
  upstreams: [
    { name: 'deepseek', shape: 'any', models: [] },
    { name: 'mygw', shape: 'gemini', models: ['gemini-3-pro'] },
  ],
  brokerBase: 'http://dsh-key-broker:8080',
  placeholder: 'dsh-broker-placeholder',
  catalog,
})
assert.deepEqual(fresh.entries.map((entry) => entry.name), ['deepseek'])
assert.deepEqual(fresh.skipped.map((entry) => entry.name), ['mygw'])
assert.deepEqual(fresh.refs, { DEEPSEEK_API_KEY: 'dsh-broker-placeholder' })
// 默认模型指的是路由 id：第一方那条叫 deepseek-official。
assert.deepEqual(fresh.defaultModel, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
// 全新安装没有旧配置可收。
assert.deepEqual(fresh.removals, [])

// ---------------------------------------------------------------------------
// 旧版安装器留下的重复行：同名 pi-ai 路由指向密钥代理时收掉；指向别处的不动。
// ---------------------------------------------------------------------------
const cleanup = planSeed({
  upstreams: [{ name: 'deepseek', shape: 'any', models: [] }],
  brokerBase: 'http://dsh-key-broker:8080',
  placeholder: 'dsh-broker-placeholder',
  catalog,
  existing: { providers: { deepseek: { baseURL: 'http://dsh-key-broker:8080/u/deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' } } },
})
assert.deepEqual(cleanup.removals, [['llm-pi-ai', 'providers', 'deepseek']])

const handWritten = planSeed({
  upstreams: [{ name: 'deepseek', shape: 'any', models: [] }],
  brokerBase: 'http://dsh-key-broker:8080',
  placeholder: 'dsh-broker-placeholder',
  catalog,
  existing: { providers: { deepseek: { baseURL: 'https://my-own-proxy.example', apiKeyEnv: 'DEEPSEEK_API_KEY' } } },
})
assert.deepEqual(handWritten.removals, [])

// ---------------------------------------------------------------------------
// 幂等：已经是占位串的引用照原样写回（文本不变），已选过的默认模型不改回来。
// ---------------------------------------------------------------------------
const again = planSeed({
  upstreams: [{ name: 'deepseek', shape: 'any', models: [] }],
  brokerBase: 'http://dsh-key-broker:8080',
  placeholder: 'dsh-broker-placeholder',
  catalog,
  existing: { refValues: { DEEPSEEK_API_KEY: 'dsh-broker-placeholder' }, defaultModel: true },
})
assert.deepEqual(again.refs, { DEEPSEEK_API_KEY: 'dsh-broker-placeholder' })
assert.deepEqual(again.reclaimed, [])
assert.equal(again.defaultModel, null)

// 引用里存着一把真实密钥：代理托管这个上游，容器里那把只是泄漏，必须换回占位串，
// 并且要被点出来（摘要靠它提醒用户轮换）。
const reclaim = planSeed({
  upstreams: [{ name: 'deepseek', shape: 'any', models: [] }],
  brokerBase: 'http://dsh-key-broker:8080',
  placeholder: 'dsh-broker-placeholder',
  catalog,
  existing: { refValues: { DEEPSEEK_API_KEY: 'sk-real-user-key' }, defaultModel: true },
})
assert.deepEqual(reclaim.refs, { DEEPSEEK_API_KEY: 'dsh-broker-placeholder' })
assert.deepEqual(reclaim.reclaimed, ['DEEPSEEK_API_KEY'])
// 部署相关的两项照样重算：密钥代理换了地址，旧 baseURL 会让请求绕开代理。
assert.equal(again.entries[0].always.baseURL, 'http://dsh-key-broker:8080/u/deepseek')

// 一个上游都写不进去的时候不能瞎设默认模型。
const allSkipped = planSeed({
  upstreams: [{ name: 'mygw', shape: 'chat', models: [] }],
  brokerBase: 'http://b:8080',
  placeholder: 'p',
  catalog,
})
assert.deepEqual(allSkipped.entries, [])
assert.equal(allSkipped.defaultModel, null)
assert.deepEqual(allSkipped.refs, {})

console.log('model-settings policy smoke: ok')
