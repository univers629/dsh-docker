#!/usr/bin/env node
// DSH 认证网关（dsh-auth）。
//
// 它解决的问题：DSH 自己没有用户体系，原来只能靠 nginx basic auth 一把共用密码。
// 这个服务把认证从「一层 htpasswd」升级为「账户 + 会话 + 双桶限速 + 审计」，
// 并作为 nginx auth_request 的判定端：通过则放行到对应用户的 DSH 实例，否则 401。
//
// 边界（见 docs/auth-design.md §3）：
//   * 它是部署层组件，DSH 核心零改动；不做任何模型/业务逻辑。
//   * 令牌与密码只以摘要/哈希落盘；一次性凭据走 auth_flows 且单次消费。
//   * 单管理员模式做路由裁剪：/register 与 /admin/* 直接 404，攻击面收敛到
//     登录 + verify + /account。
//   * 它不持有 docker.sock（实例编排归 dsh-instances），也不持有模型密钥。
//
// M1 范围：状态库、Argon2id 密码登录、会话 + CSRF + auth_version、双桶限速、
// 审计骨架、静态登录页、auth_request verify。TOTP/Passkey/注册/账户页见 M2/M3。

import dns from 'node:dns/promises'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  SESSION_COOKIE,
  buildOtpAuthUri,
  clientIp,
  isAddressLiteral,
  constantTimeEqual,
  evaluateFailureBucket,
  findRecoveryCode,
  flowDigest,
  generateRecoveryCodes,
  generatePassword,
  generateTotpSecret,
  hashPassword,
  isSameOrigin,
  isValidUsername,
  loginKeys,
  looksLikeRecoveryCode,
  matchTotpStep,
  openTotpSecret,
  randomToken,
  sealTotpSecret,
  tokenDigest,
  validatePassword,
  verifyPassword,
} from './dsh-auth-policy.mjs'
import QRCode from 'qrcode'

import { appendAudit, loadOrCreateTotpKey, openStore } from './dsh-auth-store.mjs'
import {
  MAX_PASSKEYS_PER_USER,
  PASSKEY_TTL_MS,
  beginAuthentication,
  beginRegistration,
  finishAuthentication,
  finishRegistration,
  resolveOrigin,
} from './dsh-auth-passkey.mjs'
import { brokerTokenDigest } from './dsh-broker-grants.mjs'
import {
  CAPTCHA_PROVIDERS,
  isCaptchaProvider,
  openCaptchaSecret,
  sealCaptchaSecret,
  verifyCaptchaToken,
} from './dsh-auth-policy.mjs'
import { UID_BASE, allocateUid } from './dsh-instances-policy.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const CONFIG = {
  listen: process.env.DSH_AUTH_LISTEN ?? '0.0.0.0:8091',
  stateFile: process.env.DSH_AUTH_STATE ?? '/data/auth/state.json',
  totpKeyFile: process.env.DSH_AUTH_TOTP_KEY ?? '/data/auth/totp.key',
  webDir: process.env.DSH_AUTH_WEB_DIR ?? path.join(HERE, 'dsh-auth-web'),
  multiUser: process.env.DSH_MULTI_USER === 'on',
  registerGate: process.env.DSH_REGISTER_GATE === 'invite' ? 'invite' : 'open',
  // Passkey 需要一个固定的 HTTPS 公开地址（与 KPanel 同款策略：没有可信域名就没有 passkey，
  // 绝不回退到请求 Host）。未配置时 passkey 整体不可用。
  publicOrigin: process.env.DSH_AUTH_PUBLIC_ORIGIN ?? '',
  // 实例编排服务：多用户模式下按需创建与唤醒用户实例
  instancesUrl: (process.env.DSH_INSTANCES_URL ?? 'http://dsh-instances:8092').replace(/\/+$/, ''),
  instancesTokenFile: process.env.DSH_INSTANCES_TOKEN_FILE ?? '/data/auth/instances.token',
  // 每用户模型上游授权表：dsh-auth 写、broker 读。放在两个容器都挂载的目录下。
  brokerGrantsFile: process.env.DSH_BROKER_GRANTS_FILE ?? '/data/auth/broker-grants.json',
  // 实例令牌明文：编排服务读它注入到实例环境变量。只含「用户名 → 令牌」，不含别的。
  brokerTokensFile: process.env.DSH_BROKER_TOKENS_FILE ?? '/data/auth/broker-tokens.json',
  // 密钥代理地址：管理界面要从它读出「当前有哪些上游可选」，否则只能靠人手打名字。
  brokerUrl: (process.env.DSH_BROKER_URL ?? 'http://dsh-key-broker:8080').replace(/\/+$/, ''),
  // root 的工作台实例由部署方维护，不归 dsh-instances 管理
  adminInstance: process.env.DSH_ADMIN_INSTANCE_NAME ?? 'dsh-admin',
  // 入口后面是否有工作台：多用户模式必有；单用户模式由部署方显式开启。
  workspace: process.env.DSH_MULTI_USER === 'on' || process.env.DSH_AUTH_WORKSPACE === 'on',
  // 唤醒一个实例最多等多久（dsh-instances 自身也有超时，这里留少量余量）
  instancesTimeoutMs: Number(process.env.DSH_AUTH_INSTANCES_TIMEOUT_SECONDS ?? 70) * 1000,
  sessionTtlMs: Number(process.env.DSH_AUTH_SESSION_TTL_SECONDS ?? 7 * 24 * 3600) * 1000,
  idleTtlMs: Number(process.env.DSH_AUTH_IDLE_TTL_SECONDS ?? 24 * 3600) * 1000,
  // 判定端点把"这个会话还活着"落盘的节流间隔。verify 的频率约等于页面资源数，逐请求
  // 落盘等于把每个静态资源都变成一次状态库写入；但完全不落盘会让滑动过期只在内存里
  // 成立——prune 读的是磁盘快照，用户一直在浏览也会在闲置窗口到点后被登出。
  // 设 0 表示每次判定都落盘。
  activityPersistIntervalMs: Number(process.env.DSH_AUTH_ACTIVITY_PERSIST_SECONDS ?? 60) * 1000,
  loginWindowMs: Number(process.env.DSH_AUTH_LOGIN_WINDOW_SECONDS ?? 900) * 1000,
  maxLoginFailures: Number(process.env.DSH_AUTH_MAX_LOGIN_FAILURES ?? 10),
  // 注册限速：同一 IP 在窗口内允许的新账户数（防止批量注册刷爆磁盘）
  registerWindowMs: Number(process.env.DSH_AUTH_REGISTER_WINDOW_SECONDS ?? 3600) * 1000,
  maxRegistrationsPerIp: Number(process.env.DSH_AUTH_MAX_REGISTRATIONS_PER_IP ?? 5),
  // 未知用户也跑一次哈希比对，代价与真实用户一致（防枚举，威胁 T2）
  dummyHash: '',
  // 入口↔网关共享密钥：设置后 /__dsh_auth/verify 要求调用者携带同一个值。
  // nginx 的 internal 只约束「经由入口的请求」，不约束直连网关端口的调用者；
  // 网关与管理员工作台共享 dsh-private，因此这道进程内校验是必要的纵深防御。
  // 留空则维持旧行为（仅靠网络边界），供单入口直连的开发场景使用。
  ingressToken: process.env.DSH_AUTH_INGRESS_TOKEN ?? '',
  // 可信代理地址列表：只有直接对端在这个列表里时，x-real-ip / x-forwarded-for 才被
  // 采信（否则一律用 socket 地址）。默认只信入口容器；多入口部署用逗号分隔追加。
  trustedProxies: (process.env.DSH_AUTH_TRUSTED_PROXIES ?? 'dsh-ingress')
    .split(',')
    .map((entry) => entry.trim().replace(/^::ffff:/i, '').toLowerCase())
    .filter((entry) => entry.length > 0),
}

// 活动时间落盘的节流上限还要受**闲置窗口**约束：基准是该会话磁盘上的 lastSeenAt，
// 新建会话的基准就是创建时间，因此若节流间隔长于闲置窗口，活跃用户在窗口到点前一次
// 都来不及落盘，照样会被判闲置。取「配置值」与「闲置窗口的四分之一」的较小者，
// 使活跃会话在窗口内至少落盘三次；下限 1 秒避免极短窗口把写盘变成风暴。
CONFIG.activityPersistIntervalMs = Math.min(
  CONFIG.activityPersistIntervalMs,
  Math.max(1000, Math.floor(CONFIG.idleTtlMs / 4)),
)

const MAX_BODY_BYTES = 64 * 1024
// 失败计数映射的键数上限（prune 里按最久不活跃淘汰）。正常部署的键数是
// 「账户数 × 2 + 活跃来源 IP 数」的量级；到上限只能说明有人在批量伪造用户名。
const MAX_FAILURE_KEYS = 10000
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }

const store = openStore(CONFIG.stateFile)
const totpKey = loadOrCreateTotpKey(CONFIG.totpKeyFile)
CONFIG.dummyHash = hashPassword(randomToken(24))

function now() {
  return Date.now()
}

// 统一的客户端地址推导：只有直接对端是可信代理（默认入口容器）时才采信转发头。
// 见 bin/dsh-auth-policy.mjs clientIp 的注释——网关与用户实例共享网络，直连调用者
// 可以自带 x-real-ip，无条件信任会让按 IP 的配额与审计地址都变成调用者可选的值。
//
// 可信列表里的主机名必须先解析成地址：拿名字与 socket 地址直接比永远不相等，会让
// 每个客户端都折叠成同一个 IP（审计实测的全局登录锁定）。解析是异步的，因此在启动
// 时做一次并缓存结果；失败时保持「未解析」状态，让限速退化为不设 IP 维度。
//
// 解析**绝不能阻塞监听**：网关是入口 auth_request 的唯一后端，迟一秒开始监听就多一秒
// 全站不可用；而 DNS 在容器里可能要等到超时才失败（实测约 4 秒）。因此这里把解析做成
// 后台任务：立刻开始监听，解析完成后原子替换列表。解析未完成时按「来源不可区分」处理，
// 即不设 IP 维度——这比「按一个尚不可信的地址分桶」更安全，且窗口只有几秒。
const TRUSTED_PROXY_LOOKUP_TIMEOUT_MS = 2000
let resolvedTrustedProxies = []
// 解析成功前一律视为「来源不可区分」：宁可不设 IP 维度，也不要用一个错的键。
let trustedProxiesResolved = false

/** 在超时内解析一个主机名；超时或失败都返回空数组。 */
async function lookupWithTimeout(host) {
  let timer
  try {
    const records = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), TRUSTED_PROXY_LOOKUP_TIMEOUT_MS) }),
    ])
    if (!records) {
      process.stderr.write(`[dsh-auth] trusted proxy '${host}' lookup timed out\n`)
      return []
    }
    return records.map((record) => record.address)
  } catch (error) {
    process.stderr.write(`[dsh-auth] trusted proxy '${host}' did not resolve: ${error?.message ?? error}\n`)
    return []
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 后台解析可信代理，完成后原子替换列表。
 * 不 await 它：调用方（启动路径）必须立刻进入监听状态。
 * @returns {Promise<void>} 解析完成的 promise（仅供测试等待）。
 */
async function resolveTrustedProxies() {
  const entries = CONFIG.trustedProxies ?? []
  if (entries.length === 0) {
    // 没有配置可信代理：来源天然可区分（对端就是真实来源），IP 维度可以照常使用。
    resolvedTrustedProxies = []
    trustedProxiesResolved = true
    return
  }
  // 重试直到解析成功或放弃。
  //
  // 首次尝试经常失败，而这与配置无关：compose 同时拉起所有容器，网关可能在入口
  // 容器注册进 Docker DNS *之前* 就已经启动，于是解析超时。实测过一次（入口晚于
  // 网关起来）。此时退化为「不设 IP 维度」虽然安全，但会永久失去按来源限速的能力，
  // 直到有人重启网关——所以必须重试，而不是把一次时序竞态固化成终态。
  const MAX_ATTEMPTS = 12
  const RETRY_DELAY_MS = 2500
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const out = []
    for (const entry of entries) {
      if (isAddressLiteral(entry)) {
        out.push(entry)
        continue
      }
      out.push(...await lookupWithTimeout(entry))
    }
    if (out.length > 0) {
      resolvedTrustedProxies = out
      trustedProxiesResolved = true
      if (attempt > 1) {
        process.stdout.write(`[dsh-auth] trusted proxies resolved on attempt ${attempt}: ${out.join(', ')}\n`)
      }
      return
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
  }
  resolvedTrustedProxies = []
  // 只有「解析出了至少一个地址」才算来源可区分。配置了名字却一个都解析不出来，
  // 与没配置在效果上相同：对端恒为入口地址，此时按 IP 分桶就是全局单桶。
  trustedProxiesResolved = false
  process.stderr.write(
    '[dsh-auth] trusted proxy list resolved to no address after retries; IP-scoped rate limiting is '
    + 'disabled (per-account buckets still apply). Set DSH_AUTH_TRUSTED_PROXIES to the ingress address.\n',
  )
}

function requestClientIp(req) {
  return clientIp(req.headers, req.socket.remoteAddress, { trustedProxies: resolvedTrustedProxies })
}

/** 本次请求的来源是否可区分（决定要不要给 IP 桶记账）。 */
function sourceDistinguishable() {
  return trustedProxiesResolved
}

// ---------------------------------------------------------------- 状态修订（CAS）
//
// 状态库是「读一次快照 → 处理器就地改 → 整份写回」的形态；处理器中途还会 await
// （Argon2、编排调用、验证码），因此两个并发请求会各自拿着过期快照先后写回，
// 后写者把先写者的安全决策静默回退——审计实测：停用被撤销、一次性挑战变回可重放、
// 会话被销毁、审计条目丢失。锁会把慢等待一起锁住（登录等容器创建可达数十秒，
// 入口的 auth_request 也会被拖住），因此这里用「修订号比对」：快照之后只要发生过
// 别的写入，本次写入就响亮地失败（409 state_conflict），由客户端重试。宁可丢一次
// 失败计数，绝不静默回退停用/挑战消费/会话撤销这类安全决策。
class StateConflictError extends Error {}

/** 给刚读出的快照挂上当前修订号（不可枚举，因此绝不落进状态文件）。 */
function attachRevision(state) {
  Object.defineProperty(state, '__rev', {
    value: store.revision(),
    enumerable: false,
    writable: true,
    configurable: true,
  })
  return state
}

/** 请求路径统一入口：读快照 + 过期回收 + 挂修订号。 */
function readState() {
  return attachRevision(prune(store.read()))
}

/** 启动路径（bootstrap / 部署同步）：不做过期回收，同样挂修订号。 */
function freshState() {
  return attachRevision(store.read())
}

/**
 * 带修订比对的写入：快照之后有别的写入落盘就拒绝，而不是盲目覆盖。
 * 成功后同步快照的修订号，同一请求内的后续写入（如登录先记失败再建会话）仍然有效。
 */
function commitState(state) {
  if (state?.__rev !== store.revision()) {
    throw new StateConflictError('state changed since it was read; retry the request')
  }
  store.write(state)
  state.__rev = store.revision()
}

/** 统一失败响应：文案不分「用户不存在 / 密码错 / 被限速以外」的差异（威胁 T2）。 */
function fail(res, status, code, extra = {}) {
  send(res, status, { ok: false, code, ...extra })
}

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload), ...headers })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function cookies(req) {
  const header = req.headers.cookie
  if (typeof header !== 'string') return {}
  const out = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted)
}

function headerText(value) {
  if (Array.isArray(value)) return value[0] ?? ''
  return typeof value === 'string' ? value : ''
}

/**
 * 同源判定。除「Origin 与 Host 一致」外，还接受**配置好的公开 origin**：
 * 真实部署里 nginx 会把 Host 改写成公开域名，只比对 Host 会误拒合法请求；
 * 而比对已配置的公开 origin 比信任请求头更严格，不构成放开。
 * @param {Record<string,string|string[]|undefined>} headers 请求头。
 * @returns {boolean} 是否同源。
 */
function sameOrigin(headers) {
  if (isSameOrigin(headers)) return true
  const configured = CONFIG.publicOrigin.replace(/\/+$/, '')
  if (!configured) return false
  const origin = headerText(headers.origin).replace(/\/+$/, '')
  if (origin && origin === configured) return true
  const referer = headerText(headers.referer)
  if (referer) {
    try {
      if (new URL(referer).origin === configured) return true
    } catch {
      return false
    }
  }
  return false
}

function sessionCookie(value, req, maxAgeSeconds) {
  const bits = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`]
  if (isHttps(req)) bits.push('Secure')
  return bits.join('; ')
}

/**
 * CSRF 令牌的读取型 Cookie（双提交模式）。
 *
 * 服务端只保存令牌哈希，无法在后续请求里把原文回传；而管理面板这类独立页面需要拿到
 * 令牌才能发写请求。因此登录时同时下发一个**非 HttpOnly** 的同名 Cookie，页面读它、
 * 放进 X-CSRF-Token 头，服务端再与保存的哈希比对。令牌不是凭据，被同源脚本读到是
 * 这个模式的既定前提；跨源页面既写不了这个 Cookie 也读不到它。
 */
const CSRF_COOKIE = 'dsh_auth_csrf'

function csrfCookie(value, req, maxAgeSeconds) {
  const bits = [`${CSRF_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`]
  if (isHttps(req)) bits.push('Secure')
  return bits.join('; ')
}

/** 登录成功后要下发的两个 Cookie。 */
function loginCookies(token, csrf, req) {
  const maxAge = Math.floor(CONFIG.sessionTtlMs / 1000)
  return [sessionCookie(token, req, maxAge), csrfCookie(csrf, req, maxAge)]
}

/** 清除两个 Cookie（登出、改密、关闭两步验证）。 */
function clearedCookies(req) {
  return [sessionCookie('', req, 0), csrfCookie('', req, 0)]
}

function prune(state) {
  const at = now()
  state.sessions = state.sessions.filter((s) => s.expiresAt > at && s.lastSeenAt + CONFIG.idleTtlMs > at)
  state.flows = (state.flows ?? []).filter((f) => f.expiresAt > at && !f.consumedAt)
  // 失败计数由未认证输入派生（键里含调用者提供的用户名），必须自己设上限：
  // 否则每个不同的用户名都会留下一个永久的键，而每次写入都要重新序列化整份文档。
  // 两层回收：先按最大窗口过期，再对键数设上限，超限时丢最久不活跃的那批。
  if (state.failures && typeof state.failures === 'object') {
    const longestWindow = Math.max(CONFIG.loginWindowMs, CONFIG.registerWindowMs)
    const live = new Map()
    for (const [key, entries] of Object.entries(state.failures)) {
      if (!Array.isArray(entries)) continue
      const kept = entries.filter((t) => Number.isFinite(t) && at - t < longestWindow)
      if (kept.length > 0) live.set(key, kept)
    }
    if (live.size > MAX_FAILURE_KEYS) {
      // 超限时**先淘汰不属于真实账户的键**。
      //
      // 原实现只按「桶内最新时间戳」淘汰，于是攻击者可以用 1 万个伪造用户名各失败一次，
      // 让受害者的 account: 桶（最近一次失败较早）落进被删的一批里，从而重置其锁定计数
      // ——那是锁定机制本身的绕过。这里利用一个攻击者伪造不了的判据：真实账户名来自
      // state.users。属于真实账户的桶是锁定的依据，必须最后才动；伪造的键（account:‹不存在
      // 的用户›、以及 ip: 桶）先淘汰。
      const realAccounts = new Set(
        (state.users ?? [])
          .map((user) => String(user?.username ?? '').trim().toLowerCase())
          .filter((name) => name.length > 0)
          .map((name) => `account:${name}`),
      )
      const byOldest = [...live.entries()].sort((a, b) => Math.max(...a[1]) - Math.max(...b[1]))
      let excess = live.size - MAX_FAILURE_KEYS
      // 第一轮：只淘汰非真实账户的键（伪造用户名、IP 桶），从最旧的开始。
      for (const [key] of byOldest) {
        if (excess <= 0) break
        if (realAccounts.has(key)) continue
        live.delete(key)
        excess -= 1
      }
      // 第二轮：连真实账户的键也要删时才动它们（上一轮已经清掉全部可清的了）。
      if (excess > 0) {
        for (const [key] of byOldest) {
          if (excess <= 0) break
          if (!live.has(key)) continue
          live.delete(key)
          excess -= 1
        }
      }
    }
    state.failures = Object.fromEntries(live)
  }
  return state
}

/** 解析当前会话：令牌摘要命中 + 未过期 + 用户启用 + auth_version 未变（级联失效）。 */
function resolveSession(state, req) {
  const token = cookies(req)[SESSION_COOKIE]
  if (!token) return null
  const digest = tokenDigest(token)
  const session = state.sessions.find((s) => constantTimeEqual(s.tokenHash, digest))
  if (!session) return null
  const user = state.users.find((u) => u.id === session.userId)
  if (!user || user.status !== 'enabled') return null
  if (user.authVersion !== session.authVersion) return null
  return { session, user, token }
}

function issueSession(state, user, req) {
  const token = randomToken(32)
  const csrf = randomToken(32)
  const at = now()
  state.sessions.push({
    tokenHash: tokenDigest(token),
    csrfHash: tokenDigest(csrf),
    userId: user.id,
    authVersion: user.authVersion,
    loginMethod: 'password',
    ip: requestClientIp(req),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 256),
    createdAt: at,
    lastSeenAt: at,
    expiresAt: at + CONFIG.sessionTtlMs,
  })
  return { token, csrf }
}

/** 权限矩阵：root 全权；user 只能碰自己的东西（威胁 T9）。 */
function requireSession(state, req, res) {
  const resolved = resolveSession(state, req)
  if (!resolved) {
    fail(res, 401, 'unauthenticated')
    return null
  }
  return resolved
}

function requireCsrf(resolved, req, res) {
  const header = req.headers['x-csrf-token']
  if (typeof header !== 'string' || !constantTimeEqual(tokenDigest(header), resolved.session.csrfHash)) {
    fail(res, 403, 'csrf_failed')
    return false
  }
  return true
}

/**
 * 把「每个账户被开放了哪些模型上游」同步给密钥代理。
 *
 * 代理按 uid 识别调用者，因此这里要写的是 uid → { tokenDigest, upstreams }。
 * 每次用户/授权变动都重写整份文件：它是派生数据，不是权威来源，权威在 state.users。
 *
 * 只包含普通用户：管理员自己直接用 DSH 的模型设置，不经过这套限制。
 */
async function syncBrokerGrants(state) {
  // 「未单独设置」= 默认全部开放。要把它展开成代理当前的上游集合：
  // 授权表是静态清单，代理无法表达「全部」，所以必须在这里枚举。
  const available = await brokerUpstreamNames()
  const users = {}
  for (const user of state.users) {
    if (!Number.isInteger(user.uid)) continue
    // 停用的账户即时失去模型访问：授权表按当前状态生成，而不是按历史
    let upstreams = []
    if (user.status === 'enabled') {
      upstreams = user.allowedUpstreams === null || user.allowedUpstreams === undefined
        ? available
        : (Array.isArray(user.allowedUpstreams) ? user.allowedUpstreams : [])
    }
    users[String(user.uid)] = {
      tokenDigest: user.brokerTokenDigest ?? '',
      upstreams: [...new Set(upstreams.map((name) => String(name).toLowerCase()).filter(Boolean))],
    }
  }
  if (available.length === 0) {
    // 代理还没起来或没配上游：此时「默认全部开放」展开为空。不是错误，但要留痕，
    // 否则管理员会看到「明明默认开放、实例里却一个模型都没有」而无从下手。
    process.stderr.write('[dsh-auth] broker upstream list is empty; default-open accounts get no upstreams yet\n')
  }
  const payload = JSON.stringify({ version: 1, users }, null, 2)
  writeShared(CONFIG.brokerGrantsFile, payload)

  // 令牌明文：编排服务创建实例时要用它。停用的账户不下发——实例重建时拿不到令牌，
  // 也就发不出被代理认可的请求，与「停用即失去模型访问」一致。
  const tokens = {}
  for (const user of state.users) {
    if (!Number.isInteger(user.uid) || user.status !== 'enabled') continue
    const token = state.brokerTokens?.[user.id]
    if (typeof token === 'string' && token.length > 0) tokens[user.username] = token
  }
  writeShared(CONFIG.brokerTokensFile, JSON.stringify({ version: 1, tokens }, null, 2))
}

/**
 * 原子写一份共享文件（先写临时文件再 rename，避免读到半份内容）。
 *
 * 失败只记日志不抛：这类文件是派生数据，写不进去不该让认证流程失败，
 * 但必须留痕——否则会出现「管理员改了授权但没生效」这种查不出来的现象。
 *
 * @param {string} file 目标路径。
 * @param {string} text 内容。
 * @returns {void}
 */
function writeShared(file, text) {
  const temp = `${file}.tmp-${process.pid}`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, text, { mode: 0o600 })
    fs.renameSync(temp, file)
  } catch (error) {
    process.stderr.write(`[dsh-auth] cannot write ${file}: ${error?.message ?? error}\n`)
    try { fs.rmSync(temp, { force: true }) } catch { /* 尽力而为 */ }
  }
}

/**
 * 当前生效的人机验证配置（未配置时为关闭）。
 * @param {object} state 状态库。
 * @returns {{enabled: boolean, provider: string, siteKey: string, secret: string}} 配置。
 */
function captchaConfig(state) {
  const raw = state.setup?.captcha ?? {}
  return {
    enabled: raw.enabled === true && isCaptchaProvider(raw.provider) && Boolean(raw.siteKey) && Boolean(raw.secret),
    provider: isCaptchaProvider(raw.provider) ? raw.provider : 'turnstile',
    siteKey: typeof raw.siteKey === 'string' ? raw.siteKey : '',
    secret: typeof raw.secret === 'string' ? raw.secret : '',
  }
}

/**
 * 需要人机验证时校验请求里的 token。
 *
 * 关闭时直接放行；开启时失败即拒绝（fail closed）——这是安全控件，
 * 校验不了就不能放行。同时把原因写进审计，便于区分「provider 拒绝了」与「我们没能问到 provider」。
 *
 * @param {object} state 状态库。
 * @param {object} req 请求。
 * @param {object} body 已解析的请求体。
 * @param {string} action 审计里的动作名。
 * @returns {Promise<{ok: boolean, code?: string, reason?: string}>} 结论。
 */
async function enforceCaptcha(state, req, body, action) {
  const config = captchaConfig(state)
  if (!config.enabled) return { ok: true }
  const secret = openCaptchaSecret(totpKey, config.secret)
  if (!secret) {
    // 密文解不开（主密钥换了/文件被改）：配置形同失效，此时必须拒绝而不是放行
    appendAudit(state, { action, result: 'failure', change: { captcha: 'secret_unreadable' } })
    commitState(state)
    return { ok: false, code: 'captcha_unavailable' }
  }
  const verdict = await verifyCaptchaToken({
    provider: config.provider,
    secret,
    token: typeof body?.captchaToken === 'string' ? body.captchaToken : '',
    remoteIp: requestClientIp(req),
  })
  if (!verdict.ok) {
    appendAudit(state, { action, result: 'failure', change: { captcha: verdict.reason }, ip: requestClientIp(req) })
    commitState(state)
    return { ok: false, code: 'captcha_failed', reason: verdict.reason }
  }
  return { ok: true }
}

/**
 * 待确认登记的存活时间。用户确认验证码之后、勾选「已保存恢复码」并点「完成」之前，
 * 登记停在这个状态；超时后必须重新开始，以免留下一个永远悬着的半成品。
 */
const TOTP_PENDING_TTL_MS = 15 * 60_000

/**
 * 把 otpauth 地址渲染成二维码的 data URI。
 *
 * 为什么在服务端生成：验证器要扫的是这个地址，而它只在浏览器与认证网关之间传递。
 * 交给服务端渲染，容器（插件的宿主）就不参与二维码这件事；接口原本就返回同一个地址
 * 的明文，因此这没有引入新的暴露面。
 *
 * 用 data URI 而不是裸 SVG 字符串：前端只要给 <img src> 赋值，不必把服务端返回的
 * 标记注入 DOM，也就不存在注入面。
 * @param {string} uri otpauth 地址。
 * @returns {Promise<string|null>} data URI，失败返回 null（前端会退回显示明文密钥）。
 */
async function otpauthQrDataUri(uri) {
  try {
    const svg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 200 })
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  } catch (error) {
    process.stderr.write(`[dsh-auth] cannot render the otpauth QR code: ${error?.message ?? error}\n`)
    return null
  }
}

// ---------------------------------------------------------------- auth flows
//
// 一次性凭据统一走 flows（new-api AuthFlow 模式）：TOTP 开通、TOTP 登录挑战都签发一个
// 哈希后落盘的令牌，到期或消费即失效。摘要用 TOTP 主密钥做域分隔，密钥不出服务端。

const FLOW_TTL_MS = { totp_setup: 10 * 60_000, totp_login: 5 * 60_000 }

function flowSecret() {
  return totpKey.toString('hex')
}

function createFlow(state, purpose, userId, payload = '') {
  const token = randomToken(32)
  state.flows = state.flows ?? []
  state.flows.push({
    purpose,
    digest: flowDigest(flowSecret(), purpose, token),
    userId,
    payload,
    createdAt: now(),
    expiresAt: now() + (FLOW_TTL_MS[purpose] ?? 5 * 60_000),
    consumedAt: null,
  })
  return token
}

/** 取出并作废一个未消费、未过期的一次性凭据；不匹配返回 null。 */
function consumeFlow(state, purpose, token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 128) return null
  const digest = flowDigest(flowSecret(), purpose, token)
  const flow = (state.flows ?? []).find((f) => f.purpose === purpose && !f.consumedAt && f.expiresAt > now() && constantTimeEqual(f.digest, digest))
  if (!flow) return null
  flow.consumedAt = now()
  return flow
}

/**
 * 会话的对外标识：令牌摘要的前 16 位十六进制。
 * 不落库额外字段，也无法从它反推出令牌本身。
 * @param {object} session 会话记录。
 * @returns {string} 会话 id。
 */
function sessionId(session) {
  return String(session.tokenHash).slice(0, 16)
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    totpEnabled: Boolean(user.totp?.enabled),
    // 账户页要显示还剩几个恢复码；只给数量，不给哈希。
    recoveryCodesLeft: (user.totp?.recoveryHashes ?? []).length,
    // 已确认验证码但还没点「完成」：两步验证此时尚未启用
    totpPending: Boolean(user.totpPending),
    passkeyCount: (user.passkeys ?? []).length,
  }
}

// ---------------------------------------------------------------- 实例编排联动
//
// 多用户模式下每个账户对应一个独立实例：root 用部署方维护的管理员工作台，其他账户
// 由 dsh-instances 按需创建。认证网关只做两件事——登录时确保实例已就绪、verify 时告诉
// nginx 该把请求转发到哪个上游。

let instancesToken = ''

/**
 * 读取调用编排服务的令牌；缺失时创建。
 *
 * 由本服务创建而不是 dsh-instances：本服务以 uid 1000 运行，写出 0600 的文件自己能读；
 * 而编排服务以 root 运行（要 chown 用户数据树），root 读任何文件都不成问题。反过来
 * 让 root 创建 0600 文件，uid 1000 就读不到了。
 * @returns {string} 令牌；仍不可用时返回空串。
 */
function loadInstancesToken() {
  if (instancesToken) return instancesToken
  try {
    const existing = fs.readFileSync(CONFIG.instancesTokenFile, 'utf8').trim()
    if (existing.length >= 32) {
      instancesToken = existing
      return instancesToken
    }
  } catch {
    /* 尚未创建 */
  }
  try {
    const token = randomToken(32)
    fs.mkdirSync(path.dirname(CONFIG.instancesTokenFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(CONFIG.instancesTokenFile, `${token}\n`, { mode: 0o600 })
    process.stdout.write(`[dsh-auth] orchestration token written to ${CONFIG.instancesTokenFile}\n`)
    instancesToken = token
  } catch (error) {
    // 不能缓存失败：编排服务可能稍后才就绪，下一次调用要重新尝试
    process.stderr.write(`[dsh-auth] cannot provision orchestration token: ${error?.message ?? error}\n`)
  }
  return instancesToken
}

/**
 * 该账户的实例名。root 走管理员工作台；其余账户若尚未分配 UID 则返回 null。
 * @param {object} user 用户记录。
 * @returns {string|null} 实例名。
 */
function instanceFor(user) {
  if (!CONFIG.multiUser) return null
  if (user.role === 'root') return CONFIG.adminInstance
  if (!Number.isInteger(user.uid)) return null
  return `dsh-u${user.uid - 100000 + 1}`
}

/**
 * 调用实例编排服务。
 * @param {string} path 接口路径。
 * @param {object} body 请求体；为 null 时发 GET。
 * @returns {Promise<{ok:boolean, status:number, body:object}>} 调用结果（失败不抛错）。
 */
async function callInstances(path, body = null) {
  const token = loadInstancesToken()
  if (!token) return { ok: false, status: 0, body: { code: 'instances_unavailable' } }
  try {
    const response = await fetch(`${CONFIG.instancesUrl}${path}`, {
      method: body === null ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body === null ? {} : { 'content-type': 'application/json' }) },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CONFIG.instancesTimeoutMs),
    })
    const parsed = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, body: parsed }
  } catch (error) {
    process.stderr.write(`[dsh-auth] instances ${path} failed: ${error?.message ?? error}\n`)
    return { ok: false, status: 0, body: { code: 'instances_unreachable' } }
  }
}

/**
 * 登录后确保实例可用。
 *
 * ensure 只保证「容器已创建或已启动」，不等于「已经能服务」——所以要紧接着查一次
 * 真实就绪状态。否则登录响应会谎报 ready，前端不做等待直接跳转，用户撞到 502。
 * @param {object} user 用户记录。
 * @returns {Promise<{instance:string|null, ready:boolean, status:string}>} 结果。
 */
async function ensureInstance(user) {
  const instance = instanceFor(user)
  if (!instance) return { instance: null, ready: true, status: 'single_user' }
  if (user.role === 'root') return { instance, ready: true, status: 'running' }
  const ensured = await callInstances('/instances/ensure', { uid: user.uid, username: user.username })
  if (!ensured.ok) return { instance, ready: false, status: String(ensured.body?.code ?? 'unavailable') }
  const state = await callInstances(`/instances/state?uid=${encodeURIComponent(String(user.uid))}`)
  return {
    instance,
    ready: state.ok && state.body?.ready === true,
    status: String(state.body?.status ?? ensured.body?.status ?? 'unknown'),
  }
}

/** 第二因子校验：先按恢复码处理（消费即焚），否则按 TOTP 码处理并记录已用时间步。 */
function verifySecondFactor(user, code) {
  const totp = user.totp
  if (!totp?.enabled) return { ok: false, reason: 'not_enabled' }
  if (looksLikeRecoveryCode(code)) {
    const index = findRecoveryCode(totp.recoveryHashes ?? [], code)
    if (index < 0) return { ok: false, reason: 'invalid' }
    totp.recoveryHashes.splice(index, 1)
    return { ok: true, usedRecovery: true }
  }
  const secret = openTotpSecret(totpKey, totp.secret)
  if (!secret) return { ok: false, reason: 'unavailable' }
  const match = matchTotpStep(secret, String(code ?? '').trim(), now(), totp.lastUsedStep ?? -1)
  if (!match.ok) return { ok: false, reason: 'invalid' }
  totp.lastUsedStep = match.step
  return { ok: true, usedRecovery: false }
}

// ---------------------------------------------------------------- bootstrap

/** 首次启动创建 root。密码来自环境变量，否则随机生成写入 0600 文件（不打印明文）。 */
function bootstrap(state) {
  if (state.setup.initialized && state.users.some((u) => u.role === 'root')) return
  const fromEnv = process.env.DSH_AUTH_INITIAL_PASSWORD
  const password = typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : generatePassword()
  const at = now()
  state.users.push({
    id: `u-${randomToken(8)}`,
    username: 'root',
    role: 'root',
    status: 'enabled',
    passwordHash: hashPassword(password),
    authVersion: 1,
    totp: { enabled: false },
    passkeys: [],
    createdAt: at,
  })
  state.setup.initialized = true
  state.setup.multiUser = CONFIG.multiUser
  state.setup.registerGate = CONFIG.registerGate
  // 注册策略拆成两个独立开关（对齐 cloud-mail 的 register + regKey 两个设置项）：
  //   registrationOpen：注册入口是否开放；关闭后 handleRegister 直接拒绝。
  //   inviteRequired：注册是否必须凭邀请码；关闭时邀请码可留空。
  // 旧的 registerGate 是二选一枚举，表达不了「关闭注册」与「开放但免码」这类组合。
  // 这里从它迁移一次，此后以状态库为准——管理员在面板上的改动必须能存活重启。
  if (state.setup.registrationOpen === undefined) {
    state.setup.registrationOpen = true
    state.setup.inviteRequired = CONFIG.registerGate === 'invite'
  }
  // 人机验证默认关闭：开启需要管理员先填好服务与密钥
  state.setup.captcha = state.setup.captcha ?? { enabled: false, provider: 'turnstile', siteKey: '', secret: '' }
  if (typeof fromEnv !== 'string' || fromEnv.length === 0) {
    const file = path.join(path.dirname(CONFIG.stateFile), 'initial-password')
    fs.writeFileSync(file, `${password}\n`, { mode: 0o600 })
    process.stdout.write(`[dsh-auth] root password written to ${file} (read it, then delete)\n`)
  }
  // 多用户 + 邀请码门槛：首次生成一个初始邀请码，明文写入 0600 文件供安装器打印一次。
  if (CONFIG.multiUser && CONFIG.registerGate === 'invite') {
    const code = randomToken(16).replace(/[^A-Za-z0-9]/g, '').slice(0, 20).toUpperCase()
    state.tokens = { ...(state.tokens ?? {}), inviteCode: code }
    const file = path.join(path.dirname(CONFIG.stateFile), 'invite-code')
    fs.writeFileSync(file, `${code}\n`, { mode: 0o600 })
    process.stdout.write(`[dsh-auth] initial invite code written to ${file} (read it, then delete)\n`)
  }
  appendAudit(state, { actorId: 'system', action: 'bootstrap.root', result: 'ok', change: { username: 'root' } })
  commitState(state)
}

/**
 * 把部署配置同步进状态库。
 *
 * 状态库是「谁存在、邀请码是什么」的权威；但「单管理员还是多用户」「注册门槛」属于
 * 部署声明，写在本服务的环境变量（即 .env）里。若只认状态库里首次启动时记下的那份值，
 * 改 .env 并重跑安装向导就不会生效——这与安装器写 .env 的语义相矛盾。
 * @param {object} state 状态对象。
 * @returns {Record<string,string>} 本次发生的变更（为空表示无需改动）。
 */
function syncDeploymentConfig(state) {
  const changes = {}
  if (state.setup.multiUser !== CONFIG.multiUser) {
    changes.multiUser = `${state.setup.multiUser} -> ${CONFIG.multiUser}`
    state.setup.multiUser = CONFIG.multiUser
  }
  if ((state.setup.registerGate ?? 'open') !== CONFIG.registerGate) {
    changes.registerGate = `${state.setup.registerGate ?? 'open'} -> ${CONFIG.registerGate}`
    state.setup.registerGate = CONFIG.registerGate
  }
  // 注册开关一旦被管理员在面板上改过，就以状态库为准，不再被环境变量覆盖：
  // 否则「面板上关掉注册」会在下次重启时被 .env 的默认值悄悄推翻。
  if (state.setup.registrationOpen === undefined) {
    state.setup.registrationOpen = true
    state.setup.inviteRequired = CONFIG.registerGate === 'invite'
  }
  // 要求邀请码但没有可用码时补发一个，否则没有人能注册
  if (CONFIG.multiUser && state.setup.registrationOpen !== false && state.setup.inviteRequired === true && !state.tokens?.inviteCode) {
    const code = randomToken(16).replace(/[^A-Za-z0-9]/g, '').slice(0, 20).toUpperCase()
    state.tokens = { ...(state.tokens ?? {}), inviteCode: code }
    const file = path.join(path.dirname(CONFIG.stateFile), 'invite-code')
    fs.writeFileSync(file, `${code}\n`, { mode: 0o600 })
    changes.inviteCode = `written to ${file}`
  }
  if (Object.keys(changes).length > 0) {
    appendAudit(state, { actorId: 'system', action: 'config.sync', result: 'ok', change: changes })
    commitState(state)
  }
  return changes
}

/**
 * 第二因子登录：消费挑战 → 校验 TOTP 码或恢复码 → 建会话。
 * 失败计入**每用户独立的 2FA 锁**（T5），与密码锁互不干扰。
 */
async function handleTotpLogin(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const body = await readBody(req)
  if (!body || typeof body.challenge !== 'string' || typeof body.code !== 'string') return fail(res, 400, 'invalid_request')
  const flow = consumeFlow(state, 'totp_login', body.challenge)
  if (!flow) return fail(res, 401, 'invalid_challenge')
  const user = state.users.find((u) => u.id === flow.userId)
  if (!user || user.status !== 'enabled' || !user.totp?.enabled) return fail(res, 401, 'invalid_challenge')

  user.totp.failedAttempts = user.totp.failedAttempts ?? 0
  if (user.totp.lockedUntil && user.totp.lockedUntil > now()) {
    const retryAfter = Math.ceil((user.totp.lockedUntil - now()) / 1000)
    commitState(state)
    return fail(res, 429, 'second_factor_locked', { retryAfter })
  }

  const result = verifySecondFactor(user, body.code)
  if (!result.ok) {
    user.totp.failedAttempts += 1
    if (user.totp.failedAttempts >= 5) {
      user.totp.lockedUntil = now() + 15 * 60_000
      user.totp.failedAttempts = 0
    }
    appendAudit(state, { actorId: user.id, action: 'login.second_factor', result: 'failure', ip: requestClientIp(req) })
    commitState(state)
    return fail(res, 401, 'invalid_second_factor')
  }

  user.totp.failedAttempts = 0
  user.totp.lockedUntil = null
  await completeLogin(state, user, req, res, { secondFactor: result.usedRecovery ? 'recovery_code' : 'totp' })
}

/** 开通 TOTP 第一步：验当前密码 → 签发密钥与挑战（密钥此时尚未生效）。 */
async function handleTotpSetup(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  if (!requireCsrf(resolved, req, res)) return
  const body = await readBody(req)
  if (!body || typeof body.currentPassword !== 'string') return fail(res, 400, 'invalid_request')
  if (!verifyPassword(body.currentPassword, resolved.user.passwordHash)) {
    appendAudit(state, { actorId: resolved.user.id, action: 'totp.setup', result: 'failure' })
    commitState(state)
    return fail(res, 401, 'invalid_credentials')
  }
  if (resolved.user.totp?.enabled) return fail(res, 409, 'totp_already_enabled')
  const secret = generateTotpSecret()
  const challenge = createFlow(state, 'totp_setup', resolved.user.id, secret)
  commitState(state)
  const otpauthUri = buildOtpAuthUri(resolved.user.username, secret)
  send(res, 200, {
    ok: true,
    secret,
    otpauthUri,
    // 二维码与地址来自同一次计算；渲染失败时前端仍可用明文密钥手工添加
    otpauthQrDataUri: await otpauthQrDataUri(otpauthUri),
    challenge,
    expiresInSeconds: 600,
  })
}

/** 开通 TOTP 第二步：验码 → 落加密密钥与一次性恢复码。 */
async function handleTotpConfirm(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  if (!requireCsrf(resolved, req, res)) return
  const body = await readBody(req)
  if (!body || typeof body.challenge !== 'string' || typeof body.code !== 'string') return fail(res, 400, 'invalid_request')
  const flow = consumeFlow(state, 'totp_setup', body.challenge)
  if (!flow || flow.userId !== resolved.user.id) return fail(res, 401, 'invalid_challenge')
  const match = matchTotpStep(flow.payload, String(body.code).trim(), now(), -1)
  if (!match.ok) {
    appendAudit(state, { actorId: resolved.user.id, action: 'totp.enable', result: 'failure' })
    commitState(state)
    return fail(res, 401, 'invalid_second_factor')
  }
  const { codes, hashes } = generateRecoveryCodes()
  // 这里**不启用**两步验证，只把它挂成「待确认」。
  //
  // 理由：恢复码只在这次响应里返回一次，而它正是「验证器丢失时的唯一退路」。
  // 如果确认验证码就立刻启用，用户没保存恢复码也照样被保护起来，一旦验证器丢失就再也进不去。
  // 因此「启用」被绑定到用户显式点「完成」（界面要求先勾选已保存）之后，见 handleTotpActivate。
  resolved.user.totpPending = {
    secret: sealTotpSecret(totpKey, flow.payload),
    recoveryHashes: hashes,
    // 记下确认时用掉的时间步，避免同一个码在启用后立刻被重放
    lastUsedStep: match.step,
    createdAt: now(),
  }
  resolved.user.updatedAt = now()
  appendAudit(state, { actorId: resolved.user.id, action: 'totp.enrol_pending', result: 'ok', change: { recoveryCodes: codes.length } })
  commitState(state)
  // 恢复码只在这里返回一次；之后服务端只有哈希，无法再取回。
  send(res, 200, { ok: true, pending: true, recoveryCodes: codes, expiresInSeconds: Math.floor(TOTP_PENDING_TTL_MS / 1000) })
}

/**
 * 完成登记：把「待确认」转为真正启用。
 *
 * 这是唯一会打开两步验证的地方。界面要求用户先勾选「已把恢复码保存到安全的地方」才能点
 * 「完成」，因此没有保存恢复码的人不会在不知不觉中被保护起来、也就不会在验证器丢失后
 * 永久失去访问权。
 */
async function handleTotpActivate(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  if (!requireCsrf(resolved, req, res)) return
  if (resolved.user.totp?.enabled) return fail(res, 409, 'totp_already_enabled')
  const pending = resolved.user.totpPending
  if (!pending) return fail(res, 409, 'no_pending_enrolment')
  if (now() - Number(pending.createdAt ?? 0) > TOTP_PENDING_TTL_MS) {
    delete resolved.user.totpPending
    resolved.user.updatedAt = now()
    commitState(state)
    return fail(res, 409, 'enrolment_expired')
  }
  resolved.user.totp = {
    enabled: true,
    secret: pending.secret,
    enabledAt: now(),
    lastUsedStep: Number.isInteger(pending.lastUsedStep) ? pending.lastUsedStep : -1,
    failedAttempts: 0,
    lockedUntil: null,
    recoveryHashes: pending.recoveryHashes ?? [],
  }
  delete resolved.user.totpPending
  resolved.user.updatedAt = now()
  // 启用新因素不会撤销现有会话：它是安全升级，不是凭据变更，没理由把刚操作的人踢下线。
  appendAudit(state, { actorId: resolved.user.id, action: 'totp.enable', result: 'ok' })
  commitState(state)
  send(res, 200, { ok: true })
}

/**
 * 放弃未完成的登记。用户在恢复码那一步离开页面后，凭据与哈希都只存在于服务端，
 * 他也不可能再看到明文；这里允许把半成品清掉、重新开始。
 */
async function handleTotpCancel(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  if (!requireCsrf(resolved, req, res)) return
  if (!resolved.user.totpPending) return send(res, 200, { ok: true, cancelled: false })
  delete resolved.user.totpPending
  resolved.user.updatedAt = now()
  appendAudit(state, { actorId: resolved.user.id, action: 'totp.enrol_cancel', result: 'ok' })
  commitState(state)
  send(res, 200, { ok: true, cancelled: true })
}

/** 关闭 TOTP：安全降级操作，需密码 + 当前验证码；成功后撤销该用户全部会话。 */
async function handleTotpDisable(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  if (!requireCsrf(resolved, req, res)) return
  const body = await readBody(req)
  if (!body || typeof body.currentPassword !== 'string' || typeof body.code !== 'string') return fail(res, 400, 'invalid_request')
  if (!verifyPassword(body.currentPassword, resolved.user.passwordHash)) return fail(res, 401, 'invalid_credentials')
  if (!resolved.user.totp?.enabled) return fail(res, 409, 'totp_not_enabled')
  const result = verifySecondFactor(resolved.user, body.code)
  if (!result.ok) {
    appendAudit(state, { actorId: resolved.user.id, action: 'totp.disable', result: 'failure' })
    commitState(state)
    return fail(res, 401, 'invalid_second_factor')
  }
  resolved.user.totp = { enabled: false }
  delete resolved.user.totpPending
  resolved.user.updatedAt = now()
  resolved.user.authVersion += 1
  state.sessions = state.sessions.filter((s) => s.userId !== resolved.user.id)
  appendAudit(state, { actorId: resolved.user.id, action: 'totp.disable', result: 'ok' })
  commitState(state)
  send(res, 200, { ok: true }, { 'set-cookie': clearedCookies(req) })
}

/**
 * 读取模型上游授权总览：可选上游（来自代理）+ 每个账户当前的授权。
 * @param {object} state 状态库。
 * @param {object} req 请求。
 * @param {object} res 响应。
 */
async function handleAdminModelAccess(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  const available = await brokerUpstreamNames()
  send(res, 200, {
    ok: true,
    // 代理不可达时为空：界面据此提示「无法读取可用上游」，而不是显示成「一个都没有」
    available,
    brokerReachable: available.length > 0,
    users: state.users
      .filter((u) => Number.isInteger(u.uid))
      .map((u) => ({
        username: u.username,
        uid: u.uid,
        role: u.role,
        status: u.status,
        // null = 默认全部开放（尚未单独设置过）
        allowedUpstreams: Array.isArray(u.allowedUpstreams) ? u.allowedUpstreams : null,
      })),
  })
}

/**
 * 设置某个账户可用的模型上游。
 *
 * 传 allowedUpstreams: null 表示恢复「默认全部开放」（即跟随代理当前的上游集合）。
 * 传数组则精确限定；空数组表示明确不给任何上游。
 *
 * @param {object} state 状态库。
 * @param {object} req 请求。
 * @param {object} res 响应。
 */
async function handleAdminModelAccessUpdate(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  if (!requireCsrf(admin, req, res)) return
  const body = await readBody(req)
  if (!body || typeof body.username !== 'string') return fail(res, 400, 'invalid_request')
  const target = state.users.find((u) => u.username === body.username)
  if (!target) return fail(res, 404, 'not_found')
  if (!Number.isInteger(target.uid)) return fail(res, 409, 'account_has_no_instance')

  if (body.allowedUpstreams === null || body.allowedUpstreams === undefined) {
    target.allowedUpstreams = null
  } else if (Array.isArray(body.allowedUpstreams)) {
    const available = await brokerUpstreamNames()
    const requested = [...new Set(body.allowedUpstreams.map((name) => String(name).toLowerCase()).filter(Boolean))]
    // 只接受代理确实存在的上游：接受不存在的名字会让人以为开放了、实际用不了
    if (available.length > 0) {
      const unknown = requested.filter((name) => !available.includes(name))
      if (unknown.length > 0) return fail(res, 400, 'unknown_upstream', { unknown })
    }
    target.allowedUpstreams = requested
  } else {
    return fail(res, 400, 'invalid_request')
  }

  target.updatedAt = now()
  await syncBrokerGrants(state)
  appendAudit(state, {
    actorId: admin.user.id,
    action: 'admin.model-access.update',
    result: 'ok',
    change: { account: target.username, upstreams: target.allowedUpstreams === null ? 'all' : target.allowedUpstreams.length },
  })
  commitState(state)
  send(res, 200, { ok: true, username: target.username, allowedUpstreams: target.allowedUpstreams })
}

/**
 * 读取人机验证配置。密钥**只报是否已配置**，绝不回传明文或密文。
 * @param {object} state 状态库。
 * @param {object} req 请求。
 * @param {object} res 响应。
 */
function handleAdminCaptcha(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  const raw = state.setup?.captcha ?? {}
  send(res, 200, {
    ok: true,
    // 支持的 provider 列表由服务端给出，前端不再维护第二份
    providers: Object.entries(CAPTCHA_PROVIDERS).map(([id, meta]) => ({ id, label: meta.label, script: meta.script })),
    enabled: raw.enabled === true,
    provider: isCaptchaProvider(raw.provider) ? raw.provider : 'turnstile',
    siteKey: typeof raw.siteKey === 'string' ? raw.siteKey : '',
    // 只回答「有没有」：明文只在写入时经过一次，之后连管理员也读不回来
    secretConfigured: Boolean(raw.secret),
    // 配置是否真的在生效（三项齐全且密文可解）
    active: captchaConfig(state).enabled,
  })
}

/**
 * 写入人机验证配置。
 *
 * 密钥单独用主密钥加密后落盘；不提交 secret 时保留原值，这样改 siteKey 不必重填密钥。
 * 开启时要求 provider/siteKey/secret 三者齐备，否则拒绝——半配置状态会让所有人登录失败。
 *
 * @param {object} state 状态库。
 * @param {object} req 请求。
 * @param {object} res 响应。
 */
async function handleAdminCaptchaUpdate(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  if (!requireCsrf(admin, req, res)) return
  const body = await readBody(req)
  if (!body) return fail(res, 400, 'invalid_request')

  const current = state.setup.captcha ?? { enabled: false, provider: 'turnstile', siteKey: '', secret: '' }
  const provider = body.provider === undefined ? current.provider : body.provider
  if (!isCaptchaProvider(provider)) return fail(res, 400, 'unsupported_provider')
  const siteKey = typeof body.siteKey === 'string' ? body.siteKey.trim() : current.siteKey
  const enabled = body.enabled === undefined ? current.enabled === true : body.enabled === true

  // secret 缺省表示「不改」；显式传空串表示「清掉」
  let secret = current.secret
  let secretChanged = false
  if (typeof body.secret === 'string') {
    const trimmed = body.secret.trim()
    secret = trimmed.length > 0 ? sealCaptchaSecret(totpKey, trimmed) : ''
    secretChanged = true
  }

  if (enabled) {
    if (!siteKey) return fail(res, 400, 'missing_site_key')
    if (!secret) return fail(res, 400, 'missing_secret')
  }

  state.setup.captcha = { enabled, provider, siteKey, secret }
  appendAudit(state, {
    actorId: admin.user.id,
    action: 'admin.captcha.update',
    result: 'ok',
    change: { enabled, provider, siteKey: siteKey ? 'set' : 'empty', secret: secretChanged ? (secret ? 'set' : 'cleared') : 'unchanged' },
  })
  commitState(state)
  send(res, 200, { ok: true, enabled, provider, siteKey, secretConfigured: Boolean(secret), active: captchaConfig(state).enabled })
}

/**
 * 重新生成恢复码：要求当前密码 + 一个有效第二因素，轮换后旧码全部失效。
 *
 * 已开启两步验证时才能轮换；与关闭 TOTP 一样，这是安全相关操作，因此审计并递增
 * authVersion（不撤销会话——用户只是换了备用码，没必要重新登录）。
 */
async function handleRecoveryRegenerate(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  if (!requireCsrf(resolved, req, res)) return
  const body = await readBody(req)
  if (!body || typeof body.currentPassword !== 'string' || typeof body.code !== 'string') return fail(res, 400, 'invalid_request')
  if (!verifyPassword(body.currentPassword, resolved.user.passwordHash)) return fail(res, 401, 'invalid_credentials')
  if (!resolved.user.totp?.enabled) return fail(res, 409, 'totp_not_enabled')
  const result = verifySecondFactor(resolved.user, body.code)
  if (!result.ok) {
    appendAudit(state, { actorId: resolved.user.id, action: 'totp.recovery.regenerate', result: 'failure' })
    commitState(state)
    return fail(res, 401, 'invalid_second_factor')
  }
  const { codes, hashes } = generateRecoveryCodes()
  resolved.user.totp.recoveryHashes = hashes
  resolved.user.updatedAt = now()
  // 刻意不动 authVersion。authVersion 是「让全部会话失效」的级联开关，用于密码/第二因素
  // 变更这类会改变「谁能登录」的事情；轮换恢复码换掉的是**备用凭据**，主因素没变，
  // 因此执行这次操作的人不应该被自己的操作踢出去（早先这里多加了 +1，实测就是被弹回登录页）。
  appendAudit(state, { actorId: resolved.user.id, action: 'totp.recovery.regenerate', result: 'ok', change: { recoveryCodes: codes.length, usedSecondFactor: result.usedRecovery ? 'recovery' : 'totp' } })
  commitState(state)
  send(res, 200, { ok: true, recoveryCodes: codes })
}

/**
 * 开放注册（仅多用户模式）。角色恒为 user，注册成功即分配独立实例身份与数据目录。
 * 邀请码门槛、用户名规则、密码强度、按 IP 限速与审计都在这里落地。
 */
async function handleRegister(state, req, res) {
  if (!state.setup.multiUser) return fail(res, 404, 'not_available')
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const ip = requestClientIp(req)
  const at = now()
  state.failures = state.failures ?? {}
  const key = `register:${ip}`
  const bucket = evaluateFailureBucket(state.failures[key], at, CONFIG.registerWindowMs, CONFIG.maxRegistrationsPerIp)
  state.failures[key] = bucket.kept
  if (!bucket.allowed) {
    commitState(state)
    return fail(res, 429, 'rate_limited', { retryAfter: Math.ceil(bucket.retryAfterMs / 1000) })
  }
  const body = await readBody(req)
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') return fail(res, 400, 'invalid_request')
  // 开放注册最容易被人机滥用；同样排在创建账户之前
  const captcha = await enforceCaptcha(state, req, body, 'register')
  if (!captcha.ok) return fail(res, 403, captcha.code, captcha.reason ? { reason: captcha.reason } : undefined)
  const username = body.username.trim()
  if (!isValidUsername(username)) {
    state.failures[key] = [...bucket.kept, at]
    commitState(state)
    return fail(res, 400, 'invalid_username')
  }
  const weak = validatePassword(body.password)
  if (weak) {
    state.failures[key] = [...bucket.kept, at]
    commitState(state)
    return fail(res, 400, 'weak_password', { reason: weak })
  }
  if (state.setup.registrationOpen === false) {
    // 关闭注册：入口整体不可用。这与「邀请码不对」区分开，前端据此提示而不是
    // 让用户反复试码——他们拿到的码可能完全正确，只是管理员关了注册。
    commitState(state)
    return fail(res, 403, 'registration_closed')
  }
  if (state.setup.inviteRequired === true) {
    const expected = state.tokens?.inviteCode ?? ''
    const provided = typeof body.inviteCode === 'string' ? body.inviteCode.trim().toUpperCase() : ''
    if (!expected || !constantTimeEqual(provided, expected)) {
      state.failures[key] = [...bucket.kept, at]
      appendAudit(state, { action: 'register', result: 'invalid_invite', ip })
      commitState(state)
      return fail(res, 403, 'invalid_invite')
    }
  }
  // 用户名唯一性：不区分大小写，避免出现仅大小写不同的两个账户
  if (state.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    state.failures[key] = [...bucket.kept, at]
    commitState(state)
    return fail(res, 409, 'username_taken')
  }
  // 墓碑里的 uid（数据可能仍在磁盘上）一并视为已占用，避免新账户继承他人数据
  const uid = allocateUid([
    ...state.users.map((u) => u.uid),
    ...(Array.isArray(state.retainedUids) ? state.retainedUids.map((entry) => entry?.uid) : []),
  ])
  // 每个实例一枚模型代理令牌：代理用它识别调用者，从而只放行该用户被开放的上游。
  // 只存摘要，与 instances.token 同一套做法。
  const brokerToken = randomToken(32)
  const user = {
    id: `u-${randomToken(8)}`,
    username,
    role: 'user',
    status: 'enabled',
    uid,
    brokerTokenDigest: brokerTokenDigest(brokerToken),
    // 默认全部开放：管理员配好上游后，用户开箱即可用（符合「默认显示并可用」）。
    // 显式传 null 表示尚未设置过，syncBrokerGrants 会按 broker 现有上游补齐。
    allowedUpstreams: null,
    passwordHash: hashPassword(body.password),
    authVersion: 1,
    totp: { enabled: false },
    passkeys: [],
    createdAt: at,
  }
  state.users.push(user)
  state.brokerTokens = state.brokerTokens ?? {}
  state.brokerTokens[user.id] = brokerToken
  await syncBrokerGrants(state)
  // 成功注册同样计入额度：限速的目的是限制「新建账户数」，只统计失败会形同虚设
  state.failures[key] = [...bucket.kept, at]
  if (state.tokens?.inviteCode && state.setup.inviteRequired === true) {
    // 单次邀请码：用掉即作废，避免同一个码被无限传播
    delete state.tokens.inviteCode
  }
  appendAudit(state, { actorId: user.id, action: 'register', result: 'ok', ip, change: { username, uid } })
  commitState(state)
  send(res, 201, { ok: true, username, instance: instanceFor(user) })
}

/**
 * 登录完成：签发会话、写审计、触发实例确保，并返回客户端需要的去向信息。
 *
 * 不在请求里等实例就绪：唤醒要数十秒，会把登录请求拖到代理超时。客户端据 `ready`
 * 决定直接进入工作台还是先展示等待页，再用 /api/auth/instance 轮询。
 * @param {object} state 状态对象。
 * @param {object} user 用户记录。
 * @param {object} req 请求。
 * @param {object} res 响应。
 * @param {object} [auditChange] 审计补充信息。
 * @returns {Promise<void>} 无返回值。
 */
async function completeLogin(state, user, req, res, auditChange = null) {
  const { token, csrf } = issueSession(state, user, req)
  user.lastLoginAt = now()
  appendAudit(state, { actorId: user.id, action: 'login', result: 'ok', ip: requestClientIp(req), change: auditChange })
  commitState(state)
  const instance = await ensureInstance(user)
  send(res, 200, {
    ok: true,
    user: publicUser(user),
    csrfToken: csrf,
    instance: instance.instance,
    ready: instance.ready,
  }, { 'set-cookie': loginCookies(token, csrf, req) })
}

/**
 * 实例就绪状态轮询。等待页用它判断何时可以进入工作台。
 * 未分配实例（单用户模式或尚未分配 UID）视为立即就绪。
 */
async function handleInstanceState(state, req, res) {
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  const instance = instanceFor(resolved.user)
  if (!instance) return send(res, 200, { ok: true, instance: null, ready: true })
  if (resolved.user.role === 'root') return send(res, 200, { ok: true, instance, ready: true })
  const result = await callInstances(`/instances/state?uid=${encodeURIComponent(String(resolved.user.uid))}`)
  if (result.status === 404) return send(res, 200, { ok: true, instance, ready: false, status: 'absent' })
  return send(res, 200, {
    ok: true,
    instance,
    ready: result.ok && result.body?.ready === true,
    status: String(result.body?.status ?? 'unknown'),
  })
}

/**
 * 主动唤醒实例（实例被闲置回收后用户回来时走这里）。
 *
 * 幂等操作，只影响调用者自己的实例；因此只要求同源与会话，不要求 CSRF 令牌——
 * 它由页面导航触发，而非表单提交。
 */
async function handleInstanceWake(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  const result = await ensureInstance(resolved.user)
  send(res, 200, { ok: true, instance: result.instance, ready: result.ready, status: result.status })
}

/**
 * 列出当前账户的会话。用于账户页让用户看到「我在哪些地方登录着」并单独吊销。
 * 令牌摘要只用于计算 id，绝不返回。
 */
function handleSessions(state, req, res) {
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  const currentId = sessionId(resolved.session)
  const sessions = state.sessions
    .filter((session) => session.userId === resolved.user.id)
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
    .map((session) => ({
      id: sessionId(session),
      current: sessionId(session) === currentId,
      loginMethod: session.loginMethod,
      ip: session.ip,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
    }))
  send(res, 200, { ok: true, sessions })
}

/**
 * 吊销会话。可指定一个 id，或 `all: true` 吊销**除当前会话外**的全部会话
 * （账号页上「退出其他所有设备」的语义；保留当前会话才不会把自己也踢出去）。
 */
async function handleSessionRevoke(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  if (!requireCsrf(resolved, req, res)) return
  const body = await readBody(req)
  if (!body) return fail(res, 400, 'invalid_request')
  const currentId = sessionId(resolved.session)
  let removed = 0
  if (body.all === true) {
    const before = state.sessions.length
    state.sessions = state.sessions.filter((session) => session.userId !== resolved.user.id || sessionId(session) === currentId)
    removed = before - state.sessions.length
  } else if (typeof body.id === 'string' && body.id.length > 0) {
    if (body.id === currentId) return fail(res, 409, 'use_logout', { hint: 'revoking the current session is a logout' })
    const before = state.sessions.length
    state.sessions = state.sessions.filter((session) => !(session.userId === resolved.user.id && sessionId(session) === body.id))
    removed = before - state.sessions.length
    if (removed === 0) return fail(res, 404, 'session_not_found')
  } else {
    return fail(res, 400, 'invalid_request')
  }
  appendAudit(state, {
    actorId: resolved.user.id,
    action: 'session.revoke',
    result: 'ok',
    ip: requestClientIp(req),
    change: { removed, scope: body.all === true ? 'others' : body.id },
  })
  commitState(state)
  send(res, 200, { ok: true, removed })
}

// ---------------------------------------------------------------- 管理面（仅 root）

/** root 专属守卫。返回已解析的会话，或已写出 403 时返回 null。 */
function requireRoot(state, req, res) {
  const resolved = requireSession(state, req, res)
  if (!resolved) return null
  if (resolved.user.role !== 'root') {
    appendAudit(state, { actorId: resolved.user.id, action: 'admin.denied', result: 'forbidden', ip: requestClientIp(req), change: { path: req.url } })
    commitState(state)
    fail(res, 403, 'forbidden')
    return null
  }
  return resolved
}

/** 统计仍处于启用状态的 root 数量，用于「不能移除最后一个管理员」守卫。 */
function activeRootCount(state) {
  return state.users.filter((u) => u.role === 'root' && u.status === 'enabled').length
}

/** 撤销某账户的全部会话（停用、改密、删除时共用）。 */
function revokeSessions(state, userId) {
  state.sessions = state.sessions.filter((s) => s.userId !== userId)
}

function adminUserView(state, user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    uid: user.uid ?? null,
    instance: instanceFor(user),
    totpEnabled: Boolean(user.totp?.enabled),
    passkeyCount: (user.passkeys ?? []).length,
    createdAt: user.createdAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    sessions: state.sessions.filter((s) => s.userId === user.id).length,
    // null 表示「未设置过」：界面按「默认全部开放」呈现
    allowedUpstreams: Array.isArray(user.allowedUpstreams) ? user.allowedUpstreams : null,
  }
}

/**
 * 列出密钥代理里当前可用的上游名。
 *
 * 授权界面要让人从「实际存在的上游」里挑，而不是手打名字——打错一个字就等于
 * 悄悄关掉了一个模型。代理不可达时返回空数组，由调用方决定如何提示。
 *
 * @returns {Promise<string[]>} 上游名列表。
 */
async function brokerUpstreamNames() {
  try {
    const response = await fetch(`${CONFIG.brokerUrl}/status`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return []
    const body = await response.json()
    const names = Array.isArray(body?.upstreams) ? body.upstreams : []
    return names.map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter((name) => typeof name === 'string' && name.length > 0)
  } catch {
    return []
  }
}

function handleAdminUsers(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  send(res, 200, { ok: true, users: state.users.map((u) => adminUserView(state, u)) })
}

/** 启用/停用账户。停用会同时撤销会话并停掉其实例。 */
async function handleAdminUserStatus(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  if (!requireCsrf(admin, req, res)) return
  const body = await readBody(req)
  const username = typeof body?.username === 'string' ? body.username : ''
  const status = body?.status === 'disabled' ? 'disabled' : body?.status === 'enabled' ? 'enabled' : null
  if (!status) return fail(res, 400, 'invalid_request')
  const target = state.users.find((u) => u.username === username)
  if (!target) return fail(res, 404, 'not_found')
  if (target.id === admin.user.id) return fail(res, 409, 'cannot_modify_self')
  if (target.role === 'root' && status === 'disabled' && activeRootCount(state) <= 1) {
    return fail(res, 409, 'last_admin')
  }
  target.status = status
  target.updatedAt = now()
  if (status === 'disabled') {
    // 级联失效：版本号自增 + 撤销会话，停用即刻生效，不等待会话自然过期
    target.authVersion += 1
    revokeSessions(state, target.id)
  }
  if (target.role === 'user' && Number.isInteger(target.uid)) {
    // 实例状态跟随账户状态，避免停用后仍占内存
    await callInstances(status === 'disabled' ? '/instances/stop' : '/instances/ensure', { uid: target.uid, username: target.username })
  }
  appendAudit(state, { actorId: admin.user.id, action: 'admin.user.status', result: 'ok', ip: requestClientIp(req), change: { target: target.username, status } })
  commitState(state)
  // 账户状态变了就要刷新授权表：syncBrokerGrants 只被模型授权变更/注册/启动三处
  // 调用，停用与启用不刷新的话，被停用账户的实例令牌会一直被 broker 认作有效，
  // 与 :312「停用的账户即时失去模型访问」的承诺相悖。
  await syncBrokerGrants(state)
  send(res, 200, { ok: true, user: adminUserView(state, target) })
}

/** 重置他人密码：管理员设置新口令，旧会话全部失效。 */
async function handleAdminUserPassword(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  if (!requireCsrf(admin, req, res)) return
  const body = await readBody(req)
  const username = typeof body?.username === 'string' ? body.username : ''
  const target = state.users.find((u) => u.username === username)
  if (!target) return fail(res, 404, 'not_found')
  // 管理员提供口令时校验强度；不提供则生成随机口令并只返回一次
  const generated = typeof body.password !== 'string' || body.password.length === 0
  const password = generated ? generatePassword() : body.password
  const weak = validatePassword(password)
  if (weak) return fail(res, 400, 'weak_password', { reason: weak })
  if (target.username === admin.user.username) return fail(res, 409, 'cannot_modify_self')
  target.passwordHash = hashPassword(password)
  target.authVersion += 1
  revokeSessions(state, target.id)
  target.updatedAt = now()
  // 重置口令的常见动机正是「账户被锁/凭据泄露」：同步清除该账户的失败桶，
  // 否则锁定会在整个窗口内持续，管理员也无从解除（与登录侧的桶语义配套）。
  if (state.failures) delete state.failures[`account:${target.username.toLowerCase()}`]
  appendAudit(state, { actorId: admin.user.id, action: 'admin.user.password', result: 'ok', ip: requestClientIp(req), change: { target: target.username, generated } })
  commitState(state)
  // 明文口令只在这一个响应里出现，之后服务端只有哈希
  send(res, 200, { ok: true, generated, password: generated ? password : null })
}

/** 删除账户：摘掉实例并按需清理数据目录。 */
async function handleAdminUserDelete(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  if (!requireCsrf(admin, req, res)) return
  const body = await readBody(req)
  const username = typeof body?.username === 'string' ? body.username : ''
  const target = state.users.find((u) => u.username === username)
  if (!target) return fail(res, 404, 'not_found')
  if (target.id === admin.user.id) return fail(res, 409, 'cannot_modify_self')
  if (target.role === 'root' && activeRootCount(state) <= 1) return fail(res, 409, 'last_admin')
  let instanceRemoved = true
  // purge 未被要求、或编排服务清理失败时，数据卷可能仍在磁盘上。这种 uid 绝不能被
  // 立即重新分配给下一个注册者，否则新账户会继承前一账户的 workspace 与 home
  // （审计复现：注册 B 得到同一 uid 与同一实例名，直接读到 A 的文件）。这里记入墓碑，
  // allocateUid 会跳过它。
  const purging = body?.purge === true
  if (Number.isInteger(target.uid)) {
    // 实例清理失败不阻断账号删除：封禁账号是管理动作，不能因为编排服务故障就做不了。
    // 但必须如实回报并留痕，否则会留下「账号已删、数据目录仍在」的孤儿数据而无人知晓。
    const result = await callInstances('/instances/delete', { uid: target.uid, purge: purging })
    instanceRemoved = result.ok
  }
  const dataMayRemain = Number.isInteger(target.uid) && (!purging || !instanceRemoved)
  if (dataMayRemain) retainUid(state, target.uid, target.username)
  revokeSessions(state, target.id)
  state.users = state.users.filter((u) => u.id !== target.id)
  appendAudit(state, {
    actorId: admin.user.id,
    action: 'admin.user.delete',
    result: instanceRemoved ? 'ok' : 'instance_cleanup_failed',
    ip: requestClientIp(req),
    change: {
      target: target.username,
      purge: purging,
      uid: target.uid ?? null,
      uidRetained: dataMayRemain,
    },
  })
  commitState(state)
  // 账户已从列表移除：授权表必须同步，否则被删账户的实例令牌仍会被 broker 认作有效。
  await syncBrokerGrants(state)
  send(res, 200, { ok: true, instanceRemoved, uidRetained: dataMayRemain })
}

/**
 * 记下「这个 uid 的数据可能还在磁盘上」，使 allocateUid 不再把它发给新账户。
 *
 * 保留而非释放是刻意的：数据是否真的清干净只有编排服务知道，而删账户这个动作本身
 * 由管理员发起、失败也不该阻断。把 uid 永久保留比冒一次数据继承的风险小得多，
 * 且墓碑数量受账户删除次数约束（不是攻击者可无界放大的量）。
 * @param {object} state 状态文档。
 * @param {number} uid 被占用的 uid。
 * @param {string} username 便于运维辨认。
 */
function retainUid(state, uid, username) {
  state.retainedUids = Array.isArray(state.retainedUids) ? state.retainedUids : []
  if (!state.retainedUids.some((entry) => entry?.uid === uid)) {
    state.retainedUids.push({ uid, username, at: now() })
  }
}

/** 审计查询：倒序返回，支持按动作过滤与条数上限。 */
function handleAdminAudit(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  const url = new URL(req.url ?? '/', 'http://localhost')
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200), 1), 2000)
  const action = url.searchParams.get('action') ?? ''
  const entries = [...(state.audit ?? [])].reverse()
  const filtered = action ? entries.filter((entry) => String(entry.action).includes(action)) : entries
  send(res, 200, { ok: true, total: entries.length, entries: filtered.slice(0, limit) })
}

/** 实例与水位视图：直接取自编排服务，认证网关不缓存。 */
async function handleAdminInstances(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  const result = await callInstances('/status')
  if (!result.ok) return fail(res, 502, 'instances_unavailable')
  send(res, 200, { ok: true, ...result.body })
}

/**
 * 改运行时设置（闲置阈值 / 每实例内存）。
 *
 * 编排服务是这些值的权威：它把设置写进自己的注册表并对新实例生效。网关只做
 * 转发与审计——面板的每次改动都要留痕，因为阈值直接影响「用户会不会被回收」。
 */
async function handleAdminInstancesSettings(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  if (!requireCsrf(admin, req, res)) return
  const body = await readBody(req)
  if (!body) return fail(res, 400, 'invalid_request')
  const result = await callInstances('/settings', body)
  if (!result.ok) {
    return fail(res, result.status === 400 ? 400 : 502, result.body?.code ?? 'instances_unavailable')
  }
  appendAudit(state, {
    actorId: admin.user.id,
    action: 'admin.instances.settings',
    result: 'ok',
    change: { idleTimeoutSeconds: result.body.settings?.idleTimeoutSeconds, memoryMb: result.body.settings?.memoryMb },
  })
  commitState(state)
  send(res, 200, { ok: true, ...result.body })
}

/** 固化 / 取消固化某个账户的实例容器（永久保留，回收策略跳过）。 */
async function handleAdminInstancePin(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  if (!requireCsrf(admin, req, res)) return
  const body = await readBody(req)
  const uid = Number(body?.uid)
  if (!Number.isInteger(uid) || uid < UID_BASE) return fail(res, 400, 'invalid_uid')
  const result = await callInstances('/instances/pin', { uid, pinned: body?.pinned === true })
  if (!result.ok) return fail(res, result.status === 404 ? 404 : 502, result.body?.code ?? 'instances_unavailable')
  const target = state.users.find((user) => user.uid === uid)
  appendAudit(state, {
    actorId: admin.user.id,
    action: 'admin.instance.pin',
    result: 'ok',
    change: { uid, pinned: result.body.pinned === true, username: target?.username ?? '' },
  })
  commitState(state)
  send(res, 200, { ok: true, uid, pinned: result.body.pinned === true })
}

/** 生成新的邀请码（仅邀请码门槛下有意义），旧码立即作废。 */
function handleAdminInvite(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  if (!requireCsrf(admin, req, res)) return
  const code = randomToken(16).replace(/[^A-Za-z0-9]/g, '').slice(0, 20).toUpperCase()
  state.tokens = { ...(state.tokens ?? {}), inviteCode: code }
  appendAudit(state, { actorId: admin.user.id, action: 'admin.invite.rotate', result: 'ok' })
  commitState(state)
  send(res, 200, { ok: true, inviteCode: code })
}

/** 读取注册策略（两个开关 + 当前邀请码）。 */
function handleAdminRegistration(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  send(res, 200, {
    ok: true,
    registrationOpen: state.setup.registrationOpen !== false,
    inviteRequired: state.setup.inviteRequired === true,
    // 邀请码只在「开放注册且要求邀请码」时有意义；其它组合下不暴露，避免误以为它生效
    inviteCode: state.setup.registrationOpen !== false && state.setup.inviteRequired === true
      ? (state.tokens?.inviteCode ?? '')
      : '',
  })
}

/**
 * 改注册策略。
 *
 * 两个开关互相独立（对齐 cloud-mail 的 register + regKey）：关闭注册后是否要求邀请码
 * 已经没有意义，但保留其值——重新开放时不该丢掉管理员之前的设置。
 */
async function handleAdminRegistrationUpdate(state, req, res) {
  const admin = requireRoot(state, req, res)
  if (!admin) return
  if (!requireCsrf(admin, req, res)) return
  const body = await readBody(req)
  if (!body) return fail(res, 400, 'invalid_request')
  const changes = {}
  if (body.registrationOpen !== undefined) {
    const next = body.registrationOpen === true
    if (next !== (state.setup.registrationOpen !== false)) changes.registrationOpen = next
    state.setup.registrationOpen = next
  }
  if (body.inviteRequired !== undefined) {
    const next = body.inviteRequired === true
    if (next !== (state.setup.inviteRequired === true)) changes.inviteRequired = next
    state.setup.inviteRequired = next
  }
  // 开放注册 + 要求邀请码，但没有可用码 → 立刻补发一个，否则没人能注册
  let issued = ''
  if (state.setup.registrationOpen !== false && state.setup.inviteRequired === true && !state.tokens?.inviteCode) {
    issued = randomToken(16).replace(/[^A-Za-z0-9]/g, '').slice(0, 20).toUpperCase()
    state.tokens = { ...(state.tokens ?? {}), inviteCode: issued }
  }
  appendAudit(state, { actorId: admin.user.id, action: 'admin.registration.update', result: 'ok', change: changes })
  commitState(state)
  send(res, 200, {
    ok: true,
    registrationOpen: state.setup.registrationOpen !== false,
    inviteRequired: state.setup.inviteRequired === true,
    inviteCode: state.setup.registrationOpen !== false && state.setup.inviteRequired === true
      ? (state.tokens?.inviteCode ?? '')
      : '',
  })
}

// ---------------------------------------------------------------- passkey

/** 当前部署的 passkey 能力：必须配置了合法 HTTPS origin 且请求本身是安全上下文。 */
function passkeyContext(req) {
  const resolved = resolveOrigin(CONFIG.publicOrigin, req.headers)
  if (!resolved) return null
  if (!isHttps(req)) return null
  return resolved
}

function findCredentialOwner(state, credentialId) {
  for (const user of state.users) {
    const entry = (user.passkeys ?? []).find((p) => p.id === credentialId)
    if (entry) return { user, entry }
  }
  return null
}

/**
 * 注册第一步：签发带 challenge 的一次性流程。
 *
 * 需已登录 + CSRF + **当前密码**：新增通行密钥是改凭据，必须与删除通行密钥
 * （:1623 附近）、开通 TOTP、关闭 TOTP、改口令一样要求再认证。仅凭会话就登记的话，
 * 被盗的会话 Cookie 能换成一个永久第二因素，而且它能挺过口令修改（改密只递增
 * authVersion 并撤销会话，不清空 passkeys）。
 */
async function handlePasskeyRegisterBegin(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  if (!requireCsrf(resolved, req, res)) return
  const ctx = passkeyContext(req)
  if (!ctx) return fail(res, 409, 'passkey_unavailable')
  const body = await readBody(req)
  if (!body || typeof body.currentPassword !== 'string') return fail(res, 400, 'invalid_request')
  if (!verifyPassword(body.currentPassword, resolved.user.passwordHash)) {
    appendAudit(state, { actorId: resolved.user.id, action: 'passkey.register', result: 'failure' })
    commitState(state)
    return fail(res, 401, 'invalid_credentials')
  }
  if ((resolved.user.passkeys ?? []).length >= MAX_PASSKEYS_PER_USER) return fail(res, 409, 'passkey_limit')
  const options = await beginRegistration({
    user: { id: resolved.user.id, username: resolved.user.username },
    excludeCredentials: (resolved.user.passkeys ?? []).map((p) => ({ credentialID: p.id, transports: p.transports })),
    rpId: ctx.rpId,
    rpName: 'DeepSeek Harness',
  })
  const challenge = createFlow(state, 'passkey_register', resolved.user.id, options.challenge)
  commitState(state)
  send(res, 200, { ok: true, publicKey: options, challenge, expiresInSeconds: Math.floor(PASSKEY_TTL_MS / 1000) })
}

/** 注册第二步：验签并落凭据。 */
async function handlePasskeyRegisterFinish(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  if (!requireCsrf(resolved, req, res)) return
  const ctx = passkeyContext(req)
  if (!ctx) return fail(res, 409, 'passkey_unavailable')
  const body = await readBody(req)
  if (!body || typeof body.challenge !== 'string' || typeof body.name !== 'string' || !body.response) {
    return fail(res, 400, 'invalid_request')
  }
  const name = body.name.trim()
  if (name.length === 0 || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) return fail(res, 400, 'invalid_name')
  const flow = consumeFlow(state, 'passkey_register', body.challenge)
  if (!flow || flow.userId !== resolved.user.id) return fail(res, 401, 'invalid_challenge')
  const result = await finishRegistration({
    response: body.response,
    expectedChallenge: flow.payload,
    expectedOrigin: ctx.origin,
    expectedRPID: ctx.rpId,
  })
  if (!result.ok) {
    appendAudit(state, { actorId: resolved.user.id, action: 'passkey.register', result: 'failure' })
    commitState(state)
    return fail(res, 401, 'passkey_failed')
  }
  if (findCredentialOwner(state, result.credential.id)) {
    appendAudit(state, { actorId: resolved.user.id, action: 'passkey.register', result: 'duplicate' })
    commitState(state)
    return fail(res, 409, 'passkey_duplicate')
  }
  resolved.user.passkeys = [
    ...(resolved.user.passkeys ?? []),
    {
      id: result.credential.id,
      publicKey: result.credential.publicKey,
      counter: result.counter,
      transports: result.credential.transports,
      rpId: ctx.rpId,
      name,
      deviceType: result.deviceType,
      backedUp: result.backedUp,
      createdAt: now(),
      lastUsedAt: null,
    },
  ]
  resolved.user.updatedAt = now()
  // 不递增 authVersion：级联会让「刚输过密码、正当在用」的会话一并失效，用户加完
  // 通行密钥就被登出。安全收益来自 begin 阶段的密码再认证（没有密码就无法登记），
  // 而不是踢掉现有会话——能走到这一步的会话本身就是密码证明过的。
  appendAudit(state, { actorId: resolved.user.id, action: 'passkey.register', result: 'ok', change: { name, deviceType: result.deviceType } })
  commitState(state)
  send(res, 200, { ok: true, id: result.credential.id })
}

/** 登录第一步：有用户名则限定凭据，否则走可发现凭据（无需先输用户名）。 */
async function handlePasskeyLoginBegin(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const ctx = passkeyContext(req)
  if (!ctx) return fail(res, 409, 'passkey_unavailable')
  const body = await readBody(req)
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : ''
  const user = username ? state.users.find((u) => u.username.toLowerCase() === username && u.status === 'enabled') : null
  // 用户枚举防护：用户名不存在时也签发一个不带 allowCredentials 的选项，响应形态一致
  const allowCredentials = (user?.passkeys ?? []).map((p) => ({ credentialID: p.id, transports: p.transports }))
  const options = await beginAuthentication({ allowCredentials, rpId: ctx.rpId })
  const challenge = createFlow(state, 'passkey_login', user?.id ?? '', options.challenge)
  commitState(state)
  send(res, 200, { ok: true, publicKey: options, challenge })
}

/** 登录第二步：定位凭据 → 验签 → 建会话（若开了 TOTP 仍需第二因子）。 */
async function handlePasskeyLoginFinish(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const ctx = passkeyContext(req)
  if (!ctx) return fail(res, 409, 'passkey_unavailable')
  const body = await readBody(req)
  if (!body || typeof body.challenge !== 'string' || !body.response) return fail(res, 400, 'invalid_request')
  const credentialId = typeof body.response.id === 'string' ? body.response.id : ''
  const found = findCredentialOwner(state, credentialId)
  const flow = consumeFlow(state, 'passkey_login', body.challenge)
  if (!flow) return fail(res, 401, 'invalid_challenge')
  if (!found || found.user.status !== 'enabled') {
    appendAudit(state, { action: 'login.passkey', result: 'failure', ip: requestClientIp(req) })
    commitState(state)
    return fail(res, 401, 'invalid_credentials')
  }
  // passkey 必须属于签发该 challenge 的账户（防止拿 A 的挑战配 B 的凭据）
  if (flow.userId && flow.userId !== found.user.id) return fail(res, 401, 'invalid_credentials')
  const result = await finishAuthentication({
    response: body.response,
    expectedChallenge: flow.payload,
    expectedOrigin: ctx.origin,
    expectedRPID: ctx.rpId,
    credential: found.entry,
  })
  if (!result.ok) {
    appendAudit(state, { actorId: found.user.id, action: 'login.passkey', result: 'failure', change: { reason: result.reason } })
    commitState(state)
    return fail(res, 401, 'invalid_credentials')
  }
  // 计数器只增不减；多设备凭据允许为 0（不支持计数的认证器）
  found.entry.counter = Math.max(found.entry.counter, result.newCounter ?? 0)
  found.entry.lastUsedAt = now()
  found.entry.deviceType = result.deviceType ?? found.entry.deviceType
  found.entry.backedUp = result.backedUp ?? found.entry.backedUp

  // 已启用 TOTP 的账户：passkey 只是第一因子，仍需第二因子
  if (found.user.totp?.enabled) {
    const challenge = createFlow(state, 'totp_login', found.user.id)
    appendAudit(state, { actorId: found.user.id, action: 'login.passkey', result: 'second_factor_required' })
    commitState(state)
    return send(res, 200, { ok: true, secondFactor: { challenge, method: 'totp' } })
  }

  await completeLogin(state, found.user, req, res, { secondFactor: 'passkey' })
}

/** 列出当前账户的 passkey（不含公钥等内部材料）。 */
function handlePasskeyList(state, req, res) {
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  send(res, 200, {
    ok: true,
    passkeys: (resolved.user.passkeys ?? []).map((p) => ({
      id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, deviceType: p.deviceType, backedUp: p.backedUp,
    })),
  })
}

/** 删除 passkey：安全降级操作，需密码 + CSRF 重新认证。 */
async function handlePasskeyDelete(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  if (!requireCsrf(resolved, req, res)) return
  const body = await readBody(req)
  if (!body || typeof body.id !== 'string' || typeof body.currentPassword !== 'string') return fail(res, 400, 'invalid_request')
  if (!verifyPassword(body.currentPassword, resolved.user.passwordHash)) {
    appendAudit(state, { actorId: resolved.user.id, action: 'passkey.delete', result: 'failure' })
    commitState(state)
    return fail(res, 401, 'invalid_credentials')
  }
  const before = (resolved.user.passkeys ?? []).length
  resolved.user.passkeys = (resolved.user.passkeys ?? []).filter((p) => p.id !== body.id)
  if (resolved.user.passkeys.length === before) return fail(res, 404, 'passkey_not_found')
  resolved.user.updatedAt = now()
  appendAudit(state, { actorId: resolved.user.id, action: 'passkey.delete', result: 'ok' })
  commitState(state)
  send(res, 200, { ok: true })
}

// ---------------------------------------------------------------- routes

async function handleLogin(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const body = await readBody(req)
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
    return fail(res, 400, 'invalid_request')
  }
  const { ipKey, accountKey } = loginKeys(requestClientIp(req), body.username, { trustedProxiesResolved: sourceDistinguishable() })
  const at = now()
  state.failures = state.failures ?? {}
  const ipBucket = evaluateFailureBucket(state.failures[ipKey], at, CONFIG.loginWindowMs, CONFIG.maxLoginFailures)
  const accountBucket = evaluateFailureBucket(state.failures[accountKey], at, CONFIG.loginWindowMs, CONFIG.maxLoginFailures)
  if (!ipBucket.allowed || !accountBucket.allowed) {
    // 被拒的请求不写回任何桶：调用者提供的用户名可以任意捏造，若在门禁前就落键，
    // 每个不同的用户名都会在状态库里留下一个空桶（审计实测 1000 请求 → 1250 个键，
    // 且每次写入都要重新序列化整份文档）。旧时间戳的过期由 prune 兜底。
    const retryAfter = Math.ceil(Math.max(ipBucket.retryAfterMs, accountBucket.retryAfterMs) / 1000)
    appendAudit(state, { action: 'login', result: 'rate_limited', ip: requestClientIp(req), change: { account: accountKey, blockedBy: !ipBucket.allowed ? 'ip' : 'account' } })
    commitState(state)
    return fail(res, 429, 'rate_limited', { retryAfter })
  }
  // 通过门禁才写回裁剪后的桶（把过期时间戳挤掉）。
  // ipKey 为空表示来源不可区分：此时故意不写 IP 桶——写进去就是一个全局可耗尽的桶，
  // 任一调用者都能用它锁死全站登录。宁可不设 IP 维度，只保留按账户的桶。
  if (ipKey) state.failures[ipKey] = ipBucket.kept
  state.failures[accountKey] = accountBucket.kept

  // 人机验证排在密码比对之前：让自动化在消耗一次 Argon2id 之前就被挡住
  const captcha = await enforceCaptcha(state, req, body, 'login')
  if (!captcha.ok) return fail(res, 403, captcha.code, captcha.reason ? { reason: captcha.reason } : undefined)

  const user = state.users.find((u) => u.username.toLowerCase() === body.username.trim().toLowerCase())
  const hash = user?.passwordHash ?? CONFIG.dummyHash
  const ok = verifyPassword(body.password, hash) && Boolean(user) && user.status === 'enabled'

  if (!ok) {
    if (ipKey) state.failures[ipKey] = [...ipBucket.kept, at]
    state.failures[accountKey] = [...accountBucket.kept, at]
    appendAudit(state, { action: 'login', result: 'failure', ip: requestClientIp(req), change: { account: accountKey } })
    commitState(state)
    return fail(res, 401, 'invalid_credentials')
  }

  // 只清除该账户自己的失败桶。绝不删除 ipKey：它被「同一来源对其他账户的全部尝试」
  // 共享，删掉它等于让任一账户的持有者随时续期自己的尝试额度，进而逐个把其他账户
  // 的账户桶钉在上限（审计复现：12/12 账户被锁死且管理员重置无法解除）。
  delete state.failures[accountKey]

  // 密码因子通过。若已启用 TOTP，则签发一次性挑战，等第二因子再建会话。
  if (user.totp?.enabled) {
    const challenge = createFlow(state, 'totp_login', user.id)
    appendAudit(state, { actorId: user.id, action: 'login', result: 'second_factor_required', ip: requestClientIp(req) })
    commitState(state)
    return send(res, 200, { ok: true, secondFactor: { challenge, method: 'totp' } })
  }

  await completeLogin(state, user, req, res)
}

function handleLogout(state, req, res) {
  const token = cookies(req)[SESSION_COOKIE]
  if (token) {
    const digest = tokenDigest(token)
    const before = state.sessions.length
    state.sessions = state.sessions.filter((s) => !constantTimeEqual(s.tokenHash, digest))
    if (state.sessions.length !== before) commitState(state)
  }
  send(res, 200, { ok: true }, { 'set-cookie': clearedCookies(req) })
}

function handleSession(state, req, res) {
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  send(res, 200, { ok: true, user: publicUser(resolved.user) })
}

function handleChangePassword(state, req, res) {
  if (!sameOrigin(req.headers)) return fail(res, 403, 'origin_mismatch')
  const resolved = requireSession(state, req, res)
  if (!resolved) return
  if (!requireCsrf(resolved, req, res)) return
  readBody(req).then((body) => {
    if (!body || typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
      return fail(res, 400, 'invalid_request')
    }
    if (!verifyPassword(body.currentPassword, resolved.user.passwordHash)) {
      appendAudit(state, { actorId: resolved.user.id, action: 'password.change', result: 'failure' })
      commitState(state)
      return fail(res, 401, 'invalid_credentials')
    }
    if (constantTimeEqual(body.currentPassword, body.newPassword)) return fail(res, 400, 'password_unchanged')
    const weak = validatePassword(body.newPassword)
    if (weak) return fail(res, 400, 'weak_password', { reason: weak })
    resolved.user.passwordHash = hashPassword(body.newPassword)
    // auth_version 级联：改密即让该用户全部旧会话失效（new-api UserSession 同款）
    resolved.user.authVersion += 1
    resolved.user.updatedAt = now()
    state.sessions = state.sessions.filter((s) => s.userId !== resolved.user.id)
    appendAudit(state, { actorId: resolved.user.id, action: 'password.change', result: 'ok' })
    commitState(state)
    send(res, 200, { ok: true }, { 'set-cookie': clearedCookies(req) })
  })
}

/**
 * nginx auth_request 判定端。204 表示放行（响应头带上身份，供 nginx 路由）；
 * 401 表示需登录。**不增删任何状态**：不建会话、不销毁会话、不改权限（威胁 T4）；
 * 唯一的写入是把已认证会话的活动时间按节流间隔落盘，边界写在函数内。
 *
 * 进程内还要求入口共享密钥（配置了 DSH_AUTH_INGRESS_TOKEN 时）：nginx 的
 * internal 只约束「经由入口的请求」，网关与别的容器共享网络时，直连 8091 的
 * 调用者同样能凭会话 Cookie 换出身份头。审计实测从用户实例直连得到 204 与
 * 四个身份头；带上这道校验后，只有持有密钥的入口才能调用本端点。
 */
function handleVerify(state, req, res) {
  if (CONFIG.ingressToken.length > 0) {
    const presented = typeof req.headers['x-dsh-ingress-token'] === 'string' ? req.headers['x-dsh-ingress-token'] : ''
    if (!constantTimeEqual(presented, CONFIG.ingressToken)) {
      res.writeHead(401, { 'content-length': '0' })
      return res.end()
    }
  }
  const resolved = resolveSession(state, req)
  if (!resolved) {
    res.writeHead(401, { 'content-length': '0' })
    return res.end()
  }
  const at = now()
  // 节流的基准是**这个会话在磁盘上的活动时间**，而不是"进程上次落盘的时刻"：
  // 用进程级节流时，入口自身的流量会占满窗口，于是某个会话可能要等满一整个窗口才轮到
  // 自己落盘——用户越活跃反而越容易被判闲置。按会话节流则每个活跃会话至多每窗口写一次，
  // 且写入次数只与"活跃会话数 ÷ 窗口"有关，与页面资源数无关。
  const persistedAt = resolved.session.lastSeenAt
  resolved.session.lastSeenAt = at
  // 把活动时间落盘。prune 在每次 readState() 里跑，而 readState() 读的是**磁盘快照**：
  // 只改内存的话，这次判定滑动过的活动时间在下一个请求就被磁盘上的旧值覆盖，于是
  // 用户一直在用工作台（页面资源与轮询都只经过 verify）也会在闲置窗口到点后被登出，
  // 网关重启后同样如此。
  //
  // 这里对"判定端点只读"的约束是一次有界的例外，边界写清楚：
  //   * 只对已认证的会话写入，未登录请求一个字节都不写；
  //   * 按会话节流（见上），写入频率与请求数、资源数无关；
  //   * 并发冲突（别人先写过）直接放过——活动时间戳丢了无所谓，下一个请求会因为
  //     磁盘上的值仍然偏旧而重试，绝不能让落盘失败影响这次判定。
  if (at - persistedAt >= CONFIG.activityPersistIntervalMs) {
    try {
      commitState(state)
    } catch (error) {
      if (!(error instanceof StateConflictError)) throw error
    }
  }
  const instance = instanceFor(resolved.user)
  res.writeHead(204, {
    'x-dsh-user': resolved.user.username,
    'x-dsh-user-id': resolved.user.id,
    'x-dsh-role': resolved.user.role,
    // nginx 用它选择上游：每个账户转发到自己的实例，管理员转发到管理工作台
    ...(instance ? { 'x-dsh-instance': instance } : {}),
  })
  res.end()
}

function handleStatus(state, req, res) {
  send(res, 200, {
    ok: true,
    initialized: state.setup.initialized,
    multiUser: Boolean(state.setup.multiUser),
    registerGate: state.setup.registerGate ?? 'open',
    // 注册的两个独立开关：登录页据此决定是否显示注册入口、是否要求邀请码。
    registrationOpen: state.setup.registrationOpen !== false,
    inviteRequired: state.setup.inviteRequired === true,
    // 本地 http 部署时 passkey 不可用（WebAuthn 要求安全上下文），前端据此隐藏入口
    passkeyAvailable: Boolean(passkeyContext(req)),
    // 入口后面是否存在可进入的工作台。有工作台时登录后直接进去；
    // 单用户模式由部署方通过 DSH_AUTH_WORKSPACE=on 声明（多用户模式默认就有）。
    workspace: CONFIG.workspace,
    // 管理面只在多用户模式存在：一个人用的部署不需要用户管理面板。
    adminPanel: Boolean(state.setup.multiUser),
    // 登录/注册页据此渲染对应服务的人机验证控件。
    // siteKey 本就是公开值（它出现在页面 HTML 里），密钥永远不会出现在这里。
    captcha: (() => {
      const config = captchaConfig(state)
      return config.enabled ? { required: true, provider: config.provider, siteKey: config.siteKey } : { required: false }
    })(),
  })
}

function serveStatic(req, res, pathname) {
  // `/` 在真实部署里由 nginx 交给 DSH 工作台；这里只做本地直连时的兜底跳转。
  // 绝不能把登录页当成 `/` 的内容：登录页会在检测到已登录时跳回 `/`，两者互为终点
  // 就成了无限重定向（浏览器表现为页面狂闪）。
  if (pathname === '/') {
    res.writeHead(302, { location: '/login', 'cache-control': 'no-store', 'content-length': '0' })
    res.end()
    return
  }
  const name = pathname === '/login' || pathname === '/register' || pathname === '/waking' ? 'index.html'
    : pathname === '/admin' || pathname === '/admin/' ? 'admin.html'
      : pathname === '/account' || pathname === '/account/' ? 'account.html'
        : pathname.replace(/^\/+/, '')
  if (name.includes('..')) {
    res.writeHead(400).end()
    return
  }
  const file = path.join(CONFIG.webDir, name)
  let data
  try {
    data = fs.readFileSync(file)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(data)
}

const server = http.createServer(async (req, res) => {
  // 请求目标的解析放在 try 之内：畸形请求行（如 `GET http://[ HTTP/1.1`）会让
  // WHATWG URL 构造器抛 ERR_INVALID_URL，若在 async 监听器里逃逸到 unhandled
  // rejection，进程会直接退出，任一实例容器都能让全站登录瘫痪。
  let url
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    res.writeHead(400, { 'content-length': '0', connection: 'close' })
    return res.end()
  }
  const p = url.pathname
  let state
  try {
    state = readState()
  } catch (error) {
    // 状态文件损坏同样不可让进程退出：以 503 明确拒绝，等待运维介入。
    process.stderr.write(`[dsh-auth] state unreadable: ${error?.message ?? error}\n`)
    if (!res.headersSent) fail(res, 503, 'state_unavailable')
    else res.end()
    return
  }

  try {
    if (p.startsWith('/api/') || p.startsWith('/__dsh_auth/')) {
      if (req.method === 'GET' && p === '/api/auth/status') return handleStatus(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/login') return await handleLogin(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/register') {
        if (!state.setup.multiUser) return fail(res, 404, 'not_available')
        return await handleRegister(state, req, res)
      }
      if (req.method === 'POST' && p === '/api/auth/login/totp') return await handleTotpLogin(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/totp/setup') return await handleTotpSetup(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/totp/confirm') return await handleTotpConfirm(state, req, res)
  if (req.method === 'POST' && p === '/api/auth/totp/activate') return await handleTotpActivate(state, req, res)
  if (req.method === 'POST' && p === '/api/auth/totp/cancel') return await handleTotpCancel(state, req, res)
  if (req.method === 'POST' && p === '/api/auth/totp/recovery/regenerate') return await handleRecoveryRegenerate(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/totp/disable') return await handleTotpDisable(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/passkey/register/begin') return await handlePasskeyRegisterBegin(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/passkey/register/finish') return await handlePasskeyRegisterFinish(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/passkey/login/begin') return await handlePasskeyLoginBegin(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/passkey/login/finish') return await handlePasskeyLoginFinish(state, req, res)
      if (req.method === 'GET' && p === '/api/auth/passkeys') return handlePasskeyList(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/passkey/delete') return await handlePasskeyDelete(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/logout') return handleLogout(state, req, res)
      if (req.method === 'GET' && p === '/api/auth/session') return handleSession(state, req, res)
      if (req.method === 'GET' && p === '/api/auth/sessions') return handleSessions(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/sessions/revoke') return await handleSessionRevoke(state, req, res)
      if (req.method === 'GET' && p === '/api/auth/instance') return await handleInstanceState(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/instance/wake') return await handleInstanceWake(state, req, res)
      if (req.method === 'POST' && p === '/api/auth/password') return handleChangePassword(state, req, res)
      if (req.method === 'GET' && p === '/__dsh_auth/verify') return handleVerify(state, req, res)
      // 路由裁剪：单管理员模式不暴露注册与多用户管理面（威胁 T12 的攻击面收敛）
      // 管理面：仅 root 可达，且只部署在多用户模式
      if (p.startsWith('/api/admin/')) {
        if (!state.setup.multiUser) return fail(res, 404, 'not_available')
        if (req.method === 'GET' && p === '/api/admin/users') return handleAdminUsers(state, req, res)
        if (req.method === 'GET' && p === '/api/admin/audit') return handleAdminAudit(state, req, res)
        if (req.method === 'GET' && p === '/api/admin/instances') return await handleAdminInstances(state, req, res)
    if (req.method === 'POST' && p === '/api/admin/instances/settings') return await handleAdminInstancesSettings(state, req, res)
    if (req.method === 'POST' && p === '/api/admin/instances/pin') return await handleAdminInstancePin(state, req, res)
        if (req.method === 'POST' && p === '/api/admin/users/status') return await handleAdminUserStatus(state, req, res)
        if (req.method === 'POST' && p === '/api/admin/users/password') return await handleAdminUserPassword(state, req, res)
        if (req.method === 'POST' && p === '/api/admin/users/delete') return await handleAdminUserDelete(state, req, res)
        if (req.method === 'POST' && p === '/api/admin/invite') return handleAdminInvite(state, req, res)
    if (req.method === 'GET' && p === '/api/admin/registration') return handleAdminRegistration(state, req, res)
    if (req.method === 'POST' && p === '/api/admin/registration') return await handleAdminRegistrationUpdate(state, req, res)
        if (req.method === 'GET' && p === '/api/admin/model-access') return await handleAdminModelAccess(state, req, res)
        if (req.method === 'POST' && p === '/api/admin/model-access') return await handleAdminModelAccessUpdate(state, req, res)
        if (req.method === 'GET' && p === '/api/admin/captcha') return handleAdminCaptcha(state, req, res)
        if (req.method === 'POST' && p === '/api/admin/captcha') return await handleAdminCaptchaUpdate(state, req, res)
        return fail(res, 404, 'not_found')
      }
      return fail(res, 404, 'not_found')
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    // 管理面板的页面与它的接口保持同一套权限：
    //   * 单管理员模式：管理面不存在 → 404
    //   * 多用户模式：只有管理员能打开，其余人回工作台
    // 否则普通用户会拿到一个每个请求都失败的页面外壳。
    if (p === '/admin' || p === '/admin/' || p === '/admin/index.html') {
      if (!state.setup.multiUser) return fail(res, 404, 'not_available')
      const resolved = resolveSession(state, req)
      if (!resolved || resolved.user.role !== 'root') {
        res.writeHead(302, { location: '/', 'cache-control': 'no-store', 'content-length': '0' })
        return res.end()
      }
    }
    return serveStatic(req, res, p)
  } catch (error) {
    process.stderr.write(`[dsh-auth] request failed: ${error?.message ?? error}\n`)
    if (error instanceof StateConflictError) {
      // 快照过期（并发写入胜出）：明确告知可重试，绝不静默回退安全决策。
      if (!res.headersSent) fail(res, 409, 'state_conflict')
      else res.end()
      return
    }
    if (!res.headersSent) fail(res, 500, 'internal_error')
    else res.end()
  }
})

const [host, port] = CONFIG.listen.includes(':') ? CONFIG.listen.split(':') : ['0.0.0.0', CONFIG.listen]
// 可信代理解析放到后台：它要等 DNS，而网关必须立刻开始监听（它是入口 auth_request
// 的唯一后端）。解析完成前按「来源不可区分」处理，即不设 IP 维度。
// 出错只记日志：解析失败的正确行为已经由 resolveTrustedProxies 内部处理（保持未解析），
// 这里再兜一层是为了不让任何意外变成未处理的拒绝。
resolveTrustedProxies().catch((error) => {
  process.stderr.write(`[dsh-auth] trusted proxy resolution failed: ${error?.stack ?? error}\n`)
})
const initial = freshState()
bootstrap(initial)
const configChanges = syncDeploymentConfig(freshState())
// 授权表是派生数据：启动时按当前账户重写一次，避免它与状态库脱节
await syncBrokerGrants(freshState())
server.listen(Number(port), host, () => {
  const users = store.read().users.length
  if (Object.keys(configChanges).length > 0) {
    process.stdout.write(`[dsh-auth] deployment config synced: ${JSON.stringify(configChanges)}\n`)
  }
  process.stdout.write(`[dsh-auth] listening on ${host}:${port} (users=${users}, multiUser=${CONFIG.multiUser})\n`)
})

// 兜底：任何遗漏的异步拒绝都不允许终止进程。网关是入口 auth_request 的唯一后端，
// 进程退出等于全站无法鉴权；记录后继续服务。
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[dsh-auth] unhandled rejection: ${reason?.stack ?? reason}\n`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
