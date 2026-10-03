// 多用户安装向导的冒烟测试。
//
// 两层验证：
//   1. 静态断言：旗标、向导分支、.env 键、叠加文件引用都在位；
//   2. 行为验证：把 configure_user_mode 抽出来，在真实 bash 里用桩函数运行，
//      检查「一键安装恒为单管理员」「显式旗标覆盖」「多用户强制 password 模式」
//      这些分支真的成立，而不是只存在于源码里。
//
// Windows 上没有 bash，此时用 WSL 运行；两者都没有则明确跳过行为验证，
// 只保留静态断言，不伪装成通过。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8')

const installSh = read('install.sh')
const multiuserCompose = read('docker-compose.multiuser.yml')
const envExample = read('.env.example')
const configureNginxAuth = read('bin/configure-nginx-auth')

// ---------------------------------------------------------------- 静态断言
assert.match(installSh, /MULTI_USER_OVERRIDE=""/, 'installer tracks a multi-user override')
assert.match(installSh, /--multi-user\) MULTI_USER_OVERRIDE=on ;;/)
assert.match(installSh, /--no-multi-user\) MULTI_USER_OVERRIDE=off ;;/)
assert.match(installSh, /--register-gate=\*\)/, 'invite gate flag exists')
assert.match(installSh, /--idle-timeout=\*\)/, 'idle timeout flag exists')
assert.match(installSh, /--user-disk-quota=\*\)/, 'disk quota flag exists')
assert.match(installSh, /configure_user_mode\(\) \{/, 'the user-mode wizard function exists')
assert.match(installSh, /configure_user_mode "\$access_mode"/, 'the wizard function is invoked')
assert.match(installSh, /4\) 多用户（开放注册 \+ 每用户独立实例；认证由内置网关承担）/, 'the access menu offers multi-user')
assert.match(installSh, /4\) access_mode=password; MULTI_USER_OVERRIDE=on ;;/, 'choosing multi-user pins password mode')
assert.match(installSh, /COMPOSE_ARGS\++=\(-f docker-compose\.multiuser\.yml\)/, 'the multi-user overlay is applied')
assert.match(installSh, /set_compose_env DSH_MULTI_USER "\$PENDING_MULTI_USER"/, 'the choice is persisted to .env')
assert.match(installSh, /set_compose_env DSH_REGISTER_GATE/, 'the register gate is persisted')
assert.match(installSh, /set_compose_env DSH_IDLE_TIMEOUT_SECONDS/, 'the idle timeout is persisted')
assert.match(installSh, /set_compose_env DSH_USER_DISK_QUOTA_BYTES/, 'the disk quota is persisted')

// password 模式必须叠加认证层：只设模式不部署网关，等于完全开放
assert.match(installSh, /if \[ "\$PENDING_ACCESS_MODE" = password \]; then/, 'password mode forces the auth overlay')
assert.match(installSh, /COMPOSE_ARGS\+=\(--profile authgate -f docker-compose\.auth\.yml\)/, 'the single-admin entry is activated by profile')
assert.match(installSh, /COMPOSE_ARGS\+=\(--profile multiuser\)/, 'the multi-user entry is activated by profile')

// dsh.sh 的多用户运维子命令
const dshSh = read('dsh.sh')
for (const action of ['users)', 'start-user)', 'stop-user)']) {
  assert.ok(dshSh.includes(action), `dsh.sh implements ${action}`)
}
assert.ok(dshSh.includes('multiuser_uid_for()'), 'dsh.sh resolves an account to its instance slot')
assert.ok(
  !/multiuser_uid_for\(\)[\s\S]{0,400}awk/.test(dshSh),
  'slot resolution must not parse JSON with awk: uid precedes username, so a sequential scan picks the wrong record',
)
assert.ok(dshSh.includes("find((instance) => instance.username === username)"), 'slot resolution matches the exact username in the registry')
assert.ok(/start-user <用户名>/.test(dshSh), 'the help text documents start-user')

for (const key of ['DSH_MULTI_USER', 'DSH_REGISTER_GATE', 'DSH_IDLE_TIMEOUT_SECONDS', 'DSH_USER_DISK_QUOTA_BYTES', 'DSH_INSTANCE_MEMORY_MB', 'DSH_MGMT_NETWORK']) {
  assert.ok(envExample.includes(`${key}=`), `.env.example documents ${key}`)
}

// 一键安装必须短路整个问答：它不该出现任何新提问
const quickGuard = /if \[ "\$QUICK_INSTALL" = true \]; then\s*\n\s*multi_user="\$existing"/
assert.match(installSh, quickGuard, 'quick install short-circuits the user-mode question')

// password 模式必须在容器内关闭认证，否则会出现第二道无人能通过的锁
assert.match(configureNginxAuth, /local\|trusted-proxy\|password\|''\)/, 'configure-nginx-auth accepts password mode')
assert.match(configureNginxAuth, /expected local, trusted-proxy, password, or basic/, 'the error message lists password')
assert.match(multiuserCompose, /DSH_ACCESS_MODE: "password"/, 'the multi-user overlay uses password mode')

// ---------------------------------------------------------------- 行为验证
// 抽出函数体，配桩函数后在真实 bash 里运行。
const start = installSh.indexOf('configure_user_mode() {')
const end = installSh.indexOf('\nbuild_dsh_image() {', start)
assert.ok(start > 0 && end > start, 'the wizard function can be extracted')
const functionBody = installSh.slice(start, end)

const harness = `
set -eu
# 桩：向导函数只依赖这两个外部命令
get_compose_env() { printf '%s\\n' "\${STUB_ENV_VALUE:-$2}"; }
prompt() { PROMPT_RESULT="\${STUB_ANSWER:-1}"; }
QUICK_INSTALL="\${STUB_QUICK:-false}"
MULTI_USER_OVERRIDE="\${STUB_MULTI_OVERRIDE:-}"
REGISTER_GATE_OVERRIDE="\${STUB_GATE_OVERRIDE:-}"
IDLE_TIMEOUT_OVERRIDE="\${STUB_IDLE_OVERRIDE:-}"
DISK_QUOTA_OVERRIDE="\${STUB_QUOTA_OVERRIDE:-}"

${functionBody}

configure_user_mode "\${STUB_ACCESS:-local}"
printf 'multi_user=%s register_gate=%s idle=%s quota=%s\\n' "$multi_user" "$register_gate" "$idle_timeout" "$user_disk_quota"
`

function findBash() {
  const candidates = [
    { command: 'bash', args: [] },
    { command: 'wsl.exe', args: ['-d', 'Debian13', '--', 'bash'] },
    { command: 'wsl.exe', args: ['--', 'bash'] },
  ]
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.args, '-c', 'echo ok'], { encoding: 'utf8', timeout: 30_000 })
    if (probe.status === 0 && (probe.stdout ?? '').includes('ok')) return candidate
  }
  return null
}

const bash = findBash()
if (!bash) {
  console.log('install multiuser smoke: ok (static assertions only; no bash available for behaviour checks)')
  process.exit(0)
}

const sandbox = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'dsh-wizard-'))
const harnessFile = path.join(sandbox, 'wizard.sh')
fs.writeFileSync(harnessFile, harness)

// 脚本从 stdin 交给 `bash -s`：不用管 Windows 路径怎么翻译，也不依赖跨环境变量传递。
// 场景值直接内联进脚本，避免 Windows→WSL 的环境变量透传差异。
const buildHarness = (scenario) => `
set -eu
get_compose_env() { printf '%s\\n' "\${2:-}"; }
prompt() { PROMPT_RESULT="${scenario.answer ?? '1'}"; }
QUICK_INSTALL="${scenario.quick ? 'true' : 'false'}"
MULTI_USER_OVERRIDE="${scenario.multiUser ?? ''}"
REGISTER_GATE_OVERRIDE="${scenario.gate ?? ''}"
IDLE_TIMEOUT_OVERRIDE="${scenario.idle ?? ''}"
DISK_QUOTA_OVERRIDE="${scenario.quota ?? ''}"

${functionBody}

configure_user_mode "${scenario.access ?? 'local'}"
printf 'RESULT multi_user=%s register_gate=%s idle=%s quota=%s\\n' "$multi_user" "$register_gate" "$idle_timeout" "$user_disk_quota"
`

/** 在 bash 里跑一次向导函数。 */
function runWizard(scenario) {
  const result = spawnSync(bash.command, [...bash.args, '-s'], {
    encoding: 'utf8',
    timeout: 60_000,
    input: buildHarness(scenario),
  })
  if (result.status !== 0) {
    throw new Error(`wizard run failed: ${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  const line = (result.stdout ?? '').split('\n').find((entry) => entry.startsWith('RESULT ')) ?? ''
  const parsed = {}
  for (const pair of line.replace('RESULT ', '').trim().split(/\s+/)) {
    const index = pair.indexOf('=')
    if (index > 0) parsed[pair.slice(0, index)] = pair.slice(index + 1)
  }
  return parsed
}

try {
  // 一键安装 + 无旗标 → 恒为单管理员，且默认参数落位
  const quick = runWizard({ quick: true, access: 'basic' })
  assert.equal(quick.multi_user, 'off', 'quick install stays single-administrator')
  assert.equal(quick.register_gate, 'open')
  assert.equal(quick.idle, '1800')
  assert.equal(quick.quota, '5')

  // 非 password 模式且无旗标 → 默认单管理员
  const localDefault = runWizard({ access: 'local' })
  assert.equal(localDefault.multi_user, 'off', 'non-password access stays single-administrator by default')

  // password 模式 + 交互选择多用户 → 开启，并走子问答
  const multi = runWizard({ access: 'password', answer: '2' })
  assert.equal(multi.multi_user, 'on', 'answering multi-user in the wizard enables it')

  // password 模式 + 选择单管理员 → 保持关闭
  const single = runWizard({ access: 'password', answer: '1' })
  assert.equal(single.multi_user, 'off', 'answering single-administrator keeps it off')

  // 显式旗标优先于问答
  const flagged = runWizard({ access: 'local', multiUser: 'on', quick: true })
  assert.equal(flagged.multi_user, 'on', 'the explicit flag wins over the default')
  const off = runWizard({ access: 'password', multiUser: 'off', answer: '2' })
  assert.equal(off.multi_user, 'off', 'the explicit opt-out wins over the answer')

  // 参数覆盖
  const tuned = runWizard({
    multiUser: 'on',
    quick: true,
    gate: 'invite',
    idle: '900',
    quota: '10',
  })
  assert.equal(tuned.multi_user, 'on')
  assert.equal(tuned.register_gate, 'invite', 'the invite gate flag reaches the result')
  assert.equal(tuned.idle, '900', 'the idle timeout flag reaches the result')
  assert.equal(tuned.quota, '10', 'the disk quota flag reaches the result')

  // 多用户 + 一键安装（无交互）也必须拿到可用默认值
  const multiQuick = runWizard({ multiUser: 'on', quick: true })
  assert.equal(multiQuick.register_gate, 'open')
  assert.equal(multiQuick.idle, '1800')
  assert.equal(multiQuick.quota, '5')

  console.log('install multiuser smoke: ok')
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}
