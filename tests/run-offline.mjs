// 批量跑离线冒烟测试并汇总结果
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const tests = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(repo, 'tests'))
      .filter((name) => name.endsWith('-smoke.mjs'))
      .map((name) => name.replace(/\.mjs$/, ''))

let passed = 0
let failed = 0
const failedNames = []
// 有些测试包含「需要外部条件」的动态层（PTY、真 docker daemon）。条件不满足时它们
// 只跑静态层并打印 DYNAMIC-SKIPPED。这类降级必须汇总出来：否则一条什么都没验证的
// 断言会显示 PASS，读日志的人会以为那部分行为已被覆盖。
const skippedDynamic = []
for (const name of tests) {
  const file = path.join(repo, 'tests', `${name}.mjs`)
  if (!fs.existsSync(file)) { console.log(`[SKIP] ${name}（文件不存在）`); continue }
  const result = spawnSync(process.execPath, [file], { cwd: repo, encoding: 'utf8', timeout: 300000 })
  const ok = result.status === 0
  if (ok) passed++
  else { failed++; failedNames.push(name) }
  const all = result.stdout + result.stderr
  for (const line of all.split('\n')) {
    if (line.includes('DYNAMIC-SKIPPED')) skippedDynamic.push(line.trim())
  }
  const tail = all.trim().split('\n').slice(-3).join(' | ')
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name.padEnd(38)} ${ok ? '' : tail.slice(0, 160)}`)
}
console.log('')
console.log(`通过 ${passed}，失败 ${failed}`)
if (skippedDynamic.length > 0) {
  console.log('')
  console.log(`动态层未运行 ${skippedDynamic.length} 处（这些测试只跑了静态断言）：`)
  for (const line of skippedDynamic) console.log('  ' + line)
}
if (failed > 0) { console.log('失败清单: ' + failedNames.join(', ')); process.exit(1) }
