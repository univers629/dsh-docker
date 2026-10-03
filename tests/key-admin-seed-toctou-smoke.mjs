// 回归：dsh-key-admin 的 seed 目标读写必须绑定同一个 inode（审计 3.4 的 TOCTOU）。
// 场景一（旧缺陷）：守卫 lstat 通过后换成符号链接，子进程按路径名重开 → 读到密钥。
// 修复后面板进程自己以 O_NOFOLLOW 打开：链接在 open 时就报 ELOOP，不存在窗口。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-toctou-'))
let failures = 0
const check = (ok, label) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + label)
  if (!ok) failures++
}

// 提取被测函数（dsh-key-admin.mjs import 即起服务，不能直接 import）
const source = fs.readFileSync(fileURLToPath(new URL('../bin/dsh-key-admin.mjs', import.meta.url)), 'utf8')
function extract(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`找不到函数 ${name}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error(`${name} 提取失败`)
}
class AdminInputError extends Error {}
const context = { fs, path, AdminInputError, process: { pid: 4242 } }
vm.createContext(context)
vm.runInContext(extract('readSeedTarget') + '\n' + extract('writeSeedTarget'), context)
const { readSeedTarget, writeSeedTarget } = context

console.log('== 场景 1：目标是符号链接（指向密钥文件）→ 读取必须拒绝 ==')
const keyFile = path.join(work, 'keys.json')
const CANARY = 'sk-TOCTOUCANARY-abcdef'
fs.writeFileSync(keyFile, JSON.stringify({ upstreams: { main: { apiKey: CANARY } } }))
const settings = path.join(work, 'settings.yaml')
fs.symlinkSync(keyFile, settings)
let refused = false
try {
  const text = readSeedTarget(settings)
  refused = !text.includes(CANARY) && text === '' ? true : false
  // 返回空串不算拒绝（那是 ENOENT 的语义）；这里必须抛错
  refused = false
} catch (error) {
  refused = error instanceof AdminInputError && /符号链接/.test(error.message)
}
check(refused, '符号链接在 open 时被拒（ELOOP → AdminInputError）')
check(!fs.readFileSync(keyFile, 'utf8').includes('settings'), '密钥文件未被触碰')

console.log('== 场景 2：普通文件 → 正常读取 ==')
fs.rmSync(settings)
fs.writeFileSync(settings, 'llm-pi-ai:\n  providers: {}\n')
check(readSeedTarget(settings) === 'llm-pi-ai:\n  providers: {}\n', '普通文件读出原文')
check(readSeedTarget(path.join(work, 'absent.yaml')) === '', '不存在的文件返回空串')

console.log('== 场景 3：写回时目标是符号链接 → 拒绝动手 ==')
fs.rmSync(settings)
fs.symlinkSync(keyFile, settings)
let writeRefused = false
try {
  writeSeedTarget(settings, '# new content\n', 0o644)
  writeRefused = false
} catch (error) {
  writeRefused = error instanceof AdminInputError && /符号链接或目录/.test(error.message)
}
check(writeRefused, '写入前发现目标是链接，拒绝')
check(!fs.readFileSync(keyFile, 'utf8').includes('new content'), '密钥文件内容未被写入')

console.log('== 场景 4：正常写回 ==')
fs.rmSync(settings)
writeSeedTarget(settings, '# merged\n', 0o644)
check(fs.readFileSync(settings, 'utf8') === '# merged\n', '普通文件写入成功')
// 权限断言仅 POSIX：win32 上 open 的 mode 不映射到 statSync().mode（审计也记录过
// O_NOFOLLOW 在 win32 缺失的事实；面板真实运行在 Debian 容器里，那里两者都成立）。
if (process.platform !== 'win32') {
  check((fs.statSync(settings).mode & 0o777) === 0o644, '权限 0644')
  const creds = path.join(work, '.credentials.yaml')
  writeSeedTarget(creds, 'refs: {}\n', 0o600)
  check((fs.statSync(creds).mode & 0o777) === 0o600, '凭据文件权限 0600')
} else {
  console.log('  SKIP 权限断言（win32 无 POSIX mode）')
}
check(fs.readdirSync(work).every((name) => !name.includes('.tmp')), '无临时文件残留')

fs.rmSync(work, { recursive: true, force: true })
console.log('')
if (failures > 0) { console.log(`${failures} 项失败`); process.exit(1) }
console.log('ALL PASS')
