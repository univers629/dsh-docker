#!/usr/bin/env node
// 对已安装的 DSH 预构建产物执行文本补丁。
//
// 用法: apply-dsh-artifact-patches.mjs <module-root> [--check]
//   <module-root>  含 @deepseek-ai/* 的 node_modules 目录
//   --check        只校验能否命中，不写盘
//
// 失败即退出非零：上游改了产物形状必须立刻可见，绝不静默跳过。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const moduleRoot = args.find(argument => !argument.startsWith('--'))
if (moduleRoot === undefined) {
  console.error('usage: apply-dsh-artifact-patches.mjs <module-root> [--check]')
  process.exit(2)
}

const patchDir = process.env.DSH_PATCH_DIR ?? '/etc/dsh-patches'
const definitions = join(patchDir, 'artifact-patches.mjs')
if (!existsSync(definitions)) {
  console.error(`[dsh-patch] patch definitions not found: ${definitions}`)
  process.exit(2)
}
const { artifactPatches } = await import(pathToFileURL(definitions).href)

/** 按文件聚合，避免同一个 bundle 被反复读写。 */
const byFile = new Map()
for (const patch of artifactPatches) {
  const file = resolve(moduleRoot, patch.package, patch.file)
  const bucket = byFile.get(file)
  if (bucket === undefined) byFile.set(file, [patch])
  else bucket.push(patch)
}

let applied = 0
let already = 0
const failures = []

for (const [file, patches] of byFile) {
  if (!existsSync(file)) {
    for (const patch of patches) failures.push(`${patch.id}: 目标文件不存在 ${file}`)
    continue
  }
  const original = readFileSync(file, 'utf8')
  let content = original
  for (const patch of patches) {
    // marker 先判：插入型补丁的 find 往往仍存在于 replace 里，只看 find
    // 会导致重入时二次插入。
    if (content.includes(patch.marker)) {
      already++
      continue
    }
    const hits = content.split(patch.find).length - 1
    if (hits === 1) {
      content = content.replace(patch.find, patch.replace)
      applied++
      continue
    }
    failures.push(hits === 0
      ? `${patch.id}: 锚点未命中（上游产物可能已变化）`
      : `${patch.id}: 锚点命中 ${hits} 次，必须唯一`)
  }
  if (!checkOnly && content !== original) writeFileSync(file, content)
}

if (failures.length > 0) {
  console.error(`[dsh-patch] ${failures.length} 处补丁无法应用:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

const mode = checkOnly ? '校验' : '应用'
console.log(`[dsh-patch] ${mode}完成: ${applied} 处生效, ${already} 处已存在, 共 ${artifactPatches.length} 处`)
