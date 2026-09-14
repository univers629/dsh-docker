#!/usr/bin/env node
// 插件 profile 快照：记录「这次能正常启动」的插件组合，好在下次启动失败时知道变了什么。
//
// 为什么需要它：dsh-market 的 hot-mount 安装是 restart-free 的，插件装完直接挂进运行中
// 的 composition，当时什么问题都看不出来；等某次重启/更新时才崩，而 /data/dsh 是挂载
// 目录，容器重启也清不掉。使用者事后只能看到 502，完全不知道是谁装的、装了什么。
//
// 只记 bundles 是不够的：更新插件时名字不变，快照对比不出差异。版本号才是关键，而
// package.json 里的 `^2.1.5` 只是范围，精确版本在 pnpm-lock.yaml。
//
// 用法：
//   dsh-plugin-snapshot.mjs capture [--note <文本>]   记录当前组合为「已知可用」
//   dsh-plugin-snapshot.mjs diff                      打印相对上次「已知可用」的变化
//   dsh-plugin-snapshot.mjs show                      打印当前快照
//
// 退出码：diff 发现变化时返回 10，没有变化返回 0，读不到快照返回 1。

import fs from 'node:fs'
import path from 'node:path'

const profileRoot = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web'
const stateDir = process.env.DSH_PLUGIN_SNAPSHOT_DIR ?? '/data/dsh/plugin-snapshots'
const knownFile = path.join(stateDir, 'known-good.json')
const historyFile = path.join(stateDir, 'history.ndjson')

const packageFile = path.join(profileRoot, 'package.json')
const lockFile = path.join(profileRoot, 'pnpm-lock.yaml')
const windowFile = path.join(profileRoot, 'pnpm-workspace.yaml')
const patchFile = path.join(profileRoot, 'cordis.patch.yml')

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// pnpm-lock.yaml 里 `  name@1.2.3:` 是解析结果，`1.2.3:` 是包版本。只取解析条目，
// 它们才是「这次实际装了什么」。
function lockVersions(text) {
  const versions = {}
  for (const line of text.split('\n')) {
    const match = /^ {2}(@?[^@\s][^:\s]*?)@(\d[^:\s(]*)(?:\([^)]*\))?:\s*$/.exec(line)
    if (!match) continue
    const [, name, version] = match
    // 同一个包可能因为 peer 组合出现多条，取第一条即可，这里只需要「变了没有」。
    if (!(name in versions)) versions[name] = version
  }
  return versions
}

// cordis.patch.yml 里的 insert 条目是额外注入的插件行，同样是故障点。
function insertedIds(text) {
  const ids = []
  let inInsert = false
  for (const line of text.split('\n')) {
    if (/^\s*-\s*insert:\s*$/.test(line)) {
      inInsert = true
      continue
    }
    if (!inInsert) continue
    const match = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
    if (match) ids.push(match[1])
    else if (/^\S/.test(line)) inInsert = false
  }
  return ids.sort()
}

function capture() {
  let pkg = {}
  const raw = readIfPresent(packageFile)
  if (raw) {
    try {
      pkg = JSON.parse(raw)
    } catch (error) {
      process.stderr.write(`[plugin-snapshot] ${packageFile} 不是合法 JSON：${error.message}\n`)
    }
  }
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? [...pkg.dsh.profile.bundles] : []
  const versions = lockVersions(readIfPresent(lockFile))
  const workspace = readIfPresent(windowFile)
  const patchIds = insertedIds(readIfPresent(patchFile))

  const dependencies = {}
  for (const bundle of bundles) {
    dependencies[bundle] = versions[bundle] ?? null
  }

  return {
    capturedAt: new Date().toISOString(),
    note: process.env.DSH_PLUGIN_SNAPSHOT_NOTE ?? '',
    bundles,
    versions: dependencies,
    lockVersions: versions,
    patchIds,
    workspaceHash: simpleHash(workspace),
  }
}

function simpleHash(text) {
  // 只用来判断「变没变」，不需要密码学强度。
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return hash.toString(16)
}

function loadKnown() {
  const raw = readIfPresent(knownFile)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function diff(before, after) {
  const changes = []
  const beforeBundles = new Set(before.bundles ?? [])
  const afterBundles = new Set(after.bundles ?? [])

  for (const bundle of afterBundles) {
    if (!beforeBundles.has(bundle)) changes.push({ kind: 'added', bundle })
  }
  for (const bundle of beforeBundles) {
    if (!afterBundles.has(bundle)) changes.push({ kind: 'removed', bundle })
  }
  for (const bundle of afterBundles) {
    if (!beforeBundles.has(bundle)) continue
    const was = before.versions?.[bundle] ?? null
    const now = after.versions?.[bundle] ?? null
    if (was !== now) changes.push({ kind: 'version', bundle, from: was, to: now })
  }
  const beforePatches = new Set(before.patchIds ?? [])
  const afterPatches = new Set(after.patchIds ?? [])
  for (const id of afterPatches) {
    if (!beforePatches.has(id)) changes.push({ kind: 'insert-added', bundle: id })
  }
  for (const id of beforePatches) {
    if (!afterPatches.has(id)) changes.push({ kind: 'insert-removed', bundle: id })
  }
  return changes
}

function describe(change) {
  switch (change.kind) {
    case 'added':
      return `新增插件：${change.bundle}`
    case 'removed':
      return `移除插件：${change.bundle}`
    case 'version':
      return `插件换版本：${change.bundle} ${change.from ?? '?'} → ${change.to ?? '?'}`
    case 'insert-added':
      return `新增 insert 条目：${change.bundle}`
    case 'insert-removed':
      return `移除 insert 条目：${change.bundle}`
    default:
      return JSON.stringify(change)
  }
}

function writeHistory(entry) {
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.appendFileSync(historyFile, `${JSON.stringify(entry)}\n`)
  } catch (error) {
    process.stderr.write(`[plugin-snapshot] 写历史失败：${error.message}\n`)
  }
}

const action = process.argv[2] ?? 'capture'

if (action === 'capture') {
  const snapshot = capture()
  snapshot.note = process.env.DSH_PLUGIN_SNAPSHOT_NOTE ?? process.argv[3] ?? ''
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    const temporary = `${knownFile}.tmp.${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`)
    fs.renameSync(temporary, knownFile)
  } catch (error) {
    process.stderr.write(`[plugin-snapshot] 写快照失败：${error.message}\n`)
    process.exit(1)
  }
  writeHistory({ event: 'capture', ...snapshot })
  process.stderr.write(
    `[plugin-snapshot] 已记录可用组合：${snapshot.bundles.length} 个 bundle${snapshot.note ? `（${snapshot.note}）` : ''}\n`,
  )
  process.exit(0)
}

if (action === 'show') {
  process.stdout.write(`${JSON.stringify(capture(), null, 2)}\n`)
  process.exit(0)
}

if (action === 'diff') {
  const known = loadKnown()
  if (!known) {
    process.stderr.write('[plugin-snapshot] 还没有「已知可用」快照，先跑 capture\n')
    process.exit(1)
  }
  const changes = diff(known, capture())
  if (changes.length === 0) {
    process.stderr.write(`[plugin-snapshot] 与上次可用组合一致（${known.capturedAt}）\n`)
    process.exit(0)
  }
  process.stderr.write(`[plugin-snapshot] 相对上次可用组合（${known.capturedAt}）有 ${changes.length} 处变化：\n`)
  for (const change of changes) process.stderr.write(`[plugin-snapshot]   - ${describe(change)}\n`)
  writeHistory({ event: 'diff', changes })
  process.exit(10)
}

process.stderr.write(`[plugin-snapshot] 未知动作：${action}\n`)
process.exit(2)
