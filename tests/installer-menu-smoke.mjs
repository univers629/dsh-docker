// 回归：向导是唯一入口，且它的页面定义必须完整。
//
// 历史背景：主菜单曾在 install.sh 里用 bash 实现，--menu 可以靠管道喂数字驱动它。
// 那个实现已被删除——向导现在全部由 dsh-installer（Go + Bubble Tea）承担，
// install.sh 拿不到二进制时直接报错退出，不再有第二套界面。
//
// 因此这里断言的是新的契约：
//   1. 页面（主菜单、更新分层、安装方式、删除确认、确认摘要）都在 Go 里定义且齐全
//   2. install.sh 不再含任何 bash 版菜单/问答
//   3. 拿不到向导二进制时报错信息要给出可执行的修复方式
//   4. 无终端且无显式动作时仍然拒绝，并给出无人值守的两条出路
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installScript = join(root, 'install.sh')
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`]
    .find((entry) => existsSync(entry))
  : 'bash'
assert.ok(bash, 'bash is required for the menu smoke test')

const installSh = readFileSync(installScript, 'utf8')
const pagesGo = readFileSync(join(root, 'cmd', 'dsh-installer', 'pages.go'), 'utf8')
const installPs1 = readFileSync(join(root, 'install.ps1'), 'utf8')

// 1) 主菜单与各分支页必须在 Go 里齐备。
const goPages = [
  ['actionPage', '主菜单'],
  ['updateModePage', '更新分层'],
  ['installModePage', '安装方式（一键/手动）'],
  ['deleteScopePage', '删除数据范围'],
  ['deleteConfirmPage', '删除确认'],
  ['confirmPage', '执行前确认摘要'],
  ['accessModePage', '访问保护方式'],
  ['egressPage', '出站模式'],
  ['proxyLocationPage', '反向代理位置'],
  ['rootPasswordPage', '容器 root 密码'],
]
for (const [fn, label] of goPages) {
  assert.match(pagesGo, new RegExp(`func ${fn}\\(\\) page`), `向导缺少页面：${label}（${fn}）`)
}
// 主菜单的动作必须与 install.sh 支持的 ACTION 取值一一对应。
for (const action of ['install', 'update', 'start', 'stop', 'restart', 'logs', 'status', 'delete', 'model-key', 'key-panel']) {
  assert.ok(pagesGo.includes(`{"${action}"`), `主菜单缺少动作：${action}`)
}

// 2) 删除确认是显式的选择项，且默认光标停在「取消」——不可逆操作不该被回车误触。
assert.match(pagesGo, /deleteConfirmPage/, '向导必须有删除确认页')
const deletePage = pagesGo.slice(pagesGo.indexOf('func deleteConfirmPage'))
const cancelIdx = deletePage.indexOf('{"no", "取消"')
const confirmIdx = deletePage.indexOf('{"yes", "确认删除"')
assert.ok(cancelIdx >= 0 && confirmIdx >= 0, '删除确认页必须同时提供「取消」与「确认删除」')
assert.ok(cancelIdx < confirmIdx, '「取消」必须排在第一位，使默认光标落在取消上')

// 3) install.sh 不应再含 bash 版菜单与手输确认。
for (const gone of ['ui_page_select "选择操作"', 'ui_page_select "安装方式"', 'ui_page_select "更新哪一层"', '请输入 DELETE 继续']) {
  assert.ok(!installSh.includes(gone), `install.sh 不该再有 bash 版界面：${gone}`)
}
// 删除确认改为由向导回传 delete_confirmed。
assert.match(installSh, /delete_confirmed\) DSH_DELETE_CONFIRMED=1/, 'install.sh 必须接受向导的删除确认')
assert.match(installSh, /DSH_WIZARD_DONE=true/, 'install.sh 必须在读入答案后标记向导已完成')

// 4) 拿不到向导二进制时，报错要给出可执行的修复方式，而不是静默回退。
//    指引由 dsh_installer_missing_help 统一提供，两条入口（交互路径 / 命令行安装）
//    都调它——同一份文案写两遍必然漂移。
const helpFn = installSh.slice(
  installSh.indexOf('dsh_installer_missing_help()'),
  installSh.indexOf('dsh_installer_missing_help()') + 2000,
)
assert.match(helpFn, /无法获取安装向导/, '拿不到二进制时必须明确报错')
assert.match(helpFn, /DSH_INSTALLER_BASE/, '报错必须给出镜像源覆盖方式')
assert.match(helpFn, /DSH_INSTALLER_BIN/, '报错必须给出本地二进制的指定方式')
assert.match(helpFn, /--non-interactive/, '报错必须给出无人值守的出路')
assert.match(helpFn, /--quick/, '报错必须给出快速安装的出路')
// 两条入口都必须调用它，而不是自己另写一段。
assert.match(
  installSh,
  /if \[ "\$guided" = true \]; then\n\s+#[^\n]*\n\s+dsh_installer_missing_help/,
  '执行外壳在带向导且拿不到二进制时必须给出修复指引',
)
// 不再有「回退到 bash 向导」的分支：交互路径通过一个入口函数进入，不套 if/else 兜底。
assert.match(installSh, /^\s+run_guided_session$/m, '交互路径必须通过 run_guided_session 进入')

// 5) 无终端、无显式动作时仍然拒绝，并给出两条出路。
//    这一条不依赖向导二进制：守卫在向导之前就短路了。
const sandbox = await mkdtemp(join(tmpdir(), 'dsh-menu-smoke-'))
const mockBin = join(sandbox, 'bin')
await mkdir(mockBin)
await writeFile(join(mockBin, 'docker'), `#!/bin/sh
case "\${1:-}" in
  compose) exit 0 ;;
  container) exit 0 ;;
  inspect) printf 'running\\n'; exit 0 ;;
  ps) printf 'dsh\\n'; exit 0 ;;
esac
exit 0
`)
await chmod(join(mockBin, 'docker'), 0o755)

const proj = join(sandbox, 'proj')
await mkdir(proj)
await writeFile(join(proj, 'docker-compose.yml'), 'services: {}\n')
const msys = (p) => p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll('\\', '/')

const noMenu = spawnSync(bash, ['-c',
  `export PATH="${msys(mockBin)}:$PATH"; exec "$1" --dir "$2" </dev/null`,
  'menu-smoke', msys(installScript), msys(proj)], { encoding: 'utf8' })
const errOut = `${noMenu.stdout}${noMenu.stderr}`
assert.match(errOut, /没有可用的控制终端/, 'a terminal-less run without flags must explain the missing terminal')
assert.match(errOut, /--quick/, 'the error must offer the quick-install escape hatch')
assert.match(errOut, /--non-interactive/, 'the error must offer the unattended escape hatch')
assert.equal(noMenu.status, 2, 'the guard exits non-zero')

// 6) 有终端但拿不到向导二进制时，也必须失败并说明原因（不静默回退）。
//    这里用 DSH_INSTALLER_BIN 指向不存在的路径来模拟。
const missingBin = spawnSync(bash, ['-c',
  `export PATH="${msys(mockBin)}:$PATH"; export DSH_INSTALLER_BIN=/nonexistent/dsh-installer; ` +
  `exec "$1" --dir "$2" </dev/null`,
  'menu-smoke', msys(installScript), msys(proj)], { encoding: 'utf8' })
assert.notEqual(missingBin.status, 0, '缺少向导二进制时必须失败')

// 7) 确认摘要页仍要存在，且必须排在镜像/容器动作之前。
//    安装被拆成两段函数：准备（取源码、装配配置）与执行（拉镜像、起容器、自检）。
//    拆开是因为两条路径对准备阶段的位置要求不同：向导路径下它与执行阶段连续，
//    一起收进滚动日志；命令行路径下必须先准备好才能把摘要展示给人看。
assert.match(
  installSh,
  /confirm_install_plan\(\) \{/,
  'install.sh must define a pre-execution confirmation summary page',
)
// 命令行路径：准备 → 确认 → 执行。
assert.match(
  installSh,
  /install_prepare_body \|\| exit \$\?\n\s*confirm_install_plan\n\s*run_install_execution --prepared/,
  'the confirmation page must run after preparation and before any image or container work',
)
// 向导路径：用户已确认过，准备与执行一起进滚动日志。
//
// 切换发生在 Go 侧（root.go 的 updateWizard → startExec），所以 install.sh 这边
// 的形态是「什么都不做」——执行已经在界面里跑完了，再跑一遍等于装两次。
assert.match(
  installSh,
  /if \[ "\$\{DSH_WIZARD_DONE:-\}" = true \]; then[\s\S]{0,400}\n\s+:\n/,
  '向导路径必须跳过 bash 侧的执行（界面里已经跑过）',
)

// 两段本体都必须存在，且各自包含该做的动作。
assert.match(installSh, /^install_prepare_body\(\) \{$/m, 'install.sh 必须定义准备本体')
assert.match(installSh, /^install_execute_body\(\) \{$/m, 'install.sh 必须定义执行本体')
assert.match(
  installSh,
  /^install_prepare_body\(\) \{[\s\S]{0,1600}fetch_project/m,
  '取工程源码必须发生在准备本体内',
)
assert.match(
  installSh,
  /^install_execute_body\(\) \{[\s\S]{0,600}obtain_dsh_image/m,
  '拉取镜像必须发生在执行本体内',
)
// 执行外壳两种模式下都要跑到这两段。它们现在由 dsh_exec_body 调用——外壳负责起
// 后台执行体与界面，执行体负责等门闸后干这些活，两者分开才能让「等确认」不挡着界面。
assert.match(installSh, /^dsh_exec_body\(\) \{$/m, 'install.sh 必须定义后台执行体')
assert.match(
  installSh,
  /^dsh_exec_body\(\) \{[\s\S]{0,1500}install_prepare_body[\s\S]{0,400}install_execute_body/m,
  '后台执行体必须调用准备与执行两段本体',
)
// 后台执行体必须由执行外壳在后台起起来（否则界面起来时没人跑安装）。
assert.match(
  installSh,
  /dsh_exec_body [^\n]*\) >>"\$logfile" 2>&1 &/,
  '执行外壳必须把执行体放到后台并重定向进日志文件',
)
// 门闸：等确认，且只在带向导时由界面放行。
assert.match(installSh, /mkfifo "\$gate"/, '执行外壳必须用 FIFO 作门闸')
assert.match(installSh, /read -r _ < "\$gate"/, '后台执行体必须等门闸放行才开始')
assert.match(installSh, /--run-gate "\$gate"/, '带向导时必须把门闸路径交给界面')
assert.match(
  pagesGo,
  /\{"yes", "是", "执行当前操作"\}/,
  'the confirmation page must offer an explicit yes/no choice',
)
assert.match(
  installPs1,
  /function Confirm-InstallPlan \{/,
  'install.ps1 must define the same pre-execution confirmation page',
)

console.log('installer menu smoke: ok')
