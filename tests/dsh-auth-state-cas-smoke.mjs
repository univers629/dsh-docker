// 回归：过期快照的写入必须响亮失败，而不是静默回退安全决策（审计 3.9 的场景）。
// 用仓库自身的 openStore + dsh-auth 的 CAS 辅助（逐字提取），重放审计的复现顺序：
//   快照 A（失败登录）先取 → 快照 B（管理员停用）先写 → A 再写。
// 旧行为：A 把停用回退成 enabled（审计实测）。CAS 后：A 的写入被拒绝。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-cas-'))
const file = path.join(work, 'state.json')

const store = await import('../bin/dsh-auth-store.mjs')
const handle = store.openStore(file)
handle.write({
  version: 1,
  setup: { initialized: true, multiUser: true, registerGate: 'open' },
  users: [{ id: 'u-1', username: 'alice', role: 'user', status: 'enabled', authVersion: 7, sessions: [] }],
  sessions: [{ id: 's1' }, { id: 's2' }],
  flows: [],
  audit: [],
  tokens: {},
})

// 从 dsh-auth.mjs 提取 CAS 辅助（该文件 import 即起服务，不能直接 import）
const source = fs.readFileSync(fileURLToPath(new URL('../bin/dsh-auth.mjs', import.meta.url)), 'utf8')
function extract(name) {
  const start = source.indexOf(`class ${name}`) >= 0
    ? source.indexOf(`class ${name}`)
    : source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`找不到 ${name}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error(`${name} 提取失败`)
}
// 供 CAS 辅助引用的最小环境
class StateConflictError extends Error {}
const context = {
  store: handle,
  StateConflictError,
  prune: (state) => state, // 纯计数语义不需要过期回收
}
vm.createContext(context)
for (const name of ['StateConflictError', 'attachRevision', 'readState', 'freshState', 'commitState']) {
  vm.runInContext(extract(name), context)
}
// class 声明是词法绑定，不会挂到 context 上；显式取出来才能做真实的 instanceof。
vm.runInContext('this.__Conflict = StateConflictError', context)
const { readState, freshState, commitState } = context
const Conflict = context.__Conflict

let failures = 0
const check = (ok, label) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + label)
  if (!ok) failures++
}

console.log('== 审计场景 1：并发写入不得回退停用 ==')
const snapshotA = readState()          // 失败登录的快照（先取）
const snapshotB = freshState()         // 管理员停用的快照
const target = snapshotB.users.find((u) => u.username === 'alice')
target.status = 'disabled'
target.authVersion += 1
commitState(snapshotB)                  // 管理员先写：停用生效
check(handle.read().users[0].status === 'disabled', '停用已落盘')

let conflicted = false
try {
  snapshotA.users.find((u) => u.username === 'alice').lastLoginAt = Date.now()
  commitState(snapshotA)               // 过期快照后写
} catch (error) {
  conflicted = error instanceof Conflict
}
check(conflicted, '过期快照的写入被拒（StateConflictError）')
check(handle.read().users[0].status === 'disabled', '停用未被回退（旧缺陷在此处把 enabled 写了回去）')
check(handle.read().users[0].authVersion === 8, 'authVersion 未被回退')

console.log('== 审计场景 2：一次性挑战的消费不被回退 ==')
const b2 = freshState()
b2.flows = [{ purpose: 'totp_login', userId: 'u-1', consumedAt: 'now', expiresAt: Date.now() + 60000 }]
commitState(b2)
const a2 = readState()                 // 注意：readState 在 b2 写入之后读取
a2.sessions.push({ id: 's3' })
// 模拟另一个更早取的快照（revision 已过期）
const stale = readState()
a2.flows.find((f) => f.purpose === 'totp_login').consumedAt = 'now'
commitState(a2)                         // a2 的修订号在 stale 读取之后写入 → 过期
let staleConflicted = false
try {
  stale.sessions = stale.sessions.slice(0, 1)
  commitState(stale)
} catch (error) {
  staleConflicted = error instanceof Conflict
}
check(staleConflicted, '挑战消费后的过期写入同样被拒')
check(handle.read().flows[0]?.consumedAt === 'now', '挑战的消费状态保留')

console.log('== 场景 3：同一快照的连续多次写入仍然有效 ==')
const c = readState()
c.audit = [{ action: 'x' }]
commitState(c)
c.audit.push({ action: 'y' })
commitState(c)                          // 写入后 __rev 已同步，第二次应通过
check(handle.read().audit.length === 2, '同一请求内第二次写入成功')

console.log('== 场景 4：修订号不落盘（状态文件干净）==')
check(!fs.readFileSync(file, 'utf8').includes('__rev'), '状态文件不含 __rev')

fs.rmSync(work, { recursive: true, force: true })
console.log('')
if (failures > 0) { console.log(`${failures} 项失败`); process.exit(1) }
console.log('ALL PASS')
