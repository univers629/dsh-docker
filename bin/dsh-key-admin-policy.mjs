// DSH 密钥管理面板（dsh-key-admin）的策略层。
//
// 面板要解决的是"密钥只能在安装向导里填"这件事：真实密钥必须留在 dsh 容器之外，
// 所以填密钥的界面也不能是 DSH 自己的 WebUI（那个页面跑在 Agent 所在的容器里，
// 填进去的密钥一条 cat 就能读到）。面板因此是一个独立容器，只发布在宿主回环上，
// 它写的仍然是 data/broker/keys.json —— 与安装向导写的是同一份文件、同一套语义。
//
// 这一层不碰文件、不开网络，所以能在宿主上直接跑单元测试；真正读写文件和转发请求的
// 那一半在 dsh-key-admin.mjs 里。
//
// 与 install.sh 的对应关系（两边必须一致，tests/key-admin-policy-smoke.mjs 会逐条比对）：
//   API_SHAPES        <-> broker_profile_header_name / _header_template / _paths / _headers
//   DEFAULT_BASE_URLS <-> model_default_base_url
//   defaultShapeOf    <-> broker_default_profile
//   toBrokerEntry     <-> broker_upstreams_json（只写偏离 broker 默认值的字段）

import { createHash } from 'node:crypto'

import {
  HOP_BY_HOP_HEADERS,
  STRIPPED_REQUEST_HEADERS,
  isBlockedHost,
} from './dsh-key-broker-policy.mjs'

/** 面板返回给浏览器的错误：status 决定 HTTP 码，message 直接显示给人看。 */
export class AdminInputError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'AdminInputError'
    this.status = status
  }
}

const UPSTREAM_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/
// 模型 id 会被写进 settings.yaml，也会出现在页面上：限制字符集，别让上游返回的
// 任意字符串成为一条注入路径。冒号、斜杠、点在真实模型 id 里都常见，必须放行。
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/
const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * API 形态：一个上游到底长什么样，只有几种可能。选一次形态，认证头、放行端点、
 * 必带的额外头、模型列表端点和写进 DSH 的协议就都定下来了。
 *
 * 这张表是 install.sh 里 broker_profile_* 那四个函数的同一份事实，改一边必须改另一边。
 */
export const API_SHAPES = Object.freeze({
  any: Object.freeze({
    label: 'OpenAI 兼容（不收窄端点）',
    headerName: 'authorization',
    headerTemplate: 'Bearer {key}',
    // 空数组 = 不写 allowedPathPrefixes，沿用 broker 内置的兼容端点集合。
    pathPrefixes: Object.freeze([]),
    extraHeaders: Object.freeze({}),
    modelsPaths: Object.freeze(['/models', '/v1/models']),
  }),
  chat: Object.freeze({
    label: '只用 Chat Completions',
    headerName: 'authorization',
    headerTemplate: 'Bearer {key}',
    pathPrefixes: Object.freeze(['/v1/chat/completions', '/chat/completions', '/v1/models', '/models']),
    extraHeaders: Object.freeze({}),
    modelsPaths: Object.freeze(['/models', '/v1/models']),
  }),
  responses: Object.freeze({
    label: '只用 Responses（Codex 那类客户端）',
    headerName: 'authorization',
    headerTemplate: 'Bearer {key}',
    pathPrefixes: Object.freeze(['/v1/responses', '/responses', '/v1/models', '/models']),
    extraHeaders: Object.freeze({}),
    modelsPaths: Object.freeze(['/models', '/v1/models']),
  }),
  messages: Object.freeze({
    label: 'Anthropic Messages',
    headerName: 'x-api-key',
    headerTemplate: '{key}',
    pathPrefixes: Object.freeze(['/v1/messages', '/messages', '/v1/models', '/models']),
    // 缺 anthropic-version 会被上游直接 400，所以这个头跟着形态一起给。
    extraHeaders: Object.freeze({ 'anthropic-version': '2023-06-01' }),
    modelsPaths: Object.freeze(['/v1/models', '/models']),
  }),
  gemini: Object.freeze({
    label: 'Gemini 原生',
    headerName: 'x-goog-api-key',
    headerTemplate: '{key}',
    pathPrefixes: Object.freeze(['/models', '/v1beta/models']),
    extraHeaders: Object.freeze({}),
    modelsPaths: Object.freeze(['/models']),
  }),
})

/** 常见上游的 base_url。版本段留在这里：DSH 侧填的是 <代理>/u/<上游名>。 */
export const DEFAULT_BASE_URLS = Object.freeze({
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
  moonshotai: 'https://api.moonshot.ai/v1',
  together: 'https://api.together.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  mistral: 'https://api.mistral.ai',
  zai: 'https://api.z.ai/api/coding/paas/v4',
})

// 额外请求头不能碰认证类和逐跳头：那等于让一份配置悄悄绕过密钥注入。
export const FORBIDDEN_HEADER_NAMES = Object.freeze([
  ...STRIPPED_REQUEST_HEADERS,
  ...HOP_BY_HOP_HEADERS,
  'content-length',
])

/** 没显式选形态时按上游名猜一个。猜错只影响端点宽窄，不影响认证头写对写错。 */
export function defaultShapeOf(name) {
  switch (name) {
    case 'anthropic':
    case 'claude':
      return 'messages'
    case 'gemini':
    case 'google':
    case 'googleai':
      return 'gemini'
    default:
      return 'any'
  }
}

export function normalizeName(raw) {
  const name = String(raw ?? '').trim().toLowerCase()
  if (!UPSTREAM_NAME.test(name)) {
    throw new AdminInputError('上游名字只能是小写字母、数字、下划线和短横线，最多 32 个字符：' + name)
  }
  return name
}

export function normalizeShape(raw, name) {
  const shape = String(raw ?? '').trim() || defaultShapeOf(name)
  if (!Object.prototype.hasOwnProperty.call(API_SHAPES, shape)) {
    throw new AdminInputError('未知的 API 形态：' + shape)
  }
  return shape
}

/** base_url 的校验口径与 broker 的 parseBrokerConfig 一致，早报错好过晚报错。 */
export function normalizeBaseUrl(raw, name) {
  const text = String(raw ?? '').trim() || DEFAULT_BASE_URLS[name] || ''
  if (text === '') {
    throw new AdminInputError('上游 ' + name + ' 没有内置 base_url，请自己填一个（要带版本段，例如 https://gateway.example.com/v1）')
  }
  let url
  try {
    url = new URL(text)
  } catch {
    throw new AdminInputError('base_url 不是合法 URL：' + text)
  }
  if (url.protocol !== 'https:') throw new AdminInputError('base_url 必须使用 https（密钥不能走明文）：' + text)
  if (url.username || url.password) throw new AdminInputError('base_url 不允许内嵌凭据')
  if (url.search || url.hash) throw new AdminInputError('base_url 不允许带 query 或 fragment')
  if (isBlockedHost(url.hostname)) {
    throw new AdminInputError('base_url 指向环回、私网或链路本地地址：' + url.hostname)
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export function normalizeModelIds(raw) {
  // 逗号和空白都算分隔符：页面上的模型清单是个多行文本框，人会顺手按回车。
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/)
  const out = []
  for (const entry of list) {
    const id = String(entry ?? '').trim()
    if (id === '') continue
    if (!MODEL_ID.test(id)) throw new AdminInputError('模型 id 含有不允许的字符：' + id)
    if (!out.includes(id)) out.push(id)
  }
  if (out.length > 200) throw new AdminInputError('一个上游最多 200 个模型 id')
  return out
}

/**
 * 额外请求头。用户要的 originator / version / User-Agent 就走这里，
 * 由 broker 在转发时覆盖到上游请求上（它在 stripHeaders 之后写，所以一定生效）。
 */
export function normalizeExtraHeaders(raw, shape) {
  const shapeDefaults = API_SHAPES[shape].extraHeaders
  const entries = Array.isArray(raw)
    ? raw.map((item) => [item?.name, item?.value])
    : Object.entries(raw ?? {})
  const out = {}
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName ?? '').trim().toLowerCase()
    if (name === '') continue
    const value = String(rawValue ?? '').trim()
    if (!HEADER_NAME.test(name)) throw new AdminInputError('不是合法的 HTTP 头名：' + rawName)
    if (FORBIDDEN_HEADER_NAMES.includes(name) || name === API_SHAPES[shape].headerName) {
      throw new AdminInputError('不允许覆盖认证类或逐跳请求头：' + name)
    }
    if (value === '') throw new AdminInputError('请求头 ' + name + ' 的值不能为空')
    if (value.length > 1024) throw new AdminInputError('请求头 ' + name + ' 的值超过 1024 个字符')
    if (/[\r\n]/.test(value)) throw new AdminInputError('请求头 ' + name + ' 的值不允许换行')
    // 形态自带的头（例如 anthropic-version）不必重复存一份：它由形态提供。
    if (shapeDefaults[name] === value) continue
    out[name] = value
  }
  if (Object.keys(out).length > 16) throw new AdminInputError('一个上游最多 16 个额外请求头')
  return out
}

export function normalizeQuota(raw, field) {
  const text = String(raw ?? '').trim()
  if (text === '') return 0
  const value = Number(text)
  if (!Number.isInteger(value) || value < 0) throw new AdminInputError(field + ' 必须是非负整数')
  if (value > 1_000_000) throw new AdminInputError(field + ' 太大了（上限 1000000）')
  return value
}

/** 密钥指纹：只为回答"我这次填的和上次是不是同一把"，不足以还原密钥。 */
export function keyFingerprint(key) {
  if (typeof key !== 'string' || key === '') return ''
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8)
}

/**
 * 面板表单 -> 内部记录。密钥留空表示"沿用已存的那把"：页面永远不显示密钥，
 * 所以改配额、改头、改模型清单时不能要求用户把密钥再抄一遍。
 */
export function normalizeUpstreamInput(raw, existingEntry) {
  const name = normalizeName(raw?.name)
  const shape = normalizeShape(raw?.shape, name)
  const baseUrl = normalizeBaseUrl(raw?.baseUrl, name)
  const models = normalizeModelIds(raw?.models)
  const extraHeaders = normalizeExtraHeaders(raw?.extraHeaders, shape)
  const requestsPerMinute = normalizeQuota(raw?.requestsPerMinute, '每分钟请求上限')
  const dailyRequestBudget = normalizeQuota(raw?.dailyRequestBudget, '每日请求配额')
  const typed = typeof raw?.key === 'string' ? raw.key.trim() : ''
  const key = typed !== '' ? typed : String(existingEntry?.key ?? '')
  if (key === '') throw new AdminInputError('上游 ' + name + ' 还没有密钥，请填一次（之后修改其它字段可以留空）')
  if (key.length > 4096) throw new AdminInputError('密钥超过 4096 个字符')
  return { name, shape, baseUrl, key, models, extraHeaders, requestsPerMinute, dailyRequestBudget }
}

/**
 * 内部记录 -> keys.json 里的一条上游。
 *
 * 只写偏离 broker 默认值的字段：把默认值抄进配置，只会在 broker 改默认值之后变成
 * 静默的行为分叉，也让人更难看出哪些限制是自己真的设过的。
 *
 * dsh 这个字段不是 broker 的（它的解析器忽略未知字段），存的是"DSH 侧要怎么填"：
 * 形态和模型清单。安装向导以前把这两样只留在内存里，重跑一次就丢了，面板需要它们
 * 才能把已有上游正确地显示出来。
 */
export function toBrokerEntry(record) {
  const shape = API_SHAPES[record.shape]
  const entry = { name: record.name, baseUrl: record.baseUrl, key: record.key }
  if (shape.headerName !== 'authorization' || shape.headerTemplate !== 'Bearer {key}') {
    entry.headerName = shape.headerName
    entry.headerTemplate = shape.headerTemplate
  }
  if (shape.pathPrefixes.length > 0) entry.allowedPathPrefixes = [...shape.pathPrefixes]
  const extras = { ...shape.extraHeaders, ...record.extraHeaders }
  if (Object.keys(extras).length > 0) entry.extraHeaders = extras
  if (record.requestsPerMinute > 0) entry.requestsPerMinute = record.requestsPerMinute
  if (record.dailyRequestBudget > 0) entry.dailyRequestBudget = record.dailyRequestBudget
  entry.dsh = { api: record.shape, models: [...record.models] }
  return entry
}

/** 从 headerName / allowedPathPrefixes 反推形态：给没有 dsh 字段的老配置用。 */
export function inferShape(entry) {
  const headerName = String(entry?.headerName ?? 'authorization').toLowerCase()
  if (headerName === 'x-api-key') return 'messages'
  if (headerName === 'x-goog-api-key') return 'gemini'
  const prefixes = Array.isArray(entry?.allowedPathPrefixes) ? entry.allowedPathPrefixes : []
  if (prefixes.includes('/v1/responses') || prefixes.includes('/responses')) return 'responses'
  if (prefixes.includes('/v1/chat/completions') || prefixes.includes('/chat/completions')) return 'chat'
  return 'any'
}

/**
 * keys.json 里的一条上游 -> 页面要显示的视图。这里是唯一一处"从密钥旁边取数据"的
 * 地方，所以它必须只吐出非秘密字段：key 永远不出现，只给一个指纹。
 */
export function toUpstreamView(entry) {
  const shape = Object.prototype.hasOwnProperty.call(API_SHAPES, entry?.dsh?.api)
    ? entry.dsh.api
    : inferShape(entry)
  const shapeDefaults = API_SHAPES[shape].extraHeaders
  const extraHeaders = []
  for (const [name, value] of Object.entries(entry?.extraHeaders ?? {})) {
    if (shapeDefaults[name] === value) continue
    extraHeaders.push({ name, value: String(value) })
  }
  let models = []
  try {
    models = normalizeModelIds(entry?.dsh?.models)
  } catch {
    models = []
  }
  return {
    name: String(entry?.name ?? ''),
    baseUrl: String(entry?.baseUrl ?? ''),
    shape,
    models,
    extraHeaders,
    requestsPerMinute: Number(entry?.requestsPerMinute ?? 0) || 0,
    dailyRequestBudget: Number(entry?.dailyRequestBudget ?? 0) || 0,
    hasKey: typeof entry?.key === 'string' && entry.key !== '',
    keyFingerprint: keyFingerprint(entry?.key),
  }
}

/** 读一份 keys.json。文件不存在或是空的都按"还没有任何上游"处理，面板要能从零开始。 */
export function readDocument(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { version: 1, upstreams: [] }
  let document
  try {
    document = JSON.parse(raw)
  } catch (error) {
    throw new AdminInputError('data/broker/keys.json 不是合法 JSON，面板不敢改它：' + error.message, 500)
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new AdminInputError('data/broker/keys.json 的顶层必须是对象', 500)
  }
  if (document.version !== undefined && document.version !== 1) {
    throw new AdminInputError('不支持的 keys.json 版本：' + document.version, 500)
  }
  const upstreams = Array.isArray(document.upstreams) ? document.upstreams : []
  return { version: 1, upstreams: upstreams.filter((entry) => entry && typeof entry === 'object') }
}

export function serializeDocument(document) {
  return JSON.stringify({ version: 1, upstreams: document.upstreams }, null, 2) + '\n'
}

export function findUpstream(document, name) {
  return document.upstreams.find((entry) => String(entry?.name ?? '') === name)
}

/** 同名上游整条替换（与安装器合并 keys.json 的语义一致：以最后一次为准）。 */
export function mergeUpstream(document, entry) {
  const upstreams = document.upstreams.filter((item) => String(item?.name ?? '') !== entry.name)
  if (upstreams.length >= 32) throw new AdminInputError('上游数量上限是 32')
  upstreams.push(entry)
  return { version: 1, upstreams }
}

export function removeUpstream(document, name) {
  const upstreams = document.upstreams.filter((item) => String(item?.name ?? '') !== name)
  if (upstreams.length === document.upstreams.length) {
    throw new AdminInputError('没有这个上游：' + name, 404)
  }
  return { version: 1, upstreams }
}

/**
 * 拉模型列表要打的请求。面板自己直连上游（它本来就持有密钥），不经过 broker：
 * broker 在另一张网络上，而且它的存在意义是不让 dsh 容器碰密钥，不是给面板做跳板。
 *
 * 候选多于一个是因为版本段的位置由上游决定：base_url 已经带 /v1 时要打 /models，
 * 没带时要打 /v1/models。逐个试，第一个能解析出清单的算成功。
 */
export function modelsRequestCandidates(record) {
  const shape = API_SHAPES[record.shape]
  const headers = { accept: 'application/json', 'accept-encoding': 'identity' }
  headers[shape.headerName] = shape.headerTemplate.replace('{key}', record.key)
  for (const [name, value] of Object.entries({ ...shape.extraHeaders, ...record.extraHeaders })) {
    headers[name] = value
  }
  // base_url 已经带版本段时不要再拼一个：那会打出 /v1/v1/models 这种必然 404 的地址。
  const versioned = /\/v\d[a-z0-9]*$/i.test(record.baseUrl)
  const seen = new Set()
  const candidates = []
  for (const suffix of shape.modelsPaths) {
    if (versioned && suffix.startsWith('/v1/')) continue
    const url = record.baseUrl + suffix
    if (seen.has(url)) continue
    seen.add(url)
    candidates.push({ url, headers })
  }
  if (candidates.length === 0) candidates.push({ url: record.baseUrl + '/models', headers })
  return candidates
}

/** 上游的模型列表响应 -> 模型 id 数组。OpenAI、Anthropic、Gemini 三种形状都认。 */
export function extractModelIds(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : null
  if (list === null) return []
  const out = []
  for (const item of list) {
    let id = typeof item === 'string' ? item : String(item?.id ?? item?.name ?? '')
    // Gemini 返回的是 models/gemini-3-pro 这种全名，DSH 侧要的是后面那一段。
    if (id.startsWith('models/')) id = id.slice('models/'.length)
    id = id.trim()
    if (id === '' || !MODEL_ID.test(id) || out.includes(id)) continue
    out.push(id)
    if (out.length >= 500) break
  }
  return out
}

/**
 * 交给 bin/seed-dsh-model-settings.mjs 的载荷：把 keys.json 里的非秘密事实
 * （上游名、形态、模型 id）翻译成"DSH 侧该怎么填"。密钥不在其中。
 */
export function seedPayload(document, brokerBase, placeholder) {
  return {
    brokerBase,
    placeholder,
    upstreams: document.upstreams.map((entry) => {
      const view = toUpstreamView(entry)
      return { name: view.name, shape: view.shape, models: view.models }
    }),
  }
}
