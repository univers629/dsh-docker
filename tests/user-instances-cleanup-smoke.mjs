// 回归：删除多用户的每用户实例资源时，只能碰 DSH 自己创建的。
//
// 为什么必须这样测：dsh-instances 动态创建的容器/卷/网络**不带任何 Docker 标签**，
// 只能按命名规则识别。命名规则写宽一个字符，就可能删掉宿主上别的项目的资源——
// 而这一步是不可恢复的。
//
// 测试用 docker 桩回放一份「混合了 DSH 资源与他人资源」的清单，断言：
//   该删的都删了（dsh-u<N> / dsh-user-<uid>-{home,workspace} / dsh-instances-net-u<N>）
//   不该删的一个都没碰（名字相近但不符合规则、以及其他项目的）
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installSh = readFileSync(join(root, 'install.sh'), 'utf8')
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`]
    .find((entry) => existsSync(entry))
  : 'bash'
assert.ok(bash, 'bash is required for the instances cleanup test')

// 结构断言：删除流程必须调用它，且必须排在按标签过滤之后。
assert.match(installSh, /^cleanup_user_instances\(\) \{$/m, 'install.sh 必须定义 cleanup_user_instances')
assert.match(
  installSh,
  /^delete_project\(\) \{[\s\S]{0,6000}cleanup_user_instances/m,
  'delete_project 必须调用 cleanup_user_instances',
)
// 命名规则必须与 dsh-instances 的实现一致，否则会漏删或误删。
const policy = readFileSync(join(root, 'bin', 'dsh-instances-policy.mjs'), 'utf8')
assert.match(policy, /return `dsh-u\$\{uid - UID_BASE \+ 1\}`/, '实例容器命名规则应仍为 dsh-u<N>')
const instances = readFileSync(join(root, 'bin', 'dsh-instances.mjs'), 'utf8')
assert.match(instances, /volumePrefix: process\.env\.DSH_INSTANCE_VOLUME_PREFIX \?\? 'dsh-user'/, '卷前缀应仍为 dsh-user')
assert.match(instances, /network: process\.env\.DSH_INSTANCE_NETWORK \?\? 'dsh-instances-net'/, '网络前缀应仍为 dsh-instances-net')

// 抽出函数体，配一个回放式 docker 桩来跑。
const start = installSh.indexOf('cleanup_user_instances() {')
assert.ok(start > 0, '找不到 cleanup_user_instances')
const body = installSh.slice(start)
const end = body.indexOf('\n}\n')
assert.ok(end > 0, 'cleanup_user_instances 未正常结束')
const fn = body.slice(0, end + 2)

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-instances-cleanup-'))
const mockBin = join(sandbox, 'bin')
mkdirSync(mockBin)
const calls = join(sandbox, 'calls.txt')
writeFileSync(calls, '')
writeFileSync(join(mockBin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${calls}"
case "$1 $2" in
  "container ls")
    cat <<'LIST'
c1 dsh-u1
c2 dsh-u2
c3 dsh-u12
c4 dsh
c5 dsh-auth
c6 dsh-instances
c7 dsh-u
c8 dsh-u1-extra
c9 dsh-user1
c10 my-dsh-u3
c11 dsh-utils
c12 otherapp
LIST
    exit 0 ;;
  "volume ls")
    cat <<'LIST'
dsh-user-100000-home
dsh-user-100000-workspace
dsh-user-100001-home
dsh-user-100001-workspace
dsh-user-data
dsh-user-abc-home
dsh-user-100002-cache
my-dsh-user-100003-home
dsh-user-100004-HOME
LIST
    exit 0 ;;
  "network ls")
    cat <<'LIST'
n1 dsh-instances-net-u1
n2 dsh-instances-net-u2
n3 dsh-instances-net
n4 dsh-private
n5 dsh-instances-net-uX
n6 other-net-u1
n7 dsh-instances-net-u1-extra
LIST
    exit 0 ;;
esac
exit 0
`)
chmodSync(join(mockBin, 'docker'), 0o755)

const runner = join(sandbox, 'run.sh')
writeFileSync(runner, `#!/usr/bin/env bash
set -uo pipefail
DOCKER() { docker "$@"; }
${fn}
cleanup_user_instances
`)

const res = spawnSync(bash, [runner], {
  encoding: 'utf8',
  env: { ...process.env, PATH: mockBin + ':' + (process.env.PATH ?? '') },
})
assert.equal(res.status, 0, `执行失败：${res.stderr}`)

const made = readFileSync(calls, 'utf8')
const has = (s) => made.includes(s)

// 该删的
for (const item of [
  'container rm -f c1', 'container rm -f c2', 'container rm -f c3',
  'volume rm -f dsh-user-100000-home', 'volume rm -f dsh-user-100000-workspace',
  'volume rm -f dsh-user-100001-home', 'volume rm -f dsh-user-100001-workspace',
  'network rm n1', 'network rm n2',
]) {
  assert.ok(has(item), `应删除却未删除：${item}`)
}

// 绝不该删的：名字相近但不是我们创建的，以及其他项目的资源
for (const item of [
  'container rm -f c4',   // dsh 本体由 compose down 处理，不在这里删
  'container rm -f c5',   // dsh-auth
  'container rm -f c6',   // dsh-instances
  'container rm -f c7',   // dsh-u 无数字
  'container rm -f c8',   // dsh-u1-extra 后缀非纯数字
  'container rm -f c9',   // dsh-user1 少了连字符
  'container rm -f c10',  // my-dsh-u3 前缀不符
  'container rm -f c11',  // dsh-utils
  'container rm -f c12',  // otherapp
  'volume rm -f dsh-user-data',
  'volume rm -f dsh-user-abc-home',
  'volume rm -f dsh-user-100002-cache',
  'volume rm -f my-dsh-user-100003-home',
  'volume rm -f dsh-user-100004-HOME',
  'network rm n3',        // dsh-instances-net 无 -u<N>
  'network rm n4',        // dsh-private
  'network rm n5',        // dsh-instances-net-uX
  'network rm n6',        // other-net-u1
  'network rm n7',        // dsh-instances-net-u1-extra
]) {
  assert.ok(!has(item), `误删了不该动的资源：${item}`)
}

console.log('user instances cleanup smoke: ok（只删 DSH 自己的实例资源）')
