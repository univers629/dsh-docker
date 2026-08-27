// 向上游拉模型列表这件事的唯一实现。
//
// 两个调用方共用它，所以它必须独立于两者：
//   * dsh-key-admin.mjs（面板保存 / 手动点"拉取模型列表"）；
//   * discover-upstream-models.mjs（安装向导替目录外的网关自动拉一次）。
//
// 为什么安装向导也要拉：DSH 对内置目录之外的路由要求至少一个模型 id，缺了就拒绝整条
// 路由，而被拒绝的表现是"WebUI 的模型页不多出卡片、也不报错"。向导以前靠追问用户
// 手写模型 id 来避免这件事，但那是把上游文档的活推给了用户；能自动问出来就别问人。
//
// 密钥只在本进程内存里用：它不进日志，也不进返回值；上游响应里万一回显了密钥，
// redactSecrets 会在拼进错误消息之前抹掉。

import https from 'node:https'

import { createGuardedLookup } from './dsh-egress-policy.mjs'
import { redactSecrets } from './dsh-key-broker-policy.mjs'
import { extractModelIds, modelsRequestCandidates } from './dsh-key-admin-policy.mjs'

/** 响应体上限：模型列表再大也就几十 KB，留 4 MB 是为了别被一个坏上游拖垮内存。 */
const BODY_LIMIT = 4 * 1024 * 1024

// 上游主机名是配置里的合法域名，但解析结果由 DNS 说了算：复用出站代理那套判定，
// 只允许公网单播地址，防止"合法域名解析到 169.254.169.254"这种内网探测。
const guardedLookup = createGuardedLookup()

function fetchJson(candidate, secrets, timeoutMs) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(candidate.url)
    } catch {
      resolve({ ok: false, message: '地址不合法：' + candidate.url })
      return
    }
    const request = https.request(
      {
        host: url.hostname,
        port: url.port === '' ? 443 : Number(url.port),
        method: 'GET',
        path: url.pathname + url.search,
        headers: { ...candidate.headers, host: url.hostname },
        servername: url.hostname,
        lookup: guardedLookup,
      },
      (upstream) => {
        const chunks = []
        let size = 0
        upstream.on('data', (chunk) => {
          size += chunk.length
          if (size <= BODY_LIMIT) chunks.push(chunk)
        })
        upstream.on('end', () => {
          const status = upstream.statusCode ?? 0
          const text = redactSecrets(Buffer.concat(chunks).toString('utf8'), secrets)
          if (status !== 200) {
            resolve({ ok: false, message: 'HTTP ' + status + ' ' + text.replace(/\s+/g, ' ').slice(0, 200) })
            return
          }
          try {
            resolve({ ok: true, payload: JSON.parse(text) })
          } catch {
            resolve({ ok: false, message: '200 但响应不是 JSON' })
          }
        })
        upstream.on('error', (error) => resolve({ ok: false, message: redactSecrets(error.message, secrets) }))
      },
    )
    request.setTimeout(timeoutMs, () => request.destroy(new Error('上游超时')))
    request.on('error', (error) => resolve({ ok: false, message: redactSecrets(error.message, secrets) }))
    request.end()
  })
}

/**
 * 逐个候选端点试，第一个能解析出清单的算成功。
 *
 * 候选多于一个是因为版本段的位置由上游决定：base_url 已经带 /v1 时要打 /models，
 * 没带时要打 /v1/models。全部失败不抛异常——很多自建网关根本不实现 /models，
 * 手写模型 id 一样能用，所以"拉不到"是一个调用方要如实转述的结果，不是错误。
 *
 * @param record { name, baseUrl, key, shape, extraHeaders }
 * @returns { ok: true, models, endpoint, tried } 或 { ok: false, tried, message }
 */
export async function fetchUpstreamModels(record, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 20_000)
  const secrets = [record.key]
  const tried = []
  for (const candidate of modelsRequestCandidates(record)) {
    const result = await fetchJson(candidate, secrets, timeoutMs)
    if (!result.ok) {
      tried.push(candidate.url + ' -> ' + result.message)
      continue
    }
    const models = extractModelIds(result.payload)
    if (models.length === 0) {
      tried.push(candidate.url + ' -> 200，但响应里没有可用的模型 id')
      continue
    }
    return { ok: true, models, endpoint: candidate.url, tried }
  }
  return { ok: false, tried, message: '试过的地址：' + tried.join('；') }
}
