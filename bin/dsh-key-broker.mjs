#!/usr/bin/env node
// DSH 模型密钥代理（key broker）。
//
// 它解决的问题：DSH 容器里跑着一个可以执行任意命令的 Agent，所以任何放在容器内
// 的模型 API 密钥都必然可被读取——不需要“骗”它，一条 cat 就够了。把密钥挪到这个
// 独立容器里之后，DSH 只持有一个占位密钥和一个指向本进程的 base_url，容器内不存在
// 真实密钥这个字符串，提示注入再成功也偷不走。
//
// 边界要说清楚：本代理保护的是“密钥不外泄、不被复用”，不保护额度和数据——容器内
// 进程仍然可以借它发请求。所以这里还带了每分钟限速和 UTC 日配额，用来限制一个被
// 劫持的 Agent 能烧掉多少，并把可访问的上游路径收敛到白名单。
//
// 运行形态：独立容器、非 root、cap_drop ALL、只读根文件系统，只挂载一份 0600 的
// 密钥配置（只读）。DSH 容器与它之间只有 HTTP，没有共享卷。

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import process from 'node:process'

import { createGuardedLookup } from './dsh-egress-policy.mjs'
import {
  BrokerConfigError,
  BrokerPolicyError,
  HOP_BY_HOP_HEADERS,
  STRIPPED_REQUEST_HEADERS,
  assertMethod,
  collectSecrets,
  emptyUsageState,
  parseBrokerConfig,
  redactSecrets,
  registerUsage,
  resolveRoute,
  usageDecision,
} from './dsh-key-broker-policy.mjs'

const CONFIG_PATH = process.env.DSH_BROKER_CONFIG ?? '/etc/dsh-broker/keys.json'
const PORT = Number(process.env.DSH_BROKER_PORT ?? 8080)
const BIND = process.env.DSH_BROKER_BIND ?? '0.0.0.0'
const RELOAD_INTERVAL_MS = Number(process.env.DSH_BROKER_RELOAD_MS ?? 5000)
const UPSTREAM_TIMEOUT_MS = Number(process.env.DSH_BROKER_UPSTREAM_TIMEOUT_MS ?? 600_000)
const CONNECT_TIMEOUT_MS = Number(process.env.DSH_BROKER_CONNECT_TIMEOUT_MS ?? 20_000)
const MAX_CONCURRENT = Number(process.env.DSH_BROKER_MAX_CONCURRENT ?? 64)
// 见下方 https.request 的 lookup：防止「配置里的合法域名被解析到内网」。
const guardedLookup = createGuardedLookup()

const ERROR_BODY_LIMIT = 64 * 1024

let config = null
let secrets = []
let configStamp = ''
const usage = new Map()
let inFlight = 0
let totalAllowed = 0
let totalDenied = 0

function log(event) {
  // 审计日志只记元数据：方法、上游名、上游路径、判定、状态码、字节数、耗时。
  // 不记请求体、不记 query、不记任何 header 值，所以日志本身不会成为泄漏面。
  const line = { ts: new Date().toISOString(), ...event }
  process.stdout.write(redactSecrets(JSON.stringify(line), secrets) + '\n')
}

function stampOf(stats) {
  return `${stats.size}:${stats.mtimeMs}`
}

function loadConfig({ initial = false } = {}) {
  let stats
  try {
    stats = fs.statSync(CONFIG_PATH)
  } catch (error) {
    if (initial) throw new BrokerConfigError(`无法读取密钥配置 ${CONFIG_PATH}：${error.message}`)
    return
  }
  const stamp = stampOf(stats)
  if (stamp === configStamp) return

  let next
  try {
    // allowEmpty：密钥管理面板可以在容器起来之后才填第一把密钥，所以"upstreams 是
    // 空数组"是一个合法状态，不该让 broker 崩在启动上。没有上游时下面每个 /u/
    // 请求都会拿到 503。
    next = parseBrokerConfig(fs.readFileSync(CONFIG_PATH, 'utf8'), { allowEmpty: true })
  } catch (error) {
    // 轮换时写坏了配置不应该让代理跟着崩：保留旧配置，只报错。
    log({ event: 'config-error', message: error.message })
    if (initial) throw error
    return
  }

  config = next
  secrets = collectSecrets(next)
  configStamp = stamp
  for (const name of usage.keys()) {
    if (!next.upstreams.has(name)) usage.delete(name)
  }
  log({ event: 'config-loaded', upstreams: [...next.upstreams.keys()] })
}

function usageFor(name) {
  if (!usage.has(name)) usage.set(name, emptyUsageState())
  return usage.get(name)
}

function deny(response, status, message, context) {
  totalDenied += 1
  if (context?.upstreamName) {
    usage.set(context.upstreamName, registerUsage(usageFor(context.upstreamName), Date.now(), 'deny'))
  }
  log({ event: 'deny', status, ...context, message })
  if (!response.headersSent) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  }
  response.end(JSON.stringify({ error: { type: 'dsh_key_broker_denied', message } }))
}

function stripHeaders(headers) {
  const output = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (STRIPPED_REQUEST_HEADERS.includes(lower)) continue
    if (HOP_BY_HOP_HEADERS.includes(lower)) continue
    if (lower === 'content-length') continue
    if (lower.startsWith('x-dsh-')) continue
    output[lower] = value
  }
  return output
}

function statusResponse(response) {
  const upstreams = config
    ? [...config.upstreams.values()].map((upstream) => {
        const state = usageFor(upstream.name)
        return {
          name: upstream.name,
          host: upstream.host,
          allowedPathPrefixes: upstream.allowedPathPrefixes,
          dailyRequestBudget: upstream.dailyRequestBudget,
          requestsPerMinute: upstream.requestsPerMinute,
          usedToday: state.day === new Date().toISOString().slice(0, 10) ? state.dayCount : 0,
        }
      })
    : []
  const body = JSON.stringify({
    ok: true,
    // 只暴露上游名字、主机和配额用量。密钥、请求内容和调用方信息一概不出现。
    upstreams,
    inFlight,
    totalAllowed,
    totalDenied,
  })
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(body)
}

function forward(request, response, route) {
  const { upstream, upstreamPath, query } = route
  const started = Date.now()
  const headers = stripHeaders(request.headers)
  headers[upstream.headerName] = upstream.headerValue
  for (const [name, value] of Object.entries(upstream.extraHeaders)) headers[name] = value
  headers.host = upstream.host
  headers['accept-encoding'] = 'identity'

  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > upstream.maxRequestBytes) {
    deny(response, 413, `请求体超过上限 ${upstream.maxRequestBytes} 字节`, {
      upstreamName: upstream.name,
      path: upstreamPath,
    })
    request.resume()
    return
  }

  const target = upstream.basePath + upstreamPath + (query ? '?' + query : '')
  const upstreamRequest = https.request(
    {
      host: upstream.host,
      port: upstream.port,
      method: request.method,
      path: target,
      headers,
      servername: upstream.host,
      // 上游主机名在配置解析时已经拒过环回/私网字面量，但域名的解析结果是 DNS 说了算：
      // 一个写着 https://api.example.com 的合法配置，仍可能被解析到 127.0.0.1 或
      // 169.254.169.254。所以建连时再看一眼解析结果，只允许公网单播地址。这里复用出站
      // 代理的同一套判定（两个文件在镜像里同目录）。
      lookup: guardedLookup,
    },
    (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502
      const responseHeaders = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (HOP_BY_HOP_HEADERS.includes(name.toLowerCase())) continue
        if (name.toLowerCase() === 'set-cookie') continue
        responseHeaders[name] = value
      }

      if (status >= 400) {
        // 失败响应体先缓冲再回：部分上游会在错误信息里回显收到的密钥。
        const chunks = []
        let size = 0
        upstreamResponse.on('data', (chunk) => {
          size += chunk.length
          if (size <= ERROR_BODY_LIMIT) chunks.push(chunk)
        })
        upstreamResponse.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          const clean = Buffer.from(redactSecrets(raw, secrets), 'utf8')
          delete responseHeaders['content-length']
          response.writeHead(status, { ...responseHeaders, 'content-length': clean.length })
          response.end(clean)
          finish('allow', status, clean.length)
        })
        upstreamResponse.on('error', () => {
          if (!response.headersSent) response.writeHead(502)
          response.end()
          finish('allow', 502, 0)
        })
        return
      }

      response.writeHead(status, responseHeaders)
      let bytes = 0
      upstreamResponse.on('data', (chunk) => {
        bytes += chunk.length
      })
      upstreamResponse.pipe(response)
      upstreamResponse.on('end', () => finish('allow', status, bytes))
      upstreamResponse.on('error', () => {
        response.destroy()
        finish('allow', status, bytes)
      })
    },
  )

  let settled = false
  function finish(outcome, status, bytes) {
    if (settled) return
    settled = true
    inFlight -= 1
    if (outcome === 'allow') totalAllowed += 1
    log({
      event: 'forward',
      upstream: upstream.name,
      method: request.method,
      path: upstreamPath,
      status,
      bytes,
      ms: Date.now() - started,
    })
  }

  upstreamRequest.setTimeout(CONNECT_TIMEOUT_MS, () => {
    upstreamRequest.destroy(new Error('上游连接超时'))
  })
  upstreamRequest.on('response', () => {
    upstreamRequest.setTimeout(UPSTREAM_TIMEOUT_MS)
  })
  upstreamRequest.on('error', (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    }
    response.end(JSON.stringify({ error: { type: 'dsh_key_broker_upstream_error', message: redactSecrets(error.message, secrets) } }))
    finish('allow', 502, 0)
  })

  let received = 0
  request.on('data', (chunk) => {
    received += chunk.length
    if (received > upstream.maxRequestBytes) {
      upstreamRequest.destroy(new Error('请求体超过上限'))
      request.destroy()
    }
  })
  request.on('aborted', () => upstreamRequest.destroy(new Error('客户端中断')))
  request.pipe(upstreamRequest)
}

const server = http.createServer((request, response) => {
  const pathname = String(request.url ?? '/').split('?')[0]

  if (request.method === 'GET' && pathname === '/healthz') {
    response.writeHead(204)
    response.end()
    return
  }
  if (request.method === 'GET' && pathname === '/status') {
    statusResponse(response)
    return
  }

  if (!config) {
    deny(response, 503, '密钥代理还没有可用配置', { path: pathname })
    request.resume()
    return
  }
  if (config.upstreams.size === 0) {
    deny(response, 503, '密钥代理里还没有任何上游：请在密钥管理面板或 ./install.sh model-key 里填一把模型密钥', { path: pathname })
    request.resume()
    return
  }
  if (inFlight >= MAX_CONCURRENT) {
    deny(response, 503, `并发上限 ${MAX_CONCURRENT} 已满`, { path: pathname })
    request.resume()
    return
  }

  let method
  let route
  try {
    method = assertMethod(request.method)
    route = resolveRoute(request.url ?? '/', config)
  } catch (error) {
    const status = error instanceof BrokerPolicyError ? error.status : 400
    deny(response, status, error.message, { path: pathname, method: request.method })
    request.resume()
    return
  }

  const decision = usageDecision(usageFor(route.upstream.name), route.upstream, Date.now())
  if (!decision.allowed) {
    deny(response, decision.status, decision.reason, {
      upstreamName: route.upstream.name,
      path: route.upstreamPath,
      method,
    })
    request.resume()
    return
  }

  usage.set(route.upstream.name, registerUsage(usageFor(route.upstream.name), Date.now(), 'allow'))
  inFlight += 1
  forward(request, response, route)
})

server.headersTimeout = 60_000
server.requestTimeout = 0
server.keepAliveTimeout = 30_000

function shutdown(signal) {
  log({ event: 'shutdown', signal })
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}

try {
  loadConfig({ initial: true })
} catch (error) {
  process.stderr.write(`[dsh-key-broker] ${error.message}\n`)
  process.exit(78)
}

setInterval(() => loadConfig(), Math.max(1000, RELOAD_INTERVAL_MS)).unref()
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.listen(PORT, BIND, () => {
  log({ event: 'listening', port: PORT, bind: BIND, upstreams: [...config.upstreams.keys()] })
})
