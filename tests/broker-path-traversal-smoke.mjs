// 回归：normalizeUpstreamPath 必须拒绝「解码后含分隔符」的段（审计 3.11 的变体）。
const pol = await import('../bin/dsh-key-broker-policy.mjs')

let rejected = 0
let accepted = 0
const mustReject = [
  '/v1/models/%2e%2e%2fadmin',          // 审计实测被转发的形式
  '/v1/models/..%2fadmin',              // 单层编码
  '/v1/chat/completions/..%2f..%2ffiles', // 双段
  '/v1/%2e%2e%2f%2e%2e%2fadmin',
  '/v1/..%2f',
  '/v1/%2F..%2Fadmin',
  '/v1/..;/../admin',
  '/v1/../../admin',                    // 原本就被拒（对照）
  '/v1/%2e%2e',                         // 原本就被拒（对照）
]
const mustAccept = [
  '/v1/chat/completions',
  '/v1/models',
  '/v1beta/models/gemini-pro:generateContent',
  '/v1/embeddings',
]

console.log('== 必须拒绝（解码后含分隔符或相对段）==')
for (const p of mustReject) {
  let out
  try { out = 'ACCEPTED ' + JSON.stringify(pol.normalizeUpstreamPath(p)) }
  catch (e) { out = 'rejected: ' + e.message }
  const ok = out.startsWith('rejected')
  if (ok) rejected++; else console.log('  **未被拒**: ' + p + ' -> ' + out)
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + p.padEnd(42) + ' ' + out.slice(0, 46))
}
console.log('== 必须接受（正常 API 路径）==')
for (const p of mustAccept) {
  let out
  try { out = 'ACCEPTED ' + JSON.stringify(pol.normalizeUpstreamPath(p)); accepted++ }
  catch (e) { out = 'rejected: ' + e.message }
  const ok = out.startsWith('ACCEPTED')
  if (!ok) console.log('  **被误拒**: ' + p + ' -> ' + out)
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + p.padEnd(42) + ' ' + out.slice(0, 46))
}

console.log('')
console.log('拒绝 ' + rejected + '/' + mustReject.length + '，接受 ' + accepted + '/' + mustAccept.length)
if (rejected !== mustReject.length || accepted !== mustAccept.length) process.exit(1)
console.log('ALL PASS')
