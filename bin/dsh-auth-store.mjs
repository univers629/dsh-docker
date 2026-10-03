// dsh-auth 状态库：单份 JSON 的原子读写 + TOTP 主密钥管理。
//
// 为什么不用 SQLite：本服务的规模是「一个自托管部署的几十个账户」，JSON 全量原子重写
// 足够且零依赖（镜像约定：只用 Node 内置模块）。写入一律「临时文件 + fsync + rename」，
// 崩溃不会留下半截状态；文件权限恒为 0600，属主由部署侧对齐。
//
// 状态结构（见 docs/auth-design.md §2、§4.1）：
//   {
//     version: 1,
//     setup:   { initialized: boolean, multiUser: boolean, registerGate: 'open'|'invite' },
//     users:   [ { id, username, role, status, passwordHash, authVersion, totp, passkeys, ... } ],
//     sessions:[ { tokenHash, csrfHash, userId, authVersion, expiresAt, ... } ],
//     flows:   [ { purpose, digest, userId, payload, expiresAt, consumedAt } ],
//     audit:   [ { at, actorId, action, ip, result, change } ],
//     tokens:  { inviteCode?: string }
//   }

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/** 状态库版本。结构不兼容变更时递增，并在打开时拒绝未知版本。 */
export const STATE_VERSION = 1

/** 审计环形上限：只保留最近 N 条，防止无限增长（威胁 T14 的容量面）。 */
export const AUDIT_LIMIT = 5000

function emptyState() {
  return {
    version: STATE_VERSION,
    setup: { initialized: false, multiUser: false, registerGate: 'open' },
    users: [],
    sessions: [],
    flows: [],
    audit: [],
    tokens: {},
  }
}

/**
 * 打开（或初始化）状态库。
 *
 * `revision()` 是一个单调递增的写入计数：调用方在读取时记下它，写入前比对，
 * 不一致就说明「快照之后有别的写入落盘」——这时应拒绝写入而不是盲目覆盖
 * （否则并发请求会互相回退安全决策：停用被撤销、一次性挑战变回可重放、
 * 会话被销毁，审计实测全部发生过）。
 * @param {string} file 状态文件路径（如 /data/auth/state.json）。
 * @returns {{read:()=>object, write:(state:object)=>void, revision:()=>number, path:string, dir:string}} 句柄。
 */
export function openStore(file) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let writeRevision = 0

  /** 当前写入修订号（每次成功写入后递增）。 */
  function revision() {
    return writeRevision
  }

  /** 读取当前状态；文件缺失或损坏时返回空状态（首次启动的合法情形）。 */
  function read() {
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState()
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 损坏的状态文件不静默重建：那会让用户悄悄丢失全部账户。交由调用方决定。
      throw new Error(`dsh-auth state is not valid JSON: ${file}`)
    }
    if (parsed?.version !== STATE_VERSION) {
      throw new Error(`dsh-auth state version ${parsed?.version} is not supported (expected ${STATE_VERSION})`)
    }
    return { ...emptyState(), ...parsed }
  }

  /** 原子写入：同目录临时文件 → fsync → rename → 目录 fsync。 */
  function write(state) {
    const tmp = path.join(dir, `.state.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    const payload = JSON.stringify(state)
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeFileSync(fd, payload)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
    try {
      const dirFd = fs.openSync(dir, 'r')
      try {
        fs.fsyncSync(dirFd)
      } finally {
        fs.closeSync(dirFd)
      }
    } catch {
      // 目录 fsync 在部分文件系统上不支持；rename 已完成，数据仍然可见。
    }
    writeRevision += 1
  }

  return { read, write, revision, path: file, dir }
}

/**
 * 原子写入任意 JSON 文件：同目录临时文件 → fsync → rename → 目录 fsync。
 * dsh-auth 与 dsh-instances 共用同一套落盘语义，避免各自实现出不同的崩溃行为。
 * @param {string} file 目标文件路径。
 * @param {unknown} value 可序列化的值。
 */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(value))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

/**
 * 读取 JSON 文件；不存在时返回 fallback，内容损坏时抛错（不静默重置）。
 * @param {string} file 文件路径。
 * @param {unknown} fallback 缺省值。
 * @returns {any} 解析结果。
 */
export function readJsonFile(file, fallback) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`not valid JSON: ${file}`)
  }
}

/**
 * 读取（或创建）TOTP 主密钥。32 字节，0600，只存宿主。
 * 缺失时生成并落盘——这是「TOTP 密钥加密存储」的前提（威胁 T8）。
 * @param {string} file 主密钥路径（如 /data/auth/totp.key）。
 * @returns {Buffer} 32 字节主密钥。
 */
export function loadOrCreateTotpKey(file) {
  try {
    const existing = fs.readFileSync(file)
    if (existing.length === 32) return existing
    throw new Error(`dsh-auth TOTP key has unexpected length ${existing.length} (expected 32)`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const key = randomBytes(32)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.totp.${process.pid}.tmp`)
  fs.writeFileSync(tmp, key, { mode: 0o600 })
  fs.renameSync(tmp, file)
  return key
}

/**
 * 追加审计事件并裁剪到上限。就地修改传入的 state（调用方随后 write）。
 * @param {object} state 状态对象。
 * @param {{actorId?:string,action:string,ip?:string,result:string,change?:object}} event 事件。
 * @param {number} [now] 当前毫秒时间戳。
 */
export function appendAudit(state, event, now = Date.now()) {
  state.audit.push({
    at: new Date(now).toISOString(),
    actorId: event.actorId ?? '',
    action: event.action,
    ip: event.ip ?? '',
    result: event.result,
    change: event.change ?? null,
  })
  if (state.audit.length > AUDIT_LIMIT) {
    state.audit.splice(0, state.audit.length - AUDIT_LIMIT)
  }
}

/** 当前时间的 ISO 串，供 TOTP 步骤与审计共用一套时钟。 */
/**
 * @returns {string} 当前 UTC 时间 ISO 串。
 */
export function nowIso() {
  return new Date().toISOString()
}
