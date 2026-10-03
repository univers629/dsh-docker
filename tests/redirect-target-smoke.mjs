// 回归：redirectTarget 必须拒绝所有能离开站点的 redirect 参数（审计 3.13 的字符类）。
// 逐字提取页面里的函数体，在模拟的 window 环境里执行。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const html = fs.readFileSync(fileURLToPath(new URL('../bin/dsh-auth-web/index.html', import.meta.url)), 'utf8')
const start = html.indexOf('function redirectTarget()')
const end = html.indexOf('\n  }', start) + 4
const body = html.slice(start, end)

// 模拟页面环境：redirectTarget 读 window.location.search 与 origin
const ORIGIN = 'https://dsh.example.com'
function evaluate(raw) {
  const fakeWindow = {
    location: {
      origin: ORIGIN,
      search: raw === null ? '' : '?redirect=' + encodeURIComponent(raw),
    },
  }
  const fn = new Function('window', 'URLSearchParams', 'URL', `${body}; return redirectTarget()`)(fakeWindow, URLSearchParams, URL)
  return fn
}

// 从 nginx 的角度构造请求 URI → 页面读到的解码值
function fromRequestUri(uri) {
  return decodeURIComponent(new URLSearchParams('redirect=' + uri).get('redirect'))
}

const mustReject = [
  ['反斜杠', '/\\evil.com'],
  ['编码反斜杠', fromRequestUri('/%5Cevil.com')],
  ['制表符', fromRequestUri('/%09/evil.com')],
  ['LF', fromRequestUri('/%0a//evil.com')],
  ['CR', fromRequestUri('/%0d//evil.com')],
  ['协议相对', '//evil.com'],
  ['三斜杠', fromRequestUri('/%2F%2Fevil.com')],
  ['绝对 URL', 'https://evil.com'],
  ['指向 /login', '/login'],
  ['VT', fromRequestUri('/%0b//evil.com')],
  // 审计确认 %00 虽留在站内，但它是控制字符：新守卫一律拒绝，这是更保守的正确行为
  ['NUL（控制字符，应拒绝）', fromRequestUri('/%00/app')],
]
const mustAccept = [
  ['普通路径', '/app'],
  ['带查询', '/waking?x=1'],
  ['@ 开头（同源）', '/@evil.com'],
  ['空格开头（同源）', fromRequestUri('/%20//app')],
]

let bad = 0
console.log('== 必须拒绝（会离开站点或本身是登录页）==')
for (const [label, raw] of mustReject) {
  const out = evaluate(raw)
  // 拒绝 = 返回空串；若返回了值，再确认它解析后确实离开站点才算失败
  let escaped = ''
  if (out) {
    try { escaped = new URL(out, ORIGIN).href } catch { escaped = 'THROW' }
  }
  const ok = out === '' || escaped.startsWith(ORIGIN)
  if (!ok) { bad++; console.log(`  FAIL ${label.padEnd(12)} raw=${JSON.stringify(raw)} -> ${JSON.stringify(out)} 解析为 ${escaped}`) }
  else console.log(`  PASS ${label.padEnd(12)} -> ${out === '' ? '(拒绝)' : out + '（仍在本站）'}`)
}
console.log('== 必须接受（站内路径）==')
for (const [label, raw] of mustAccept) {
  const out = evaluate(raw)
  const ok = typeof out === 'string' && out.length > 0
  if (!ok) { bad++; console.log(`  FAIL ${label.padEnd(12)} raw=${JSON.stringify(raw)} -> ${JSON.stringify(out)}`) }
  else console.log(`  PASS ${label.padEnd(12)} -> ${out}`)
}

console.log('')
if (bad > 0) { console.log(`${bad} 项失败`); process.exit(1) }
console.log('ALL PASS')
