#!/usr/bin/env node
// 预检 profile 里的插件在目标 DSH 版本下能否加载。
//
// DSH 启动时会逐个校验插件声明的 @deepseek-ai/dsh / @deepseek-ai/dsh-* peer 范围，
// 不满足的插件会被直接禁用：进程照常启动、健康检查照样通过、更新脚本的回滚逻辑也
// 不会触发，只有 stderr 上的一行提示。升级到新的 DSH 小版本后插件功能可能整块消失，
// 而现有的存活检测看不见这种状态，所以在替换运行时之前先把结果算出来。
//
// 判定不在这里重写：从目标运行时树里 import @deepseek-ai/dsh-app-boot，用新版本
// 自带的 getDshRuntimeVersion() 与 evaluatePluginCompatibility()。这样预检结论与
// 新版本启动时的判定必然一致，上游改了判定规则也不会出现两套逻辑。
//
// 用法：
//   preflight-profile-plugins.mjs <module-root> [profile-dir] [--json] [--fail-on-incompatible]
//
//   <module-root>  目标运行时树的 node_modules 目录，与 apply-dsh-artifact-patches.mjs 同一参数
//   profile-dir    默认 $DSH_PROFILE_ROOT，缺省退回 $DSH_HOME/profiles/web
//   --json                 输出机器可读结果，不打印人类可读报告
//   --fail-on-incompatible 存在会被禁用的插件时以 3 退出，供调用方决定是否放行
//
// 退出码：0 完成；1 预检自身失败；2 参数错误；3 存在会被禁用或未安装的插件（仅带上述旗标）
// 人类可读模式的最后一行固定是「摘要：...」，调用方可直接取用。
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const KNOWN_FLAGS = new Set(['--json', '--fail-on-incompatible'])
const args = process.argv.slice(2)
const flags = new Set(args.filter((value) => value.startsWith('--')))
const positional = args.filter((value) => !value.startsWith('--'))

function usage() {
  console.error('usage: preflight-profile-plugins.mjs <module-root> [profile-dir] [--json] [--fail-on-incompatible]')
}

if (positional.length > 2 || [...flags].some((flag) => !KNOWN_FLAGS.has(flag)) || positional.length === 0) {
  usage()
  process.exit(2)
}

const moduleRoot = resolve(positional[0])
const profileDir = resolve(
  positional[1] ?? process.env.DSH_PROFILE_ROOT ?? join(process.env.DSH_HOME ?? '/data/dsh', 'profiles', 'web'),
)
const asJson = flags.has('--json')
const failOnIncompatible = flags.has('--fail-on-incompatible')

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// 目标运行时的 app-boot：兼容性判定的唯一来源。
//
// 必须按绝对路径取，不能交给裸包名解析：容器里 NODE_PATH 指向现行的
// /app/dsh/node_modules，裸解析会命中正在运行的那棵树，于是用旧版本去判定新版本，
// 结论正好相反（旧版本的 peer 全部满足，预检会报“全部可用”）。
function resolveAppBoot(moduleRoot) {
  const dir = join(moduleRoot, '@deepseek-ai', 'dsh-app-boot')
  const manifest = readJson(join(dir, 'package.json'))
  const declared = manifest.error
    ? undefined
    : (typeof manifest.value?.exports?.['.'] === 'string'
      ? manifest.value.exports['.']
      : manifest.value?.exports?.['.']?.default ?? manifest.value?.main)
  const candidates = [declared, join('lib', 'index.js')].filter((value) => typeof value === 'string')
  for (const relative of candidates) {
    const file = join(dir, relative)
    if (existsSync(file)) return file
  }
  return undefined
}

const appBootPath = resolveAppBoot(moduleRoot)
if (appBootPath === undefined) {
  console.error(`[preflight] 运行时树里没有 @deepseek-ai/dsh-app-boot（module-root：${moduleRoot}）`)
  process.exit(1)
}

const appBoot = await import(pathToFileURL(appBootPath).href)
if (typeof appBoot.evaluatePluginCompatibility !== 'function' || typeof appBoot.getDshRuntimeVersion !== 'function') {
  console.error('[preflight] app-boot 不再导出 evaluatePluginCompatibility / getDshRuntimeVersion，预检无法进行')
  process.exit(1)
}

const runtimeVersion = appBoot.getDshRuntimeVersion()

// profile 侧的输入保持与上游一致的读法：package.json 的 dsh.profile.bundles 是有序清单，
// compatibility.json 是 「name@exact-version: [exact-dsh-version, ...]」的精确版本豁免。
const warnings = []
const profileManifestPath = join(profileDir, 'package.json')
const bundles = []
if (!existsSync(profileManifestPath)) {
  warnings.push(`profile 目录里没有 package.json（${profileManifestPath}），没有可预检的插件`)
} else {
  const manifest = readJson(profileManifestPath)
  if (manifest.error) {
    warnings.push(`profile package.json 无法解析：${manifest.error}`)
  } else {
    const list = manifest.value?.dsh?.profile?.bundles
    if (!Array.isArray(list)) {
      warnings.push('profile package.json 没有 dsh.profile.bundles 清单，无法确定加载哪些插件')
    } else {
      for (const name of list) {
        if (typeof name === 'string' && name.length > 0) bundles.push(name)
        else warnings.push(`dsh.profile.bundles 里存在非法条目：${JSON.stringify(name)}`)
      }
    }
  }
}

const exemptions = {}
const compatibilityPath = join(profileDir, 'compatibility.json')
if (existsSync(compatibilityPath)) {
  const parsed = readJson(compatibilityPath)
  if (parsed.error) {
    warnings.push(`compatibility.json 无法解析，按“没有任何豁免”处理：${parsed.error}`)
  } else if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    warnings.push('compatibility.json 必须是 name@version → DSH 版本列表 的对象，已按“没有任何豁免”处理')
  } else {
    for (const [key, versions] of Object.entries(parsed.value)) {
      if (Array.isArray(versions) && versions.every((version) => typeof version === 'string')) exemptions[key] = versions
      else warnings.push(`compatibility.json 的 ${key} 不是精确 DSH 版本列表，该条豁免被忽略`)
    }
  }
}

// 内置 bundle（dsh-base、dsh-web-app 等）不在 profile 的 node_modules 里，而是随运行时
// 一起发布：解析顺序与启动时一致，installation anchor 优先，profile 兜底。用上游的
// resolveBundleDir 而不是自己拼路径，避免两处解析规则分叉。
const installAnchor = join(moduleRoot, '..', 'package.json')

function bundleManifestPath(name) {
  if (typeof appBoot.resolveBundleDir === 'function') {
    try {
      return join(appBoot.resolveBundleDir('preflight', name, installAnchor, profileDir), 'package.json')
    } catch {}
  }
  const local = join(profileDir, 'node_modules', name, 'package.json')
  return existsSync(local) ? local : undefined
}

const results = []
for (const name of bundles) {
  const manifestPath = bundleManifestPath(name)
  if (manifestPath === undefined || !existsSync(manifestPath)) {
    results.push({ name, version: undefined, status: 'missing' })
    continue
  }
  const manifest = readJson(manifestPath)
  if (manifest.error) {
    results.push({ name, version: undefined, status: 'unreadable', detail: manifest.error })
    continue
  }
  const version = typeof manifest.value?.version === 'string' ? manifest.value.version : 'unknown'
  let issue
  try {
    issue = appBoot.evaluatePluginCompatibility(manifest.value, exemptions, runtimeVersion)
  } catch (error) {
    results.push({
      name,
      version,
      status: 'unreadable',
      detail: error instanceof Error ? error.message : String(error),
    })
    continue
  }
  if (issue === undefined) {
    results.push({ name, version, status: 'ok' })
    continue
  }
  results.push({
    name,
    version,
    status: issue.exempted ? 'exempted' : 'incompatible',
    peers: issue.peers,
    exemptionKey: `${issue.name}@${issue.version}`,
  })
}

const counts = {
  bundles: results.length,
  ok: results.filter((row) => row.status === 'ok').length,
  exempted: results.filter((row) => row.status === 'exempted').length,
  incompatible: results.filter((row) => row.status === 'incompatible').length,
  missing: results.filter((row) => row.status === 'missing').length,
  unreadable: results.filter((row) => row.status === 'unreadable').length,
}
const blocked = counts.incompatible + counts.missing + counts.unreadable

if (asJson) {
  process.stdout.write(`${JSON.stringify({ runtimeVersion, profileDir, moduleRoot, counts, results, warnings }, null, 2)}\n`)
} else {
  const lines = [
    `插件兼容性预检：运行时 ${runtimeVersion}（判定来自 ${appBootPath}）`,
    `  profile  ${profileDir}`,
    `  可用     ${counts.ok}${counts.exempted > 0 ? `（另 ${counts.exempted} 个已豁免，加载时会有警告）` : ''}`,
    `  会被禁用 ${counts.incompatible}`,
  ]
  for (const row of results) {
    if (row.status !== 'incompatible') continue
    lines.push(`    - ${row.name}@${row.version}`)
    lines.push(`      未满足的 peer：${JSON.stringify(row.peers)}`)
    lines.push(`      处置：升级到支持该 DSH 版本的插件版本，或在 compatibility.json 里写入`)
    lines.push(`            "${row.exemptionKey}": ["${runtimeVersion}"] 授予精确版本豁免（有崩溃或数据损坏风险）`)
  }
  if (counts.missing + counts.unreadable > 0) lines.push(`  未装载   ${counts.missing + counts.unreadable}`)
  for (const row of results) {
    if (row.status === 'missing') lines.push(`    - ${row.name}：profile 的 node_modules 里没有这个包，启动时会报错`)
    else if (row.status === 'unreadable') lines.push(`    - ${row.name}：清单无法判定（${row.detail}）`)
  }
  for (const warning of warnings) lines.push(`  提示     ${warning}`)
  lines.push(`摘要：共 ${counts.bundles} 个插件，${counts.ok} 个可用，${counts.incompatible} 个在新版本下会被禁用，${counts.missing + counts.unreadable} 个未装载`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (failOnIncompatible && blocked > 0) process.exit(3)
