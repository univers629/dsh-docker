// 回归测试：向导路径下选「卸载」后，install.sh 必须能自行退出。
//
// 触发路径：`curl ... | bash` → 向导里选「删除 → 全部删除」→ 确认 → 界面退出。
//
// 原因：门闸是个 FIFO，向导确认时界面放行一次，执行体读完就关闭了读端
//（卸载属于维护动作，dsh_exec_body 判定不需要执行、立刻 return）。界面退出后
// bash 的收尾补放行正好落在「无读端」状态上，`printf '\n' > "$gate"` 的写端
// open() 于是永久阻塞。
//
// 静态层锁住写法（补放行必须走非阻塞的 gate_release），动态层用真实 install.sh
// 走完整条路径并断言它在限时内退出。动态层交给 helpers/gate-delete-e2e.py：
// 它需要伪终端（install.sh 有无 TTY 守卫）与伪造的 docker，用 pty.fork 一次把
// 两者都摆好，比在 Node 里拼引号可靠。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const installSh = readFileSync(join(root, 'install.sh'), 'utf8')

// —— 静态：不得有裸的门闸写入 ——
//
// `printf > "$gate"` 正是会阻塞的写法。两点必须排除，否则是自我误报：
//   1. 注释行里提到它是在解释原因；
//   2. gate_release 内部用 `exec 9<>"$gate"` 以读写方式打开，那是修法本身。
const codeLines = installSh.split('\n').filter((l) => !/^\s*#/.test(l))
const rawGateWrites = codeLines.filter((l) => />\s*"\$gate"/.test(l) && !/exec\s+\d+<>/.test(l))
assert.deepEqual(
  rawGateWrites,
  [],
  `门闸写入必须走 gate_release（以 O_RDWR 打开，无读端也不阻塞）；` +
    `裸写会在执行体已退出时永久挂死：\n${rawGateWrites.join('\n')}`,
)

assert.match(installSh, /^gate_release\(\) \{/m, 'install.sh 必须定义 gate_release')
const callSites = codeLines.filter((l) => /^\s*gate_release\s/.test(l))
assert.ok(
  callSites.length >= 2,
  `门闸有两处放行（命令行路径、界面退出后的补放行），实际只有 ${callSites.length} 处`,
)

// —— 动态：用真实 install.sh 跑完整条路径 ——
if (process.platform === 'win32') {
  console.log('gate-delete smoke: ok (static only)')
  console.log('DYNAMIC-SKIPPED: gate-delete: 需要 POSIX FIFO、伪终端与 timeout(1)，只在 Linux 上跑')
  process.exit(0)
}

// 动态层交给 helpers/gate-delete-e2e.py：install.sh 要求控制终端，而它又必须看到
// 伪造的 PATH 与桩 installer，用 pty.fork 一次把三者都摆好最稳（仓库里其他探针同做法）。
const helper = join(root, 'tests', 'helpers', 'gate-delete-e2e.py')
let out = ''
let rc = 0
try {
  out = execFileSync('python3', [helper, join(root, 'install.sh'), '40'], {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (e) {
  rc = e.status ?? 1
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`
}

const m = out.match(/EXIT=(\d+)/)
assert.ok(m, `探针必须报告退出码，实际输出：\n${out.slice(-1200)}`)
const code = Number(m[1])
assert.notEqual(
  code,
  124,
  `install.sh 在向导路径下挂死了（门闸补放行阻塞在无读端状态）。输出尾部：\n${out.slice(-1200)}`,
)
assert.equal(code, 0, `卸载路径应干净退出，实际退出码 ${code}：\n${out.slice(-1200)}`)

console.log('gate-delete smoke: ok (向导选卸载后脚本能在限时内退出)')
