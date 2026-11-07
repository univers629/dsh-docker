import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// 侧边栏浏览器插件的预装器：和 install-docker-control.mjs 同一套三角色模型。
//
//   baked   镜像烘进来的种子（/opt/dsh-browser-panel）
//   source  容器里真正运行的那份（持久数据目录，默认 /data/dsh/browser-panel-plugin）
//   target  profile 里的安装副本 —— 每次拉起 DSH 之前同步一次
//
// 为什么不能只拷目录：node_modules 由 pnpm 管理，任何一次 pnpm add/install 都会按
// 依赖图重新计算并移除未登记的目录；而 dsh-app-boot 解析 bundle 时只看 node_modules
// 里有没有那个目录。因此这里既拷目录，也把 dsh-browser-panel 登记成 file: 依赖。
const baked = process.env.DSH_BROWSER_PANEL_BAKED ?? '/opt/dsh-browser-panel'
const dataDir = process.env.DSH_BROWSER_PANEL_DATA ?? '/data/dsh/browser-panel-plugin'
const explicitSource = process.env.DSH_BROWSER_PANEL_SOURCE
const profile = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web'
const reportFile = process.env.DSH_BROWSER_PANEL_REPORT ?? '/run/dsh-state/browser-panel-source.json'
const seedStampFile = process.env.DSH_BROWSER_PANEL_SEED_STAMP
  ?? path.join(path.dirname(dataDir), '.dsh-browser-panel-seed.json')

const source = explicitSource ?? dataDir
const target = path.join(profile, 'node_modules', 'dsh-browser-panel')
const manifestPath = path.join(profile, 'package.json')
const patchPath = path.join(profile, 'cordis.patch.yml')
const workspacePath = path.join(profile, 'pnpm-workspace.yaml')
const PACKAGE = 'dsh-browser-panel'

const IGNORED = new Set(['node_modules', '.git'])

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
}

function short(hash) {
  return typeof hash === 'string' ? hash.slice(0, 12) : 'absent'
}

function hashTree(root) {
  if (!fs.existsSync(path.join(root, 'package.json'))) return undefined
  const hash = crypto.createHash('sha256')
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        walk(full, relative)
        continue
      }
      if (!entry.isFile()) continue
      hash.update(relative).update('\0').update(fs.readFileSync(full)).update('\0')
    }
  }
  walk(root, '')
  return hash.digest('hex')
}

function pluginVersion(root) {
  return readJson(path.join(root, 'package.json'))?.version ?? 'unknown'
}

// 删除只发生在插件自己的目录上：目录不存在，或确实是本插件时才允许覆盖，避免
// DSH_BROWSER_PANEL_DATA 指向其他路径时删掉数据。
function replaceTreeInto(from, to) {
  const manifest = readJson(path.join(to, 'package.json'))
  if (fs.existsSync(to) && manifest?.name !== PACKAGE) return false
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true, force: true })
  return true
}

function ensureWebProfile() {
  fs.mkdirSync(profile, { recursive: true })
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      name: `dsh-profile-${path.basename(profile)}`,
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        },
      },
    }, null, 2)}\n`, 'utf8')
  }
  if (!fs.existsSync(patchPath)) fs.writeFileSync(patchPath, '[]\n', 'utf8')
  if (!fs.existsSync(workspacePath)) {
    fs.writeFileSync(workspacePath, 'nodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
  }
}

function writeReport(payload) {
  try {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true })
    const temporary = `${reportFile}.tmp.${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, reportFile)
  } catch {}
}

function ensureBundleDependency(manifest) {
  const spec = `file:${source}`
  const dependencies = manifest.dependencies ?? (manifest.dependencies = {})
  if (dependencies[PACKAGE] === spec) return false
  dependencies[PACKAGE] = spec
  return true
}

// 锁文件在的时候顺手对齐；没有 pnpm、离线、超时都只记一条告警 —— 下一次真正的安装
// 同样会重写它，不能因此卡住容器启动。
function refreshLockfile() {
  const lockfile = path.join(profile, 'pnpm-lock.yaml')
  if (!fs.existsSync(lockfile)) return false
  try {
    if (fs.readFileSync(lockfile, 'utf8').includes(PACKAGE)) return false
  } catch { return false }
  const result = spawnSync(process.env.DSH_PNPM_BIN ?? 'pnpm',
    ['install', '--lockfile-only', '--ignore-scripts'],
    { cwd: profile, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.error?.message ?? result.stderr ?? '').trim().split('\n').at(-1)
    process.stderr.write(`[dsh][warn] could not refresh ${lockfile} for ${PACKAGE} (${detail === undefined || detail === '' ? `exit ${result.status}` : detail}); the next plugin install will do it\n`)
  }
}

// node_modules 由 pnpm 管理、体积又大，参与哈希没有意义。
const bakedHash = hashTree(baked)
const bakedUsable = bakedHash !== undefined
if (!bakedUsable && !fs.existsSync(path.join(source, 'package.json'))) {
  // 既没有种子也没有可用的源（例如开发环境直接指向工作树之外）：什么都不做。
  process.exit(0)
}

ensureWebProfile()

let seeded = false
if (explicitSource === undefined && bakedUsable) {
  const usable = fs.existsSync(path.join(dataDir, 'package.json'))
  const stamp = readJson(seedStampFile)
  // 播种条件只有两个：数据目录不可用，或者镜像里的种子换了一份（新镜像）。
  // 数据目录被改过而种子未变时不播种，本地修改因此跨重启保留。
  if (!usable || stamp?.seedHash !== bakedHash) {
    if (replaceTreeInto(baked, dataDir)) {
      seeded = true
      try {
        fs.mkdirSync(path.dirname(seedStampFile), { recursive: true })
        fs.writeFileSync(seedStampFile, `${JSON.stringify({
          seedHash: bakedHash,
          seededAt: new Date().toISOString(),
          source: baked,
          version: pluginVersion(baked),
        }, null, 2)}\n`, 'utf8')
      } catch {}
      process.stderr.write(`[dsh] seeded the browser panel plugin into ${dataDir}\n`)
    }
  }
}

if (!fs.existsSync(path.join(source, 'package.json'))) process.exit(0)

const sourceHash = hashTree(source)
const previousReport = readJson(reportFile)
const profileHashBefore = hashTree(target)
fs.mkdirSync(path.dirname(target), { recursive: true })
// 目标路径上可能已经有上一版：pnpm 会把它装成符号链接、镜像种子会留下真实目录，
// 直接 cpSync 到已存在的路径会抛 ERR_FS_CP_EEXIST 并以非零码退出，所以整目录替换。
if (!replaceTreeInto(source, target)) {
  process.stderr.write(`[dsh][warn] ${target} holds something other than ${PACKAGE}; the profile copy was left untouched\n`)
  process.exit(0)
}
const profileHashAfter = hashTree(target)

if (profileHashBefore !== undefined
  && typeof previousReport?.profileHashAfter === 'string'
  && profileHashBefore !== previousReport.profileHashAfter) {
  process.stderr.write(`[dsh][warn] the profile copy of ${PACKAGE} (${short(profileHashBefore)}) had been modified (was ${short(previousReport.profileHashAfter)}) and was overwritten from ${source}; put plugin changes in ${source} instead\n`)
}

writeReport({
  generatedAt: new Date().toISOString(),
  source,
  sourceKind: explicitSource === undefined ? 'data-volume' : 'override',
  sourceHash,
  version: pluginVersion(source),
  baked,
  bakedHash: bakedHash ?? null,
  seeded,
  profileHashBefore: profileHashBefore ?? null,
  profileHashAfter: profileHashAfter ?? null,
})

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) process.exit(0)
  let changed = false
  if (!bundles.includes(PACKAGE)) {
    manifest.dsh.profile.bundles = [...bundles, PACKAGE]
    changed = true
    process.stderr.write('[dsh] enabled built-in browser panel plugin\n')
  }
  if (ensureBundleDependency(manifest)) {
    changed = true
    process.stderr.write(`[dsh] registered ${PACKAGE} as a profile dependency\n`)
  }
  if (changed) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    // 仅在 manifest 发生变化时对齐锁文件：这一步要运行 pnpm，每次启动都跑会延长
    // 冷启动时间，离线时会一直等到超时。锁文件与 manifest 不一致时，面板自身的
    // 安装事务会重写它。
    refreshLockfile()
  }
} catch {
  process.stderr.write('[dsh] browser panel plugin could not update the web profile\n')
}
