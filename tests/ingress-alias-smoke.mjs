// 回归测试：多用户模式下 `dsh-private` 上必须有主机名 `dsh` 指向入口。
//
// README 告诉容器化反代（Docker 面板等）把上游写成 http://dsh:3080。单管理员
// 隔离模式下 dsh-ingress-iso 顶着这个别名；多用户模式下入口换成了 multiuser.yml
// 里的 dsh-ingress，若它不带这个别名，反代就解析不到主机名——表现为 502，
// 而错误信息只会说「连不上上游」，看不出是别名缺失。
//
// 两种模式对外必须是同一个名字：反代配置不该因为切换模式而失效。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(root, f), 'utf8')

// 切出某服务在文件里的定义块（到下一个同级键为止）。
function serviceBlock(text, name) {
  const lines = text.split('\n')
  const head = `  ${name}:`
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === head) { start = i; break }
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-z0-9][a-z0-9_-]*:$/.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

// 该服务在指定网络上是否声明了给定别名。
function hasAliasOn(block, network, alias) {
  if (!block) return false
  const lines = block.split('\n')
  let inNetwork = false
  for (let i = 0; i < lines.length; i++) {
    const netHead = lines[i].match(/^      ([a-z0-9][a-z0-9_-]*):\s*$/)
    if (netHead) { inNetwork = netHead[1] === network; continue }
    if (inNetwork && new RegExp(`^\\s+- ${alias}\\s*$`).test(lines[i])) return true
  }
  return false
}

// —— 多用户入口 ——
const multi = read('docker-compose.multiuser.yml')
const multiIngress = serviceBlock(multi, 'dsh-ingress')
assert.ok(multiIngress, 'multiuser 叠加层必须定义 dsh-ingress')
assert.ok(
  hasAliasOn(multiIngress, 'dsh-private', 'dsh'),
  'dsh-ingress 必须在 dsh-private 上声明别名 `dsh`：README 让容器化反代把上游写成 ' +
    'http://dsh:3080，缺这个别名反代解析不到主机名，表现为 502',
)

// —— 单管理员隔离入口：同一契约，避免两边行为分叉 ——
const iso = read('docker-compose.isolated.yml')
const isoIngress = serviceBlock(iso, 'dsh-ingress-iso')
assert.ok(isoIngress, 'isolated 叠加层必须定义 dsh-ingress-iso')
assert.ok(
  hasAliasOn(isoIngress, 'dsh-private', 'dsh'),
  'dsh-ingress-iso 必须在 dsh-private 上声明别名 `dsh`（与多用户模式同一契约）',
)

// —— 两个入口不能在 dsh-private 上同时声称 dsh：同一网络里重名别名会冲突 ——
//
// 靠的是服务名不同（isolated 用 dsh-ingress-iso），所以 isolated.yml 里不该再有
// 无后缀的 dsh-ingress——那会与 multiuser.yml 的同名服务被 Compose 合并。
assert.equal(
  serviceBlock(iso, 'dsh-ingress'),
  null,
  'isolated 叠加层不应再定义无后缀的 dsh-ingress（会与 multiuser 的同名服务被合并）',
)

// —— README 记录的正是这个上游 ——
for (const doc of ['README.md', 'README.en.md']) {
  const text = read(doc)
  assert.match(
    text,
    /http:\/\/dsh:3080/,
    `${doc} 记录的容器化反代上游是 http://dsh:3080，本测试锁定的就是它必须可解析`,
  )
}

console.log('ingress-alias smoke: ok (两种模式都提供 dsh 别名，容器化反代上游可解析)')
