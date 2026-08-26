import assert from 'node:assert/strict'
import {
  APT_EXECUTABLES,
  DEFAULT_LOCKOUT,
  PolicyError,
  attemptDelayMs,
  emptyLockoutState,
  findProtectedRemovals,
  isProtectedPackage,
  isRemovalSubcommand,
  lockoutRemainingSeconds,
  normalizeLockoutState,
  registerFailure,
  registerSuccess,
  validateAptCommand,
} from '../bin/dsh-privileged-policy.mjs'

// 特权代理的策略层是这套加固里唯一真正的提权入口，所以它的白名单和失败锁定
// 必须能在宿主机上直接单测，不依赖容器。

// --- 放行：日常安装/查询确实要能用，否则 Agent 装不了包 ---
const allowed = [
  ['apt-get', ['update']],
  ['apt-get', ['install', '-y', 'sl']],
  ['apt-get', ['install', '-y', '--no-install-recommends', 'ripgrep', 'jq']],
  ['apt-get', ['install', '-y', 'libssl3:amd64']],
  ['apt-get', ['install', '-y', 'sl=3.03-17build3']],
  ['apt-get', ['remove', '-y', 'sl']],
  ['apt-get', ['purge', '-y', 'sl']],
  ['apt-get', ['autoremove', '-y']],
  ['apt-get', ['clean']],
  ['apt-get', ['upgrade', '-y']],
  ['apt-get', ['build-dep', '-y', 'jq']],
  ['apt', ['list', '--installed']],
  ['apt-cache', ['policy', 'sl']],
  ['apt-cache', ['search', 'ripgrep']],
  ['apt-mark', ['hold', 'sl']],
]
for (const [command, args] of allowed) {
  const resolved = validateAptCommand(command, args)
  assert.equal(resolved.executable, APT_EXECUTABLES.get(command))
  assert.deepEqual(resolved.argv, [command, ...args])
}
assert.deepEqual(validateAptCommand('apt-get', ['install', '-y', 'sl', 'jq']).packages, ['sl', 'jq'])
assert.equal(validateAptCommand('apt-get', ['update']).subcommand, 'update')

// --- 拒绝：任何能把 apt 变成任意 root 命令的入口 ---
const denied = [
  ['dpkg', ['-i', 'payload.deb']],
  ['bash', ['-c', 'id']],
  ['apt-get', []],
  ['apt-get', ['source', 'bash']],
  ['apt-get', ['install', '-y', './payload.deb']],
  ['apt-get', ['install', '-y', '/tmp/payload.deb']],
  ['apt-get', ['install', '-y', '../payload.deb']],
  ['apt-get', ['install', '-y', 'sl', '-o', 'APT::Update::Pre-Invoke::=/bin/sh']],
  ['apt-get', ['-o', 'Dpkg::Options::=--force-all', 'install', '-y', 'sl']],
  ['apt-get', ['-c', '/tmp/apt.conf', 'update']],
  ['apt-get', ['-t', 'unstable', 'install', '-y', 'sl']],
  ['apt-get', ['--option', 'Foo=bar', 'update']],
  ['apt-get', ['install', '-y', 'sl*']],
  ['apt-get', ['install', '-y', '?name(sl)']],
  ['apt-get', ['install', '-y', 'sl;id']],
  ['apt-get', ['install', '-y', '$(id)']],
  ['apt-get', ['install', '-y', '--', 'sl']],
  ['apt-get', ['install', '-y', '']],
  ['apt-get', ['update', 'sl']],
  ['apt-get', ['install', '-y']],
  ['apt-get', ['install', '-y', 'SL']],
  ['apt-get', ['changelog', 'sl']],
  ['apt-get', ['install', '-y', ...Array.from({ length: 300 }, () => 'sl')]],
]
for (const [command, args] of denied) {
  assert.throws(
    () => validateAptCommand(command, args),
    PolicyError,
    `policy must reject ${command} ${args.join(' ')}`,
  )
}
assert.throws(() => validateAptCommand('apt-get', ['install', '-y', 42]), PolicyError)

// --- 失败锁定：延迟递增，达到阈值后指数锁定，成功后清零 ---
assert.deepEqual(emptyLockoutState(), { failures: 0, firstFailureAt: 0, lockedUntil: 0, lockLevel: 0 })
assert.deepEqual(normalizeLockoutState(null), emptyLockoutState())
assert.deepEqual(normalizeLockoutState({ failures: -3, lockedUntil: 'x' }), emptyLockoutState())
assert.deepEqual(normalizeLockoutState({ failures: 2.9 }).failures, 2)

let state = emptyLockoutState()
let now = 1_000
assert.equal(attemptDelayMs(state), DEFAULT_LOCKOUT.minDelayMs)
for (let attempt = 1; attempt < DEFAULT_LOCKOUT.maxFailures; attempt += 1) {
  state = registerFailure(state, now, DEFAULT_LOCKOUT)
  now += 1
  assert.equal(state.failures, attempt, 'failures accumulate inside the window')
  assert.equal(lockoutRemainingSeconds(state, now), 0, 'no lockout before the threshold')
  assert.equal(
    attemptDelayMs(state),
    DEFAULT_LOCKOUT.minDelayMs + attempt * DEFAULT_LOCKOUT.perFailureDelayMs,
    'each failure makes the next attempt slower',
  )
}
state = registerFailure(state, now, DEFAULT_LOCKOUT)
assert.equal(state.lockLevel, 1)
assert.equal(state.failures, 0, 'the counter resets once the lock is armed')
assert.equal(lockoutRemainingSeconds(state, now), DEFAULT_LOCKOUT.baseLockSeconds)
assert.equal(lockoutRemainingSeconds(state, now + DEFAULT_LOCKOUT.baseLockSeconds), 0)

// 第二轮锁定翻倍，重复触发按 2 的幂增长但不超过上限。
let second = state
for (let attempt = 0; attempt < DEFAULT_LOCKOUT.maxFailures; attempt += 1) {
  second = registerFailure(second, now, DEFAULT_LOCKOUT)
}
assert.equal(second.lockLevel, 2)
assert.equal(lockoutRemainingSeconds(second, now), DEFAULT_LOCKOUT.baseLockSeconds * 2)

let deep = { failures: DEFAULT_LOCKOUT.maxFailures - 1, firstFailureAt: now, lockedUntil: 0, lockLevel: 20 }
deep = registerFailure(deep, now, DEFAULT_LOCKOUT)
assert.equal(
  lockoutRemainingSeconds(deep, now),
  DEFAULT_LOCKOUT.maxLockSeconds,
  'the lock is capped so a legitimate admin is not locked out forever',
)

// 窗口外的孤立失败重新开始计数，避免长期偶发输错就被锁。
let sparse = registerFailure(emptyLockoutState(), 1_000, DEFAULT_LOCKOUT)
sparse = registerFailure(sparse, 1_000 + DEFAULT_LOCKOUT.failureWindowSeconds + 1, DEFAULT_LOCKOUT)
assert.equal(sparse.failures, 1, 'failures outside the window do not accumulate')

assert.deepEqual(registerSuccess(), emptyLockoutState())
assert.equal(
  attemptDelayMs({ failures: 1_000 }),
  DEFAULT_LOCKOUT.maxDelayMs,
  'the per-attempt delay stays bounded',
)

// --- 卸载保护：免密 apt 不能变成一条命令的自毁开关 ---
//
// 背景：remove/purge 一直在白名单里，`apt-get purge -y nginx` 因此可以把反向代理从
// 容器可写层里删掉。已经在跑的进程靠已删除的 inode 继续活着，容器看起来是 healthy，
// 直到下一次重启才发现再也起不来。所以显式点名受保护包必须在策略层就被拒。
const protectedRemovals = [
  ['apt-get', ['remove', '-y', 'nginx']],
  ['apt-get', ['purge', '-y', 'nginx-common']],
  ['apt-get', ['purge', '-y', 'libnginx-mod-stream']],
  ['apt-get', ['remove', '-y', 'ca-certificates']],
  ['apt-get', ['purge', '-y', 'openssl']],
  ['apt-get', ['remove', '-y', 'mawk']],
  ['apt-get', ['remove', '-y', 'util-linux']],
  ['apt-get', ['remove', '-y', 'passwd']],
  ['apt-get', ['purge', '-y', 'adduser']],
  // 架构限定与版本锁定都不能绕过比对。
  ['apt-get', ['purge', '-y', 'nginx:amd64']],
  ['apt-get', ['remove', '-y', 'openssl=3.5.4-1']],
  // 混在一堆无害包里也要被挑出来。
  ['apt-get', ['purge', '-y', 'sl', 'jq', 'nginx']],
  ['apt', ['remove', '-y', 'nginx']],
]
for (const [command, args] of protectedRemovals) {
  assert.throws(
    () => validateAptCommand(command, args),
    (error) => error instanceof PolicyError && /运行时依赖/.test(error.message),
    `${command} ${args.join(' ')} 必须被拒绝`,
  )
}

// 安装、重装、查询受保护包完全正常——这条闸只针对卸载。
for (const args of [['install', '-y', 'nginx'], ['install', '-y', '--reinstall', 'openssl'], ['show', 'mawk']]) {
  assert.ok(validateAptCommand('apt-get', args), `apt-get ${args.join(' ')} 不该被拦`)
}
// 用户自己装的东西照旧可以随便卸，否则免密 apt 就没意义了。
assert.equal(validateAptCommand('apt-get', ['purge', '-y', 'sl']).removal, true)
assert.equal(validateAptCommand('apt-get', ['install', '-y', 'sl']).removal, false)
assert.equal(validateAptCommand('apt-get', ['autoremove', '-y']).removal, true)
assert.equal(validateAptCommand('apt-get', ['autopurge', '-y']).removal, true)
assert.equal(validateAptCommand('apt-get', ['update']).removal, false)

assert.ok(isProtectedPackage('nginx-core'))
assert.ok(isProtectedPackage('nginx:arm64'))
assert.ok(!isProtectedPackage('nginxx'))
assert.ok(!isProtectedPackage('sl'))
assert.ok(isRemovalSubcommand('purge'))
assert.ok(!isRemovalSubcommand('install'))

// 策略层只看得见显式点名的包。真正危险的是 `purge <某个无害依赖>` 让 apt 级联把
// Nginx 一起带走，所以代理在执行前会用 apt -s 算一遍计划，再交给下面这个解析器。
assert.deepEqual(findProtectedRemovals('Remv nginx [1.26.3-3+deb13u7]'), ['nginx'])
assert.deepEqual(findProtectedRemovals('Purg ca-certificates [20250419]'), ['ca-certificates'])
assert.deepEqual(
  findProtectedRemovals(['Remv libpcre2-8-0 [10.45-1]', 'Remv nginx [1.26.3-3+deb13u7]'].join('\n')),
  ['nginx'],
  '级联卸载同样要被识别出来',
)
assert.deepEqual(findProtectedRemovals('  Remv nginx:amd64 [1.26.3]'), ['nginx'], '缩进与架构后缀都要容忍')
assert.deepEqual(
  findProtectedRemovals(['Remv nginx [1]', 'Purg nginx-common [1]'].join('\n')),
  ['nginx', 'nginx-common'],
)
assert.deepEqual(findProtectedRemovals('Remv sl [3.03-17build3]'), [], '无害计划不应误报')
assert.deepEqual(findProtectedRemovals('Inst nginx [1.26.3] (1.26.4 Debian:13/stable [amd64])'), [], 'Inst 不是卸载')
assert.deepEqual(findProtectedRemovals('这行提到了 Remv 但不在行首以外的位置无所谓'), [])
assert.deepEqual(findProtectedRemovals(''), [])
assert.deepEqual(findProtectedRemovals(null), [])
assert.deepEqual(findProtectedRemovals(undefined), [])
console.log('privileged policy smoke: ok')
