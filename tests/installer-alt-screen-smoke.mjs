// 回归：安装向导必须占用终端的备用屏幕缓冲（alternate screen buffer），
// 而不是用主屏幕 + Clear-Host 反复重绘。
//
// 为什么必须这样测：用主屏幕重绘会把每一页都留在 scrollback 里，表现就是
// 「每次选择都把整页重印一遍到日志」。这是实际发生过的缺陷——备用屏幕缺失时，
// 功能测试全绿，因为每一页的内容确实都打印出来了，只是打错了地方。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installSh = readFileSync(join(root, 'install.sh'), 'utf8')
const installPs1 = readFileSync(join(root, 'install.ps1'), 'utf8')

// 1) 两个安装器都要切换备用屏幕（CSI ?1049h 进入 / ?1049l 离开）。
assert.match(
  installSh,
  /\\033\[\?1049h/,
  'install.sh must enter the alternate screen buffer (CSI ?1049h)',
)
assert.match(
  installSh,
  /\\033\[\?1049l/,
  'install.sh must leave the alternate screen buffer (CSI ?1049l)',
)
assert.match(installPs1, /`e\[\?1049h/, 'install.ps1 must enter the alternate screen buffer')
assert.match(installPs1, /`e\[\?1049l/, 'install.ps1 must leave the alternate screen buffer')

// 2) 进入/离开必须幂等：每翻一页都进出一次会闪屏。
assert.match(installSh, /ui_alt_enter\(\) \{[\s\S]*?\}/, 'install.sh must define ui_alt_enter')
assert.match(installSh, /ui_alt_leave\(\) \{[\s\S]*?\}/, 'install.sh must define ui_alt_leave')
assert.match(
  installSh,
  /ui_alt_enter\(\) \{\s*\n\s*\[ "\$UI_ALT_SCREEN" = true \] && return 0/,
  'ui_alt_enter must be idempotent so paging does not flicker',
)
assert.match(
  installSh,
  /ui_alt_leave\(\) \{\s*\n\s*\[ "\$UI_ALT_SCREEN" = true \] \|\| return 0/,
  'ui_alt_leave must be idempotent',
)

// 3) 退出路径必须还原终端，否则用户的 shell 会留在无回显、无光标的画布里。
assert.match(
  installSh,
  /trap 'ui_term_restore; ui_run_prev_trap' EXIT/,
  'the EXIT trap must restore the terminal',
)
assert.match(
  installSh,
  /trap 'ui_term_restore; exit 130' INT/,
  'Ctrl+C must restore the terminal',
)

// 4) 维护类动作（没有后续向导页）开始前必须离开备用屏幕，
//    否则它们的输出落在用户看不见的画布上。
assert.match(
  installSh,
  /case "\$ACTION" in\s*\n\s*install\|configure\) ;;\s*\n\s*\*\) ui_term_restore ;;/,
  'maintenance actions must leave the alternate screen before producing output',
)
assert.match(
  installPs1,
  /if \(\$DshAction -notin @\('install', 'configure'\)\) \{ Exit-UiAltScreen \}/,
  'install.ps1 must leave the alternate screen for maintenance actions',
)

// 5) 单击安装不再是「没有终端」的隐式默认：默认动作是显示向导。
assert.match(
  installSh,
  /if \[ "\$QUICK_INSTALL" = auto \]; then\s*\n\s*QUICK_INSTALL=false/,
  'quick install must not be the implicit no-TTY default',
)
// 一键必须先于「无终端」守卫处理，否则 install.sh --quick 在 CI 里会被误判。
const quickIdx = installSh.indexOf('if [ "$QUICK_INSTALL" = true ]; then\n  INTERACTIVE=false')
const guardIdx = installSh.indexOf('当前环境没有可用的控制终端')
assert.ok(quickIdx > 0 && guardIdx > 0, 'both the quick path and the no-terminal guard must exist')
assert.ok(
  quickIdx < guardIdx,
  'the quick-install branch must be evaluated before the no-terminal guard',
)
// 守卫必须排除一键，否则 --quick 在无终端环境下会被拒绝。
assert.match(
  installSh,
  /\[ "\$QUICK_INSTALL" != true \] && \[ -z "\$ACTION" \]/,
  'the no-terminal guard must not fire for --quick',
)

// 6) 交互判定必须看 /dev/tty，而不是 stdin——curl|bash 时 stdin 是管道。
assert.match(
  installSh,
  /if \(: < \/dev\/tty\) 2>\/dev\/null; then\s*\n\s*INTERACTIVE=true/,
  'interactive detection must probe /dev/tty rather than stdin',
)

console.log('installer alt-screen smoke: ok')
