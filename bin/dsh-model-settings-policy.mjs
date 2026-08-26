// DSH 模型设置的"该写什么"这一半：把安装器收集到的上游（名字 + API 形态 + 模型 id）
// 翻译成 DSH 官方的配置格式——settings.yaml 里的 llm-pi-ai.providers 与 .credentials.yaml
// 里的 refs。这个模块不碰文件、不依赖 yaml 库，所以它能在宿主上直接跑单元测试；真正
// 改文件的那一半在 seed-dsh-model-settings.mjs 里。
//
// 为什么安装器要替用户写这份配置：真实密钥搬进 dsh-key-broker 之后，DSH 侧需要的
// 只是"指向代理的 base_url"和"一个占位密钥"，两样都不是秘密。以前只把它们打印在
// 摘要里让用户手抄进 WebUI，而抄错一处就是 404 或 403——尤其是 base_url 的版本段。
//
// 路径契约（决定 base_url 长什么样）：
//   - dsh-key-broker 的转发目标 = 上游 base_url 的路径 + 客户端请求的路径；
//   - pi-ai 各协议的 SDK 自己会补相对路径（/chat/completions、/responses、
//     /v1/messages、/models/<model>:...），不会补版本段；
//   所以 DSH 侧的 base_url 一律是 <broker>/u/<上游名>（不带 /v1），版本段属于
//   keys.json 里那个只有 broker 能读到的上游 base_url。

/** 安装器的 API 形态 → pi-ai 的 wire 协议名（自定义路由必须显式给一个）。 */
export const PROTOCOL_BY_API_SHAPE = Object.freeze({
  // any 是"没显式选形态"的默认值。自定义路由必须落一个协议，OpenAI 兼容的
  // /chat/completions 是网关里最常见的那个，所以拿它兜底。
  any: 'openai-completions',
  chat: 'openai-completions',
  responses: 'openai-responses',
  messages: 'anthropic-messages',
  // gemini 故意留空：这个 DSH 构建的自定义路由只能声明下面三种协议，
  // google-generative-ai 只存在于内置目录路由上。
  gemini: '',
})

/** 自定义（目录里没有的）路由可以声明的协议。与 pi-ai 的 supportedProtocols() 一致。 */
export const SUPPORTED_ROUTE_PROTOCOLS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

/**
 * 上游名 → 凭据引用名。必须和 WebUI 自己派生的名字一致（大写、非字母数字换成
 * 下划线、加 _API_KEY 后缀），否则用户在页面上改密钥会改到另一个引用上，
 * 页面显示"已配置"而请求仍然用着占位密钥。
 */
export function deriveCredentialRef(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
}

/** DSH 侧该填的 base_url。见文件头的路径契约：不带版本段。 */
export function brokerRouteBaseUrl(brokerBase, name) {
  return String(brokerBase).replace(/\/+$/, '') + '/u/' + name
}

/** 归一化模型 id 列表：去空、去重、保持填写顺序。 */
export function normalizeModelIds(models) {
  const seen = new Set()
  const result = []
  for (const raw of models ?? []) {
    const id = String(raw ?? '').trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * 规划一个上游的 provider profile。
 *
 * 两种路由的规则不一样，这个分叉是 pi-ai 定的，不是我们选的：
 *   - 目录路由（名字正好是 pi-ai 内置目录里的 id，如 deepseek/google/nvidia）：
 *     协议和模型清单由目录提供，我们只覆盖 baseURL 和 apiKeyEnv，用户立刻就有
 *     一整排可选模型；
 *   - 自定义路由：目录什么都不知道，所以必须显式给协议和至少一个模型 id，
 *     少一样 pi-ai 就会拒绝整个 namespace。
 *
 * @param request.name 上游名（同时是 settings 里的路由键）
 * @param request.shape 安装器的 API 形态（any/chat/responses/messages/gemini）
 * @param request.models 用户填的模型 id
 * @param request.brokerBase 密钥代理的 base（http://dsh-key-broker:8080）
 * @param request.catalog 目录快照：{ [id]: { api, models: [id] } }
 * @returns 可写入时返回 ok:true 与字段计划，否则 ok:false 与拒绝原因
 */
export function planProvider(request) {
  const name = String(request.name ?? '')
  const catalogEntry = (request.catalog ?? {})[name]
  const models = normalizeModelIds(request.models)
  const baseURL = brokerRouteBaseUrl(request.brokerBase, name)
  const apiKeyEnv = deriveCredentialRef(name)
  // baseURL / apiKeyEnv 由密钥代理的部署形态决定，用户在 WebUI 里改它们只会让
  // 请求绕开代理或找不到密钥，所以这两项每次都写成当前部署的值；其余字段属于
  // 用户，只在缺失时补。
  const always = { baseURL, apiKeyEnv }
  const whenMissing = {}

  if (catalogEntry) {
    // 目录路由不写 api：写了就等于宣布"这条路由的每个模型都说这一种协议"，
    // 而目录里的模型各自带着自己的协议（google 的就不在自定义路由的三种里）。
    if (models.length > 0) whenMissing.models = models.map((id) => ({ id }))
    return {
      ok: true,
      name,
      source: 'catalog',
      always,
      whenMissing,
      api: catalogEntry.api ?? '',
      models: models.length > 0 ? models : normalizeModelIds(catalogEntry.models),
    }
  }

  // 空串和缺失都按 any 处理：安装器没问过形态时给的就是空串，那不该变成一条拒绝。
  const shape = String(request.shape ?? '').trim().toLowerCase() || 'any'
  const protocol = PROTOCOL_BY_API_SHAPE[shape] ?? ''
  if (protocol.length === 0) {
    return {
      ok: false,
      name,
      reason: '自定义上游只能声明 ' + SUPPORTED_ROUTE_PROTOCOLS.join(' / ') +
        '；Gemini 协议只存在于内置目录路由上，把上游名字改成 google 就能用目录里的 Gemini 模型。',
    }
  }
  if (models.length === 0) {
    return {
      ok: false,
      name,
      reason: '内置目录里没有这个上游，所以它的模型必须显式列出来：用 --model-id ' +
        name + '=<模型 id> 或在向导里填一个。',
    }
  }
  whenMissing.api = protocol
  whenMissing.models = models.map((id) => ({ id }))
  return { ok: true, name, source: 'declared', always, whenMissing, api: protocol, models }
}

/**
 * 规划整份种子配置。
 *
 * @param request.upstreams [{ name, shape, models }]
 * @param request.brokerBase 密钥代理 base
 * @param request.placeholder 占位密钥字面值
 * @param request.catalog 目录快照
 * @param request.existing { providers: 已有的 llm-pi-ai.providers, refs: 已有的凭据引用名, defaultModel: 已有的 agent-default-model }
 * @returns { entries, skipped, refs, defaultModel }
 */
export function planSeed(request) {
  const existing = request.existing ?? {}
  const existingProviders = existing.providers ?? {}
  const existingRefs = new Set(existing.refs ?? [])
  const entries = []
  const skipped = []
  const refs = {}

  for (const upstream of request.upstreams ?? []) {
    const plan = planProvider({
      name: upstream.name,
      shape: upstream.shape,
      models: upstream.models,
      brokerBase: request.brokerBase,
      catalog: request.catalog,
    })
    if (!plan.ok) {
      skipped.push({ name: plan.name, reason: plan.reason })
      continue
    }
    entries.push(plan)
    // 占位密钥只在这个引用还没有值的时候写：用户要是自己在 WebUI 里填过真实密钥
    // （那是他的选择），占位串盖回去会让请求直接失效。
    const ref = plan.always.apiKeyEnv
    if (!existingRefs.has(ref)) refs[ref] = request.placeholder
  }

  // 默认模型只在还没有的时候设：这是"装完就能对话"的最后一步，但用户选过之后
  // 每次重新配置都改回来就成了骚扰。
  let defaultModel = null
  if (!existing.defaultModel) {
    const seed = entries.find((entry) => entry.models.length > 0)
    if (seed) defaultModel = { provider: seed.name, model: seed.models[0] }
  }

  return { entries, skipped, refs, defaultModel, existingProviders }
}
