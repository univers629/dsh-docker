#!/usr/bin/env node
// 插件故障隔离：DSH 因为某个插件起不来时，把它禁掉并重试，而不是无限重启同一个坏组合。
//
// 为什么需要它：dsh-market 的 hot-mount 安装完全不重启进程，所以当时看不出任何问题；
// 等某次重启或更新时才崩，而 profile 在 /data/dsh（挂载目录），容器重启也清不掉。
// supervisor 只会一遍遍重试同一个坏组合，使用者看到的是持续 502，只能手动去修。
//
// 禁用方式刻意不用「改原文件」：DSH 的 patch 机制支持把某个条目的 disabled 置真
// （cordis-plugin-loader 的 disabledOf 读 options.disabled），所以这里生成一个
// --patch 叠加文件。原配置永远不动，出问题删掉叠加文件就能恢复。
//
// 用法：
//   dsh-plugin-quarantine.mjs record <日志文件>   从启动日志里记下可疑插件
//   dsh-plugin-quarantine.mjs apply               把记下的插件写进禁用叠加文件
//   dsh-plugin-quarantine.mjs list                列出当前隔离的插件
//   dsh-plugin-quarantine.mjs clear               解除全部隔离

import fs from 'node:fs'
import path from 'node:path'

const profileRoot = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web'
const stateDir = process.env.DSH_PLUGIN_SNAPSHOT_DIR ?? '/data/dsh/plugin-snapshots'
const overlayFile = process.env.DSH_PLUGIN_OVERLAY ?? '/data/dsh/plugin-quarantine.yml'
const quarantineFile = path.join(stateDir, 'quarantined.json')

// DSH 启动失败时，错误里会点名出事的条目。已知两种形态：
//   dsh: 1 entry did not activate\n<条目名>: pending (waiting for service: ...)
//   failed to apply loader entry <id> (<包名>): ...
const ACTIVATION_PATTERN = /^([A-Za-z0-9@/._-]+):\s*(?:pending|failed|error)\b/gm
const LOADER_ENTRY_PATTERN = /failed to apply loader entry\s+([A-Za-z0-9@/._-]+)/g

// 这些是 DSH 自身的核心条目，禁用它们等于把整个应用拆掉，永远不碰。
const PROTECTED = new Set([
  'modules',
  'connection',
  'webserver',
  'webServer',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-connection',
])

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// 条目 id 和包名并不是一回事（dsh-files 的 id 是 files-toolkit，dshmarket 的是
// dsh-market），所以要把日志里出现的名字映射到最终配置里真实存在的 id。这份映射从
// dump-config 的结果建立，找不到就退回原名 —— patch 对不存在的 id 只会告警并跳过，
// 不会让启动变得更糟。
function entryIdMap() {
  const map = new Map()
  const configFile = process.env.DSH_DUMPED_CONFIG ?? path.join(stateDir, 'config-entries.json')
  const entries = readJson(configFile, null)
  if (!Array.isArray(entries)) return map
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.id && entry.name) map.set(entry.name, entry.id)
    if (entry.id) map.set(entry.id, entry.id)
  }
  return map
}

function suspiciousFromLog(text) {
  const found = new Set()
  for (const pattern of [ACTIVATION_PATTERN, LOADER_ENTRY_PATTERN]) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1]
      if (!name || PROTECTED.has(name)) continue
      found.add(name)
    }
  }
  return [...found]
}

function loadQuarantine() {
  const data = readJson(quarantineFile, { entries: [] })
  return Array.isArray(data?.entries) ? data : { entries: [] }
}

function writeOverlay(entries) {
  if (entries.length === 0) {
    try {
      fs.rmSync(overlayFile, { force: true })
    } catch {
      /* 删不掉也不算错，下面的空叠加文件等价 */
    }
    return
  }
  const lines = [
    '# 由 dsh-plugin-quarantine.mjs 生成：这些插件在启动时崩溃，已被临时禁用。',
    '# 原 profile 配置没有被修改；确认插件修好后删掉本文件即可恢复。',
    `# 生成时间：${new Date().toISOString()}`,
    '',
  ]
  for (const entry of entries) {
    lines.push(`- id: ${entry.id}`)
    lines.push('  disabled: true')
  }
  lines.push('')
  const temporary = `${overlayFile}.tmp.${process.pid}`
  fs.mkdirSync(path.dirname(overlayFile), { recursive: true })
  fs.writeFileSync(temporary, lines.join('\n'))
  fs.renameSync(temporary, overlayFile)
}

function saveQuarantine(data) {
  fs.mkdirSync(stateDir, { recursive: true })
  const temporary = `${quarantineFile}.tmp.${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`)
  fs.renameSync(temporary, quarantineFile)
}

function resolveId(name, map) {
  return map.get(name) ?? name
}

const action = process.argv[2] ?? 'list'

if (action === 'record') {
  const logFile = process.argv[3]
  if (!logFile) {
    process.stderr.write('usage: dsh-plugin-quarantine.mjs record <日志文件>\n')
    process.exit(2)
  }
  let text = ''
  try {
    text = fs.readFileSync(logFile, 'utf8')
  } catch (error) {
    process.stderr.write(`[plugin-quarantine] 读不到 ${logFile}：${error.message}\n`)
    process.exit(1)
  }
  const suspicious = suspiciousFromLog(text)
  if (suspicious.length === 0) {
    process.stderr.write('[plugin-quarantine] 日志里没有点名任何条目，无可隔离的插件\n')
    process.exit(0)
  }
  const map = entryIdMap()
  const data = loadQuarantine()
  const known = new Set(data.entries.map((entry) => entry.id))
  for (const name of suspicious) {
    const id = resolveId(name, map)
    if (known.has(id)) continue
    known.add(id)
    data.entries.push({ id, reported: name, at: new Date().toISOString() })
    process.stderr.write(`[plugin-quarantine] 记下可疑条目：${name}（禁用 id=${id}）\n`)
  }
  saveQuarantine(data)
  process.exit(0)
}

if (action === 'apply') {
  const data = loadQuarantine()
  writeOverlay(data.entries)
  if (data.entries.length === 0) {
    process.stderr.write('[plugin-quarantine] 没有需要隔离的插件，已确保叠加文件不存在\n')
  } else {
    process.stderr.write(
      `[plugin-quarantine] 已写入禁用叠加文件 ${overlayFile}：${data.entries.map((entry) => entry.id).join(', ')}\n`,
    )
  }
  process.exit(0)
}

if (action === 'list') {
  const data = loadQuarantine()
  if (data.entries.length === 0) {
    process.stdout.write('（没有隔离中的插件）\n')
  } else {
    for (const entry of data.entries) {
      process.stdout.write(`${entry.id}\t${entry.reported}\t${entry.at}\n`)
    }
  }
  process.exit(0)
}

if (action === 'clear') {
  saveQuarantine({ entries: [] })
  writeOverlay([])
  process.stderr.write('[plugin-quarantine] 已解除全部隔离\n')
  process.exit(0)
}

process.stderr.write(`[plugin-quarantine] 未知动作：${action}\n`)
process.exit(2)
