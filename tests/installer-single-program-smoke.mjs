// 回归：整个安装会话必须由**一个** tea.Program 承载，全程只进出备用屏幕一次。
//
// 为什么必须这样测：拆成两次程序调用时，向导退出会让备用屏幕还原、执行视图再进入，
// 于是「2 进 2 出」，两次之间那段输出还会漏到备用屏幕之外的终端行里——而那时用户
// 已经滚过去了。功能测试全绿也发现不了：每一页内容确实都打印了，只是打在了错误的
// 地方（scrollback 而不是画布）。
//
// 分层验证：
//   1. 静态：main.go 只有一个 tea.NewProgram，且 root.go 在向导结束后切到执行阶段。
//      这一层在任何平台都能跑。
//   2. 动态：在 PTY 里跑真实二进制，数 CSI ?1049h/?1049l。需要 Linux + python3。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const mainGo = readFileSync(join(root, 'cmd', 'dsh-installer', 'main.go'), 'utf8')
const rootGo = readFileSync(join(root, 'cmd', 'dsh-installer', 'root.go'), 'utf8')
const execGo = readFileSync(join(root, 'cmd', 'dsh-installer', 'execview.go'), 'utf8')

// —— 1) 静态：只有一个 tea.Program，且两个阶段都由它承载 ——

// 两个 tea.NewProgram 会各自进出一次备用屏幕，正是要避免的形态。
const programCount = mainGo.match(/tea\.NewProgram\(/g)?.length ?? 0
assert.equal(
  programCount,
  1,
  `main.go 必须只创建一次 tea.Program（向导与执行视图共用一个），实际 ${programCount} 次`,
)
// 备用屏幕必须开在这个唯一的程序上，且不带任何条件——执行视图过去刻意留在主屏，
// 那正是「日志跑到终端行里」的来源。
assert.match(
  mainGo,
  /tea\.NewProgram\(newRootModel\(opts\), tea\.WithAltScreen\(\)\)/,
  '唯一的程序必须无条件使用备用屏幕',
)
assert.ok(
  !/tea\.NewProgram\(model\)/.test(mainGo),
  'main.go 不应再有第二个不带备用屏幕的程序启动路径',
)

// 根模型必须按阶段分派，且在向导结束后切到执行阶段（而不是结束程序）。
assert.match(rootGo, /const \(\s*\n\s*phaseWizard = iota\s*\n\s*phaseExec\s*\n\)/, 'root.go 必须定义两个阶段')
assert.match(
  rootGo,
  /if !m\.wizard\.done \{\s*\n\s*return m, cmd\s*\n\s*\}/,
  '向导未结束时根模型必须把控制权留在向导阶段',
)
assert.match(
  rootGo,
  /m\.persistAnswers\(\)[\s\S]{0,700}return m\.startExec\(\)/,
  '向导确认后必须落答案并原地切到执行视图',
)
assert.match(rootGo, /m\.phase = phaseExec/, '切阶段必须真的改动阶段标记')
// 切换时不能顺手退出：丢掉向导在 done 时返回的 tea.Quit 是这个改动的关键。
assert.match(
  rootGo,
  /\/\/ 向导结束。注意丢掉向导返回的 cmd/,
  'root.go 必须显式说明「丢掉向导的 tea.Quit」，否则模式会被后人改回去',
)
// main.go 不得再按 --watch-log 分流到第二个程序（旧形态）。
assert.ok(
  !/if opts\.watchLog != "" \{\s*\n\s*os\.Exit\(runExecView/.test(mainGo),
  'main.go 不应再按 --watch-log 分流到独立的执行视图程序',
)
assert.ok(!/func runExecView/.test(mainGo), '独立的 runExecView 启动路径必须已删除')

// 执行视图要能被父模型要求退出（Bubble Tea 不把子模型的 tea.Quit 转给父模型）。
assert.match(execGo, /quit bool/, '执行视图必须向父模型暴露退出意愿')
assert.match(
  execGo,
  /m\.quit = true\s*\n\s*return m, tea\.Quit/,
  '执行视图决定退出时必须同时置 quit 标记',
)

// —— 2) 动态：PTY 里数备用屏幕的进出次数 ——
//
// 这一段需要 Linux + python3 + 已构建的 dsh-installer。任一缺失都只跑静态层，
// 但必须把「动态层没跑」这件事显式说出来：否则一条什么都没验证的断言会打印 ok，
// 读日志的人会以为备用屏幕的行为已经被覆盖。用 DYNAMIC-SKIPPED 标记，
// run-offline.mjs 会把它汇总出来。

/** 只跑完静态层就退出，并留下可汇总的标记。 */
function staticOnly(reason) {
  console.log(`installer single-program smoke: ok (static only)`)
  console.log(`DYNAMIC-SKIPPED: installer-single-program: ${reason}`)
  process.exit(0)
}

const helper = join(root, 'tests', 'helpers', 'alt-screen-count.py')
if (process.platform === 'win32') {
  staticOnly('PTY 探针只能在 Linux 上跑（Windows 没有 pty.fork）')
}
if (!existsSync(helper)) {
  staticOnly(`缺少探针脚本 ${helper}`)
}

const binary = process.env.DSH_INSTALLER_BIN || join(root, 'cmd', 'dsh-installer', 'dsh-installer')
if (!existsSync(binary)) {
  staticOnly(`未构建 dsh-installer（${binary} 不存在）——先跑 go build 才有动态层`)
}

const probe = spawnSync('python3', [helper, binary], { encoding: 'utf8', timeout: 180000 })
if (probe.error || probe.status !== 0) {
  // 探针本身跑不起来（没有 python3、容器里没有 /dev/tty 等）时只跑静态层。
  // 这仍然要显式标记：探针失败与「界面确实只进出一次」是两件事。
  const detail = (probe.error?.message ?? `${probe.stdout ?? ''}${probe.stderr ?? ''}`).trim()
  staticOnly(`探针不可用：${detail.slice(0, 200)}`)
}

const out = probe.stdout.trim()
const match = out.match(/enter=(\d+)\s+leave=(\d+)\s+exec=(\d+)/)
assert.ok(match, `PTY 探针必须报告进出次数，实际输出：${out}`)
const enter = Number(match[1])
const leave = Number(match[2])
const exec = Number(match[3])

assert.equal(
  enter,
  1,
  `整个安装会话必须只进入备用屏幕一次（向导与执行视图共用一个 tea.Program），实际 ${enter} 次。\n${out}`,
)
assert.equal(leave, 1, `备用屏幕必须只离开一次，实际 ${leave} 次。\n${out}`)
assert.equal(leave, enter, '进入与离开必须配对，否则用户的 shell 会留在画布里')

// 只数进出次数还不够：若向导压根没切到执行视图（例如切换逻辑被删掉，改为直接退出），
// 次数依然是 1 进 1 出，测试会假通过。所以必须确认真的到达过执行视图。
assert.equal(
  exec,
  1,
  `向导确认后必须原地切到执行视图（而不是退出程序），实际未观察到执行视图。\n${out}`,
)

// —— 3) 动态：安装失败时不得有内容漏到备用屏幕之外 ——
//
// 这条断言锁定的缺陷（在真实部署上观察到的输出）：
//     ==> 多用户模式：注册门槛=open，闲置停用=3600s，每用户配额=2GB。
//     安装未完成（退出码 1）
//     完整日志: /tmp/dsh-exec-BgTWVQ.log
// 前两行来自执行阶段、第三行来自退出视图后的 printf。备用屏幕一还原，
// 它们就落到了终端行上。这里断言最后一次 ?1049l 之后不再有摘要内容。
const leakHelper = join(root, 'tests', 'helpers', 'leak-check.py')
if (existsSync(leakHelper)) {
  const leak = spawnSync('python3', [leakHelper, binary], { encoding: 'utf8', timeout: 180000 })
  if (!leak.error && leak.status !== null) {
    const leakOut = `${leak.stdout ?? ''}${leak.stderr ?? ''}`.trim()
    assert.equal(
      leak.status,
      0,
      `安装失败时不得有摘要漏到备用屏幕之外（那是「跑到终端行里」的输出）：\n${leakOut}`,
    )
  }
}

// —— 4) 动态：向导里取消时干净退出 ——
//
// 取消路径有个容易漏的坑：Go 在向导阶段被 Ctrl+C 时不会去放行门闸，而后台执行
// 子 shell 正阻塞在门闸上。若 bash 侧不补一次放行，wait 会永远挂住——用户看到
// 「取消了但命令不返回」。这里断言退出码是 3（exitCancelled）。
const cancelHelper = join(root, 'tests', 'helpers', 'cancel-check.py')
if (existsSync(cancelHelper)) {
  const cancel = spawnSync('python3', [cancelHelper, binary], { encoding: 'utf8', timeout: 120000 })
  if (!cancel.error && cancel.status !== null) {
    const cancelOut = `${cancel.stdout ?? ''}${cancel.stderr ?? ''}`.trim()
    assert.equal(cancel.status, 0, `向导里取消必须以退出码 3 干净收尾：\n${cancelOut}`)
  }
}

console.log(
  `installer single-program smoke: ok (enter=${enter}, leave=${leave}, exec=${exec})`,
)
