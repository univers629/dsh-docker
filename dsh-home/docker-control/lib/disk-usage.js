// 磁盘占用扫描：把一组根路径量成 treemap 需要的树。
//
// 为什么用 `du` 而不是 Node 递归：这里要的是**磁盘占用**（blocks），不是逻辑
// 字节数。`du` 直接读 stat 的 blocks 字段，稀疏文件、硬链接重复计数这些差异
// 都能如实反映；而 Node 递归会慢一个量级（/tmp 有 5 万+ 文件），还得自己处理
// 权限错误。`du` 已经把这两件事都解决了。
//
// 为什么每个根只调一次 du（-k --max-depth）而不是逐节点调用：逐节点意味着
// 上百次进程启动，而且每次都要重新遍历子树。一次拿到深度上限内的全部目录，
// 再在内存里建树，既快又保证父子 size 同源（面积比例不会失真）。
//
// 输出契约（前端按此渲染）：
//   { name, path, size, kind, deletable, cleanable, children?, pruned?, unknown? }
// size 单位字节。父 size 由 du 给出整棵子树大小，天然逐层一致。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)

// 每个节点最多保留几个子块，其余聚合进"其它"。5 万+ 文件的 /tmp 若全部展开，
// 方块图会碎成噪点，JSON 也会大到拖慢链路。
const MAX_CHILDREN = 24
// du 的下钻深度。与 MAX_CHILDREN 一起构成"限制深度与条目数"的性能策略。
const MAX_DEPTH = 3
// 整个扫描的墙钟上限。超时就返回已扫到的部分，宁可不全也不要卡住请求。
const SCAN_TIMEOUT_MS = 20000

/**
 * 安全分类：决定一个路径能不能被清理（对应前端的灰度与可点击）。
 *
 * 顺序很重要：先判"绝不可删"，再判"明确可清理"，剩下的划为"需用户判断"。
 * 宁可把不确定的划成不可删 —— 误删会话或系统文件的代价远高于少清理一点空间。
 */
const SYSTEM_PREFIXES = ['/app', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/boot', '/dev', '/proc', '/sys']
// DSH 自身数据：会话、插件、上传附件、配置。删了就是丢数据。
const DSH_DATA_PREFIXES = ['/data/dsh', '/data/agents', '/data/mcp']

// 明确可清理的模式：崩溃转储与各类构建缓存。删掉不影响任何功能。
//
// `onlyUnder` 限定父目录：gradle-home、watcher、dsh-stage 这类名字很通用，只按
// basename 判定会把用户自己建的 /data/home/x/watcher 也划成可删（审查指出 /tmp/watcher
// 疑似正被 watch-profile-plugins 使用）。限定父目录后，同名但位置不同的目录不会被误判。
const CLEANABLE_PATTERNS = [
  // core dump 出现在任何地方都该清：它只是某次崩溃的内存快照。
  { test: /^core\.\d+$/, reason: 'core-dump' },
  { test: /^gradle-home$/, reason: 'build-cache', onlyUnder: ['/tmp'] },
  { test: /^dsh-stage$/, reason: 'build-cache', onlyUnder: ['/tmp'] },
  { test: /^chromium-clean$/, reason: 'build-cache', onlyUnder: ['/tmp'] },
  { test: /^watcher$/, reason: 'build-cache', onlyUnder: ['/tmp'] },
  { test: /^\.pnpm-store$/, reason: 'package-cache' },
  { test: /^node-compile-cache$/, reason: 'build-cache', onlyUnder: ['/tmp'] },
  { test: /^miniflare-/, reason: 'build-cache', onlyUnder: ['/tmp'] },
  { test: /^\.org\.chromium\.Chromium\./, reason: 'build-cache', onlyUnder: ['/tmp'] },
]

/** 判断 path 是否落在 onlyUnder 限定的父目录里（含父目录自身）。 */
function underAllowedParent(path, parents) {
  if (!Array.isArray(parents) || parents.length === 0) return true
  for (const parent of parents) {
    if (path === parent) return true
    if (path.startsWith(parent.endsWith('/') ? parent : `${parent}/`)) return true
  }
  return false
}

function classify(path) {
  if (SYSTEM_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    return { kind: 'system', deletable: false, cleanable: false }
  }
  const name = basename(path)
  const hit = CLEANABLE_PATTERNS.find((rule) => rule.test.test(name) && underAllowedParent(path, rule.onlyUnder))
  // 先判可清理：缓存可能寄生在数据目录里（如 /data/dsh/.pnpm-store），
  // 若先按父目录判成"数据不可删"，这些本该能清的缓存就永远清不掉了。
  if (hit) return { kind: 'cleanable', deletable: true, cleanable: true, reason: hit.reason }
  if (DSH_DATA_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    return { kind: 'data', deletable: false, cleanable: false }
  }
  // 用户数据：能否清理无法自动判定，一律不可删，交给用户自己在终端判断。
  return { kind: 'user', deletable: false, cleanable: false }
}

/** 解析 `du -k` 输出为 Map<path, bytes>。 */
function parseDu(stdout) {
  const map = new Map()
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const kb = Number.parseInt(line.slice(0, tab), 10)
    if (!Number.isFinite(kb) || kb < 0) continue
    map.set(line.slice(tab + 1), kb * 1024)
  }
  return map
}

function makeNode(path, size, extra = {}) {
  const info = classify(path)
  return {
    name: basename(path) || path,
    path,
    size,
    ...info,
    ...extra,
  }
}

/**
 * 由扁平的 path->size 表建树，并做剪枝：每个节点只保留最大的 MAX_CHILDREN 个
 * 子块，其余按其真实大小之和合成一个"其它"块。
 *
 * 剪枝而不是丢弃，是因为丢弃会让父块面积大于子块之和，treemap 上就会出现
 * "看起来有空间却点不到"的鬼区域。
 */
function buildTree(root, sizes) {
  const rootSize = sizes.get(root) ?? 0
  const node = makeNode(root, rootSize)

  const byParent = new Map()
  for (const [path, size] of sizes) {
    if (path === root) continue
    const parent = dirname(path)
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent).push({ path, size })
  }

  const attach = (parentNode) => {
    const kids = byParent.get(parentNode.path)
    if (!kids || kids.length === 0) return
    kids.sort((a, b) => b.size - a.size)
    const kept = kids.slice(0, MAX_CHILDREN)
    const rest = kids.slice(MAX_CHILDREN)
    parentNode.children = kept.map((k) => {
      const child = makeNode(k.path, k.size)
      if (k.path === parentNode.path || dirname(k.path) !== parentNode.path) return child
      attach(child)
      return child
    })
    if (rest.length > 0) {
      const restBytes = rest.reduce((sum, k) => sum + k.size, 0)
      parentNode.children.push({
        name: `其它 ${rest.length} 项`,
        path: parentNode.path,
        size: restBytes,
        kind: 'other',
        deletable: false,
        cleanable: false,
        aggregated: true,
      })
      parentNode.pruned = rest.length
    }
  }
  attach(node)
  return node
}

/**
 * 定向查找"明确可清理"的目标（core dump、构建缓存），深度不限。
 *
 * 为什么需要这一步：treemap 为了不碎成噪点，深度被限制在 MAX_DEPTH；而真正
 * 值得清理的大东西（8.6G 的 core dump）往往埋在 /data/home/learn/ 这样的第
 * 三、四层。只靠固定深度的 du 会漏掉它们，界面上就看不到最能省空间的那几项。
 * 所以用 find 直接按名字定位——它只匹配文件/目录名，代价很低。
 */
async function findCleanable(roots, deadline) {
  const found = []
  for (const root of roots) {
    if (Date.now() > deadline) break
    let stdout = ''
    try {
      const result = await execFileAsync(
        'find',
        [root, '-maxdepth', '5', '(', '-name', 'core.[0-9]*', '-o', '-name', 'gradle-home',
          '-o', '-name', 'dsh-stage', '-o', '-name', 'watcher', '-o', '-name', 'chromium-clean',
          '-o', '-name', '.pnpm-store', '-o', '-name', 'node-compile-cache', ')',
          '-not', '-path', '*/node_modules/*'],
        { timeout: Math.max(1000, Math.min(15000, deadline - Date.now())), maxBuffer: 16 * 1024 * 1024 },
      )
      stdout = result.stdout
    } catch (error) {
      stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    }
    for (const line of stdout.split('\n')) {
      const path = line.trim()
      if (!path) continue
      const info = classify(path)
      if (info.deletable) found.push(path)
    }
  }
  // 逐个量大小（数量有限，find 已经把候选收敛到很小的集合）
  const out = []
  for (const path of [...new Set(found)]) {
    if (Date.now() > deadline) break
    let size = 0
    try {
      const remaining = Math.max(1000, Math.min(10000, deadline - Date.now()))
      const { stdout } = await execFileAsync('du', ['-sk', '--', path], { timeout: remaining })
      const first = stdout.split('\t')[0]
      const kb = Number.parseInt(first, 10)
      if (Number.isFinite(kb)) size = kb * 1024
    } catch { size = 0 }
    const info = classify(path)
    out.push({ name: basename(path), path, size, ...info })
  }
  out.sort((a, b) => b.size - a.size)
  return out
}

/**
 * 扫描一组根路径，返回森林（每个根一棵树）+ 可清理清单。
 * @param {string[]} roots
 */
export async function scanDiskUsage(roots) {
  const deadline = Date.now() + SCAN_TIMEOUT_MS
  const trees = []
  const errors = []
  for (const root of roots) {
    let stdout = ''
    try {
      const result = await execFileAsync(
        'du',
        ['-k', '--max-depth', String(MAX_DEPTH), '--', root],
        { timeout: Math.max(1000, deadline - Date.now()), maxBuffer: 64 * 1024 * 1024 },
      )
      stdout = result.stdout
    } catch (error) {
      // du 遇到读不到的目录会以 exit 1 结束，但 **stdout 里仍然带着它能读到的
      // 全部结果**（stderr 只是告警）。把它当失败会让 /data 这类含受限子目录的
      // 根整棵消失，面积严重失真。所以只在 stdout 真的为空时才算失败。
      stdout = error && typeof error.stdout === 'string' ? error.stdout : ''
      if (stdout.trim() === '') {
        errors.push({ path: root, error: error instanceof Error ? (error.stderr || error.message) : String(error) })
        trees.push({ ...makeNode(root, 0), unknown: true })
        continue
      }
      errors.push({ path: root, partial: true })
    }
    trees.push(buildTree(root, parseDu(stdout)))
  }
  return {
    roots: trees,
    cleanable: await findCleanable(roots, Date.now() + SCAN_TIMEOUT_MS),
    generatedAt: new Date().toISOString(),
    errors,
  }
}

/**
 * 删除一个被判定为可清理的目标。
 * 只接受 cleanable 类，且删除前**重新判定一次**——不信任调用方传来的标记，
 * 避免前端被篡改或数据过期导致误删。
 */
export async function removeCleanable(path) {
  const info = classify(path)
  if (!info.deletable || !info.cleanable) {
    throw new Error(`不允许清理该路径 / refusing to remove non-cleanable path: ${path}`)
  }
  const normalized = path.startsWith('/') ? path : `/${path}`
  if (normalized.includes('/../') || normalized.endsWith('/..')) {
    throw new Error('路径含上级引用 / path contains parent traversal')
  }

  // 关键：解析成真实路径后**重新判定一次**。
  //
  // rm -rf 会跟随符号链接：若 /tmp/x/gradle-home 是指向别处的软链，仅凭名字判定
  // "gradle-home 可删"就会把链接指向的真实目录删掉 —— 审查中实测利用成功。所以
  // 这里先 realpath，再对解析结果重跑分类、白名单与穿越检查，最后用真实路径删除。
  let real
  try {
    real = await realpath(normalized)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, path: normalized, alreadyAbsent: true }
    throw error
  }

  // 目标自身是软链就拒绝：即便解析后的路径落在允许范围内，删除范围也和用户看到
  // 的不一致。
  try {
    const link = await stat(normalized)
    if (link.isSymbolicLink()) {
      throw new Error('目标本身是符号链接，拒绝清理 / refusing to remove a symlink')
    }
  } catch (error) {
    if (error instanceof Error && /符号链接|symlink/i.test(error.message)) throw error
    return { ok: true, path: normalized, alreadyAbsent: true }
  }

  const realInfo = classify(real)
  if (!realInfo.deletable || !realInfo.cleanable) {
    throw new Error(`解析后的真实路径不允许清理 / resolved path is not cleanable: ${real}`)
  }
  const allowed = ['/tmp/', '/workspace/', '/data/home/', '/data/']
  if (!allowed.some((p) => real.startsWith(p))) {
    throw new Error(`解析后的路径不在允许范围内 / resolved path outside allowed roots: ${real}`)
  }
  if (real.includes('/../') || real.endsWith('/..')) {
    throw new Error('解析后的路径含上级引用 / resolved path contains parent traversal')
  }

  await execFileAsync('rm', ['-rf', '--', real], { timeout: 120000 })
  return { ok: true, path: real }
}
