// 单管理员部署的插件开关（登录后、进入工作台之前）。
//
// 放在认证网关里的原因：插件把 DSH 的启动搞崩时，工作台只剩 503，唯一能改配置的
// 入口就是那个还在独立运行的网关容器。因此这里只做文件读写——补丁层
// cordis.patch.yml 的禁用块与清单的 dsh.profile.bundles——不依赖 DSH 在跑。
//
// 安全线：
//   * 行 id 只允许 [A-Za-z0-9_.-]，写入前校验，避免把任意文本写进补丁层；
//   * 补丁层不是合法条目数组时拒绝追加，宁可报错也不写坏；
//   * 删掉最后一条禁用块后补回 `[]` 占位，空文件会让整个 profile 起不来；
//   * 官方包（@deepseek-ai/*）与市场自管行（mkt-/client-/include:）不提供开关。
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROW_ID = /^[A-Za-z0-9_.-]+$/
const OFFICIAL = /^@deepseek-ai\//
/** 市场与启动器自管的行：写进补丁层只会留下指向不存在行的孤儿条目。 */
const MANAGED_ROWS = /^(?:mkt-|client-|include:)/
const DISABLE_LINE = /^ {2}disabled:\s*(true|false)\s*$/u

export class PluginConfigError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'PluginConfigError'
    this.status = status
  }
}

const patchPath = (profileDir) => join(profileDir, 'cordis.patch.yml')
const manifestPath = (profileDir) => join(profileDir, 'package.json')

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 先写临时文件再改名：网关与 DSH 的插件管理器可能同时在写这份配置。 */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, text)
  renameSync(temporary, file)
}

function backupOnce(file) {
  try {
    if (!existsSync(`${file}.bak`)) copyFileSync(file, `${file}.bak`)
  } catch {
    // 备份失败不阻塞开关本身
  }
}

/**
 * 补丁层里已有的禁用/强制启用行。按行扫描而不是解析 YAML：
 * 这层允许注释、`- insert:` 块与任意键顺序，行扫描不会因为形状变化而写坏文件。
 */
export function scanPatch(text) {
  const disables = new Set()
  const forced = new Set()
  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const head = /^- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/u.exec(lines[index] ?? '')
    if (!head) continue
    for (let cursor = index + 1; cursor < lines.length && !/^- /.test(lines[cursor]); cursor += 1) {
      const flag = DISABLE_LINE.exec(lines[cursor])
      if (!flag) continue
      if (flag[1] === 'true') disables.add(head[1])
      else forced.add(head[1])
      break
    }
  }
  return { disables, forced }
}

/** `- insert:` 块里插入的行 id（4 空格缩进，避免误吞 config 里的同名字段）。 */
export function insertedRowIds(text) {
  const ids = new Set()
  let inside = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^- /.test(line)) inside = /^- insert:\s*$/u.test(line)
    if (!inside) continue
    const row = /^ {4}- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/u.exec(line)
    if (row) ids.add(row[1])
  }
  return [...ids]
}

/** 补丁文件是否仍是合法的顶层条目数组；不是就拒绝追加。 */
export function looksLikeEntryList(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  if (!lines.length) return true
  if (lines.length === 1 && /^\[\s*\]$/u.test(lines[0].trim())) return true
  if (lines.some((line) => /^\S/.test(line) && !line.startsWith('- '))) return false
  return !lines.some((line) => /^\[\s*\]$|^\{\s*\}$/u.test(line.trim()))
}

function withoutComments(text) {
  return String(text ?? '').replace(/^[ \t]*#.*$/gmu, '').trim()
}

function appendDisable(text, rowId) {
  const row = `- id: ${rowId}\n  disabled: true\n`
  const core = String(text ?? '').trim()
  if (core === '') return row
  if (withoutComments(core) === '') return `${core}${core.endsWith('\n') ? '' : '\n'}${row}`
  if (withoutComments(core) === '[]' || withoutComments(core) === '[ ]') {
    const commented = String(text).replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/gmu, '# []\n')
    return `${commented}${commented.endsWith('\n') ? '' : '\n'}${row}`
  }
  if (!looksLikeEntryList(text)) {
    throw new PluginConfigError('cordis.patch.yml 不是合法的条目数组，已拒绝写入；请先手工修正这个文件')
  }
  return `${text}${text.endsWith('\n') ? '' : '\n'}${row}`
}

function removeDisable(text, rowId) {
  const idLine = new RegExp(`^- id:\\s*['"]?${rowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'u')
  const lines = String(text ?? '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!idLine.test(lines[index])) continue
    let end = index + 1
    while (end < lines.length && !/^- /.test(lines[end])) end += 1
    const row = lines.slice(index, end)
    const at = row.findIndex((line, position) => position > 0 && /^ {2}disabled:\s*true\s*$/u.test(line))
    if (at < 0) return { text, changed: false }
    const kept = row.filter((_, position) => position !== at)
    const stillHasKeys = kept.slice(1).some((line) => line.trim() !== '')
    lines.splice(index, end - index, ...(stillHasKeys ? kept : []))
    const merged = lines.join('\n')
    // 空补丁文件会让整个 profile 起不来，删空时必须补回占位。
    const body = withoutComments(merged)
    const restored = body === '' ? `${merged.trim() === '' ? '' : merged.replace(/\s+$/u, '\n')}[]\n` : merged
    return { text: restored, changed: true }
  }
  return { text, changed: false }
}

function readManifest(profileDir) {
  const raw = readText(manifestPath(profileDir))
  if (!raw) throw new PluginConfigError('找不到 profile 清单 package.json', 500)
  try {
    return { manifest: JSON.parse(raw), raw }
  } catch {
    throw new PluginConfigError('profile 清单 package.json 不是合法 JSON', 500)
  }
}

function writeManifest(profileDir, manifest, expectedRaw) {
  const current = readText(manifestPath(profileDir))
  if (current !== expectedRaw) {
    throw new PluginConfigError('profile 清单刚被别的进程改写，本次修改未落盘，请重试', 409)
  }
  writeAtomic(manifestPath(profileDir), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** 一个已装包拥有的 loader 行：dsh.bundle.patch 声明的文件 + 根目录 cordis.patch.yml。 */
export function packageRowIds(profileDir, name) {
  const packageDir = join(profileDir, 'node_modules', name)
  const ids = new Set()
  for (const candidate of [declaredPatch(packageDir), join(packageDir, 'cordis.patch.yml')]) {
    if (!candidate) continue
    for (const id of insertedRowIds(readText(candidate))) ids.add(id)
  }
  return [...ids]
}

function declaredPatch(packageDir) {
  try {
    const manifest = JSON.parse(readText(join(packageDir, 'package.json')))
    const declared = manifest?.dsh?.bundle?.patch
    if (typeof declared !== 'string' || !declared.trim()) return ''
    const file = join(packageDir, declared)
    return existsSync(file) ? file : ''
  } catch {
    return ''
  }
}

function packageMeta(profileDir, name) {
  try {
    const manifest = JSON.parse(readText(join(profileDir, 'node_modules', name, 'package.json')))
    const description = typeof manifest.description === 'string' ? manifest.description.trim() : ''
    return {
      version: String(manifest.version ?? ''),
      description: description.length > 140 ? `${description.slice(0, 139)}…` : description,
    }
  } catch {
    return { version: '', description: '' }
  }
}

export function bundlesOf(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles.filter((entry) => typeof entry === 'string') : []
}

/** 已装插件的开关状态。enabled 同时要求「挂在 bundles 里」且「没有被补丁层禁用」。 */
export function listPlugins(profileDir) {
  const { manifest } = readManifest(profileDir)
  const text = readText(patchPath(profileDir))
  const state = scanPatch(text)
  const bundles = bundlesOf(manifest)
  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const plugins = Object.keys(dependencies).sort().map((name) => {
    const ids = packageRowIds(profileDir, name)
    const official = OFFICIAL.test(name)
    const managed = ids.length > 0 && ids.every((id) => MANAGED_ROWS.test(id))
    const disabled = ids.some((id) => state.disables.has(id))
    const mounted = ids.length === 0 || bundles.includes(name)
    const meta = packageMeta(profileDir, name)
    let toggleable = true
    let reason = ''
    if (ids.length === 0) {
      toggleable = false
      reason = '没有可开关的加载行（客户端插件，由插件市场管理）'
    } else if (official) {
      toggleable = false
      reason = '官方组件，关掉会让工作台起不来'
    } else if (managed) {
      toggleable = false
      reason = '市场自管行，不写进补丁层'
    }
    return {
      name,
      version: meta.version,
      description: meta.description,
      spec: String(dependencies[name] ?? ''),
      rows: ids,
      official,
      toggleable,
      disabled,
      mounted,
      enabled: mounted && !disabled,
      reason,
    }
  })
  return {
    profile: profileDir,
    patch: patchPath(profileDir),
    writable: isWritable(profileDir),
    plugins,
    bundleCount: bundles.length,
    disabledRows: [...state.disables],
  }
}

function isWritable(directory) {
  try {
    const stats = statSync(directory)
    return stats.isDirectory() && existsSync(join(directory, 'package.json'))
  } catch {
    return false
  }
}

/**
 * 开关一个插件。禁用写补丁层的 `disabled: true` 块（清单不动，安装记录留着）；
 * 启用时删掉该块，并把包重新挂回 dsh.profile.bundles——0.2.x 只挂载清单里的包，
 * 只删禁用块而包已移出清单时，开关显示为开，实际不会加载。
 *
 * 带 `dsh.bundle.patch` 的包还要第二个动作：它的 bundle 层可能覆盖官方行的
 * inject/config（vision-router 给 connection 加了 visionRouterWebConnectionReady），
 * 而补丁层的 disabled 只关插件自己的行、关不掉那层覆盖。禁用时把包从
 * dsh.profile.bundles 摘掉，bundle 层因此不再被应用；启用时再挂回去。
 */
export function setPluginEnabled(profileDir, name, enabled) {
  if (typeof name !== 'string' || name === '') throw new PluginConfigError('缺少插件名')
  const { manifest, raw } = readManifest(profileDir)
  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  if (!Object.hasOwn(dependencies, name)) throw new PluginConfigError(`${name} 不在 profile 依赖里`, 404)
  if (OFFICIAL.test(name)) throw new PluginConfigError('官方组件不提供开关')

  const rows = packageRowIds(profileDir, name)
  if (!rows.length) throw new PluginConfigError(`${name} 没有可开关的加载行`)
  const targets = rows.filter((id) => !MANAGED_ROWS.test(id))
  if (!targets.length) throw new PluginConfigError(`${name} 的加载行由市场自管，不提供开关`)
  for (const id of targets) {
    if (!ROW_ID.test(id)) throw new PluginConfigError(`行 id ${id} 含特殊字符，不能写进补丁层`)
  }

  const file = patchPath(profileDir)
  const original = readText(file)
  const state = scanPatch(original)
  let text = original
  let changed = false
  for (const id of targets) {
    if (enabled) {
      const result = removeDisable(text, id)
      if (result.changed) {
        text = result.text
        state.disables.delete(id)
        changed = true
      }
      continue
    }
    if (state.disables.has(id)) continue
    text = appendDisable(text, id)
    state.disables.add(id)
    changed = true
  }
  if (changed) {
    backupOnce(file)
    writeAtomic(file, text)
  }

  // 纯依赖没有 cordis.patch.yml，挂上去或摘下来都没有意义。
  const isBundle = existsSync(join(profileDir, 'node_modules', name, 'cordis.patch.yml'))
  let mounted = false
  let detached = false
  if (isBundle && enabled && !bundlesOf(manifest).includes(name)) {
    manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
    manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}
    manifest.dsh.profile.bundles = [...bundlesOf(manifest), name]
    writeManifest(profileDir, manifest, raw)
    mounted = true
  } else if (isBundle && !enabled) {
    const bundles = bundlesOf(manifest)
    if (bundles.includes(name)) {
      manifest.dsh.profile.bundles = bundles.filter((bundle) => bundle !== name)
      writeManifest(profileDir, manifest, raw)
      detached = true
    }
  }
  return { name, enabled, rows: targets, changed: changed || mounted || detached, mounted, detached }
}

/**
 * 安全模式：停用所有可开关的第三方插件。官方包留在原地——它们被关掉时工作台
 * 同样起不来，此时关闭官方包不是保留进入页面的通路，而是换成另一种启动失败。
 */
export function disableThirdParty(profileDir) {
  const { plugins } = listPlugins(profileDir)
  const disabled = []
  const skipped = []
  for (const plugin of plugins) {
    if (!plugin.toggleable) {
      skipped.push({ name: plugin.name, reason: plugin.reason })
      continue
    }
    if (!plugin.enabled) continue
    setPluginEnabled(profileDir, plugin.name, false)
    disabled.push(plugin.name)
  }
  return { disabled, skipped }
}

/** 请求 DSH 重启：supervisor 在数据目录里盯这个文件，看到就重启子进程。 */
export function requestRestart(file, at = Date.now()) {
  writeAtomic(file, `${JSON.stringify({ at, by: 'auth-gateway' })}\n`)
  return at
}

export function restartRequestedAt(file) {
  try {
    const payload = JSON.parse(readText(file))
    return typeof payload?.at === 'number' ? payload.at : null
  } catch {
    return null
  }
}
