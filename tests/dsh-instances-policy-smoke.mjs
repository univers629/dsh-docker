// dsh-instances 策略层测试：身份分配、容器规格安全基线、闲置回收、水位滞回、
// 唤醒决策、磁盘配额。纯函数，无 IO。

import assert from 'node:assert/strict'

import {
  DEFAULT_MEMORY_MB,
  defaultNodeHeapMb,
  INSTANCE_PORT,
  SHRINK_IDLE_TIMEOUT_MS,
  UID_BASE,
  WATERMARK,
  allocateUid,
  buildContainerSpec,
  checkDiskQuota,
  decideIdle,
  decideWake,
  effectiveIdleTimeout,
  instanceName,
  planReclaim,
  watermarkMode,
} from '../bin/dsh-instances-policy.mjs'

// ---------- UID 分配 ----------
assert.equal(allocateUid([]), UID_BASE, 'first uid is the base')
assert.equal(allocateUid([UID_BASE]), UID_BASE + 1, 'skips taken uid')
assert.equal(allocateUid([UID_BASE, UID_BASE + 1, UID_BASE + 3]), UID_BASE + 2, 'fills the first gap')
assert.equal(allocateUid([1000, 99999]), UID_BASE, 'ignores uids outside the instance range')
assert.equal(allocateUid(null), UID_BASE, 'tolerates missing input')

// ---------- 实例名 ----------
assert.equal(instanceName(UID_BASE), 'dsh-u1')
assert.equal(instanceName(UID_BASE + 4), 'dsh-u5')
assert.throws(() => instanceName(999), /invalid instance uid/, 'uid below base rejected')
assert.throws(() => instanceName(Number.NaN), /invalid instance uid/, 'non-integer uid rejected')
assert.equal(INSTANCE_PORT, 3080, 'instances are reached through the in-container nginx port')

// ---------- 容器规格：安全基线必须逐条在位 ----------
const spec = buildContainerSpec({
  name: 'dsh-u1', uid: UID_BASE, image: 'dsh:local', network: 'dsh-private',
  dataDir: '/srv/dsh/data/users/100000',
})
const joined = spec.join(' ')
assert.ok(spec.includes('--cap-drop') && spec.includes('ALL'), 'capabilities dropped')
// 入口需要这几个能力才能 chown 挂载目录并降权；与主容器保持同一套。
for (const capability of ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETGID', 'SETUID', 'KILL']) {
  assert.ok(joined.includes(`--cap-add ${capability}`), `instance needs ${capability} to run the entrypoint`)
}
for (const forbidden of ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'MKNOD', 'NET_RAW']) {
  assert.ok(!joined.includes(forbidden), `instance must never hold ${forbidden}`)
}
assert.ok(joined.includes('no-new-privileges'), 'no-new-privileges set')
assert.ok(!joined.includes('--user'), 'instances must boot as root: the entrypoint drops privileges itself')
assert.ok(joined.includes(`--memory ${DEFAULT_MEMORY_MB}m`), 'memory limit applied')
assert.ok(joined.includes(`--memory-swap ${DEFAULT_MEMORY_MB}m`), 'swap pinned to the same limit')
assert.ok(joined.includes('--pids-limit 256'), 'pids limited')
assert.ok(!spec.includes('--read-only'), 'instances keep a writable rootfs: the entrypoint writes /etc/shadow and /run/dsh-*')
assert.ok(joined.includes('/data/dsh:rw'), 'DSH home mounted writable for this instance only')
assert.ok(joined.includes('/workspace:rw'), 'workspace mounted for this instance only')
// DSH 把这三个目录声明为可写（DSH_WRITABLE_PATHS），Agent 会把产物写进 /data/home。
// 不挂它们的话文件落在容器可写层：用户在自己的工作区里看不到，容器一重建就丢。
for (const target of ['/data/home:rw', '/data/agents:rw', '/data/mcp:rw']) {
  assert.ok(joined.includes(target), `${target} 必须挂到宿主，否则 Agent 产物不可见且不持久`)
}
assert.ok(!joined.includes('settings.yaml:'), 'no nested file mount inside the DSH home: it breaks on file-sharing hosts')
assert.ok(joined.includes(`--max-old-space-size=${defaultNodeHeapMb(DEFAULT_MEMORY_MB)}`), 'node heap capped')
assert.ok(joined.includes('DSH_ACCESS_MODE=password'), 'inner nginx auth disabled: the gateway is the gate')
assert.ok(!joined.includes('DSH_ACCESS_MODE=basic'), 'instances must not require Basic Auth')
assert.ok(!joined.includes('docker.sock'), 'no docker socket inside user instances')
assert.ok(!joined.includes('--privileged'), 'never privileged')
assert.ok(joined.includes('--restart no'), 'no automatic restart storms')

// 规格参数校验
assert.throws(() => buildContainerSpec({ name: 'x', uid: UID_BASE, image: 'i', network: 'n', dataDir: 'd', memoryMb: 32 }), /below 64MB/, 'absurd memory rejected')
assert.throws(() => buildContainerSpec({ name: 'x', uid: UID_BASE, image: 'i', network: 'n', dataDir: 'd', memoryMb: 128, nodeHeapMb: 128 }), /heap must stay below/, 'heap >= memory rejected')
assert.throws(() => buildContainerSpec({ uid: UID_BASE, image: 'i', network: 'n', dataDir: 'd' }), /requires name/, 'missing fields rejected')

// ---------- 闲置判定 ----------
const now = 1_700_000_000_000
const idle = (over) => decideIdle({ running: true, busy: false, lastSeenAt: now - 60_000, now, idleTimeoutMs: 30 * 60_000, ...over })
assert.equal(idle({}).stop, false, 'recent activity keeps it running')
assert.equal(idle({ lastSeenAt: now - 31 * 60_000 }).stop, true, 'idle past the threshold stops')
assert.equal(idle({ lastSeenAt: now - 31 * 60_000 }).reason, 'idle')
assert.equal(idle({ busy: true, lastSeenAt: now - 10 * 3600_000 }).stop, false, 'busy instance is never stopped')
assert.equal(idle({ running: false }).reason, 'not_running')
assert.equal(idle({ lastSeenAt: Number.NaN }).stop, false, 'unknown activity is treated conservatively')
// 固化优先于一切：闲置再久、内存再紧张都不回收，连 busy 判定都不必看
assert.equal(idle({ pinned: true, lastSeenAt: now - 10 * 3600_000 }).stop, false, 'a pinned instance is never reclaimed')
assert.equal(idle({ pinned: true, lastSeenAt: now - 10 * 3600_000 }).reason, 'pinned', 'the reason names pinning')
assert.equal(idle({ pinned: true, busy: true, lastSeenAt: now - 10 * 3600_000 }).stop, false, 'pin wins over every other signal')

// ---------- 水位决策（含滞回） ----------
// 压力 = 需求/(需求+可用)。按定义反解出落进各区间的实例数，而不是写死 200MB 时的
// 具体数字：默认内存上限会随宿主规模调整，写死的话调一次默认值这里就跟着红。
const perInstanceMb = DEFAULT_MEMORY_MB
const MB = 1024 ** 2
// 给定可用内存，求「压力达到 target 所需的在线实例数」。
const countForPressure = (target, availableMb) =>
  Math.round((target * availableMb) / (perInstanceMb * (1 - target)))

const wideAvailable = 8 * 1024
const narrowAvailable = 2 * 1024
const lowCount = Math.max(1, Math.round(countForPressure(0.20, wideAvailable)))
const shrinkCount = countForPressure(0.75, narrowAvailable)
const emergencyCount = countForPressure(0.95, narrowAvailable)

assert.equal(watermarkMode({ onlineCount: 0, perInstanceMb, availableBytes: wideAvailable * MB }), 'normal', 'no demand')
assert.equal(
  watermarkMode({ onlineCount: lowCount, perInstanceMb, availableBytes: wideAvailable * MB }),
  'normal',
  'low pressure is normal',
)
assert.equal(
  watermarkMode({ onlineCount: emergencyCount, perInstanceMb, availableBytes: narrowAvailable * MB }),
  'emergency',
  'very high pressure is emergency',
)
assert.equal(
  watermarkMode({ onlineCount: shrinkCount, perInstanceMb, availableBytes: narrowAvailable * MB }),
  'shrink',
  'high pressure shrinks',
)
// 滞回：0.75 已高于 recover(0.60)，收缩态不应立刻恢复
assert.equal(
  watermarkMode({ onlineCount: shrinkCount, perInstanceMb, availableBytes: narrowAvailable * MB, previous: 'shrink' }),
  'shrink',
  'hysteresis keeps shrink above recover',
)
assert.equal(
  watermarkMode({ onlineCount: lowCount, perInstanceMb, availableBytes: wideAvailable * MB, previous: 'shrink' }),
  'normal',
  'recovers once below recover threshold',
)
assert.ok(WATERMARK.recover < WATERMARK.shrink && WATERMARK.shrink < WATERMARK.emergency, 'thresholds are ordered')

// ---------- 回收规划 ----------
const instances = [
  { name: 'dsh-u1', running: true, busy: false, lastSeenAt: now - 5 * 60_000 },
  { name: 'dsh-u2', running: true, busy: false, lastSeenAt: now - 120 * 60_000 },
  { name: 'dsh-u3', running: true, busy: true, lastSeenAt: now - 300 * 60_000 },
  { name: 'dsh-u4', running: false, busy: false, lastSeenAt: now - 300 * 60_000 },
  { name: 'dsh-u5', running: true, busy: false, lastSeenAt: now - 60 * 60_000 },
]
const reclaim = planReclaim({ instances, now, idleTimeoutMs: 30 * 60_000 })
assert.deepEqual(reclaim, ['dsh-u2', 'dsh-u5'], 'stops only idle running instances, longest-idle first')
assert.ok(!reclaim.includes('dsh-u3'), 'busy instance spared')
assert.ok(!reclaim.includes('dsh-u4'), 'already-stopped instance not re-stopped')
assert.deepEqual(planReclaim({ instances, now, idleTimeoutMs: 30 * 60_000, limit: 1 }), ['dsh-u2'], 'limit caps the reclaim batch')
assert.deepEqual(planReclaim({ instances: [], now, idleTimeoutMs: 1000 }), [], 'empty input is safe')
// 固化实例不进回收名单：它在最久闲置的位置也不被选中，紧急模式的限额也不该浪费在它身上。
const withPinned = [
  { name: 'dsh-u2', running: true, busy: false, lastSeenAt: now - 120 * 60_000 },
  { name: 'dsh-pinned', running: true, busy: false, pinned: true, lastSeenAt: now - 999 * 60_000 },
  { name: 'dsh-u5', running: true, busy: false, lastSeenAt: now - 60 * 60_000 },
]
assert.deepEqual(
  planReclaim({ instances: withPinned, now, idleTimeoutMs: 30 * 60_000 }),
  ['dsh-u2', 'dsh-u5'],
  'a pinned instance is excluded even though it is the longest idle',
)

// ---------- 生效阈值 ----------
assert.equal(effectiveIdleTimeout('normal', 30 * 60_000), 30 * 60_000)
assert.equal(effectiveIdleTimeout('shrink', 30 * 60_000), SHRINK_IDLE_TIMEOUT_MS)
assert.equal(effectiveIdleTimeout('emergency', 30 * 60_000), SHRINK_IDLE_TIMEOUT_MS)
assert.equal(effectiveIdleTimeout('shrink', 60_000), 60_000, 'never extends a shorter configured timeout')

// ---------- 唤醒决策 ----------
assert.deepEqual(decideWake('normal', 0), { allow: true, reason: 'immediate' })
assert.deepEqual(decideWake('shrink', 0), { allow: true, reason: 'queued' })
assert.equal(decideWake('emergency', 0).allow, false, 'emergency pauses waking')
assert.equal(decideWake('normal', 8).allow, false, 'queue full rejects')
assert.equal(decideWake('normal', 7).allow, true)

// ---------- 磁盘配额 ----------
const GB = 1024 ** 3
assert.deepEqual(checkDiskQuota(1, 0), { allowed: true, percent: 0, level: 'ok' }, 'no quota means unlimited')
assert.equal(checkDiskQuota(4 * GB, 5 * GB).level, 'ok')
assert.equal(checkDiskQuota(4.6 * GB, 5 * GB).level, 'warn')
assert.equal(checkDiskQuota(5 * GB, 5 * GB).level, 'over')
assert.equal(checkDiskQuota(6 * GB, 5 * GB).allowed, false, 'over quota blocks writes')

console.log('dsh-instances policy smoke: ok')
