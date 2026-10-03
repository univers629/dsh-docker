// 每用户上游授权：代理侧的执行逻辑。
//
// 背景：代理本身不校验调用者时，「只给某用户开放某几个上游」只是界面上的说法——
// 任何实例都能直接请求任意上游名。因此代理需要能认出调用者是谁，并按该用户的
// 授权清单过滤上游。
//
// 令牌形态沿用本项目已有的做法（与 dsh-auth 的 instances.token 一致）：
//   * 每实例一枚随机令牌，通过共享挂载下发给实例
//   * 代理只保存摘要，比对用恒时比较
//   * 令牌 → uid，uid → 该用户被开放的上游集合

import { createHash, timingSafeEqual } from 'node:crypto'

import { BrokerConfigError } from './dsh-key-broker-policy.mjs'

/** 授权表的版本号，便于以后演进而不误读旧文件。 */
export const GRANTS_VERSION = 1

/**
 * 令牌摘要。与 dsh-auth 的 tokenDigest 同构：只存摘要，泄库也拿不到可用令牌。
 * @param {string} token 原始令牌。
 * @returns {string} 十六进制摘要。
 */
export function brokerTokenDigest(token) {
  return createHash('sha256').update(`dsh-broker-token\0${String(token ?? '')}`, 'utf8').digest('hex')
}

/**
 * 恒时比较两个摘要。长度不同直接返回 false（长度本身不是秘密）。
 * @param {string} a 摘要一。
 * @param {string} b 摘要二。
 * @returns {boolean} 是否相同。
 */
function digestsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 解析授权表。结构：
 * ```
 * { version: 1, users: { "<uid>": { tokenDigest: "...", upstreams: ["a","b"] } } }
 * ```
 * `upstreams` 为空数组表示该用户没有任何可用上游（明确拒绝，而不是「不限」）。
 * 这一点很重要：默认必须是拒绝，漏配只会让人用不了，而不是让人随便用。
 *
 * @param {unknown} raw 解析好的对象或 JSON 文本。
 * @returns {{version: number, users: Map<string, {tokenDigest: string, upstreams: Set<string>}>}} 规范化结果。
 */
export function parseGrants(raw) {
  let document = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text.length === 0) return { version: GRANTS_VERSION, users: new Map() }
    try {
      document = JSON.parse(text)
    } catch (error) {
      throw new BrokerConfigError(`授权表不是合法 JSON：${error.message}`)
    }
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new BrokerConfigError('授权表必须是 JSON 对象')
  }
  if (document.version !== undefined && document.version !== GRANTS_VERSION) {
    throw new BrokerConfigError(`不支持的授权表版本：${document.version}`)
  }
  const users = new Map()
  const source = document.users
  if (source === undefined) return { version: GRANTS_VERSION, users }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new BrokerConfigError('授权表的 users 必须是对象')
  }
  for (const [uid, entry] of Object.entries(source)) {
    if (!/^\d+$/.test(uid)) throw new BrokerConfigError(`授权表的键必须是 uid（数字）：${uid}`)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BrokerConfigError(`授权表 users[${uid}] 必须是对象`)
    }
    const tokenDigest = typeof entry.tokenDigest === 'string' ? entry.tokenDigest : ''
    const upstreams = Array.isArray(entry.upstreams) ? entry.upstreams : []
    users.set(uid, {
      tokenDigest,
      upstreams: new Set(upstreams.filter((name) => typeof name === 'string' && name.length > 0)),
    })
  }
  return { version: GRANTS_VERSION, users }
}

/**
 * 由令牌解析出调用者。
 *
 * 遍历而非哈希查表：用户数量级很小（几十），而遍历 + 恒时比较不会因为
 * 「查不到就早退」而泄露某个摘要是否存在。
 *
 * @param {unknown} grants 授权表（parseGrants 的结果）。
 * @param {string} token 请求携带的令牌。
 * @returns {{uid: string, upstreams: Set<string>}|null} 调用者，认不出则为 null。
 */
export function identifyCaller(grants, token) {
  if (!grants || !(grants.users instanceof Map)) return null
  if (typeof token !== 'string' || token.length === 0) return null
  const digest = brokerTokenDigest(token)
  let found = null
  for (const [uid, entry] of grants.users) {
    if (digestsEqual(entry.tokenDigest, digest)) found = { uid, upstreams: entry.upstreams }
  }
  return found
}

/**
 * 判断调用者是否可以使用某个上游。
 *
 * 未配置授权表的用户一律拒绝——这正是「默认拒绝」的落点：管理员没勾选，
 * 就用不了，而不是默认全开。
 *
 * @param {{uid: string, upstreams: Set<string>}|null} caller identifyCaller 的结果。
 * @param {string} upstreamName 上游名。
 * @returns {boolean} 是否允许。
 */
export function isUpstreamAllowed(caller, upstreamName) {
  if (!caller || !(caller.upstreams instanceof Set)) return false
  return caller.upstreams.has(String(upstreamName ?? '').toLowerCase())
}

/**
 * 从请求头里取调用者令牌。
 *
 * 头名用 `x-dsh-instance-token`：DSH 侧的 Authorization 头会被代理丢弃并替换成
 * 真实密钥，因此不能占用它传递身份。
 *
 * @param {Record<string, unknown>} headers 请求头。
 * @returns {string} 令牌或空串。
 */
export function callerTokenFromHeaders(headers) {
  const raw = headers?.['x-dsh-instance-token']
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : ''
}
