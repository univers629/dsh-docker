// dsh-auth 的 Passkey（WebAuthn）层。
//
// 与 KPanel 同构：密码学交给成熟库，本层只实现策略。
//   * KPanel 用 go-webauthn/webauthn，本文件用等价的 @simplewebauthn/server
//     （attestation 解析、COSE 公钥、CBOR、签名验证全部在库里）；
//   * 本层策略与 KPanel 逐条对齐：固定 HTTPS origin、RPID 严格校验、UV required、
//     resident key、ceremony 单次消费与 TTL、计数器回退拒绝。
//
// 之所以不手写 CBOR/COSE/ES256：那是背离 KPanel 的做法，而不是借鉴它（见
// docs/auth-design.md §2.4）。

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'

/** ceremony 存活时长（KPanel passkeyTTL 同款）。 */
export const PASSKEY_TTL_MS = 3 * 60_000

/** 单用户凭据上限（KPanel maxPasskeys 同款语义）。 */
export const MAX_PASSKEYS_PER_USER = 10

const LABEL_PATTERN = /^[a-z0-9-]+$/

/**
 * 公共后缀根域（Public Suffix List 的**精选子集**，不是完整 PSL）。
 *
 * 为什么需要它：RPID 一旦是公共后缀根，该后缀下所有互不相关的站点就共享同一个
 * 凭据作用域——`co.uk` 作 RPID 等于让任意 `*.co.uk` 站点发起对本部署的断言。
 * 单标签根域（`com`、`uk`）已由"至少两段"的结构规则挡住，但多标签公共后缀
 * （`co.uk`、`com.au`、`github.io`）必须逐个列名。
 *
 * 这是**有意为之的精选**而不是内嵌完整 PSL：完整表约 200KB 且需要持续更新，而
 * 此处的作用是挡住"把公共后缀当 RPID"这类配置错误——该值来自运维配置，没有攻击者
 * 输入可达，因此漏掉冷门后缀的后果是一次配置错误，而不是一个可被利用的入口。
 * 新增条目时保持小写、无尾点。
 */
const PUBLIC_SUFFIX_ROOTS = new Set([
  // 英国 / 爱尔兰
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk',
  // 亚太
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'org.hk', 'edu.hk', 'gov.hk', 'net.hk', 'idv.hk',
  'com.tw', 'org.tw', 'edu.tw', 'gov.tw', 'net.tw',
  'com.sg', 'org.sg', 'edu.sg', 'gov.sg', 'net.sg', 'per.sg',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 're.kr', 'pe.kr',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in', 'res.in',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id', 'sch.id',
  'co.th', 'or.th', 'ac.th', 'go.th', 'in.th',
  'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz', 'geek.nz', 'gen.nz', 'kiwi.nz', 'maori.nz', 'school.nz',
  'com.my', 'net.my', 'org.my', 'edu.my', 'gov.my',
  'com.ph', 'net.ph', 'org.ph', 'edu.ph', 'gov.ph',
  'com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn',
  // 美洲 / 非洲 / 中东
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'net.mx', 'org.mx', 'edu.mx', 'gob.mx',
  'com.ar', 'net.ar', 'org.ar', 'edu.ar', 'gob.ar',
  'com.co', 'net.co', 'org.co', 'edu.co', 'gov.co',
  'co.za', 'net.za', 'org.za', 'gov.za', 'ac.za', 'web.za',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il', 'muni.il',
  'com.tr', 'net.tr', 'org.tr', 'edu.tr', 'gov.tr',
  'com.sa', 'net.sa', 'org.sa', 'edu.sa', 'gov.sa',
  // 托管平台提供的私有后缀根：这些根之下每个租户是独立注册域，但根本身共享
  'github.io', 'gitlab.io', 'pages.dev', 'vercel.app', 'netlify.app', 'web.app',
  'herokuapp.com', 'azurewebsites.net', 'cloudfront.net', 's3.amazonaws.com',
])

/**
 * 解析并校验 Passkey 的 origin 与 RPID。
 *
 * 与 KPanel PasskeyOrigin 同款的严格策略：只接受**单个固定 HTTPS origin**，
 * 不接受请求 Host、不接受父域通配、不接受 IP 字面量、不接受公共后缀根域，
 * 也不留任何开发例外进入生产策略。
 * @param {string} value 配置的公开地址，如 https://dsh.example.com。
 * @returns {{origin:string, rpId:string}|null} 通过校验时返回 origin 与 rpId，否则 null。
 */
export function passkeyOrigin(value) {
  if (typeof value !== 'string' || value === '') return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  const host = url.hostname.toLowerCase()
  if (host === '' || host.endsWith('.')) return null
  // IP 字面量（含 IPv6）没有可用的 RPID 语义
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null
  if (!host.includes('.')) return null
  if (host.length > 253) return null
  for (const label of host.split('.')) {
    if (label.length === 0 || label.length > 63) return null
    if (label.startsWith('-') || label.endsWith('-')) return null
    if (!LABEL_PATTERN.test(label)) return null
  }
  // 公共后缀根域（如 "com"、"co.uk"、"github.io"）不能作为 RPID：同后缀下互不相关
  // 的站点会共享凭据作用域。判定的是**整个主机名等于后缀根**，而不是"以它为结尾"——
  // example.co.uk 是公共后缀之下的合法注册域，必须继续可用。
  const labels = host.split('.')
  if (labels.length < 2) return null
  if (PUBLIC_SUFFIX_ROOTS.has(host)) return null
  const port = url.port && url.port !== '443' ? `:${url.port}` : ''
  return { origin: `https://${host}${port}`, rpId: host }
}

/**
 * 由请求推导 origin（真实部署下 dsh-auth 在 nginx 之后，用转发头）。
 * 只有配置了公开地址时才启用 passkey——这一点与 KPanel 一致：
 * 没有可信 HTTPS 域名就没有 passkey，绝不退回请求 Host。
 * @param {string} configured 配置的公开地址。
 * @param {Record<string,string|string[]|undefined>} _headers 请求头（保留签名以备将来比对）。
 * @returns {{origin:string, rpId:string}|null} 解析结果。
 */
export function resolveOrigin(configured, _headers) {
  return passkeyOrigin(configured)
}

function utf8(value) {
  return new TextEncoder().encode(value)
}

/**
 * 生成注册选项（resident key + 强制用户验证，KPanel 同款强度）。
 * @param {object} input 输入。
 * @param {{id:string,username:string}} input.user 账户。
 * @param {Array<{credentialID:string,transports?:string[]}>} [input.excludeCredentials] 已存在凭据。
 * @param {string} input.rpId RPID。
 * @param {string} input.rpName RP 展示名。
 * @returns {Promise<object>} 注册选项（含 challenge 与 user.id，均为 base64url）。
 */
export function beginRegistration({ user, excludeCredentials = [], rpId, rpName = 'DSH' }) {
  return generateRegistrationOptions({
    rpName,
    rpID: rpId,
    userName: user.username,
    userDisplayName: user.username,
    // userID 用账户 id 的 UTF-8 字节：稳定且不泄露密码材料
    userID: utf8(user.id),
    attestationType: 'none',
    excludeCredentials: excludeCredentials.map((c) => ({
      id: c.credentialID,
      ...(c.transports ? { transports: c.transports } : {}),
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  })
}

/**
 * 校验注册响应。
 *
 * 注意编解码边界：库内部用 `Uint8Array` 表示公钥，状态库要存 JSON，所以这里统一
 * 转成 base64url——出库入库都只经过本文件这一处转换，避免下游各处各自猜格式。
 * @param {object} input 输入。
 * @param {object} input.response 浏览器返回的注册响应 JSON。
 * @param {string} input.expectedChallenge 期望的 challenge（base64url）。
 * @param {string} input.expectedOrigin 期望 origin。
 * @param {string} input.expectedRPID 期望 RPID。
 * @returns {Promise<{ok:boolean, credential?:object, counter?:number, deviceType?:string, backedUp?:boolean, aaguid?:string}>} 校验结果。
 */
export async function finishRegistration({ response, expectedChallenge, expectedOrigin, expectedRPID }) {
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      requireUserVerification: true,
    })
    if (!result.verified || !result.registrationInfo) return { ok: false }
    const info = result.registrationInfo
    return {
      ok: true,
      credential: {
        id: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
      },
      counter: info.credential.counter,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      aaguid: info.aaguid,
    }
  } catch {
    return { ok: false }
  }
}

/**
 * 生成登录选项。传入凭据则限定 allowCredentials，否则走可发现凭据（discoverable）。
 * @param {object} input 输入。
 * @param {Array<{credentialID:string,transports?:string[]}>} [input.allowCredentials] 允许的凭据。
 * @param {string} input.rpId RPID。
 * @returns {Promise<object>} 登录选项（含 challenge）。
 */
export function beginAuthentication({ allowCredentials = [], rpId }) {
  return generateAuthenticationOptions({
    rpID: rpId,
    userVerification: 'required',
    allowCredentials: allowCredentials.map((c) => ({
      id: c.credentialID,
      ...(c.transports ? { transports: c.transports } : {}),
    })),
  })
}

/**
 * 校验登录响应，并执行**计数器回退拒绝**（KPanel 同款：克隆信号一律拒绝）。
 * @param {object} input 输入。
 * @param {object} input.response 浏览器返回的断言响应 JSON。
 * @param {string} input.expectedChallenge 期望 challenge。
 * @param {string} input.expectedOrigin 期望 origin。
 * @param {string} input.expectedRPID 期望 RPID。
 * @param {{id:string,publicKey:string,counter:number,transports?:string[]}} input.credential 存储的凭据。
 * @returns {Promise<{ok:boolean, newCounter?:number, deviceType?:string, backedUp?:boolean, reason?:string}>} 校验结果。
 */
export async function finishAuthentication({ response, expectedChallenge, expectedOrigin, expectedRPID, credential }) {
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey, 'base64url'),
        counter: credential.counter,
        ...(credential.transports ? { transports: credential.transports } : {}),
      },
    })
    if (!result.verified) return { ok: false, reason: 'unverified' }
    const info = result.authenticationInfo
    // 计数器回退 = 同一凭据被克隆或重放的强信号；多设备凭据允许计数器不变，但绝不允许回退
    if (info.newCounter !== 0 && info.newCounter < credential.counter) {
      return { ok: false, reason: 'counter_regression' }
    }
    return { ok: true, newCounter: info.newCounter, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
