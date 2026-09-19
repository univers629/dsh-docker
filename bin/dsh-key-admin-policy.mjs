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

// 上游名字同时是 settings.yaml 里的路由键和凭据引用名的词干，所以规则不能比 DSH
// 自己宽：官方「添加自定义提供方」用的是 /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/，首字符必须
// 是小写字母（凭据引用名是 POSIX 标识符，不能以数字开头），分隔符只有单个短横线。
// 我们这边放行 b_ai、4o 之类的名字，只会写出一条用户在官方页面上改不了的路由。
const UPSTREAM_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
// 模型 id 会被写进 settings.yaml，也会出现在页面上，所以要挡住控制字符、引号和
// 反斜杠（YAML 与 JSON 的引号语义）以及空白和逗号（它们是模型清单的分隔符）。
// 除此之外一律放行：DSH 那边 id 就是 z.string()，没有字符集限制，而转卖网关很爱给
// 模型贴花名（[蝶恋花]deepseek-v4-flash①），照官方模板发请求就得用那个原样的 id。
const MODEL_ID = /^[^\s,'"\\\u0000-\u001f\u007f]{1,128}$/u
// Gemini 原生协议例外：它把模型 id 拼进 URL 路径（/v1beta/models/<id>:generateContent），
// 所以这一种形态下 id 必须是 URL 路径里能原样出现的字符。
const MODEL_ID_URL_SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/
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
/**
 * 这个名字是不是 DSH 内置模型目录里的路由。用内置 base_url 表当近似：那张表本来就是
 * 从 pi-ai 的目录里抄下来的，而面板这一侧拿不到真正的目录（它在 dsh 镜像的依赖里）。
 * 目录路由不用列模型清单，DSH 会沿用它自带的那份；目录外的网关必须至少有一个模型 id，
 * 否则 DSH 会拒绝整条路由，页面上也就不会多出那张卡片。
 */
export function looksLikeCatalogRoute(name) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_BASE_URLS, name)
}

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
  if (!UPSTREAM_NAME.test(name) || name.length > 32) {
    throw new AdminInputError(
      '上游名字要以小写字母开头，之后只能是小写字母、数字和单个短横线，最多 32 个字符：' + name,
    )
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

/** 一个模型能声明的调用能力，与 pi-ai 的 `input` 一一对应。 */
export const MODEL_INPUT_MODALITIES = Object.freeze(['text', 'image'])

/**
 * 一个模型的调用能力（pi-ai 的 `input`）。
 *
 * 空数组 = 不声明，不是"没有能力"：pi-ai 那边 `input: []` 和不写这个字段是一回事，
 * 都会落到目录条目或路由的 defaultInput 上（默认 text）。所以面板只在真的要声明图像
 * 输入时才写这个字段——给一个目录里的视觉模型写上 `input: [text]` 就把它钉死成纯文本了。
 */
export function normalizeModelInput(raw) {
  const text = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/)
  const out = []
  for (const piece of text) {
    const modality = String(piece ?? '').trim().toLowerCase()
    if (modality === '') continue
    if (!MODEL_INPUT_MODALITIES.includes(modality)) {
      throw new AdminInputError('模型的调用能力只能是 ' + MODEL_INPUT_MODALITIES.join('、') + '，收到：' + modality)
    }
    if (!out.includes(modality)) out.push(modality)
  }
  // 按 MODEL_INPUT_MODALITIES 的顺序归一：这个数组会原样写进 settings.yaml，顺序稳定了
  // 配置的 diff 才看得懂（pi-ai 只看有没有，不看顺序）。
  return MODEL_INPUT_MODALITIES.filter((modality) => out.includes(modality))
}

/**
 * 模型清单 -> 内部记录。每个模型一条，带着它自己的调用能力和推理强度档位。
 *
 * 从前这里只是一串字符串 id，档位挂在整个上游上；但档位本来就是"每个模型各说各话"的
 * 事实（同一个网关里 gpt-5 吃 reasoning_effort，而 image 模型不吃），挂在上游上等于
 * 逼用户在一个上游里只放同一种口味的模型。所以清单里的每一条都带自己的能力与档位，
 * 字符串 id 继续接受（安装器写的就是这个形状），当成"什么都没声明"。
 */
export function normalizeModelRecords(raw, shape) {
  // 逗号和空白都算分隔符：清单也可能直接给一串文本（旧面板的文本框、安装器的参数）。
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/)
  const pattern = shape === 'gemini' ? MODEL_ID_URL_SAFE : MODEL_ID
  const out = []
  for (const entry of list) {
    const record = (entry !== null && typeof entry === 'object') ? entry : { id: entry }
    const id = String(record.id ?? '').trim()
    if (id === '') continue
    if (!pattern.test(id)) {
      throw new AdminInputError(shape === 'gemini'
        ? '模型 id 含有不允许的字符（Gemini 原生协议把它拼进 URL 路径，只能用字母、数字和 . _ : @ / + -）：' + id
        : '模型 id 含有不允许的字符（空白、逗号、引号、反斜杠和控制字符不行，其它都可以）：' + id)
    }
    if (out.some((item) => item.id === id)) continue
    out.push({
      id,
      input: normalizeModelInput(record.input),
      reasoningEfforts: normalizeThinkingLevels(record.reasoningEfforts),
    })
  }
  if (out.length > 200) throw new AdminInputError('一个上游最多 200 个模型 id')
  return out
}

/** 只要 id 的调用方（安装器比对、摘要）：从记录里取出来。 */
export function normalizeModelIds(raw, shape) {
  return normalizeModelRecords(raw, shape).map((record) => record.id)
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

/**
 * pi-ai 认的推理强度档位，按升级顺序。
 *
 * 为什么要在这里出现：DSH 的模型页只对"带推理元数据的模型"显示强度菜单，而安装器和面板
 * 写进 settings.yaml 的模型全是手写声明的——pi-ai 对手写模型一律报告"不提供任何档位"，
 * 于是页面上就没有那个下拉。想要菜单，必须在每个模型上显式声明 reasoningEfforts。
 * 这不能默认开：给一个不吃 reasoning_effort 的模型声明档位，请求会被上游 400。
 */
export const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

// 这里以前还有一份"面板默认勾上的档位"（DEFAULT_PANEL_THINKING_LEVELS）。现在档位是逐模型
// 勾的，没有"新上游默认吃哪几档"这回事：同一个网关里不同模型吃的不一样，替用户预勾等于
// 替他保存一份没验证过的配置，而不勾的后果（模型页没有那个下拉）在表头已经写清楚了。

/**
 * 逗号或换行分隔的档位 -> 规范顺序的数组。空 = 不声明（沿用目录能力，手写模型则没有菜单）。
 * 只有 off 是不合法的：pi-ai 要求至少给出一个 off 之外的档位。
 */
export function normalizeThinkingLevels(raw) {
  const text = Array.isArray(raw) ? raw.join(',') : String(raw ?? '')
  const wanted = new Set()
  for (const piece of text.split(/[\s,]+/)) {
    const level = piece.trim().toLowerCase()
    if (level === '') continue
    if (!THINKING_LEVELS.includes(level)) {
      throw new AdminInputError('推理强度档位只能是 ' + THINKING_LEVELS.join('、') + '，收到：' + level)
    }
    wanted.add(level)
  }
  const levels = THINKING_LEVELS.filter((level) => wanted.has(level))
  if (levels.length > 0 && levels.every((level) => level === 'off')) {
    throw new AdminInputError('推理强度只写 off 没有意义，至少再给一个 low / medium / high 这样的档位')
  }
  return levels
}

export function normalizeQuota(raw, field, fallback = 0) {
  if (raw === undefined || raw === null) return fallback
  const text = String(raw).trim()
  if (text === '') return fallback
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
  const models = normalizeModelRecords(raw?.models, shape)
  const extraHeaders = normalizeExtraHeaders(raw?.extraHeaders, shape)
  // 限额数的是请求次数（每分钟上限 + UTC 每日配额），不是 token 也不是金额。面板上有这
  // 两个输入框，但留空或缺字段一律沿用 keys.json 里那条的现值，只有显式写 0 才是"取消限制"。
  const requestsPerMinute = normalizeQuota(
    raw?.requestsPerMinute, '每分钟请求上限', Number(existingEntry?.requestsPerMinute ?? 0) || 0,
  )
  const dailyRequestBudget = normalizeQuota(
    raw?.dailyRequestBudget, '每日请求配额', Number(existingEntry?.dailyRequestBudget ?? 0) || 0,
  )
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
  // 每一条只写它真的声明过的东西：能力与档位都为空时就是一个光秃秃的 id，与老配置一字不差。
  // 这里再归一化一次，是因为调用方给的既可能是记录，也可能是安装器写的字符串 id。
  // 上游级的 reasoningEfforts 不再写：档位已经跟着模型走了，再留一份就成了两个真相。
  entry.dsh = {
    api: record.shape,
    models: normalizeModelRecords(record.models, record.shape).map((model) => ({
      id: model.id,
      ...(model.input.length > 0 ? { input: [...model.input] } : {}),
      ...(model.reasoningEfforts.length > 0 ? { reasoningEfforts: [...model.reasoningEfforts] } : {}),
    })),
  }
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
    models = normalizeModelRecords(entry?.dsh?.models, shape)
  } catch {
    models = []
  }
  // 老配置的档位挂在上游上（面板以前那一节叫"推理强度档位"，写的是 dsh.reasoningEfforts）。
  // 读的时候把它当成"这一层模型的默认值"补到还没有自己声明的模型上，页面就能照原样回显；
  // 下一次保存会把它们落到每个模型身上，上游级那一份自然消失（toBrokerEntry 不再写它）。
  let legacyLevels = []
  try {
    legacyLevels = normalizeThinkingLevels(entry?.dsh?.reasoningEfforts)
  } catch {
    legacyLevels = []
  }
  return {
    name: String(entry?.name ?? ''),
    baseUrl: String(entry?.baseUrl ?? ''),
    shape,
    models: models.map((model) => ({
      id: model.id,
      input: [...model.input],
      reasoningEfforts: model.reasoningEfforts.length > 0 ? [...model.reasoningEfforts] : [...legacyLevels],
    })),
    // 页面上要能直接看出这条上游为什么在 DSH 里 403：面板自己拉清单时会容错地试
    // /v1/models，所以缺版本段在面板这边完全看不出来。
    needsVersionSegment: baseUrlLooksUnversioned(shape, entry?.baseUrl),
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

/**
 * 这个形态下，DSH 客户端会不会自己往路径里补版本段。
 *
 * 这件事决定 base_url 该不该带 /v1，而它以前是个隐藏的坑：pi-ai 的 OpenAI 兼容实现直接
 * 往 base_url 后面接 /responses、/chat/completions、/models，一个版本段都不补，所以
 * base_url 必须自带 /v1。可 modelsRequestCandidates 为了兼容会同时试 /models 和
 * /v1/models——于是 base_url 少写一个 /v1 时，面板里"拉取模型列表"照样成功，而 DSH 走
 * 代理发的每一个请求都落在上游的根路径上，换回来 403 或 404。表现就是"面板能拉到模型，
 * 网页里一用就说密钥无效"。Anthropic 和 Gemini 相反：它们的客户端自己发 /v1/messages、
 * /v1beta/models，base_url 再带一次就成了 /v1/v1。
 */
const CLIENT_ADDS_VERSION_SEGMENT = Object.freeze({
  any: false,
  chat: false,
  responses: false,
  messages: true,
  gemini: true,
})

/** 这个形态下，base_url 必须自带版本段（客户端不会补）。 */
export function baseUrlMustCarryVersion(shape) {
  return CLIENT_ADDS_VERSION_SEGMENT[shape] === false
}

/** base_url 该带版本段却没带：这条上游在 DSH 里发的每个请求都会落到上游根路径上。 */
export function baseUrlLooksUnversioned(shape, baseUrl) {
  return baseUrlMustCarryVersion(shape) && !/\/v\d[a-z0-9]*$/i.test(String(baseUrl ?? ''))
}

/**
 * 拉模型列表成功的那个端点，反过来说明 base_url 缺了版本段吗？
 *
 * @returns 补好版本段的 base_url；不需要改就返回空串。
 */
export function suggestBaseUrlFix(record, endpoint) {
  if (!baseUrlMustCarryVersion(record.shape)) return ''
  const suffix = String(endpoint ?? '').slice(String(record.baseUrl ?? '').length)
  const match = /^\/(v\d[a-z0-9]*)\//i.exec(suffix)
  if (match === null) return ''
  return record.baseUrl + '/' + match[1]
}

/** 上游的模型列表响应 -> 模型 id 数组。OpenAI、Anthropic、Gemini 三种形状都认。 */
export function extractModelIds(payload, shape) {
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
    const pattern = shape === 'gemini' ? MODEL_ID_URL_SAFE : MODEL_ID
    if (id === '' || !pattern.test(id) || out.includes(id)) continue
    out.push(id)
    if (out.length >= 500) break
  }
  return out
}

/**
 * 上游返回的 id 列表 -> 模型记录：能力与档位沿用已有配置里同一个 id 那份声明。
 *
 * 面板保存时"一个都没勾"的目录外上游会走这里自动补一份清单（DSH 要求至少一个模型）。
 * 这时候用户并没有逐条重新选过，所以上一次勾好的能力与档位必须按 id 搬过来——否则
 * "这次先清空重来"的一次点击就会静默抹掉他之前所有的档位设置。
 *
 * @param ids 上游 /models 返回的 id
 * @param existingEntry keys.json 里这条上游的旧条目（没有就当作全新）
 */
export function mergeDiscoveredModels(ids, existingEntry) {
  let declared = []
  try {
    declared = existingEntry ? toUpstreamView(existingEntry).models : []
  } catch {
    declared = []
  }
  const before = new Map(declared.map((model) => [model.id, model]))
  return ids.map((id) => {
    const kept = before.get(id)
    return {
      id,
      input: kept ? [...kept.input] : [],
      reasoningEfforts: kept ? [...kept.reasoningEfforts] : [],
    }
  })
}

/**
 * 交给 bin/seed-dsh-model-settings.mjs 的载荷：把 keys.json 里的非秘密事实
 * （上游名、形态、模型 id 及其能力与档位）翻译成"DSH 侧该怎么填"。密钥不在其中。
 */
export function seedPayload(document, brokerBase, placeholder) {
  return {
    brokerBase,
    placeholder,
    upstreams: document.upstreams.map((entry) => {
      const view = toUpstreamView(entry)
      return {
        name: view.name,
        shape: view.shape,
        models: view.models,
        // 面板是这份清单的编辑处，所以每次保存都整体覆盖（见 planProvider 的 sync）。
        sync: true,
      }
    }),
  }
}
