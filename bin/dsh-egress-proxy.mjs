#!/usr/bin/env node
// DSH 出站白名单正向代理。
//
// 加固后的 dsh 容器不再直接出网：它只能把 HTTP(S) 流量交给这个独立容器，由这里
// 按域名白名单放行。只用 Node 内置模块（镜像里没有、也不装任何 npm 依赖），以非
// root 运行，不需要任何 capability。
//
// 两条转发路径：
//   * CONNECT  —— 纯 TCP 隧道，不做 TLS 中间人，容器里的证书链保持原样；
//   * absolute-URI 的普通 HTTP 请求 —— 逐跳头剥掉后透传。
// 相对路径的请求（GET /healthz、GET /status）留给探针，不会被当成转发目标。
//
// 审计日志一行一条 JSON 写 stdout，只记录时间、动作、目标 host:port、判定、状态
// 码、字节数和耗时：请求体、query 和任何 header 值都不落盘，否则日志本身就成了
// 凭据泄露面。

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import process from 'node:process'

import {
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_CONNECT_PORTS,
  DEFAULT_FORWARD_PORTS,
  parseAllowList,
  parsePortSet,
  assertConnectTarget,
  assertForwardRequest,
  createGuardedLookup,
  stripHopByHopHeaders,
} from './dsh-egress-policy.mjs'

const PROXY_AGENT = 'dsh-egress-proxy'


const STATUS_TEXT = new Map([
  [204, 'No Content'],
  [400, 'Bad Request'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [405, 'Method Not Allowed'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable'],
])

function readInt(name, fallback, { min, max }) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}..${max} 之间的整数，当前值：${raw}`)
  }
  return value
}

// 布尔开关：只认 1/true/yes/on，其余（含空串）一律为假。
function readBool(name, fallback = false) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const text = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  throw new Error(`${name} 只接受 1/0/true/false/yes/no/on/off，当前值：${raw}`)
}

function loadConfig() {
  const allowedPorts = process.env.DSH_EGRESS_ALLOWED_PORTS
  return {
    // 端口 0 只用于测试：内核分配端口，实际端口从启动日志里读。
    port: readInt('DSH_EGRESS_PORT', 3128, { min: 0, max: 65535 }),
    bind: (process.env.DSH_EGRESS_BIND || '0.0.0.0').trim(),
    allowList: parseAllowList(process.env.DSH_EGRESS_ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS),
    connectPorts: parsePortSet(allowedPorts, DEFAULT_CONNECT_PORTS),
    forwardPorts: parsePortSet(allowedPorts, DEFAULT_FORWARD_PORTS),
    connectTimeoutMs: readInt('DSH_EGRESS_CONNECT_TIMEOUT_MS', 30_000, { min: 1_000, max: 600_000 }),
    idleTimeoutMs: readInt('DSH_EGRESS_IDLE_TIMEOUT_MS', 300_000, { min: 1_000, max: 86_400_000 }),
    maxSockets: readInt('DSH_EGRESS_MAX_SOCKETS', 256, { min: 1, max: 65_535 }),
    // 关掉解析结果的公网校验。默认必须是 false：打开就等于放弃 DNS rebinding 防护。
    // 只有两种正当场合——冒烟测试要连回环上的假上游，或者白名单里确实是同网段的
    // 内网镜像源。两种情况都应当明确写在部署说明里。
    allowPrivateUpstream: readBool('DSH_EGRESS_ALLOW_PRIVATE_UPSTREAM', false),
  }
}

let config
try {
  config = loadConfig()
} catch (error) {
  process.stderr.write(`dsh-egress-proxy 配置错误：${error.message}\n`)
  // 78 = EX_CONFIG，和 sysexits 对齐，方便 Supervisor 区分「配置写错」和「跑挂了」。
  process.exit(78)
}

// 白名单只认域名，域名却可能被解析到内网（DNS rebinding）。所有上游连接默认都走这
// 个受控解析器：解析结果里只留公网单播地址，全被拒时抛 EGRESSBLOCKED。
// 显式放开时传 undefined，net/http 就退回自带的解析逻辑。
const guardedLookup = config.allowPrivateUpstream ? undefined : createGuardedLookup()
const stats = { active: 0, allowed: 0, denied: 0 }

function audit(entry) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
}

function elapsedMs(startedAt) {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n)
}

function auditTraffic({ action, target, decision, status, bytes, startedAt, reason }) {
  const entry = {
    action,
    target,
    decision,
    status,
    bytes,
    ms: elapsedMs(startedAt),
  }
  if (reason) entry.reason = reason
  audit(entry)
}

// 拒绝/失败时的响应体：一行中文说明，讲清被拒的主机名和原因，方便容器里的人
// 一眼看出是白名单挡的，而不是网络坏了。
function denyBody(message) {
  return Buffer.from(`${message}\n`, 'utf8')
}

function writeRawResponse(socket, status, message) {
  if (socket.destroyed) return
  const body = denyBody(message)
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_TEXT.get(status) ?? 'Error'}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${body.length}\r\n` +
      `Proxy-Agent: ${PROXY_AGENT}\r\n` +
      'Connection: close\r\n\r\n',
  )
  socket.end(body)
}

function writeErrorResponse(res, status, message) {
  if (res.headersSent || res.socket === null) {
    res.destroy()
    return 0
  }
  const body = denyBody(message)
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.length),
    'proxy-agent': PROXY_AGENT,
    connection: 'close',
  })
  res.end(body)
  return body.length
}

// 受控解析器拒绝时给 403 而不是 502：这不是「上游挂了」，而是策略挡下了一次指向
// 内网的解析结果，日志和响应体都要如实说清楚。
function upstreamFailureStatus(error) {
  return error && error.code === 'EGRESSBLOCKED' ? 403 : 502
}

function overLimit() {
  return stats.active > config.maxSockets
}

// --- 探针端点：走的是相对路径，不是转发目标，所以不进流量审计日志 ---
function handleLocalRequest(req, res) {
  const path = req.url.split('?')[0]
  if (path !== '/healthz' && path !== '/status') {
    writeErrorResponse(res, 404, `未知的本地端点：${path}（正向代理请求必须使用 absolute-URI）`)
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeErrorResponse(res, 405, `${path} 只接受 GET`)
    return
  }
  if (path === '/healthz') {
    res.writeHead(204, { 'proxy-agent': PROXY_AGENT })
    res.end()
    return
  }
  // /status 只暴露聚合量，不含任何目标地址明细。
  const body = Buffer.from(
    `${JSON.stringify({
      status: 'ok',
      allowedHosts: config.allowList.length,
      connectPorts: Array.from(config.connectPorts).sort((left, right) => left - right),
      httpPorts: Array.from(config.forwardPorts).sort((left, right) => left - right),
      maxSockets: config.maxSockets,
      resolvedAddressGuard: guardedLookup ? 'on' : 'off',
      activeConnections: stats.active,
      allowedCount: stats.allowed,
      deniedCount: stats.denied,
      uptimeSeconds: Math.round(process.uptime()),
    })}\n`,
    'utf8',
  )
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'proxy-agent': PROXY_AGENT,
  })
  res.end(body)
}

// --- 普通 HTTP 正向代理 ---
function handleRequest(req, res) {
  const startedAt = process.hrtime.bigint()
  req.on('error', () => res.destroy())

  if (typeof req.url === 'string' && req.url.startsWith('/')) {
    handleLocalRequest(req, res)
    return
  }

  let target
  try {
    target = assertForwardRequest(req.url, config.allowList, config.forwardPorts)
  } catch (error) {
    stats.denied += 1
    const bytes = writeErrorResponse(res, 403, error.message)
    auditTraffic({
      action: 'http',
      target: '-',
      decision: 'deny',
      status: 403,
      bytes,
      startedAt,
      reason: error.message,
    })
    return
  }

  const label = `${target.host}:${target.port}`
  if (overLimit()) {
    stats.denied += 1
    const bytes = writeErrorResponse(res, 503, `代理并发连接数已达上限 ${config.maxSockets}，请稍后重试`)
    auditTraffic({
      action: 'http',
      target: label,
      decision: 'deny',
      status: 503,
      bytes,
      startedAt,
      reason: '并发上限',
    })
    return
  }

  const headers = stripHopByHopHeaders(req.headers)
  const isDefaultPort =
    (target.url.protocol === 'https:' && target.port === 443) ||
    (target.url.protocol === 'http:' && target.port === 80)
  headers.host = isDefaultPort ? target.host : label
  // 不做上游连接复用：一次请求一条上游连接，省掉连接池的状态串味风险。
  headers.connection = 'close'

  const client = target.url.protocol === 'https:' ? https : http
  const upstream = client.request({
    protocol: target.url.protocol,
    hostname: target.host,
    port: target.port,
    method: req.method,
    path: `${target.url.pathname}${target.url.search}`,
    headers,
    agent: false,
    lookup: guardedLookup,
  })

  let bytes = 0
  let settled = false
  const settle = (decision, status, reason) => {
    if (settled) return
    settled = true
    if (decision === 'allow') stats.allowed += 1
    else stats.denied += 1
    auditTraffic({ action: 'http', target: label, decision, status, bytes, startedAt, reason })
  }

  upstream.setTimeout(config.connectTimeoutMs, () => {
    upstream.destroy(new Error(`连接上游超时（${config.connectTimeoutMs}ms）`))
  })

  upstream.on('response', (upstreamRes) => {
    // 建连成功后把超时放宽到空闲超时，长下载不会被连接超时打断。
    upstream.setTimeout(config.idleTimeoutMs, () => {
      upstream.destroy(new Error(`上游空闲超时（${config.idleTimeoutMs}ms）`))
    })
    const responseHeaders = stripHopByHopHeaders(upstreamRes.headers)
    responseHeaders['proxy-agent'] = PROXY_AGENT
    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
    upstreamRes.on('data', (chunk) => {
      bytes += chunk.length
    })
    upstreamRes.on('end', () => settle('allow', upstreamRes.statusCode ?? 502))
    upstreamRes.on('error', () => {
      res.destroy()
      settle('allow', upstreamRes.statusCode ?? 502, '上游响应中断')
    })
    upstreamRes.pipe(res)
  })

  upstream.on('error', (error) => {
    const status = upstreamFailureStatus(error)
    const written = writeErrorResponse(res, status, `访问 ${label} 失败：${error.message}`)
    settle('deny', status, error.message)
    bytes += written
  })

  res.on('close', () => {
    if (!settled) {
      upstream.destroy()
      settle('allow', res.statusCode ?? 0, '客户端提前断开')
    }
  })

  req.pipe(upstream)
}

// --- CONNECT 隧道 ---
function handleConnect(req, clientSocket, head) {
  const startedAt = process.hrtime.bigint()
  clientSocket.on('error', () => clientSocket.destroy())

  if (overLimit()) {
    stats.denied += 1
    writeRawResponse(clientSocket, 503, `代理并发连接数已达上限 ${config.maxSockets}，请稍后重试`)
    auditTraffic({
      action: 'connect',
      target: '-',
      decision: 'deny',
      status: 503,
      bytes: 0,
      startedAt,
      reason: '并发上限',
    })
    return
  }

  let target
  try {
    target = assertConnectTarget(req.url, config.allowList, config.connectPorts)
  } catch (error) {
    stats.denied += 1
    writeRawResponse(clientSocket, 403, error.message)
    auditTraffic({
      action: 'connect',
      target: '-',
      decision: 'deny',
      status: 403,
      bytes: 0,
      startedAt,
      reason: error.message,
    })
    return
  }

  const label = `${target.host}:${target.port}`
  const upstream = net.connect({ host: target.host, port: target.port, lookup: guardedLookup })
  let bytes = 0
  let established = false
  let settled = false
  const settle = (decision, status, reason) => {
    if (settled) return
    settled = true
    if (decision === 'allow') stats.allowed += 1
    else stats.denied += 1
    auditTraffic({ action: 'connect', target: label, decision, status, bytes, startedAt, reason })
  }

  const connectTimer = setTimeout(() => {
    if (!established) upstream.destroy(new Error(`连接上游超时（${config.connectTimeoutMs}ms）`))
  }, config.connectTimeoutMs)

  upstream.on('connect', () => {
    established = true
    clearTimeout(connectTimer)
    upstream.setTimeout(config.idleTimeoutMs)
    clientSocket.setTimeout(config.idleTimeoutMs)
    upstream.on('timeout', () => upstream.destroy())
    clientSocket.on('timeout', () => clientSocket.destroy())
    clientSocket.write(
      `HTTP/1.1 200 Connection Established\r\nProxy-Agent: ${PROXY_AGENT}\r\n\r\n`,
    )
    if (head && head.length > 0) upstream.write(head)
    // 纯字节转发：两个方向都只统计字节数，内容不看也不记。
    upstream.on('data', (chunk) => {
      bytes += chunk.length
    })
    clientSocket.on('data', (chunk) => {
      bytes += chunk.length
    })
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })

  upstream.on('error', (error) => {
    clearTimeout(connectTimer)
    if (established) {
      clientSocket.destroy()
      settle('allow', 200, `隧道中断：${error.message}`)
      return
    }
    const status = upstreamFailureStatus(error)
    writeRawResponse(clientSocket, status, `连接 ${label} 失败：${error.message}`)
    settle('deny', status, error.message)
  })

  upstream.on('close', () => {
    clearTimeout(connectTimer)
    clientSocket.end()
    if (established) settle('allow', 200)
  })

  clientSocket.on('close', () => {
    upstream.destroy()
    if (!established) settle('deny', 0, '客户端提前断开')
  })
}

const server = http.createServer()
server.on('connection', (socket) => {
  stats.active += 1
  socket.once('close', () => {
    stats.active -= 1
  })
})
server.on('request', handleRequest)
server.on('connect', handleConnect)
server.on('clientError', (error, socket) => {
  if (socket.writable) writeRawResponse(socket, 400, `请求无法解析：${error.code ?? 'ERR'}`)
  else socket.destroy()
})

server.listen(config.port, config.bind, () => {
  const address = server.address()
  audit({
    event: 'listen',
    bind: config.bind,
    port: typeof address === 'object' && address !== null ? address.port : config.port,
    allowedHosts: config.allowList.length,
    connectPorts: Array.from(config.connectPorts).sort((left, right) => left - right),
    httpPorts: Array.from(config.forwardPorts).sort((left, right) => left - right),
    maxSockets: config.maxSockets,
    resolvedAddressGuard: guardedLookup ? 'on' : 'off',
  })
})

server.on('error', (error) => {
  process.stderr.write(`dsh-egress-proxy 无法监听 ${config.bind}:${config.port}：${error.message}\n`)
  process.exit(1)
})

// 干净退出：先停止 accept，再等在途连接收尾；超时就强制断开，别让容器卡在 stop。
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  audit({ event: 'shutdown', signal, activeConnections: stats.active })
  server.close(() => process.exit(0))
  server.closeIdleConnections?.()
  const force = setTimeout(() => {
    server.closeAllConnections?.()
    process.exit(0)
  }, 5_000)
  force.unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
