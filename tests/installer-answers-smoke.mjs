// 回归：向导回传的每个答案键都必须被 install.sh 正确接收。
//
// 为什么必须这样测：向导（Go）与执行（install.sh）是两个进程，靠一份 KEY=VALUE
// 文件通信。键名写错、少写一个 case 分支，都会让用户在向导里的选择静默失效——
// 他会看到向导问过了，然后 bash 又问一遍，或者干脆用了默认值。
//
// 做法：把 install.sh 里 dsh_installer_run 的解析段抽出来单独执行，
// 断言每个键都落到了预期的变量上。只测解析与映射，不触发任何安装动作。
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installSh = readFileSync(join(root, 'install.sh'), 'utf8')
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`]
    .find((entry) => existsSync(entry))
  : 'bash'
assert.ok(bash, 'bash is required for the answers smoke test')

// 抽出解析段：从解析循环开始到 DSH_WIZARD_DONE 标记。
const lines = installSh.split('\n')
const startIdx = lines.findIndex((l) => l.includes('逐行读入 KEY=VALUE'))
const endIdx = lines.findIndex((l) => l.includes('DSH_WIZARD_DONE=true'))
assert.ok(startIdx >= 0, '找不到答案解析段的起点')
assert.ok(endIdx > startIdx, '找不到答案解析段的终点（DSH_WIZARD_DONE=true）')
const parseSection = lines.slice(startIdx, endIdx + 1).join('\n')

// 变量初值必须与 install.sh 开头的默认值一致，否则测出来的差异可能来自初值。
const defaults = {
  ACTION: '', DSH_ANSWER_MODE: '', ACCESS_MODE_OVERRIDE: '', IMAGE_SOURCE_OVERRIDE: '',
  BIND_HOST_OVERRIDE: '', EGRESS_MODE_OVERRIDE: '', MULTI_USER_OVERRIDE: '',
  REGISTER_GATE_OVERRIDE: '', IDLE_TIMEOUT_OVERRIDE: '', DISK_QUOTA_OVERRIDE: '',
  KEY_ADMIN_OVERRIDE: '', ROOT_PASSWORD_OVERRIDE: '', NO_ROOT_PASSWORD_ANSWER: 'false',
  DSH_DELETE_KEEP: '', DSH_DELETE_CONFIRMED: '', PENDING_MODEL_BROKER: 'off',
  EGRESS_ALLOW_OVERRIDE: '', PENDING_BASIC_USER: '', PENDING_BASIC_PASSWORD: '',
  DSH_ANSWER_PROXY: '', DSH_ANSWER_PROXY_NETWORK: '', TRUSTED_PROXY_ACK: '',
  DSH_WIZARD_DONE: 'false',
}

// 一份覆盖全部键的答案文件。值里刻意带上空格、逗号与通配符，
// 用来验证「只按第一个 = 切分」的实现没有截断值。
const answers = {
  action: 'install',
  mode: 'manual',
  access: 'password',
  image_source: 'prebuilt',
  bind_host: '127.0.0.1',
  egress: 'allowlist',
  egress_allow: 'extra.example.com,*.other.com',
  multi_user: 'on',
  register_gate: 'invite',
  idle_timeout: '900',
  disk_quota: '10',
  key_admin: 'on',
  root_password: 'root-secret-123',
  no_root_password: 'yes',
  delete_keep: '1',
  delete_confirmed: 'yes',
  model_broker: 'on',
  basic_user: 'alice',
  basic_password: 'secret-password-123',
  proxy: 'docker',
  proxy_network: 'my-proxy-net',
  trusted_proxy_ack: 'yes',
}

const expect = {
  ACTION: 'install',
  DSH_ANSWER_MODE: 'manual',
  ACCESS_MODE_OVERRIDE: 'password',
  IMAGE_SOURCE_OVERRIDE: 'prebuilt',
  BIND_HOST_OVERRIDE: '127.0.0.1',
  EGRESS_MODE_OVERRIDE: 'allowlist',
  EGRESS_ALLOW_OVERRIDE: 'extra.example.com,*.other.com',
  MULTI_USER_OVERRIDE: 'on',
  REGISTER_GATE_OVERRIDE: 'invite',
  IDLE_TIMEOUT_OVERRIDE: '900',
  DISK_QUOTA_OVERRIDE: '10',
  KEY_ADMIN_OVERRIDE: 'on',
  ROOT_PASSWORD_OVERRIDE: 'root-secret-123',
  NO_ROOT_PASSWORD_ANSWER: 'true',
  DSH_DELETE_KEEP: '1',
  DSH_DELETE_CONFIRMED: '1',
  PENDING_MODEL_BROKER: 'on',
  PENDING_BASIC_USER: 'alice',
  PENDING_BASIC_PASSWORD: 'secret-password-123',
  DSH_ANSWER_PROXY: 'docker',
  DSH_ANSWER_PROXY_NETWORK: 'my-proxy-net',
  TRUSTED_PROXY_ACK: 'true',
  DSH_WIZARD_DONE: 'true',
}

// 键名必须与 Go 侧写入的集合一致：少一个就说明有答案被丢弃。
const goSource = readFileSync(join(root, 'cmd', 'dsh-installer', 'pages.go'), 'utf8')
  + readFileSync(join(root, 'cmd', 'dsh-installer', 'wizard.go'), 'utf8')
const goKeys = new Set([...goSource.matchAll(/answers\["([a-z_]+)"\]/g)].map((m) => m[1]))
const shKeys = new Set(Object.keys(answers))
for (const key of goKeys) {
  assert.ok(
    shKeys.has(key),
    `向导会回传 "${key}"，但解析测试没有覆盖它（install.sh 可能没有对应的 case 分支）`,
  )
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-answers-smoke-'))
const answersFile = join(sandbox, 'answers.txt')
writeFileSync(answersFile, Object.entries(answers).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')

const initLines = Object.entries(defaults).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n')
const reportKeys = Object.keys(defaults).map((k) => `  printf '%s=%s\\n' "${k}" "\${${k}:-}"`).join('\n')
const script = [
  'set -uo pipefail',
  initLines,
  `answers=${JSON.stringify(answersFile)}`,
  parseSection,
  reportKeys,
].join('\n') + '\n'
const scriptPath = join(sandbox, 'run.sh')
writeFileSync(scriptPath, script)

const result = spawnSync(bash, [scriptPath], { encoding: 'utf8' })
assert.equal(result.status, 0, `解析段执行失败：\n${result.stdout}\n${result.stderr}`)

const actual = {}
for (const line of result.stdout.split('\n')) {
  const idx = line.indexOf('=')
  if (idx > 0) actual[line.slice(0, idx)] = line.slice(idx + 1)
}

for (const [key, want] of Object.entries(expect)) {
  assert.equal(
    actual[key],
    want,
    `向导回传的 "${key}" 没有被正确接收：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual[key] ?? '(未设置)')}`,
  )
}

console.log(`installer answers smoke: ok（${Object.keys(expect).length} 个键全部正确接收）`)
