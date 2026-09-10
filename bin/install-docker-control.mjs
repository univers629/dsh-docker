import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// 内置的 dsh-docker-control 有三个角色，以前它们被并成了一个，这才有了那个坑：
//
//   baked   镜像烘进来的那份（/opt/dsh-docker-control）—— 只是种子
//   source  容器真正运行的那份源（持久数据目录，默认 /data/dsh/docker-control）—— 权威
//   target  profile 里的安装副本 —— 每次拉起 DSH 之前同步一次
//
// 以前 source 就等于 baked，于是"运行中的插件"永远等于构建镜像那一刻的代码：仓库里后来
// 的修改、或者手工放进 profile 的修改，都会在下一次启动被无声冲掉，要让改动生效就只能
// 重建镜像（还得 root 改 /opt）。两次事故都是这么来的。
//
// 现在把权威放到持久数据目录：镜像只在「种子换了」或目录不可用时播种一次，此后数据目录
// 说了算 —— 改完插件重启即生效，既不用重建镜像也不用 root。播种和覆盖都会先比哈希、
// 打告警，并把结论写进 /run/dsh-state/docker-control-source.json 供排查与自检读取。
const baked = process.env.DSH_DOCKER_CONTROL_BAKED ?? '/opt/dsh-docker-control'
const dataDir = process.env.DSH_DOCKER_CONTROL_DATA ?? '/data/dsh/docker-control'
const explicitSource = process.env.DSH_DOCKER_CONTROL_SOURCE
const profile = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web'
const reportFile = process.env.DSH_DOCKER_CONTROL_REPORT ?? '/run/dsh-state/docker-control-source.json'
const seedStampFile = process.env.DSH_DOCKER_CONTROL_SEED_STAMP
  ?? path.join(path.dirname(dataDir), '.dsh-docker-control-seed.json')
const forceSeed = process.env.DSH_DOCKER_CONTROL_RESEED === '1'

const source = explicitSource ?? dataDir
const target = path.join(profile, 'node_modules', 'dsh-docker-control')
const manifestPath = path.join(profile, 'package.json')
const patchPath = path.join(profile, 'cordis.patch.yml')
const workspacePath = path.join(profile, 'pnpm-workspace.yaml')

// node_modules 是构建时装的、体积又大，参与哈希没有意义；.git 同理。
const IGNORED = new Set(['node_modules', '.git'])

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
}

function short(hash) {
  return typeof hash === 'string' ? hash.slice(0, 12) : 'absent'
}

// 插件自身文件的确定性哈希（排序遍历 + 相对路径 + 内容），用来回答"这份和那份是不是
// 同一份"。认不出插件（没有 package.json）时返回 undefined，调用方据此区分"没有"和
// "内容为空"。
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

// 只在自己认定的目录上做删除：目录不存在、或者确实是本插件时才允许重播覆盖，避免
// DSH_DOCKER_CONTROL_DATA 被误设成别的路径时把用户数据删掉。
function replaceTreeInto(from, to) {
  const manifest = readJson(path.join(to, 'package.json'))
  if (fs.existsSync(to) && manifest?.name !== 'dsh-docker-control') return false
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
  // 报告写不出去绝不能影响启动：/run/dsh-state 在排查场景下可能不存在。
  try {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true })
    const temporary = `${reportFile}.tmp.${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, reportFile)
  } catch {}
}

const bakedHash = hashTree(baked)
const bakedUsable = bakedHash !== undefined
if (!bakedUsable && !fs.existsSync(path.join(source, 'package.json'))) {
  // 既没有种子也没有可用的源（例如开发环境直接指向工作树之外）：什么都不做。
  process.exit(0)
}

// The upstream web profile is normally initialized lazily by dsh itself. The
// built-in plugin is installed before dsh starts, so initialize the same
// profile files here when the persistent profile directory is empty.
ensureWebProfile()

let seeded = false
let seedReplacedHash

// 播种只发生在默认路径上：显式指定 DSH_DOCKER_CONTROL_SOURCE 的人是拿它当源用的
// （开发、测试、自维护部署），往那里写镜像种子会把他的东西冲掉。
if (explicitSource === undefined && bakedUsable) {
  const usable = fs.existsSync(path.join(dataDir, 'package.json'))
  const stamp = readJson(seedStampFile)
  // 播种条件只有三个：数据目录不可用、显式要求重播、镜像里的种子换了一份（新镜像）。
  // "数据目录自己改过、但种子没变"刻意不播种 —— 这正是本地改动能活过重启的那一条。
  if (!usable || forceSeed || stamp?.seedHash !== bakedHash) {
    const previousHash = usable ? hashTree(dataDir) : undefined
    if (replaceTreeInto(baked, dataDir)) {
      seeded = true
      try {
        fs.writeFileSync(seedStampFile, `${JSON.stringify({
          seedHash: bakedHash,
          seededAt: new Date().toISOString(),
          source: baked,
          version: pluginVersion(baked),
        }, null, 2)}\n`, 'utf8')
      } catch {}
      if (previousHash !== undefined && previousHash !== bakedHash) {
        seedReplacedHash = previousHash
        process.stderr.write(`[dsh][warn] ${dataDir} held a modified dsh-docker-control (${short(previousHash)}) that the image seed (${short(bakedHash)}) replaced: the image shipped a different plugin build, so local changes were not kept\n`)
      } else {
        process.stderr.write(`[dsh] seeded the built-in Docker control plugin into ${dataDir}\n`)
      }
    }
  }
}

if (!fs.existsSync(path.join(source, 'package.json'))) process.exit(0)

// 上一次的报告就是"我上次装进去的是哪一份"的记忆：有了它才能把"源正常更新"和"有人
// 动过 profile 里那份"区分开 —— 只看两份哈希不等的话，每次正常更新都会被误报成篡改。
const previousReport = readJson(reportFile)
const sourceHash = hashTree(source)
const profileHashBefore = hashTree(target)
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.cpSync(source, target, { recursive: true, force: true })
const profileHashAfter = hashTree(target)

const sourceChanged = typeof previousReport?.sourceHash === 'string' && previousReport.sourceHash !== sourceHash
const profileTampered = profileHashBefore !== undefined
  && typeof previousReport?.profileHashAfter === 'string'
  && profileHashBefore !== previousReport.profileHashAfter

if (profileTampered) {
  process.stderr.write(`[dsh][warn] the profile copy of dsh-docker-control (${short(profileHashBefore)}) had been modified (was ${short(previousReport.profileHashAfter)}) and was overwritten from ${source}; put plugin changes in ${source} instead\n`)
} else if (sourceChanged) {
  process.stderr.write(`[dsh] dsh-docker-control source updated (${short(previousReport.sourceHash)} -> ${short(sourceHash)}); profile synced\n`)
}

writeReport({
  generatedAt: new Date().toISOString(),
  source,
  sourceKind: explicitSource === undefined ? 'data-volume' : 'override',
  sourceHash,
  version: pluginVersion(source),
  baked,
  bakedHash: bakedHash ?? null,
  seedStamp: seedStampFile,
  seeded,
  seedReplacedHash: seedReplacedHash ?? null,
  profileHashBefore: profileHashBefore ?? null,
  profileHashAfter: profileHashAfter ?? null,
  sourceChanged,
  profileTampered,
})

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) process.exit(0)
  if (!bundles.includes('dsh-docker-control')) {
    manifest.dsh.profile.bundles = [...bundles, 'dsh-docker-control']
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    process.stderr.write('[dsh] enabled built-in Docker control plugin\n')
  }
} catch {
  process.stderr.write('[dsh] Docker control plugin could not update the web profile\n')
}
