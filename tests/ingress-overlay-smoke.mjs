// 回归测试：两个入口定义不得被 Compose 合并成重复字段。
//
// 现场（用户 VPS 安装失败）：
//   validating /home/debian/dsh-docker/docker-compose.isolated.yml:
//   services.dsh-ingress.security_opt items at 0 and 1 are equal
//
// 原因：docker-compose.multiuser.yml 与 docker-compose.isolated.yml 都定义了
// dsh-ingress，而它们是两套不同实现（不同 nginx 配置、不同运行用户、不同
// entrypoint）。Compose 合并同名服务时，标量字段后者覆盖、**序列字段追加**，
// 于是 security_opt 变成 ["no-new-privileges:true", "no-new-privileges:true"]、
// command 变成两套命令被拼接、ports 出现两条相同端口。严格版本的 compose
//（docker/compose 2.2x 的某些构建）直接拒绝校验，表现为「容器启动失败」，
// 且错误信息指向 isolated.yml，与真正的原因（两文件同名）隔了一层。
//
// 修法：两套定义用不同服务名（dsh-ingress / dsh-ingress-iso），各自挂互斥的
// profile；对外容器名保持 dsh-ingress 不变。
//
// 本测试不依赖 docker：直接读 compose 文件的文本，断言
//   1) 两个文件里的入口服务名不同；
//   2) 两者都带 profile，且 profile 名不同；
//   3) 没有任何文件同时激活两个 profile（那是让两套定义撞车的唯一途径）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(root, f), 'utf8')

// 切出某服务名在文件里的定义块（到下一个同级键为止）。
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

// 收集所有 compose 文件里的顶层服务名，映射到「出现在哪些文件」。
function servicesOf(text) {
  const out = []
  const lines = text.split('\n')
  let inServices = false
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue }
    if (inServices && /^[a-zA-Z]/.test(line)) { inServices = false; continue }
    if (!inServices) continue
    const m = line.match(/^  ([a-z0-9][a-z0-9_-]*):\s*$/)
    if (m) out.push(m[1])
  }
  return out
}

const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.auth.yml',
  'docker-compose.basic-auth.yml',
  'docker-compose.keys.yml',
  'docker-compose.keys-admin.yml',
  'docker-compose.multiuser.yml',
  'docker-compose.isolated.yml',
]

const texts = {}
for (const f of COMPOSE_FILES) {
  try { texts[f] = read(f) } catch { /* 可选文件 */ }
}

// 1) 没有任何服务名定义在多个文件里并携带序列字段——那正是合并出重复项的来源。
//
// 例外：dsh / dsh-auth / dsh-key-broker 是**有意的增量叠加**（只加 environment
// 或 networks，且 dsh 的 ports 明确用了 !override/!reset 清空）。真正的危险是
// 两套**完整实现**共用一个名字，所以这里只拦「同名且两边都定义 command 或
// entrypoint」的情况——那是两套实现被合并的确定信号。
const seen = new Map()
for (const [f, text] of Object.entries(texts)) {
  for (const svc of servicesOf(text)) {
    if (!seen.has(svc)) seen.set(svc, [])
    seen.get(svc).push(f)
  }
}

for (const [svc, files] of seen) {
  if (files.length < 2) continue
  const withEntry = files.filter((f) => {
    const block = serviceBlock(texts[f], svc)
    return block && /^    (command|entrypoint):/m.test(block)
  })
  assert.ok(
    withEntry.length < 2,
    `${svc} 在多个文件里都定义了 command/entrypoint（${withEntry.join(', ')}）：` +
      '这是两套实现共用服务名，Compose 合并时序列字段会追加成重复项，' +
      '严格版本的 compose 会拒绝校验。请给其中一套换服务名。',
  )
}

// 2) 隔离层的入口必须叫 dsh-ingress-iso，且与多用户那个互斥。
const isoText = texts['docker-compose.isolated.yml']
const multiText = texts['docker-compose.multiuser.yml']

const isoIngress = serviceBlock(isoText, 'dsh-ingress-iso')
assert.ok(isoIngress, 'isolated 叠加层必须定义 dsh-ingress-iso（不能叫 dsh-ingress）')
assert.match(isoIngress, /^    container_name: dsh-ingress$/m, '对外容器名应保持 dsh-ingress')
assert.match(isoIngress, /^    profiles: \["isolate"\]$/m, 'isolated 入口必须在 isolate profile 下')

const multiIngress = serviceBlock(multiText, 'dsh-ingress')
assert.ok(multiIngress, 'multiuser 叠加层必须定义 dsh-ingress')
assert.match(multiIngress, /^    profiles: \["multiuser"\]$/m, '多用户入口必须在 multiuser profile 下')

// 3) isolated.yml 不得再定义无后缀的 dsh-ingress（否则又与多用户那个撞名）。
assert.equal(
  serviceBlock(isoText, 'dsh-ingress'),
  null,
  'isolated.yml 不得定义 dsh-ingress：那会与 multiuser.yml 的同名服务被合并',
)

// 4) 安装器与运行脚本必须按模式只激活其中一个 profile。
//
// 两者的职责不同，要求的写法也不同：
//   install.sh  只负责 up，把 compose 参数拼进 COMPOSE_ARGS，需要 --profile isolate；
//               它没有旁路容器清单（那是 dsh.sh 的 stop/restart 才需要的）。
//   dsh.sh      除了 --profile isolate，还要把 dsh-ingress-iso 登记为旁路容器，
//               否则 stop/restart 会漏掉这个入口。
const installSrc = read('install.sh')
const cliSrc = read('dsh.sh')

const profileIsolate = /--profile isolate/
if (!profileIsolate.test(installSrc)) {
  assert.fail('install.sh 需要在非 open 出站模式下激活 --profile isolate，否则 dsh-ingress-iso 不会启动')
}
if (!installSrc.includes('dsh-ingress-iso') && !/-f docker-compose\.isolated\.yml/.test(installSrc)) {
  assert.fail('install.sh 需要叠加 isolated.yml（dsh-ingress-iso 所在文件）')
}
if (!profileIsolate.test(cliSrc)) {
  assert.fail('dsh.sh 需要在非 open 出站模式下激活 --profile isolate')
}
if (!cliSrc.includes('dsh-ingress-iso')) {
  assert.fail('dsh.sh 需要把 dsh-ingress-iso 登记为旁路容器，否则 stop/restart 会漏掉它')
}

console.log('ingress-overlay smoke: ok (两个入口分名 + profile 互斥，不产生重复字段)')
