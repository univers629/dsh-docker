// 回归测试：放行门闸在读端已消失时不得阻塞。
//
// 现场（真实部署）：用户选「卸载」，向导确认后界面退出，命令行**永久卡住**，
// 只能 Ctrl+C 或关掉终端。
//
// 原因：门闸是个 FIFO。向 FIFO 写数据时，写端的 open() 会阻塞到有读端出现。
// 向导路径下，界面放行一次后执行体就读完并关闭了读端（卸载属于维护动作，
// dsh_exec_body 判定不需要执行会立刻 return），界面退出后 bash 的收尾补放行
// 正好落在「无读端」状态上——`printf '\n' > "$gate"` 于是永久挂起。
//
// 修法：gate_release 用 `exec 9<>` 以读写方式打开（O_RDWR），进程自身即读端，
// 因此不会阻塞；有读端时行为不变（照样写入那一行）。
//
// 本测试不依赖 docker：用真实的 install.sh 抽出该函数，在 FIFO 上实测两种状态。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const installSh = readFileSync(join(root, 'install.sh'), 'utf8')

// —— 静态：不得再有裸的 FIFO 写入 ——
//
// `printf > "$gate"` 正是会阻塞的写法。两点必须排除，否则是自我误报：
//   1. 注释行里提到它是在解释原因，不算违规；
//   2. gate_release 内部用 `exec 9<>"$gate"` 以读写方式打开，那是修法本身。
const codeLines = installSh.split('\n').filter((l) => !/^\s*#/.test(l))
const rawWrites = codeLines.filter(
  (l) => />\s*"\$gate"/.test(l) && !/exec\s+\d+<>/.test(l),
)
assert.deepEqual(
  rawWrites,
  [],
  `门闸写入必须走 gate_release（exec 9<> 非阻塞打开）；裸写会在无读端时永久阻塞：\n${rawWrites.join('\n')}`,
)

// —— 静态：两个调用点都在 ——
assert.match(installSh, /^gate_release\(\) \{/m, 'install.sh 必须定义 gate_release')
const callSites = codeLines.filter((l) => /^\s*gate_release\s/.test(l))
assert.ok(
  callSites.length >= 2,
  `门闸有两处放行（命令行路径、界面退出后的补放行），实际只有 ${callSites.length} 处`,
)

// —— 动态：在真实 FIFO 上验证不阻塞 ——
//
// 需要 bash 与 mkfifo。Windows 的 Git Bash 有这两样，但 FIFO 语义不可靠，
// 所以只在那里跑静态层并显式标记（run-offline.mjs 会汇总降级）。
if (process.platform === 'win32') {
  console.log('gate-release smoke: ok (static only)')
  console.log('DYNAMIC-SKIPPED: gate-release: Windows 的 FIFO 语义不可靠，动态层只在 Linux 上跑')
  process.exit(0)
}

const fnMatch = installSh.match(/^gate_release\(\) \{[\s\S]*?\n\}/m)
assert.ok(fnMatch, '没能从 install.sh 抽出 gate_release 函数')
const fnDef = fnMatch[0]

const work = mkdtempSync(join(tmpdir(), 'gate-smoke-'))
try {
  const script = join(work, 'probe.sh')
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -u
${fnDef}

work="$(mktemp -d)"

# 场景 1：读端还在，放行必须成功送达
g="$work/normal"; mkfifo "$g"
( read -r line < "$g" && printf 'GOT:%s\\n' "$line" > "$work/got" ) &
sleep 0.2
if ! timeout 5 bash -c "$(declare -f gate_release); gate_release '$g'"; then
  echo "BLOCKED_NORMAL"; exit 1
fi
wait 2>/dev/null || true
if [ ! -f "$work/got" ]; then
  echo "NOT_DELIVERED"; exit 1
fi
echo "NORMAL_OK"

# 场景 2：读端已消失（用户遇到的挂死场景）
g2="$work/gone"; mkfifo "$g2"
( read -r _ < "$g2" || true ) &
sleep 0.2
printf '\\n' > "$g2" 2>/dev/null || true
wait 2>/dev/null || true
# 此刻 FIFO 已无读端。旧写法在这里永久阻塞。
if ! timeout 5 bash -c "$(declare -f gate_release); gate_release '$g2'"; then
  echo "BLOCKED_NO_READER"; exit 1
fi
echo "NO_READER_OK"

# 场景 3：不是 FIFO / 不存在 / 空串，都应安全返回
timeout 5 bash -c "$(declare -f gate_release); gate_release '/nonexistent/x'; gate_release ''; gate_release '$work'" || {
  echo "UNSAFE_INPUT"; exit 1
}
echo "SAFE_OK"
rm -rf "$work"
`,
  )

  let out
  try {
    out = execFileSync('bash', [script], { encoding: 'utf8', timeout: 60000 })
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    assert.fail(`门闸放行探针失败（会阻塞就是死锁回归）：\n${out}`)
  }

  assert.match(out, /NORMAL_OK/, `有读端时必须送达那一行：\n${out}`)
  assert.match(out, /NO_READER_OK/, `无读端时不得阻塞（这正是用户遇到的挂死）：\n${out}`)
  assert.match(out, /SAFE_OK/, `非法输入必须安全返回：\n${out}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log('gate-release smoke: ok (有读端送达 / 无读端不阻塞 / 非法输入安全)')
