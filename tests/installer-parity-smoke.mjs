// 回归：两个安装器（install.sh 与 install.ps1）对同一事实必须给出同一答案。
//
// 两个安装器各自实现了一套模型配置逻辑：内置 base_url、API 形态默认值、按形态的
// 请求头与路径白名单、broker 请求头的拼装。它们产出的是同一份 data/broker/keys.json，
// 在 Linux 上装与在 Windows 上装结果不同就是缺陷。这里不运行安装器，而是从两份源码里
// **逐字提取**这些表并比对——源码变了而表没同步，这条测试就会红。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sh = readFileSync(join(root, 'install.sh'), 'utf8')
const ps1 = readFileSync(join(root, 'install.ps1'), 'utf8')

/** 取 shell 函数体（从 `name() {` 到第一个顶格 `}`）。 */
function shFunction(source, name) {
  const match = source.match(new RegExp(`${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`))
  assert.ok(match, `install.sh 里找不到函数 ${name}`)
  return match[1]
}

/** 取 PowerShell 函数体（从 `function Name {` 到配对的 `}`，按花括号计数）。 */
function psFunction(source, name) {
  const start = source.indexOf(`function ${name}`)
  assert.ok(start >= 0, `install.ps1 里找不到函数 ${name}`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart + 1, index)
    }
  }
  throw new Error(`install.ps1 的 ${name} 花括号不配对`)
}

// --- 内置 base_url：按名字取 URL，两边必须一字不差 ---
const shBaseUrls = new Map()
for (const [, name, url] of shFunction(sh, 'model_default_base_url').matchAll(/([a-z0-9]+)\) printf '%s' '([^']+)'/g)) {
  shBaseUrls.set(name, url)
}
const psBaseUrls = new Map()
for (const [, name, url] of psFunction(ps1, 'Get-ModelDefaultBaseUrl').matchAll(/'([a-z0-9]+)' \{ return '([^']+)'/g)) {
  psBaseUrls.set(name, url)
}
assert.ok(shBaseUrls.size >= 10, `install.sh 的 base_url 表过小：${shBaseUrls.size}`)
assert.ok(psBaseUrls.size >= 10, `install.ps1 的 base_url 表过小：${psBaseUrls.size}`)
assert.deepEqual(
  [...shBaseUrls].sort(),
  [...psBaseUrls].sort(),
  '两个安装器的内置 base_url 表必须一致（名字与 URL 都要相同）',
)

// --- API 形态默认值：anthropic/claude→messages，gemini/google/googleai→gemini，其余 any ---
const shDefaultProfile = new Map()
for (const [, names, profile] of shFunction(sh, 'broker_default_profile').matchAll(/([a-z|]+)\) printf '%s' '([a-z]+)'/g)) {
  for (const name of names.split('|')) shDefaultProfile.set(name, profile)
}
const psDefaultProfileSrc = psFunction(ps1, 'Get-BrokerDefaultProfile')
const psDefaultProfile = new Map()
for (const [, name, profile] of psDefaultProfileSrc.matchAll(/'([a-z0-9]+)' \{ return '([a-z]+)'/g)) {
  psDefaultProfile.set(name, profile)
}
assert.deepEqual([...shDefaultProfile].sort(), [...psDefaultProfile].sort(), '两个安装器的默认 API 形态必须一致')

// --- 形态允许集合：any/chat/responses/messages/gemini ---
const shProfiles = new Set()
for (const [, list] of shFunction(sh, 'validate_broker_profile').matchAll(/^\s*([a-z|]+)\) ;;/gm)) {
  for (const name of list.split('|')) shProfiles.add(name)
}
const psProfiles = new Set()
const psProfileSrc = psFunction(ps1, 'Test-BrokerProfile')
const psProfileMatch = psProfileSrc.match(/-notin @\(([^)]*)\)/)
assert.ok(psProfileMatch, 'install.ps1 的 Test-BrokerProfile 找不到允许集合')
for (const name of psProfileMatch[1].matchAll(/'([a-z]+)'/g)) psProfiles.add(name[1])
assert.deepEqual([...shProfiles].sort(), [...psProfiles].sort(), '两个安装器的 API 形态允许集合必须一致')

// --- 按形态的请求头名与路径白名单 ---
const shHeaderNames = new Map()
for (const [, profile, header] of shFunction(sh, 'broker_profile_header_name').matchAll(/([a-z|]+)\) printf '%s' '([^']+)'/g)) {
  for (const name of profile.split('|')) shHeaderNames.set(name, header)
}
const psHeaderNames = new Map()
for (const [, profile, header] of psFunction(ps1, 'Get-BrokerProfileHeaderName').matchAll(/'([a-z|]+)' \{ return '([^']+)'/g)) {
  psHeaderNames.set(profile, header)
}
// default 分支两侧的写法不同（shell 是 *，PS 是 default），单独比对它。
const shDefaultHeader = /default\) printf '%s' '([^']+)'/.exec(shFunction(sh, 'broker_profile_header_name'))?.[1] ?? ''
const psDefaultHeader = /default \{ return '([^']+)'\}/.exec(psFunction(ps1, 'Get-BrokerProfileHeaderName'))?.[1] ?? ''
assert.equal(shDefaultHeader, psDefaultHeader, '两个安装器的默认请求头名必须一致')
for (const [profile, header] of shHeaderNames) {
  assert.equal(psHeaderNames.get(profile), header, `形态 ${profile} 的请求头名必须一致`)
}

const shPaths = new Map()
for (const [, profile, paths] of shFunction(sh, 'broker_profile_paths').matchAll(/([a-z|]+)\) printf '%s' '([^']+)'/g)) {
  shPaths.set(profile, paths.split(' ').filter(Boolean).sort())
}
const psPaths = new Map()
for (const [, profile, paths] of psFunction(ps1, 'Get-BrokerProfilePath').matchAll(/'([a-z|]+)' \{ return @\(([^)]*)\)/g)) {
  psPaths.set(profile, [...paths.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort())
}
for (const [profile, paths] of shPaths) {
  if (profile === '*') continue
  assert.deepEqual(psPaths.get(profile), paths, `形态 ${profile} 的路径白名单必须一致`)
}

// --- Anthropic 的 anthropic-version 附加头：缺了会被上游 400 ---
assert.ok(sh.includes('anthropic-version=2023-06-01'), 'install.sh 必须给 messages 形态附加 anthropic-version')
assert.ok(ps1.includes("'anthropic-version' = '2023-06-01'"), 'install.ps1 必须给 messages 形态附加 anthropic-version')

// --- API 形态校验集合也要覆盖 key-admin 的 normalizeShape（第三份实现）---
const adminPolicy = readFileSync(join(root, 'bin', 'dsh-key-admin-policy.mjs'), 'utf8')
const adminShapes = new Set([...adminPolicy.matchAll(/^ {2}([a-z]+): Object\.freeze\(\{$/gm)].map((m) => m[1]))
for (const shape of [...shProfiles]) {
  if (shape === 'any') continue // any 是“按名字推导”，不是 keys.json 里落盘的形态
  assert.ok(adminShapes.has(shape), `key-admin-policy 的 API_SHAPES 缺少形态 ${shape}`)
}

console.log('installer parity smoke: ok')
