// 回归：交互路径之外的 CLI 安装路径（install.sh install，无 --plan 确认）仍要可用。
//
// 这条路径与交互路径共用一个执行外壳，但形态不同：
//   - 没有向导，所以也**不能**把 --run-gate 交给界面（否则界面会停在一个空的向导
//     首页上等输入，而 bash 那边在等它跑完 —— 双方互等，表现为挂死）；
//   - 门闸由 bash 自己放行；
//   - 答案来自 argv，父 shell 已经解析成各 _OVERRIDE 变量，执行体不该再去读一个
//     空答案文件（那会把 DSH_WIZARD_DONE 置真，让所有提问静默跳过）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installSh = readFileSync(join(root, 'install.sh'), 'utf8')
const mainGo = readFileSync(join(root, 'cmd', 'dsh-installer', 'main.go'), 'utf8')
const rootGo = readFileSync(join(root, 'cmd', 'dsh-installer', 'root.go'), 'utf8')

// 1) --run-gate 只在带向导时传给界面。
//
// 这一条是挂死防护的核心：无条件传 --run-gate 会让界面以为有向导要翻，
// 于是停在一个空的向导首页等输入；而 bash 在等界面跑完 —— 双方互等。
//
// 断言写成精确的结构：门闸参数必须被 guided 分支正好包住。只检查「某段里没有
// --run-gate」是不够的——把它挪到分支**之前**就绕过了那种检查。
assert.match(
  installSh,
  /local -a ui_args=\(--dir "\$TARGET_DIR"\)\n  if \[ "\$guided" = true \]; then\n    ui_args\+=\(--answers-file "\$answers" --run-gate "\$gate"\)\n  fi\n/,
  '--run-gate 必须被 guided 分支正好包住，不能无条件传给界面（否则双方互等挂死）',
)

// 2) 没有向导时界面必须直接进执行视图（root.go 的判据）。
assert.match(
  rootGo,
  /if opts\.watchLog != "" && opts\.runGate == "" \{/,
  'root.go 必须按「有 watch-log 但没有 run-gate」判定命令行路径',
)
assert.match(rootGo, /m\.phase = phaseExec/, '命令行路径必须直接进执行视图')

// 3) 命令行路径下门闸由 bash 自己放行，且必须在后台执行体起来**之后**。
const execFn = installSh.slice(
  installSh.indexOf('run_install_execution() {'),
  installSh.indexOf('run_guided_session()'),
)
const releaseIdx = execFn.indexOf(`if [ "$guided" != true ]; then`)
assert.ok(releaseIdx > 0, '命令行路径必须由 bash 自己放行门闸')
const spawnIdx = execFn.indexOf('>>"$logfile" 2>&1 &')
assert.ok(
  spawnIdx > 0 && spawnIdx < releaseIdx,
  '放行必须发生在后台执行体启动之后（先开写端会在没有读端时阻塞）',
)

// 4) 执行体不能去读一个空的答案文件：那会把 DSH_WIZARD_DONE 置真，
//    让 install_execute_body 里的提问全部静默跳过。
assert.match(
  installSh,
  /if \[ -n "\$answers" \]; then\s*\n\s*dsh_installer_read_answers/,
  '执行体只在确实有答案文件时才解析它',
)

// 5) 界面侧同样要承认这条路径：不带 --run-gate 时不做「向导结束」的判断。
assert.match(
  mainGo,
  /--run-gate PATH\s+向导确认后打开该 FIFO 放行后台执行子 shell/,
  'main.go 的用法说明必须列出 --run-gate',
)

console.log('installer cli-path smoke: ok')
