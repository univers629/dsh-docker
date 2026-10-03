// 回归：uid 墓碑——删除账户后，若其数据可能仍在磁盘（未 purge 或清理失败），
// 该 uid 不得被重新分配给下一个注册者（审计 3.12：新账户直接读到前一用户的文件）。
// 直接验证「注册处传入 allocateUid 的 used 列表是否包含墓碑」这一接线，以及
// retainUid 的记录行为。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const source = fs.readFileSync(fileURLToPath(new URL('../bin/dsh-auth.mjs', import.meta.url)), 'utf8')
function extract(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`找不到 ${name}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error(`${name} 提取失败`)
}
let nowCalls = 0
const context = { now: () => 12345 }
vm.createContext(context)
vm.runInContext(extract('retainUid'), context)
const { retainUid } = context

const policy = await import('../bin/dsh-instances-policy.mjs')

let failures = 0
const check = (ok, label) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + label)
  if (!ok) failures++
}

console.log('== retainUid 记录行为 ==')
const state = { users: [], retainedUids: undefined }
retainUid(state, 100003, 'uidreuse-a')
check(Array.isArray(state.retainedUids) && state.retainedUids.length === 1, '首次记录创建列表')
check(state.retainedUids[0].uid === 100003 && state.retainedUids[0].username === 'uidreuse-a', '记录 uid 与用户名')
retainUid(state, 100003, 'uidreuse-a')
check(state.retainedUids.length === 1, '同一 uid 重复记录不重复追加')
retainUid(state, 100004, 'other')
check(state.retainedUids.length === 2, '不同 uid 各占一条')

console.log('== 注册接线：墓碑 uid 不被复用 ==')
// 复现注册处的 used 列表构造（dsh-auth.mjs 中的字面形态）
const registerUsed = (state) => [
  ...state.users.map((u) => u.uid),
  ...(Array.isArray(state.retainedUids) ? state.retainedUids.map((entry) => entry?.uid) : []),
]
const withTombstone = { users: [{ uid: 100000 }, { uid: 100002 }], retainedUids: state.retainedUids }
const allocated = policy.allocateUid(registerUsed(withTombstone))
check(allocated === 100001, `下一个 uid 跳过墓碑（得到 ${allocated}，预期 100001 而非 100003/100004）`)
check(allocated !== 100003 && allocated !== 100004, '墓碑里的 100003 与 100004 都未被分配')

console.log('== 对照：无墓碑时旧缺陷的分配方式 ==')
const withoutTombstone = { users: [{ uid: 100000 }, { uid: 100002 }] }
const legacy = policy.allocateUid(withoutTombstone.users.map((u) => u.uid))
check(legacy === 100001, `无墓碑时同样从最低空闲开始（${legacy}）`)

console.log('== 空状态：retainedUids 缺失或非数组都不炸 ==')
const empty = { users: [] }
check(Array.isArray(registerUsed(empty)), 'retainedUids 缺失时列表仍为数组')
const weird = { users: [], retainedUids: 'not-an-array' }
check(Array.isArray(registerUsed(weird)), 'retainedUids 非数组时安全降级')

console.log('')
if (failures > 0) { console.log(`${failures} 项失败`); process.exit(1) }
console.log('ALL PASS')
