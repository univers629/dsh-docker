// 回归：已有部署上必须能进主菜单做维护（更新/删除），而不是撞上"容器已存在"就死路。
//
// 为什么必须这样测：无 TTY 的 curl|bash 直灌默认走一键安装，那时主菜单根本不出现；
// 而服务器上的旧部署正是这个场景——用户想更新或卸载，却只看到"容器已经存在"的报错。
// --menu 是显式入口，必须即使没有 TTY 也能进入交互，且菜单要标出"安装"当前走不通。
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

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-menu-smoke-'))
const mockBin = join(sandbox, 'bin')
await mkdir(mockBin)

// docker 桩：让"容器已存在"成立，且不真的调 docker
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

// 工程目录：避免走到 fetch_project（它会去拉远端源码）
const proj = join(sandbox, 'proj')
await mkdir(proj)
await writeFile(join(proj, 'docker-compose.yml'), 'services: {}\n')

const run = (args, input) => spawnSync(bash, ['-c', `export PATH="${mockBin}:$PATH"; exec "$1" "$@"`, 'menu-smoke', installScript, ...args], {
  input: input ?? '',
  encoding: 'utf8',
})
const msys = (p) => p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll('\\', '/')

// 1) --menu 必须画出主菜单，更新与删除都可选
const withMenu = spawnSync(bash, ['-c',
  `export PATH="${msys(mockBin)}:$PATH"; exec "$1" --menu --dir "$2" <<'EOF'\n2\n1\nEOF`,
  'menu-smoke', msys(installScript), msys(proj)], { encoding: 'utf8' })
const menuOut = `${withMenu.stdout}${withMenu.stderr}`
assert.match(menuOut, /选择操作/, 'the main menu page must be shown with --menu')
assert.match(menuOut, /更新/, 'the menu must offer update')
assert.match(menuOut, /卸载/, 'the menu must offer uninstall')
assert.match(menuOut, /安装/, 'the menu must offer install')
assert.match(menuOut, /更新哪一层|只更新容器内的 DSH/, 'choosing update must reach the update submenu')

// 2) 有容器时，菜单里要说明"安装"当前不可用，而不是让人选了才报错
assert.match(menuOut, /安装（当前不可用/, 'the menu must mark install unavailable while a container exists')

// 3) 没有终端、也没有显式动作时必须报错，并指出两条出路。
//    旧契约（无 TTY ⇒ 隐式一键安装）已废弃：默认动作是显示向导。
const noMenu = spawnSync(bash, ['-c',
  `export PATH="${msys(mockBin)}:$PATH"; exec "$1" --dir "$2" </dev/null`,
  'menu-smoke', msys(installScript), msys(proj)], { encoding: 'utf8' })
const errOut = `${noMenu.stdout}${noMenu.stderr}`
assert.match(errOut, /没有可用的控制终端/, 'a terminal-less run without flags must explain the missing terminal')
assert.match(errOut, /--quick/, 'the error must offer the quick-install escape hatch')
assert.match(errOut, /--non-interactive/, 'the error must offer the unattended escape hatch')
assert.equal(noMenu.status, 2, 'the guard exits non-zero')

// 3b) 有终端（--menu）时才进主菜单；容器已存在时该页把「安装」标注为不可用。
//     容器存在守卫本身仍由安装路径执行，这里断言的是它在菜单里被提前说明。
assert.match(menuOut, /容器已存在/, 'the menu must say why install is unavailable')

// 4) 安装分支里必须能选「一键安装」与「手动配置」——一键不再是靠 TTY 隐式决定的
const installPage = spawnSync(bash, ['-c',
  `export PATH="${msys(mockBin)}:$PATH"; exec "$1" --menu --dir "$2" <<'EOF'\n1\n1\nEOF`,
  'menu-smoke', msys(installScript), msys(proj)], { encoding: 'utf8' })
const installOut = `${installPage.stdout}${installPage.stderr}`
assert.match(installOut, /安装方式|一键安装/, 'the install branch must offer a quick-install page')
assert.match(installOut, /手动配置/, 'the install branch must offer manual configuration')

// 5) 执行前的确认摘要页必须存在（对齐 dpanel 安装器第 7 页「确认是否执行」）。
//    这条断言的是「配置问完、写盘之前会停下来让人看一眼」，所以只检查结构，
//    不触发真实安装。
const installSh = readFileSync(installScript, 'utf8')
const installPs1 = readFileSync(join(root, 'install.ps1'), 'utf8')
assert.match(
  installSh,
  /confirm_install_plan\(\) \{/,
  'install.sh must define a pre-execution confirmation summary page',
)
assert.match(
  installSh,
  /confirm_install_plan\n\s*obtain_dsh_image/,
  'the confirmation page must run after configuration and before any image or container work',
)
assert.match(
  installSh,
  /"yes\t是\t执行当前操作"/,
  'the confirmation page must offer an explicit yes/no choice',
)
assert.match(
  installPs1,
  /function Confirm-InstallPlan \{/,
  'install.ps1 must define the same pre-execution confirmation page',
)

console.log('installer menu smoke: ok')
