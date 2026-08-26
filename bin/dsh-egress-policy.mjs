// DSH 出站白名单正向代理的策略层。
//
// 容器里的 DSH Agent 以 danger-full-access 运行，所以它的出站流量全部收敛到这个
// 正向代理上：网络侧只给容器留一条到代理的路，代理再按域名白名单决定放行。策略
// 单独放在这里，既能被代理进程引用，也能在宿主机上直接跑单元测试，不必起容器。
//
// 设计原则：默认拒绝。只认「域名白名单 + 固定端口集合」，任何绕开域名判定的写法
// 都必须挡在代理之外：IP 字面量（含 127.0.0.1、169.254.169.254、10/8、172.16/12、
// 192.168/16、::1、fd00::/8）、localhost 与本地/内网域名后缀、非 http(s) 的
// scheme、带凭据的 URL、空主机。否则 Agent 能借代理回打宿主机、云 metadata 服务
// 或同网段的内网服务，域名白名单也就形同虚设。

import dns from 'node:dns'
import net from 'node:net'

export class EgressPolicyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EgressPolicyError'
  }
}

// 默认白名单：只覆盖容器里确实要用的 Debian / npm / PyPI / GitHub / uv 生态。
// 想放行别的域名走 DSH_EGRESS_ALLOWED_HOSTS，不要往这里加通配。
export const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'deb.debian.org',
  'security.debian.org',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'pkg-containers.githubusercontent.com',
  'ghcr.io',
  'astral.sh',
  'nodejs.org',
])

// CONNECT 只放行 443：明文 80 端口的隧道没有正当用途，只会用来藏协议。
export const DEFAULT_CONNECT_PORTS = Object.freeze([443])
// 普通正向代理请求放行 80/443，apt 仍有相当多的镜像走 http。
export const DEFAULT_FORWARD_PORTS = Object.freeze([80, 443])

// 逐跳头必须在转发时剥掉：它们描述的是「这一段连接」，透传过去会让上游看到
// 代理凭据、或让 keep-alive / 分块编码的语义在两段连接之间错位。
export const HOP_BY_HOP_HEADERS = Object.freeze([
  'proxy-connection',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const HOP_BY_HOP_SET = new Set(HOP_BY_HOP_HEADERS)

// 单个域名标签：字母数字开头结尾，中间允许连字符，最长 63 字符。
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

// 指向本机或内网的保留名字。它们本来也不在白名单里，这里再兜一层，避免以后
// 有人往白名单里塞了 *.internal 之类的条目就把内网打开了。
const BLOCKED_HOST_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'instance-data',
])

const BLOCKED_HOST_SUFFIXES = Object.freeze([
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
])

// 统一小写、去掉两端空白、去掉 IPv6 字面量的方括号、归一化末尾点（`github.com.`
// 和 `github.com` 必须判成同一个主机，否则末尾点就是一条绕过白名单的路）。
export function normalizeHost(value) {
  if (typeof value !== 'string') return ''
  let host = value.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  while (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

// 端口归一化：只接受 1..65535 的十进制整数，其它一律返回 null 交给调用方兜底。
export function normalizePort(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > 65535) return null
    return value
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^[0-9]{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : null
}

export function isValidHostname(value) {
  const host = normalizeHost(value)
  if (!host || host.length > 253) return false
  if (net.isIP(host) !== 0) return false
  const labels = host.split('.')
  if (labels.some((label) => !HOST_LABEL.test(label))) return false
  // 末段全是数字的名字只可能是 IP 的变体（1.2.3.4、10.0.0.1、2130706433）。
  return !/^[0-9]+$/.test(labels[labels.length - 1])
}

function ipv4Scope(host) {
  const parts = host.split('.').map((part) => Number(part))
  const [a, b] = parts
  if (a === 127) return '环回地址'
  if (a === 10) return '私网地址'
  if (a === 172 && b >= 16 && b <= 31) return '私网地址'
  if (a === 192 && b === 168) return '私网地址'
  if (a === 169 && b === 254) return '链路本地地址，云 metadata 就在这一段'
  if (a === 100 && b >= 64 && b <= 127) return '运营商级 NAT 地址'
  if (a === 0) return '未指定地址'
  if (a >= 224) return '多播或保留地址'
  return '公网地址'
}

function ipv6Scope(host) {
  if (host === '::') return '未指定地址'
  if (host === '::1') return '环回地址'
  if (host.startsWith('::ffff:') || host.startsWith('::0.')) return 'IPv4 映射地址'
  const head = host.split(':')[0]
  if (/^fe[89ab]/.test(head)) return '链路本地地址'
  if (/^f[cd]/.test(head)) return '唯一本地地址'
  if (/^ff/.test(head)) return '多播地址'
  return '公网地址'
}

// 返回拒绝原因（中文一句话），可以访问则返回 null。原因字符串会进审计日志，
// 所以只允许包含主机名本身，不要把路径、query 或 header 拼进来。
export function describeBlockedAddress(value) {
  const host = normalizeHost(value)
  if (!host) return '缺少目标主机'
  if (net.isIPv4(host)) return `不允许直连 IPv4 字面量（${ipv4Scope(host)}）`
  if (net.isIPv6(host)) return `不允许直连 IPv6 字面量（${ipv6Scope(host)}）`
  if (BLOCKED_HOST_NAMES.has(host)) return '不允许访问本机或元数据保留名'
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return '不允许访问本地或内网域名后缀'
  }
  // 整数形式（2130706433）和十六进制形式（0x7f000001）都会被解析成 127.0.0.1。
  if (/^[0-9]+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) {
    return '不允许把整数或十六进制形式的地址当主机名'
  }
  if (!isValidHostname(host)) return '不是合法的主机名'
  return null
}

export function isBlockedAddress(value) {
  return describeBlockedAddress(value) !== null
}

function assertAllowListEntry(entry) {
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(2)
    if (suffix.includes('*')) {
      throw new EgressPolicyError(`白名单只允许最左边一级通配：${entry}`)
    }
    if (!suffix.includes('.')) {
      throw new EgressPolicyError(`通配白名单至少要写到二级域名：${entry}`)
    }
    const reason = describeBlockedAddress(suffix)
    if (reason) throw new EgressPolicyError(`不是合法的白名单条目：${entry}（${reason}）`)
    return entry
  }
  if (entry.includes('*')) {
    throw new EgressPolicyError(`通配只能写成 *.example.com 的形式：${entry}`)
  }
  const reason = describeBlockedAddress(entry)
  if (reason) throw new EgressPolicyError(`不是合法的白名单条目：${entry}（${reason}）`)
  return entry
}

// 解析逗号或空白分隔的字符串（也接受数组）：小写化、去空、去重、逐条校验。
// 空值回落到 fallback，解析结果为空则报错——宁可起不来，也不要跑成空白名单。
export function parseAllowList(value, fallback = DEFAULT_ALLOWED_HOSTS) {
  let items
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    items = Array.from(fallback ?? [])
  } else if (Array.isArray(value)) {
    items = value
  } else if (typeof value === 'string') {
    items = value.split(/[\s,]+/)
  } else {
    throw new EgressPolicyError('白名单必须是字符串或字符串数组')
  }

  const allowList = []
  const seen = new Set()
  for (const raw of items) {
    if (typeof raw !== 'string') throw new EgressPolicyError('白名单条目必须是字符串')
    const entry = normalizeHost(raw)
    if (!entry) continue
    assertAllowListEntry(entry)
    if (seen.has(entry)) continue
    seen.add(entry)
    allowList.push(entry)
  }
  if (allowList.length === 0) throw new EgressPolicyError('出站白名单不能为空')
  return allowList
}

// 端口集合解析：接受数字、数组、Set 或 "80,443" 这样的字符串。
export function parsePortSet(value, fallback = DEFAULT_FORWARD_PORTS) {
  let items
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    items = Array.from(fallback ?? [])
  } else if (typeof value === 'number') {
    items = [value]
  } else if (typeof value === 'string') {
    items = value.split(/[\s,]+/).filter((part) => part !== '')
  } else if (value && typeof value[Symbol.iterator] === 'function') {
    items = Array.from(value)
  } else {
    throw new EgressPolicyError('端口集合必须是数字、字符串或可迭代对象')
  }

  const ports = new Set()
  for (const raw of items) {
    const port = normalizePort(raw)
    if (port === null) throw new EgressPolicyError(`不是合法的端口：${String(raw)}`)
    ports.add(port)
  }
  if (ports.size === 0) throw new EgressPolicyError('允许端口集合不能为空')
  return ports
}

// 精确匹配或通配后缀匹配。`*.foo.com` 匹配 `a.foo.com`、`a.b.foo.com`，但不匹配
// `foo.com` 本身；比较的是 `.foo.com` 这个带点后缀，所以 `evilfoo.com` 这类后缀
// 混淆进不来。
export function isHostAllowed(host, allowList = DEFAULT_ALLOWED_HOSTS) {
  const target = normalizeHost(host)
  if (!target) return false
  const entries = typeof allowList === 'string' ? parseAllowList(allowList) : allowList
  if (!entries || typeof entries[Symbol.iterator] !== 'function') return false
  for (const raw of entries) {
    const entry = normalizeHost(raw)
    if (!entry) continue
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1)
      if (target.length > suffix.length && target.endsWith(suffix)) return true
      continue
    }
    if (target === entry) return true
  }
  return false
}

// 解析 `host[:port]`，含 IPv6 字面量 `[::1]:443`。端口缺失或不合法时用
// defaultPort，主机无法识别时返回空字符串，交给上面的地址检查去拒绝。
export function normalizeTarget(hostHeaderOrAuthority, defaultPort) {
  const fallbackPort = normalizePort(defaultPort) ?? 0
  const raw = typeof hostHeaderOrAuthority === 'string' ? hostHeaderOrAuthority.trim() : ''
  if (!raw) return { host: '', port: fallbackPort }

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return { host: '', port: fallbackPort }
    const host = normalizeHost(raw.slice(1, end))
    const rest = raw.slice(end + 1)
    if (rest === '') return { host, port: fallbackPort }
    if (!rest.startsWith(':')) return { host: '', port: fallbackPort }
    return { host, port: normalizePort(rest.slice(1)) ?? fallbackPort }
  }

  const colon = raw.indexOf(':')
  if (colon < 0) return { host: normalizeHost(raw), port: fallbackPort }
  // 多个冒号说明是没加方括号的 IPv6 字面量：整段当主机名，后面必然被拒。
  if (raw.indexOf(':', colon + 1) >= 0) return { host: normalizeHost(raw), port: fallbackPort }
  return {
    host: normalizeHost(raw.slice(0, colon)),
    port: normalizePort(raw.slice(colon + 1)) ?? fallbackPort,
  }
}

// 三道闸门的顺序固定：先地址形态（IP / localhost / 内网后缀），再端口，最后
// 域名白名单。这样审计日志里的拒绝原因总是最具体的那一条。
function assertTarget(action, host, port, allowList, allowedPorts, fallbackPorts) {
  const blocked = describeBlockedAddress(host)
  if (blocked) throw new EgressPolicyError(`拒绝 ${action} 目标 ${host || '(空)'}：${blocked}`)
  const ports = parsePortSet(allowedPorts, fallbackPorts)
  if (!ports.has(port)) {
    const allowed = Array.from(ports).sort((left, right) => left - right).join('/')
    throw new EgressPolicyError(`拒绝 ${action} 目标 ${host}:${port}：端口不在允许集合 ${allowed} 内`)
  }
  if (!isHostAllowed(host, allowList)) {
    throw new EgressPolicyError(`拒绝 ${action} 目标 ${host}:${port}：主机不在出站白名单内`)
  }
  return { host, port }
}

// CONNECT（HTTPS 隧道）目标校验。authority 里出现 /、\、?、#、@ 或空白都说明
// 对方在试探解析差异，直接拒绝，不去猜它想连哪里。
export function assertConnectTarget(
  authority,
  allowList = DEFAULT_ALLOWED_HOSTS,
  allowedPorts = DEFAULT_CONNECT_PORTS,
) {
  if (typeof authority !== 'string' || authority.trim() === '') {
    throw new EgressPolicyError('CONNECT 缺少目标 authority')
  }
  const raw = authority.trim()
  if (/[\s/\\?#@]/.test(raw)) {
    throw new EgressPolicyError(`CONNECT 目标格式不合法：${raw}`)
  }
  const { host, port } = normalizeTarget(raw, 443)
  if (!host) throw new EgressPolicyError(`CONNECT 目标格式不合法：${raw}`)
  return assertTarget('connect', host, port, allowList, allowedPorts, DEFAULT_CONNECT_PORTS)
}

// 普通 HTTP 正向代理请求（absolute-URI）校验。
//
// 这里的报错信息刻意不回显原始 URL：审计日志会记录拒绝原因，而路径和 query
// 里可能带令牌，落到 stdout 就等于把凭据写进日志。
export function assertForwardRequest(
  rawUrl,
  allowList = DEFAULT_ALLOWED_HOSTS,
  allowedPorts = DEFAULT_FORWARD_PORTS,
) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new EgressPolicyError('代理请求缺少目标 URL')
  }
  const raw = rawUrl.trim()
  if (raw.startsWith('/')) {
    throw new EgressPolicyError('正向代理只接受 absolute-URI 形式的请求')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new EgressPolicyError('目标 URL 无法解析')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressPolicyError(`不允许的 scheme：${url.protocol}（只放行 http/https）`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new EgressPolicyError('不允许带凭据的 URL（user:pass@host 会把凭据送出容器）')
  }
  const host = normalizeHost(url.hostname)
  if (!host) throw new EgressPolicyError('目标 URL 缺少主机')
  const defaultPort = url.protocol === 'https:' ? 443 : 80
  const port = url.port === '' ? defaultPort : normalizePort(url.port) ?? 0
  const target = assertTarget('http', host, port, allowList, allowedPorts, DEFAULT_FORWARD_PORTS)
  return { url, host: target.host, port: target.port }
}

// 逐跳头剥离：返回新对象，键统一小写，不改调用方传进来的 headers。
export function stripHopByHopHeaders(headers) {
  const result = {}
  if (!headers || typeof headers !== 'object') return result
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP_SET.has(name.toLowerCase())) continue
    result[name.toLowerCase()] = value
  }
  return result
}

// --- DNS rebinding 防护：白名单认域名，但域名可以被解析到内网 ---
//
// 上面那套闸门只看请求里写的主机名。攻击者控制一个在白名单里的域名（或能影响
// 容器的 DNS 应答）时，可以让 `objects.example.com` 解析到 127.0.0.1、
// 169.254.169.254 或 10.0.0.5，于是代理会老老实实地替他连内网。所以真正建连
// 之前还要再看一眼解析结果：只允许公网单播地址。
//
// 落地方式是给 net.connect / http.request 传自定义 lookup，而不是「先解析再用
// IP 连」——后者会自己制造 TOCTOU 窗口，也会破坏 TLS 的 SNI 与证书校验。

const PUBLIC_SCOPE = '公网地址'

// `::ffff:203.0.113.9` 这类 IPv4 映射地址要按内嵌的 IPv4 判定，否则
// `::ffff:127.0.0.1` 会因为「不是 IPv4 字面量」而漏过私网检查。
function unwrapIpv4Mapped(host) {
  const match = /^::ffff:((?:[0-9]{1,3}\.){3}[0-9]{1,3})$/.exec(host)
  if (match && net.isIPv4(match[1])) return match[1]
  return null
}

// 返回拒绝原因（中文一句话），可以连则返回 null。原因只含主机名与地址类别。
export function describeBlockedResolvedAddress(value) {
  const host = normalizeHost(value)
  if (!host) return '解析结果为空'
  const mapped = unwrapIpv4Mapped(host)
  if (mapped) {
    const scope = ipv4Scope(mapped)
    return scope === PUBLIC_SCOPE ? null : `解析到 IPv4 映射的${scope}`
  }
  if (net.isIPv4(host)) {
    const scope = ipv4Scope(host)
    return scope === PUBLIC_SCOPE ? null : `解析到${scope}`
  }
  if (net.isIPv6(host)) {
    const scope = ipv6Scope(host)
    return scope === PUBLIC_SCOPE ? null : `解析到${scope}`
  }
  return '解析结果不是 IP 地址'
}

export function isBlockedResolvedAddress(value) {
  return describeBlockedResolvedAddress(value) !== null
}

// 生成可以直接传给 net.connect({ lookup }) / http.request({ lookup }) 的解析器：
// 逐条过滤解析结果，全部被拒时返回带 EGRESSBLOCKED code 的错误（代理会把它变成
// 502 并记进审计日志）。lookupImpl 可注入，便于单测里模拟 DNS 应答。
export function createGuardedLookup(lookupImpl = dns.lookup) {
  return function guardedLookup(hostname, options, callback) {
    const opts = typeof options === 'object' && options !== null ? options : {}
    // 一律用 all:true 取全部应答：只看第一条的话，被拒的那条之后仍可能被重试到。
    lookupImpl(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) {
        callback(error)
        return
      }
      const entries = Array.isArray(addresses) ? addresses : []
      const safe = []
      let firstReason = null
      for (const entry of entries) {
        const address = typeof entry === 'string' ? entry : entry?.address
        const reason = describeBlockedResolvedAddress(address)
        if (reason) {
          if (!firstReason) firstReason = reason
          continue
        }
        safe.push({
          address: normalizeHost(address),
          family: typeof entry === 'string' ? (net.isIPv6(address) ? 6 : 4) : entry.family,
        })
      }
      if (safe.length === 0) {
        const detail = firstReason ?? '没有解析到可用的公网地址'
        const blocked = new Error(`拒绝连接 ${hostname}：${detail}`)
        blocked.code = 'EGRESSBLOCKED'
        callback(blocked)
        return
      }
      if (opts.all === true) {
        callback(null, safe)
        return
      }
      callback(null, safe[0].address, safe[0].family)
    })
  }
}
