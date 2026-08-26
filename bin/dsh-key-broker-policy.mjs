// DSH 模型密钥代理的策略层。
//
// 设计目标：容器里永远不出现真实的模型 API 密钥。DSH 只知道一个占位密钥和一个
// 指向本代理的 base_url，真密钥只存在于代理容器的内存和宿主上那份 0600 的配置文件里。
// 因此提示注入即使完全成功，也读不到一个不在容器里的字符串。
//
// 策略单独放这一层：既被代理进程引用，也能在宿主机上直接跑单元测试，不必起容器。
//
// 默认拒绝：上游是固定的 baseUrl，客户端只能选择“哪个上游 + 哪条被允许的路径”，
// 不能让代理去访问任意 URL。否则代理就退化成一个带密钥的开放跳板。

export class BrokerConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BrokerConfigError'
  }
}

export class BrokerPolicyError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'BrokerPolicyError'
    this.status = status
  }
}

// 上游名字要能安全地出现在 URL 路径里，也要能安全地打进日志。
const UPSTREAM_NAME = /^[a-z0-9][a-z0-9_-]{0,30}$/

// 常见 OpenAI/Anthropic/Gemini 兼容端点。默认只放行这些前缀，避免代理被当成
// 任意 REST 客户端使用（例如去调上游的账号管理或文件上传接口）。
export const DEFAULT_ALLOWED_PATH_PREFIXES = Object.freeze([
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/responses',
  '/v1/messages',
  '/v1/models',
  '/v1beta/models',
  '/chat/completions',
  '/completions',
  '/embeddings',
  '/responses',
  '/messages',
  '/models',
])

// 请求头黑名单：客户端不得自带任何认证材料，否则它可以绕过我们的注入逻辑，
// 或者把自己的凭据混进上游请求里。cookie 一并去掉，避免会话被顺带转发。
export const STRIPPED_REQUEST_HEADERS = Object.freeze([
  'authorization',
  'proxy-authorization',
  'api-key',
  'x-api-key',
  'x-goog-api-key',
  'x-auth-token',
  'cookie',
  'set-cookie',
  'host',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
])

export const HOP_BY_HOP_HEADERS = Object.freeze([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

// 私网、环回、链路本地（含云 metadata 的 169.254.169.254）与 IPv6 内网段。
// 上游 baseUrl 落在这些地址上就等于把代理变成打宿主机和内网的工具。
export function isBlockedHost(host) {
  if (typeof host !== 'string' || host === '') return true
  const value = host.trim().toLowerCase().replace(/\.$/, '')
  if (value === '' || value === 'localhost' || value.endsWith('.localhost')) return true
  if (value === 'metadata' || value === 'metadata.google.internal') return true

  const bracketed = /^\[(.+)\]$/.exec(value)
  const candidate = bracketed ? bracketed[1] : value

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(candidate)) {
    const octets = candidate.split('.').map(Number)
    if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return true
    const [a, b] = octets
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    return false
  }

  if (candidate.includes(':')) {
    // 任何 IPv6 字面量都拒绝：模型上游不会用裸 IPv6，放行只会增加内网面。
    return true
  }

  return false
}

function requireString(value, field, { maxLength = 512 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BrokerConfigError(`${field} 必须是非空字符串`)
  }
  if (value.length > maxLength) {
    throw new BrokerConfigError(`${field} 超过 ${maxLength} 个字符`)
  }
  return value.trim()
}

function requireCount(value, field) {
  if (value === undefined || value === null) return 0
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new BrokerConfigError(`${field} 必须是非负整数`)
  }
  return number
}

function normalizePrefix(value, field) {
  const prefix = requireString(value, field, { maxLength: 256 })
  if (!prefix.startsWith('/')) {
    throw new BrokerConfigError(`${field} 必须以 / 开头：${prefix}`)
  }
  if (prefix.includes('..') || prefix.includes('\\') || /[\s?#]/.test(prefix)) {
    throw new BrokerConfigError(`${field} 含有不允许的字符：${prefix}`)
  }
  return prefix
}

function normalizeUpstream(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BrokerConfigError(`upstreams[${index}] 必须是对象`)
  }
  const name = requireString(raw.name, `upstreams[${index}].name`, { maxLength: 32 }).toLowerCase()
  if (!UPSTREAM_NAME.test(name)) {
    throw new BrokerConfigError(`upstreams[${index}].name 只能是小写字母、数字、下划线和短横线：${name}`)
  }

  const baseUrlText = requireString(raw.baseUrl, `upstreams[${index}].baseUrl`, { maxLength: 512 })
  let baseUrl
  try {
    baseUrl = new URL(baseUrlText)
  } catch {
    throw new BrokerConfigError(`upstreams[${index}].baseUrl 不是合法 URL：${baseUrlText}`)
  }
  if (baseUrl.protocol !== 'https:') {
    throw new BrokerConfigError(`upstreams[${index}].baseUrl 必须使用 https（密钥不能走明文）：${baseUrlText}`)
  }
  if (baseUrl.username || baseUrl.password) {
    throw new BrokerConfigError(`upstreams[${index}].baseUrl 不允许内嵌凭据`)
  }
  if (baseUrl.search || baseUrl.hash) {
    throw new BrokerConfigError(`upstreams[${index}].baseUrl 不允许带 query 或 fragment`)
  }
  if (isBlockedHost(baseUrl.hostname)) {
    throw new BrokerConfigError(`upstreams[${index}].baseUrl 指向环回、私网或链路本地地址：${baseUrl.hostname}`)
  }

  const key = requireString(raw.key, `upstreams[${index}].key`, { maxLength: 4096 })
  const headerName = raw.headerName === undefined
    ? 'authorization'
    : requireString(raw.headerName, `upstreams[${index}].headerName`, { maxLength: 64 }).toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(headerName)) {
    throw new BrokerConfigError(`upstreams[${index}].headerName 不是合法的 HTTP 头名：${headerName}`)
  }
  const headerTemplate = raw.headerTemplate === undefined
    ? 'Bearer {key}'
    : requireString(raw.headerTemplate, `upstreams[${index}].headerTemplate`, { maxLength: 256 })
  if (!headerTemplate.includes('{key}')) {
    throw new BrokerConfigError(`upstreams[${index}].headerTemplate 必须包含 {key} 占位符`)
  }

  let allowedPathPrefixes = DEFAULT_ALLOWED_PATH_PREFIXES
  if (raw.allowedPathPrefixes !== undefined) {
    if (!Array.isArray(raw.allowedPathPrefixes) || raw.allowedPathPrefixes.length === 0) {
      throw new BrokerConfigError(`upstreams[${index}].allowedPathPrefixes 必须是非空数组`)
    }
    allowedPathPrefixes = raw.allowedPathPrefixes.map((value, position) =>
      normalizePrefix(value, `upstreams[${index}].allowedPathPrefixes[${position}]`))
  }

  const extraHeaders = {}
  if (raw.extraHeaders !== undefined) {
    if (!raw.extraHeaders || typeof raw.extraHeaders !== 'object' || Array.isArray(raw.extraHeaders)) {
      throw new BrokerConfigError(`upstreams[${index}].extraHeaders 必须是对象`)
    }
    for (const [headerKey, headerValue] of Object.entries(raw.extraHeaders)) {
      const normalized = headerKey.toLowerCase()
      if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
        throw new BrokerConfigError(`upstreams[${index}].extraHeaders 含非法头名：${headerKey}`)
      }
      // extraHeaders 只能补充无害的头（例如 anthropic-version）。认证类头和注入用的
      // headerName 一律禁止，否则配置能悄悄覆盖掉我们注入的密钥头。
      if (STRIPPED_REQUEST_HEADERS.includes(normalized) || normalized === headerName) {
        throw new BrokerConfigError(`upstreams[${index}].extraHeaders 不允许覆盖认证类头：${headerKey}`)
      }
      extraHeaders[normalized] = requireString(headerValue, `upstreams[${index}].extraHeaders.${headerKey}`, { maxLength: 1024 })
    }
  }

  return {
    name,
    baseUrl: baseUrl.origin + baseUrl.pathname.replace(/\/$/, ''),
    host: baseUrl.hostname,
    port: baseUrl.port === '' ? 443 : Number(baseUrl.port),
    basePath: baseUrl.pathname.replace(/\/$/, ''),
    key,
    headerName,
    headerValue: headerTemplate.replace('{key}', key),
    allowedPathPrefixes,
    extraHeaders,
    dailyRequestBudget: requireCount(raw.dailyRequestBudget, `upstreams[${index}].dailyRequestBudget`),
    requestsPerMinute: requireCount(raw.requestsPerMinute, `upstreams[${index}].requestsPerMinute`),
    maxRequestBytes: requireCount(raw.maxRequestBytes, `upstreams[${index}].maxRequestBytes`) || 8 * 1024 * 1024,
  }
}

export function parseBrokerConfig(raw) {
  let document = raw
  if (typeof raw === 'string') {
    try {
      document = JSON.parse(raw)
    } catch (error) {
      throw new BrokerConfigError(`密钥配置不是合法 JSON：${error.message}`)
    }
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new BrokerConfigError('密钥配置必须是 JSON 对象')
  }
  if (document.version !== undefined && document.version !== 1) {
    throw new BrokerConfigError(`不支持的密钥配置版本：${document.version}`)
  }
  if (!Array.isArray(document.upstreams) || document.upstreams.length === 0) {
    throw new BrokerConfigError('密钥配置必须包含非空的 upstreams 数组')
  }
  if (document.upstreams.length > 32) {
    throw new BrokerConfigError('upstreams 数量上限为 32')
  }

  const upstreams = new Map()
  for (const [index, entry] of document.upstreams.entries()) {
    const upstream = normalizeUpstream(entry, index)
    if (upstreams.has(upstream.name)) {
      throw new BrokerConfigError(`上游名字重复：${upstream.name}`)
    }
    upstreams.set(upstream.name, upstream)
  }
  return { version: 1, upstreams }
}

// 所有密钥字面量，用于把它们从日志和上游错误体里抹掉。
export function collectSecrets(config) {
  const secrets = []
  for (const upstream of config.upstreams.values()) {
    secrets.push(upstream.key)
    secrets.push(upstream.headerValue)
  }
  return secrets.filter((value) => typeof value === 'string' && value.length >= 8)
}

// 有些上游会在错误信息里回显收到的密钥。这里兜一道，避免密钥被写进容器能看到的响应体。
export function redactSecrets(text, secrets) {
  if (typeof text !== 'string' || text === '') return text
  let output = text
  for (const secret of secrets) {
    if (!secret) continue
    output = output.split(secret).join('***redacted***')
  }
  return output
}

function decodeOnce(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new BrokerPolicyError(400, '请求路径的百分号编码不合法')
  }
}

// 路径归一化：拒绝穿越、反斜杠、NUL 和空段，避免用 %2e%2e 之类绕过前缀白名单。
export function normalizeUpstreamPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) {
    throw new BrokerPolicyError(400, '上游路径必须以 / 开头')
  }
  if (rawPath.length > 2048) {
    throw new BrokerPolicyError(414, '上游路径过长')
  }
  const segments = rawPath.split('/')
  const normalized = []
  for (const segment of segments) {
    if (segment === '') continue
    const decoded = decodeOnce(segment)
    if (decoded === '.' || decoded === '..' || segment === '.' || segment === '..') {
      throw new BrokerPolicyError(400, '上游路径不允许出现相对段')
    }
    if (decoded.includes('\\') || decoded.includes('\0') || /[\r\n]/.test(decoded)) {
      throw new BrokerPolicyError(400, '上游路径含有不允许的字符')
    }
    normalized.push(segment)
  }
  return '/' + normalized.join('/')
}

export function isPathAllowed(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))
}

// 路由形如 /u/<上游名>/<上游路径>。客户端只能选上游和路径，选不了主机。
export function resolveRoute(requestPath, config) {
  const [pathname, ...rest] = String(requestPath ?? '').split('?')
  const query = rest.length > 0 ? rest.join('?') : ''
  const match = /^\/u\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!match) {
    throw new BrokerPolicyError(404, '请求路径必须形如 /u/<上游名>/<上游路径>')
  }
  const name = decodeOnce(match[1]).toLowerCase()
  const upstream = config.upstreams.get(name)
  if (!upstream) {
    throw new BrokerPolicyError(404, `未配置的上游：${name}`)
  }
  const upstreamPath = normalizeUpstreamPath(match[2] ?? '/')
  if (!isPathAllowed(upstreamPath, upstream.allowedPathPrefixes)) {
    throw new BrokerPolicyError(403, `上游 ${name} 不允许访问路径 ${upstreamPath}`)
  }
  if (query.length > 2048) {
    throw new BrokerPolicyError(414, '查询字符串过长')
  }
  return { upstream, upstreamPath, query }
}

export const ALLOWED_METHODS = Object.freeze(['GET', 'POST'])

export function assertMethod(method) {
  if (!ALLOWED_METHODS.includes(String(method ?? '').toUpperCase())) {
    throw new BrokerPolicyError(405, `不允许的方法：${method}`)
  }
  return String(method).toUpperCase()
}

// --- 配额与限速 ---
//
// 目的不是精确计费，而是让一个被提示注入劫持的 Agent 无法无上限地烧额度：
// 每分钟窗口限速挡住循环调用，UTC 日配额给出一个硬上限。

export function emptyUsageState() {
  return { day: '', dayCount: 0, minuteStart: 0, minuteCount: 0, allowed: 0, denied: 0 }
}

export function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10)
}

export function usageDecision(state, upstream, nowMs) {
  const day = utcDay(nowMs)
  const dayCount = state.day === day ? state.dayCount : 0
  const minuteStart = nowMs - state.minuteStart < 60_000 ? state.minuteStart : nowMs
  const minuteCount = minuteStart === state.minuteStart ? state.minuteCount : 0

  if (upstream.dailyRequestBudget > 0 && dayCount >= upstream.dailyRequestBudget) {
    return { allowed: false, status: 429, reason: `上游 ${upstream.name} 今日请求配额已用尽（${upstream.dailyRequestBudget}）` }
  }
  if (upstream.requestsPerMinute > 0 && minuteCount >= upstream.requestsPerMinute) {
    return { allowed: false, status: 429, reason: `上游 ${upstream.name} 每分钟请求上限已达到（${upstream.requestsPerMinute}）` }
  }
  return { allowed: true, status: 200, reason: '' }
}

export function registerUsage(state, nowMs, outcome) {
  const day = utcDay(nowMs)
  const sameMinute = nowMs - state.minuteStart < 60_000
  const next = {
    day,
    dayCount: state.day === day ? state.dayCount : 0,
    minuteStart: sameMinute ? state.minuteStart : nowMs,
    minuteCount: sameMinute ? state.minuteCount : 0,
    allowed: state.allowed,
    denied: state.denied,
  }
  if (outcome === 'allow') {
    next.dayCount += 1
    next.minuteCount += 1
    next.allowed += 1
  } else {
    next.denied += 1
  }
  return next
}
