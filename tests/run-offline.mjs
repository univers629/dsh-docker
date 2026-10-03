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
for (const name of tests) {
  const file = path.join(repo, 'tests', `${name}.mjs`)
  if (!fs.existsSync(file)) { console.log(`[SKIP] ${name}（文件不存在）`); continue }
  const result = spawnSync(process.execPath, [file], { cwd: repo, encoding: 'utf8', timeout: 300000 })
  const ok = result.status === 0
  if (ok) passed++
  else { failed++; failedNames.push(name) }
  const tail = (result.stdout + result.stderr).trim().split('\n').slice(-3).join(' | ')
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name.padEnd(38)} ${ok ? '' : tail.slice(0, 160)}`)
}
console.log('')
console.log(`通过 ${passed}，失败 ${failed}`)
if (failed > 0) { console.log('失败清单: ' + failedNames.join(', ')); process.exit(1) }
