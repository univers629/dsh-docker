#!/usr/bin/env node
// 安装向导替"DSH 内置目录之外的上游"自动问出模型清单。
//
// 为什么这一步必须存在：DSH 对目录外的路由要求至少一个模型 id，缺了就拒绝整条路由，
// 而拒绝的表现是 WebUI 的模型页不多出卡片、也不给任何提示。向导以前靠追问用户手写
// 模型 id 来绕开这件事，可那是把上游文档的活推给了用户，一旦跳过就装出一个"填了密钥
// 却选不到模型"的部署。既然密钥这时就在手上，直接向上游问一次最省事。
//
// 用法（密钥只走 stdin，不进任何进程的命令行，所以不会出现在 ps 里）：
//   printf '%s' '{"upstreams":[{"name":"acme","baseUrl":"https://...","key":"...","shape":"any"}]}' \\
//     | node bin/discover-upstream-models.mjs
//
// stdout 是给 shell 读的行，字段用制表符分隔（模型 id 和上游名里都不可能出现制表符）：
//   models<TAB><上游名><TAB><id,id,...>
//   baseurl<TAB><上游名><TAB><补好版本段的 base_url>
//   failed<TAB><上游名><TAB><拉不到的原因>
// 密钥不出现在输出里；上游响应万一回显了密钥，共享模块会在拼进原因之前抹掉它。

import process from 'node:process'

import { fetchUpstreamModels } from './dsh-upstream-models.mjs'

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

const text = await readStdin()
const payload = JSON.parse(text.trim() === '' ? '{}' : text)
/** 制表符和换行会破坏输出的行格式；原因文本来自上游，必须先压平。 */
function flatten(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 400)
}

const out = []
for (const upstream of Array.isArray(payload.upstreams) ? payload.upstreams : []) {
  const name = String(upstream?.name ?? '')
  if (name === '') continue
  const record = {
    name,
    baseUrl: String(upstream?.baseUrl ?? ''),
    key: String(upstream?.key ?? ''),
    shape: String(upstream?.shape ?? 'any'),
    extraHeaders: upstream?.extraHeaders ?? {},
  }
  // 一个上游拉不到不影响别的：失败原因单独记下来，让安装器逐条如实转述。
  try {
    const found = await fetchUpstreamModels(record, { timeoutMs: Number(payload.timeoutMs ?? 20_000) })
    if (found.ok) {
      // base_url 的修正要先说：模型清单对不对无所谓，base_url 错了整条上游都发不出请求。
      if (found.suggestedBaseUrl) out.push('baseurl\t' + name + '\t' + found.suggestedBaseUrl)
      out.push('models\t' + name + '\t' + found.models.slice(0, 200).join(','))
    } else out.push('failed\t' + name + '\t' + flatten(found.message))
  } catch (error) {
    out.push('failed\t' + name + '\t' + flatten(error instanceof Error ? error.message : String(error)))
  }
}
process.stdout.write(out.map((line) => line + '\n').join(''))
