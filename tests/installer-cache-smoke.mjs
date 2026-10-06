// 回归：向导二进制的缓存必须按内容寻址，并在下载后校验。
//
// 背景（真实事故）：缓存文件名曾只由「版本号 + 架构」决定。同一个版本号下重发
// 二进制后，旧缓存永远命中——用户拿到的是上一版向导界面，却以为是新版，而且
// 无从发现。在服务器上表现为「工作流重跑成功了，但界面没变」。
//
// 这里不模拟 HTTP：curl 支持 file://，所以直接让 DSH_INSTALLER_BASE 指向本地目录，
// 就能精确控制「清单里的哈希」与「文件内容」，且不依赖网络与端口。
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installSh = readFileSync(join(root, 'install.sh'), 'utf8')
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`]
    .find((entry) => existsSync(entry))
  : 'bash'
assert.ok(bash, 'bash is required for the cache logic test')

// —— 结构断言：函数存在、命名含摘要前缀、下载后校验 ——
assert.match(installSh, /^dsh_installer_path\(\) \{$/m, 'install.sh 必须定义 dsh_installer_path')
assert.match(installSh, /^use_unverified_cache\(\) \{$/m, 'install.sh 必须定义 use_unverified_cache')
// 注意：不在这里断言两个函数的「文本先后」。bash 先整体解析再执行，函数只要在
// 调用发生前完成定义即可，而整个文件在跑第一行之前就解析完了。真正的验证是下面
// 的情形 4/5——它们会在运行时走到 use_unverified_cache，若定义缺失就会报
// "command not found"（这正是用只抽一个函数的简化测试时踩到的坑）。
assert.match(
  installSh,
  /dest="\$cache\/dsh-installer-\$DSH_INSTALLER_VERSION-\$arch-\$\(printf '%s' "\$want" \| cut -c1-12\)"/,
  '缓存路径必须包含发布清单里的摘要前缀（内容寻址）',
)
// 必须用重定向而非传路径：GNU sha256sum 在文件名含反斜杠时会给整行加 `\` 转义
// 前缀（Windows 路径必然含反斜杠），那样取到的「哈希」会多一个字符而使校验永远失败。
assert.match(installSh, /got="\$\(sha256sum < "\$dest\.tmp"/, '计算实际摘要时必须从 stdin 读取')
assert.match(installSh, /\[ "\$got" != "\$want" \]/, '实际摘要与清单不符时必须拒绝使用')
// 清单解析要容忍行尾 CR（Windows 上的 Git Bash、被中间设备改写的响应）。
assert.match(installSh, /tr -d '\\r'/, '解析 SHA256SUMS 时必须去掉行尾 CR')
// 拿不到清单时应先尝试下载、再退回缓存：反过来会让陈旧缓存永远胜出，
// 用户在网络明明通的情况下一直看到上一版界面且无从发现。
const noManifestBranch = installSh.slice(
  installSh.indexOf('拿不到清单（离线、镜像源没放 SHA256SUMS）'),
  installSh.indexOf('use_unverified_cache() {'),
)
assert.ok(noManifestBranch.length > 0, '应能找到「无清单」分支')
const dlIdx = noManifestBranch.indexOf('if curl -fsSL')
// 取最后一次调用：分支开头还有一个「没有 curl 时只能看缓存」的早退，
// 它本来就该在下载之前。要断言的是「下载尝试失败之后」才回退缓存。
const cacheIdx = noManifestBranch.lastIndexOf('use_unverified_cache "$cache"')
assert.ok(dlIdx >= 0 && cacheIdx >= 0, '无清单分支应同时包含下载与缓存回退')
assert.ok(dlIdx < cacheIdx, '无清单时应先尝试下载，失败才退回缓存')

// 抽出两个函数，拼成测试可调用的脚本。
function extractFn(name) {
  const start = installSh.indexOf(`${name}() {`)
  assert.ok(start > 0, `找不到函数 ${name}`)
  const rest = installSh.slice(start)
  const end = rest.indexOf('\n}\n')
  assert.ok(end > 0, `函数 ${name} 未正常结束`)
  return rest.slice(0, end + 2)
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-cache-smoke-'))
const release = join(sandbox, 'release')
// URL 形状是 "$BASE/v$VERSION/<文件名>"，所以本地目录要有 v0.1.0 这一层。
const verDir = join(release, 'v0.1.0')
mkdirSync(verDir, { recursive: true })

const NEW_BODY = 'BINARY-NEW-CONTENT-v2\n'
const OLD_BODY = 'BINARY-OLD-CONTENT\n'
writeFileSync(join(verDir, 'dsh-installer-linux-amd64'), NEW_BODY)
const newHash = createHash('sha256').update(NEW_BODY).digest('hex')
const oldHash = createHash('sha256').update(OLD_BODY).digest('hex')
const manifestPath = join(verDir, 'SHA256SUMS')
const writeManifest = (hash) =>
  writeFileSync(manifestPath, `${hash}  dsh-installer-linux-amd64\n`)

const runner = join(sandbox, 'run.sh')
// 注意工作目录：dsh_installer_path 会优先使用「工程内已构建的产物」
//（./cmd/dsh-installer/dsh-installer），那是给开发者本机验证用的。
// 测试必须在空目录里跑，否则会命中那个产物、绕过被测的缓存逻辑。
const emptyCwd = join(sandbox, 'cwd')
mkdirSync(emptyCwd, { recursive: true })
writeFileSync(runner, `#!/usr/bin/env bash
set -uo pipefail
cd "${emptyCwd}"
${extractFn('dsh_installer_path')}
${extractFn('use_unverified_cache')}
${extractFn('cache_candidate_ok')}
DSH_INSTALLER_VERSION=0.1.0
DSH_INSTALLER_BASE="\${BASE:?}"
XDG_CACHE_HOME="\${CACHE:?}"
export DSH_INSTALLER_VERSION DSH_INSTALLER_BASE XDG_CACHE_HOME
mkdir -p "$XDG_CACHE_HOME"
dsh_installer_path
`)

// file:// URL 需要 POSIX 风格路径。
const asUrl = (p) => `file://${p.replaceAll('\\', '/')}`
const run = (cache, base) => {
  const res = spawnSync(bash, [runner], {
    encoding: 'utf8',
    env: { ...process.env, CACHE: cache, BASE: base },
  })
  return { out: res.stdout.trim(), err: res.stderr, status: res.status }
}

// 情形 1：哈希匹配 → 下载、校验通过、缓存名带摘要前缀
writeManifest(newHash)
const cache1 = join(sandbox, 'c1')
const r1 = run(cache1, asUrl(release))
assert.ok(r1.out, `情形 1 应下载成功，stderr: ${r1.err}`)
assert.ok(r1.out.endsWith(newHash.slice(0, 12)), `缓存名应含摘要前缀，实际 ${r1.out}`)
assert.match(readFileSync(r1.out, 'utf8'), /NEW-CONTENT/, '情形 1 下载到的内容应正确')

// 情形 2：磁盘上已有「同一版本号 + 旧内容」的缓存 → 不应被复用
const stale = join(join(cache1, 'dsh-docker'), `dsh-installer-0.1.0-amd64-${oldHash.slice(0, 12)}`)
writeFileSync(stale, OLD_BODY)
chmodSync(stale, 0o755)
const r2 = run(cache1, asUrl(release))
assert.equal(r2.out, r1.out, '旧缓存不应被误用，应仍选中带新摘要的那份')

// 情形 3：清单哈希与实际文件不符 → 拒绝并报错，不留临时文件
writeManifest('0'.repeat(64))
const cache3 = join(sandbox, 'c3')
const r3 = run(cache3, asUrl(release))
assert.equal(r3.out, '', '哈希不符时不应返回可用路径')
assert.match(r3.err, /校验失败/, `哈希不符时必须说明原因，实际: ${r3.err}`)
// 不能把校验失败的文件留在缓存目录里（否则下次无清单时会拿它当缓存用）。
const leftoverDir = join(cache3, 'dsh-docker')
const leftovers = existsSync(leftoverDir)
  ? readdirSync(leftoverDir).filter((f) => !f.endsWith('.tmp'))
  : []
assert.deepEqual(leftovers, [], `校验失败后不应留下可用的缓存文件，实际: ${leftovers.join(', ')}`)

// 情形 4：拿不到清单（离线/镜像源没放）→ 复用已缓存的那份，并警告未经校验
writeManifest(newHash)
const cache4 = join(sandbox, 'c4')
const r4a = run(cache4, asUrl(release))
assert.ok(r4a.out, '情形 4 的前置下载应成功')
// 让清单与二进制都取不到：指向一个空目录，模拟完全离线
const emptyDir = join(sandbox, 'empty')
mkdirSync(join(emptyDir, 'v0.1.0'), { recursive: true })
const r4b = run(cache4, asUrl(emptyDir))
assert.equal(r4b.out, r4a.out, '离线时应复用那份已缓存的向导')
assert.match(r4b.err, /未校验/, '离线复用时必须警告未经校验，避免被当成最新版')

// 情形 5：缓存里只有旧命名的文件（历史遗留），无清单时也应能用
const cache5 = join(sandbox, 'c5')
mkdirSync(join(cache5, 'dsh-docker'), { recursive: true })
const legacy = join(cache5, 'dsh-docker', 'dsh-installer-0.1.0-amd64')
writeFileSync(legacy, OLD_BODY)
chmodSync(legacy, 0o755)
const r5 = run(cache5, asUrl(emptyDir))
// 比较时统一分隔符：返回值里缓存目录用的是传进去的 Windows 路径（反斜杠），
// 文件部分是拼接的字面量（正斜杠），直接比较会被分隔符差异绊住。
const norm = (p) => p.replaceAll('\\', '/')
assert.equal(norm(r5.out), norm(legacy), '应兼容旧命名的缓存（无摘要后缀）')

console.log('installer cache smoke: ok（内容寻址、校验、拒绝篡改、离线降级、旧命名兼容）')
