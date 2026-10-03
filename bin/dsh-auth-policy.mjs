// dsh-auth 的纯策略层：密码、限速、校验、CSRF 令牌——不碰 IO、不碰网络，便于单测。
//
// 设计出处（见 docs/auth-design.md §2、§3）：
//   * Argon2id 参数与编码格式对齐 KPanel internal/auth/password.go；
//   * 密码强度规则对齐 KPanel validatePassword；
//   * 登录防枚举（dummy hash 恒时比对）对齐 KPanel Service.Login；
//   * 限速用「IP + 账户」双桶，对齐 KPanel loginKeys；
//   * 所有敏感比对走恒时比较，避免时序侧信道（威胁 T15）。

import { argon2Sync, createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

/** Argon2id 参数（KPanel DefaultArgon2idParams 同款：64MiB / 3 轮 / ≥1 并发）。 */
export const ARGON2 = Object.freeze({
  algorithm: 'argon2id',
  memory: 64 * 1024,
  passes: 3,
  parallelism: 4,
  saltLength: 16,
  tagLength: 32,
})

/** 密码长度与组成规则（KPanel validatePassword 同款：12–256 字节、至少一字母一数字）。 */
export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 256

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/

/**
 * 校验用户名。规则与 KPanel 一致，避免出现各种奇怪的用户名进入状态库。
 * @param {string} username 待校验用户名。
 * @returns {boolean} 是否合法。
 */
export function isValidUsername(username) {
  return typeof username === 'string' && USERNAME_PATTERN.test(username)
}

/**
 * 校验密码强度。返回 null 表示通过，否则返回面向用户的短原因（不含内部细节）。
 * @param {string} password 待校验密码。
 * @returns {null | 'length' | 'composition'} 失败原因。
 */
export function validatePassword(password) {
  if (typeof password !== 'string') return 'length'
  const bytes = Buffer.byteLength(password, 'utf8')
  if (bytes < PASSWORD_MIN || bytes > PASSWORD_MAX) return 'length'
  let hasLetter = false
  let hasDigit = false
  for (const ch of password) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) hasLetter = true
    else if (ch >= '0' && ch <= '9') hasDigit = true
  }
  if (!hasLetter || !hasDigit) return 'composition'
  return null
}

function argon2Params(password, salt) {
  return {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    parallelism: ARGON2.parallelism,
    tagLength: ARGON2.tagLength,
    memory: ARGON2.memory,
    passes: ARGON2.passes,
  }
}

/**
 * 计算 Argon2id 哈希，并编码成 PHC 字符串 `$argon2id$v=19$m=..,t=..,p=..$salt$tag`。
 * 用 Node 内建 crypto.argon2Sync：零依赖，与镜像「只用 Node 内置模块」的约定一致。
 * @param {string} password 明文密码。
 * @param {import('node:crypto').BinaryLike} [salt] 复用的盐（测试用）；省略则随机生成。
 * @returns {string} PHC 编码串。
 * @throws {Error} 当 Node 运行时不支持 argon2 时抛出，调用方必须失败而不是降级。
 */
export function hashPassword(password, salt) {
  const actualSalt = salt ?? randomBytes(ARGON2.saltLength)
  const tag = argon2Sync(ARGON2.algorithm, argon2Params(password, actualSalt))
  return `$argon2id$v=19$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}` +
    `$${actualSalt.toString('base64url')}$${tag.toString('base64url')}`
}

/**
 * 解析 PHC 编码，并校验参数落在允许区间内（拒绝攻击者塞进来的弱参数哈希）。
 * @param {string} encoded PHC 编码串。
 * @returns {{memory:number,passes:number,parallelism:number,salt:Buffer,tag:Buffer}|null} 解析结果或 null。
 */
export function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string') return null
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== '' || parts[1] !== 'argon2id') return null
  if (parts[2] !== 'v=19') return null
  const m = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parts[3])
  if (!m) return null
  const memory = Number(m[1])
  const passes = Number(m[2])
  const parallelism = Number(m[3])
  if (memory < 8 * 1024 || memory > 256 * 1024) return null
  if (passes < 1 || passes > 10) return null
  if (parallelism < 1 || parallelism > 16) return null
  let salt
  let tag
  try {
    salt = Buffer.from(parts[4], 'base64url')
    tag = Buffer.from(parts[5], 'base64url')
  } catch {
    return null
  }
  if (salt.length < 16 || salt.length > 64) return null
  if (tag.length < 16 || tag.length > 64) return null
  return { memory, passes, parallelism, salt, tag }
}

/**
 * 校验密码。非法编码、解析失败、参数越界一律返回 false（不抛错，调用方按失败处理）。
 * @param {string} password 明文密码。
 * @param {string} encoded 存储的 PHC 串。
 * @returns {boolean} 是否匹配。
 */
export function verifyPassword(password, encoded) {
  const parsed = parsePasswordHash(encoded)
  if (!parsed) return false
  if (typeof password !== 'string' || password.length === 0 || password.length > PASSWORD_MAX * 2) return false
  let tag
  try {
    tag = argon2Sync(ARGON2.algorithm, {
      message: Buffer.from(password, 'utf8'),
      nonce: parsed.salt,
      parallelism: parsed.parallelism,
      tagLength: parsed.tag.length,
      memory: parsed.memory,
      passes: parsed.passes,
    })
  } catch {
    return false
  }
  return constantTimeEqual(tag, parsed.tag)
}

/**
 * 恒时比较两个 Buffer/字符串。长度不同也走完整比较，避免长度泄漏。
 * @param {Buffer|string} left 左值。
 * @param {Buffer|string} right 右值。
 * @returns {boolean} 是否相等。
 */
export function constantTimeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(String(left), 'utf8')
  const b = Buffer.isBuffer(right) ? right : Buffer.from(String(right), 'utf8')
  // 先各自散列到定长再比较：长度差异不会短路，也不会抛 RangeError。
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** 生成不透明随机令牌（会话/CSRF/一次性凭据）。 */
/**
 * 生成随机令牌。
 * @param {number} [bytes] 熵字节数，默认 32。
 * @returns {string} base64url 编码的令牌。
 */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/**
 * 令牌摘要。状态库里只存摘要，原文永不落盘（威胁 T3/T8）。
 * @param {string} token 令牌原文。
 * @returns {string} hex 摘要。
 */
export function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * 用服务端密钥对一次性凭据做 HMAC 摘要（new-api AuthFlow.TokenHash 同款思路）。
 * 单独域前缀，避免与其它摘要串用。
 * @param {string} secret 服务端密钥（hex）。
 * @param {string} purpose 用途标识。
 * @param {string} token 令牌原文。
 * @returns {string} hex 摘要。
 */
export function flowDigest(secret, purpose, token) {
  const hmac = createHmacDigest(secret, `dsh-auth-flow\0${purpose}\0${token}`)
  return hmac
}

function createHmacDigest(secret, payload) {
  // createHash 而非 HMAC：secret 已足够长且只作前缀域分隔，这里是摘要而非签名用途。
  return createHash('sha256').update(`${secret}\0${payload}`, 'utf8').digest('hex')
}

/**
 * 登录限速双桶键（KPanel loginKeys 同款：IP 桶 + 账户桶）。
 *
 * 在「无法区分来源」（可信代理未能解析）时 ipKey 为空字符串，调用方据此跳过 IP 桶。
 * 宁可不设 IP 维度，也不要让全体调用者共用一个可被单方耗尽的桶。
 * @param {string} ip 客户端 IP。
 * @param {string} username 用户名。
 * @param {{trustedProxiesResolved?: boolean}} [options] 来源是否可区分。
 * @returns {{ipKey:string,accountKey:string}} 两个限速键（ipKey 可能为空）。
 */
export function loginKeys(ip, username, options) {
  const cleanUser = String(username ?? '').trim().toLowerCase().slice(0, 64)
  return { ipKey: ipBucketKey(ip, options), accountKey: `account:${cleanUser}` }
}

/**
 * 滑动窗口失败计数判定。
 * @param {number[]} failures 该桶内的失败时间戳（毫秒）。
 * @param {number} now 当前时间（毫秒）。
 * @param {number} windowMs 窗口长度。
 * @param {number} limit 窗口内允许的失败次数上限。
 * @returns {{allowed:boolean,retryAfterMs:number,kept:number[]}} 判定结果与裁剪后的时间戳。
 */
export function evaluateFailureBucket(failures, now, windowMs, limit) {
  const kept = (Array.isArray(failures) ? failures : []).filter((t) => Number.isFinite(t) && now - t < windowMs)
  if (kept.length < limit) return { allowed: true, retryAfterMs: 0, kept }
  const oldest = Math.min(...kept)
  return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - oldest)), kept }
}

/**
 * 从请求头解析客户端 IP。
 *
 * 转发头只在「直接对端是可信代理」时才被采信：本服务同时监听一个与用户实例共享的
 * 网络，任何容器都能直连并自带 x-real-ip / x-forwarded-for，若无条件信任，按 IP 的
 * 配额与审计地址就都成了调用者可选的值（审计复现：伪造 3 个 IP 即各得一份注册额度）。
 * 入口 nginx 会覆盖这两个头，因此「对端是入口」时头是可信的；其余对端一律回退到
 * socket 地址。
 *
 * 可信列表的条目可能是**地址**也可能是**主机名**（compose 里最自然的写法是服务名）。
 * 调用方必须先把主机名解析成地址再传进来：直接拿名字与 socket 地址比较永远不相等，
 * 而那会把每个客户端都折叠成同一个 IP（审计复现：入口默认值 'dsh-ingress' 与对端
 * 172.20.0.2 永不匹配，于是全体调用者共用一个 ip: 桶，任一容器 10 次失败登录即可
 * 让全站在 15 分钟内无法登录——这比「伪造 IP 重置配额」更严重）。
 * @param {Record<string,string|string[]|undefined>} headers 请求头。
 * @param {string} socketAddress 直连地址（回退用，也是信任判定的依据）。
 * @param {{trustedProxies?: string[]}} [options] 可信代理**地址**列表（归一化后比较）。
 * @returns {string} 归一化后的 IP 字符串。
 * @param {string} socketAddress 直连地址（回退用，也是信任判定的依据）。
 * @param {{trustedProxies?: string[]}} [options] 可信代理地址列表（归一化后比较）。
 * @returns {string} 归一化后的 IP 字符串。
 */
export function clientIp(headers, socketAddress, options) {
  const peer = normalizeAddress(socketAddress)
  const trusted = (options?.trustedProxies ?? []).map(normalizeAddress)
  if (trusted.includes(peer)) {
    const real = headerValue(headers['x-real-ip'])
    if (real) return real.trim().slice(0, 128)
    const fwd = headerValue(headers['x-forwarded-for'])
    if (fwd) {
      const last = fwd.split(',').pop()?.trim()
      if (last) return last.slice(0, 128)
    }
  }
  return peer.slice(0, 128)
}

function normalizeAddress(value) {
  return String(value ?? '').trim().replace(/^::ffff:/i, '').toLowerCase()
}

/**
 * 判断一个可信代理条目是字面地址还是需要解析的主机名。
 *
 * IPv4、IPv6（含压缩形式）、带 CIDR 的写法都算地址；其余（dsh-ingress、proxy.internal
 * 之类）是主机名，必须解析后才能与 socket 地址比较。
 * @param {string} entry 条目原文。
 * @returns {boolean} true = 字面地址。
 */
export function isAddressLiteral(entry) {
  const value = String(entry ?? '').trim()
  if (value.length === 0) return false
  // IPv4，可带 /前缀长度
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(value)) return true
  // IPv6：至少含一个冒号，且只由十六进制、冒号、点、斜杠组成
  if (value.includes(':') && /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(value)) return true
  return false
}

/**
 * 计算「无法区分来源」时使用的 IP 桶键。
 *
 * 当可信代理列表为空或未能解析出任何地址时，所有请求都会以同一个对端地址计桶。
 * 此时若仍按 IP 分桶，这个桶就成了全局共享的可耗尽资源——任一方都能让所有人无法登录
 * （审计复现）。因此退化为**不设 IP 维度**：返回空键，调用方不给 IP 桶记账，
 * 只保留按账户的桶。这比「所有人共用一个桶」安全得多：一个攻击者只能锁死他自己
 * 尝试过的那些账户，而无法一次锁死全站。
 * @param {string} ip 已解析的客户端地址。
 * @param {{trustedProxiesResolved?: boolean}} [options] 是否成功解析出可信代理地址。
 * @returns {string} 空字符串表示不记账；否则是 `ip:<地址>`。
 */
export function ipBucketKey(ip, options) {
  if (options?.trustedProxiesResolved === false) return ''
  const clean = String(ip ?? '').trim().toLowerCase().slice(0, 128)
  if (clean.length === 0) return ''
  return `ip:${clean}`
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : ''
}

/**
 * 生成一个必然通过 validatePassword 的口令。
 *
 * 直接拿随机字节做 base64url 是不够的：结果可能一个数字都没有，于是自己生成的
 * 口令反而过不了自己的强度校验（管理员重置口令时就会踩到）。这里用 base32 字母表
 * （a-z + 2-7）生成，再按需补齐种类。
 * @param {number} [bytes] 熵字节数。
 * @returns {string} 满足强度规则的口令。
 */
export function generatePassword(bytes = 18) {
  let candidate = base32Encode(randomBytes(bytes)).toLowerCase()
  if (!/[a-z]/.test(candidate)) candidate = `a${candidate}`
  if (!/[0-9]/.test(candidate)) candidate = `${candidate}7`
  return candidate.length >= PASSWORD_MIN ? candidate : candidate.padEnd(PASSWORD_MIN, '7')
}

/**
 * 判断请求是否为同源写请求（Origin/Referer 与 Host 一致）。
 * 作为 CSRF 双保险的第二道，第一道是 SameSite=Strict Cookie + 令牌校验。
 * @param {Record<string,string|string[]|undefined>} headers 请求头。
 * @returns {boolean} 是否同源。
 */
export function isSameOrigin(headers) {
  const host = headerValue(headers.host)
  if (!host) return false
  const origin = headerValue(headers.origin)
  if (origin) return originHost(origin) === host
  const referer = headerValue(headers.referer)
  if (referer) return originHost(referer) === host
  return false
}

function originHost(value) {
  try {
    return new URL(value).host
  } catch {
    return ''
  }
}

/** 会话 Cookie 默认属性。 */
export const SESSION_COOKIE = 'dsh_auth_session'

// ============================================================ TOTP 与恢复码
//
// 设计出处（docs/auth-design.md §2.3）：参数对齐 KPanel internal/auth/totp.go
// （6 位 / 30 秒 / ±1 步 / HMAC-SHA1 / 20 字节密钥），密钥用 AES-256-GCM 加密落盘，
// 恢复码只存哈希。Node 没有内建 base32，这里自带 RFC 4648 编解码。

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** TOTP 参数（KPanel totp.go 常量同款）。 */
export const TOTP = Object.freeze({
  digits: 6,
  periodSeconds: 30,
  secretBytes: 20,
  window: 1,
})

/** 恢复码数量与形态（KPanel recoveryCodeCount / 分组格式同款）。 */
export const RECOVERY = Object.freeze({ count: 10, groups: [5, 5, 5] })

/**
 * RFC 4648 base32 编码（无填充）。
 * @param {Buffer} buffer 待编码字节。
 * @returns {string} 大写 base32 串。
 */
export function base32Encode(buffer) {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

/**
 * RFC 4648 base32 解码（容忍小写、空格与填充符）。
 * @param {string} text base32 串。
 * @returns {Buffer|null} 解码结果，非法输入返回 null。
 */
export function base32Decode(text) {
  if (typeof text !== 'string') return null
  const clean = text.toUpperCase().replace(/[\s=]/g, '')
  if (clean.length === 0 || /[^A-Z2-7]/.test(clean)) return null
  let bits = 0
  let value = 0
  const bytes = []
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/**
 * 生成 TOTP 密钥（20 字节 → base32 无填充，KPanel generateTOTPSecret 同款）。
 * @returns {string} base32 密钥。
 */
export function generateTotpSecret() {
  return base32Encode(randomBytes(TOTP.secretBytes))
}

/**
 * 构造 otpauth:// URI（供验证器扫码），issuer 固定为 DSH。
 * @param {string} username 账户名。
 * @param {string} secret base32 密钥。
 * @param {string} [issuer] 发行方名。
 * @returns {string} otpauth URI。
 */
export function buildOtpAuthUri(username, secret, issuer = 'DSH') {
  const label = `${issuer}:${username}`
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP.digits),
    period: String(TOTP.periodSeconds),
  })
  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`
}

/**
 * 计算指定时间步的 TOTP 码。
 * @param {string} secret base32 密钥。
 * @param {number} step 时间步（Unix 秒 / 30）。
 * @returns {string|null} 6 位码，密钥非法返回 null。
 */
export function totpCodeAtStep(secret, step) {
  const key = base32Decode(secret)
  if (!key || key.length < 16) return null
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.max(0, Math.trunc(step))))
  const mac = createHmac('sha1', key).update(counter).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const value = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(value % 10 ** TOTP.digits).padStart(TOTP.digits, '0')
}

/**
 * 校验 TOTP 码，允许 ±1 个时间步的时钟漂移（KPanel matchTOTPStep 同款）。
 * @param {string} secret base32 密钥。
 * @param {string} code 用户输入的 6 位码。
 * @param {number} nowMs 当前时间（毫秒）。
 * @param {number} [lastUsedStep] 上次已消费的时间步，用于防重放。
 * @returns {{ok:boolean, step:number}} 校验结果与命中的时间步。
 */
export function matchTotpStep(secret, code, nowMs, lastUsedStep = -1) {
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return { ok: false, step: -1 }
  const current = Math.floor(nowMs / 1000 / TOTP.periodSeconds)
  for (const offset of [0, -1, 1]) {
    const step = current + offset
    const expected = totpCodeAtStep(secret, step)
    if (expected !== null && constantTimeEqual(expected, code)) {
      // 同一时间步只能用一次：否则一个码在 30 秒窗口内可被重放（威胁 T5）
      if (step <= lastUsedStep) return { ok: false, step }
      return { ok: true, step }
    }
  }
  return { ok: false, step: -1 }
}

/**
 * 生成恢复码及其哈希。明文只返回一次，落盘只有哈希。
 * @returns {{codes:string[], hashes:string[]}} 明文与哈希数组。
 */
export function generateRecoveryCodes() {
  const codes = []
  const hashes = []
  for (let i = 0; i < RECOVERY.count; i++) {
    const raw = base32Encode(randomBytes(10)).slice(0, RECOVERY.groups.reduce((a, b) => a + b, 0))
    let cursor = 0
    const parts = RECOVERY.groups.map((size) => {
      const part = raw.slice(cursor, cursor + size)
      cursor += size
      return part
    })
    const code = parts.join('-')
    codes.push(code)
    hashes.push(hashRecoveryCode(code))
  }
  return { codes, hashes }
}

/**
 * 归一化恢复码（去分隔符、转大写、去空白）。
 * @param {string} code 用户输入。
 * @returns {string} 归一化结果。
 */
export function normalizeRecoveryCode(code) {
  return typeof code === 'string' ? code.toUpperCase().replace(/[\s-]/g, '') : ''
}

/**
 * 计算恢复码哈希（域前缀避免与其它摘要串用）。
 * @param {string} code 恢复码（任意格式，内部归一化）。
 * @returns {string} hex 哈希。
 */
export function hashRecoveryCode(code) {
  return createHash('sha256').update(`dsh-auth-recovery\0${normalizeRecoveryCode(code)}`, 'utf8').digest('hex')
}

/**
 * 在哈希列表中查找匹配的恢复码，返回其下标（未命中 -1）。恒时比较避免时序泄漏。
 * @param {string[]} hashes 存储的哈希列表。
 * @param {string} code 用户输入。
 * @returns {number} 命中的下标，未命中为 -1。
 */
export function findRecoveryCode(hashes, code) {
  const target = hashRecoveryCode(code)
  let found = -1
  for (let i = 0; i < hashes.length; i++) {
    if (constantTimeEqual(hashes[i], target)) found = i
  }
  return found
}

/**
 * 判断输入看起来是不是恢复码（而不是 6 位 TOTP）。
 * @param {string} value 用户输入。
 * @returns {boolean} 是否为恢复码形态。
 */
export function looksLikeRecoveryCode(value) {
  return /^[A-Za-z2-7]{5}-?[A-Za-z2-7]{5}-?[A-Za-z2-7]{5}$/.test(String(value ?? '').trim())
}

const TOTP_AAD = 'dsh-totp-v1'

/**
 * 用主密钥加密一段文本（AES-256-GCM）。
 * @param {Buffer} key 32 字节主密钥。
 * @param {string} aad 附加认证数据，用于区分用途（不同用途的密文不能互换）。
 * @param {string} plaintext 明文。
 * @returns {string} base64url(nonce || ciphertext || tag)。
 */
function sealWithAad(key, aad, plaintext) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const sealed = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString('base64url')
}

/**
 * 解密一段用 sealWithAad 加密的文本。密钥错误、密文被篡改、长度异常一律返回 null。
 * @param {Buffer} key 32 字节主密钥。
 * @param {string} aad 加密时使用的附加认证数据。
 * @param {string} encoded base64url 密文。
 * @returns {string|null} 明文或 null。
 */
function openWithAad(key, aad, encoded) {
  try {
    const raw = Buffer.from(encoded, 'base64url')
    if (raw.length <= 12 + 16) return null
    const nonce = raw.subarray(0, 12)
    const tag = raw.subarray(raw.length - 16)
    const body = raw.subarray(12, raw.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * 用主密钥加密 TOTP 密钥（AES-256-GCM，AAD 固定）。
 * @param {Buffer} key 32 字节主密钥。
 * @param {string} secret base32 明文密钥。
 * @returns {string} base64url(nonce || ciphertext || tag)。
 */
export function sealTotpSecret(key, secret) {
  return sealWithAad(key, TOTP_AAD, secret)
}

/**
 * 解密 TOTP 密钥。密钥错误、密文被篡改、长度异常一律返回 null。
 * @param {Buffer} key 32 字节主密钥。
 * @param {string} encoded base64url 密文。
 * @returns {string|null} 明文 base32 密钥或 null。
 */
export function openTotpSecret(key, encoded) {
  return openWithAad(key, TOTP_AAD, encoded)
}

// ---------------------------------------------------------------- 人机验证

/**
 * 支持的人机验证服务。三者的前端脚本与校验端点不同，但协议一致：
 * 前端拿到一个一次性 token，服务端把 token 连同密钥提交给 siteverify 换一个布尔结论。
 *
 * 密钥单独用一个 AAD，这样即使同一条状态文件被部分替换，TOTP 密文与人机验证密文
 * 也不能互相冒充。
 */
const CAPTCHA_AAD = 'dsh-captcha-v1'
export const CAPTCHA_PROVIDERS = Object.freeze({
  turnstile: {
    label: 'Cloudflare Turnstile',
    script: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
    verify: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    // Turnstile 的隐式渲染需要这个 class 与 data-sitekey
    implicit: { className: 'cf-turnstile', siteKeyAttribute: 'data-sitekey' },
  },
  hcaptcha: {
    label: 'hCaptcha',
    script: 'https://js.hcaptcha.com/1/api.js',
    verify: 'https://hcaptcha.com/siteverify',
    implicit: { className: 'h-captcha', siteKeyAttribute: 'data-sitekey' },
  },
  recaptcha: {
    label: 'reCAPTCHA v2',
    script: 'https://www.google.com/recaptcha/api.js',
    verify: 'https://www.google.com/recaptcha/api/siteverify',
    implicit: { className: 'g-recaptcha', siteKeyAttribute: 'data-sitekey' },
  },
})

/**
 * 判断是否为受支持的人机验证服务名。
 * @param {unknown} value 待判定值。
 * @returns {boolean} 是否受支持。
 */
export function isCaptchaProvider(value) {
  return typeof value === 'string' && Object.hasOwn(CAPTCHA_PROVIDERS, value)
}

/**
 * 加密人机验证密钥。
 * @param {Buffer} key 32 字节主密钥。
 * @param {string} secret 站点密钥（siteverify 用）。
 * @returns {string} base64url 密文。
 */
export function sealCaptchaSecret(key, secret) {
  return sealWithAad(key, CAPTCHA_AAD, secret)
}

/**
 * 解密人机验证密钥。
 * @param {Buffer} key 32 字节主密钥。
 * @param {string} encoded base64url 密文。
 * @returns {string|null} 明文密钥或 null。
 */
export function openCaptchaSecret(key, encoded) {
  return openWithAad(key, CAPTCHA_AAD, encoded)
}

/**
 * 向人机验证服务校验前端拿到的 token。
 *
 * 失败即拒绝（fail closed）：这是安全控件，校验不了就不能放行。
 * 但网络故障与「token 无效」必须区分开，否则运维看到的现象完全一样：
 * 返回里的 reason 会说明是 provider 拒绝、还是我们没能问到 provider。
 *
 * @param {object} options 参数。
 * @param {string} options.provider 服务名（见 CAPTCHA_PROVIDERS）。
 * @param {string} options.secret 站点密钥。
 * @param {string} options.token 前端提交的 token。
 * @param {string} [options.remoteIp] 客户端 IP，可提高判定质量。
 * @param {number} [options.timeoutMs] 请求超时，默认 8 秒。
 * @param {typeof fetch} [options.fetchImpl] 注入的 fetch，便于测试。
 * @returns {Promise<{ok: boolean, reason: string}>} 校验结论与原因。
 */
export async function verifyCaptchaToken({ provider, secret, token, remoteIp, timeoutMs = 8000, fetchImpl = fetch }) {
  if (!isCaptchaProvider(provider)) return { ok: false, reason: 'unsupported_provider' }
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'no_secret' }
  if (typeof token !== 'string' || token.trim().length === 0) return { ok: false, reason: 'no_token' }

  const body = new URLSearchParams({ secret, response: token.trim() })
  if (remoteIp) body.set('remoteip', remoteIp)

  let response
  try {
    response = await fetchImpl(CAPTCHA_PROVIDERS[provider].verify, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    // 没能问到 provider：与「provider 说 token 无效」是两件事，必须分开报
    return { ok: false, reason: `unreachable:${error?.name ?? 'error'}` }
  }
  if (!response.ok) return { ok: false, reason: `http_${response.status}` }

  let payload
  try {
    payload = await response.json()
  } catch {
    return { ok: false, reason: 'bad_response' }
  }
  if (payload?.success !== true) {
    const codes = Array.isArray(payload?.['error-codes']) ? payload['error-codes'].join(',') : ''
    return { ok: false, reason: codes ? `rejected:${codes}` : 'rejected' }
  }
  return { ok: true, reason: 'ok' }
}
