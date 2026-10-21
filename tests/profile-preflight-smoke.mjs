import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'bin', 'preflight-profile-plugins.mjs')
const runtimeVersion = '9.9.9'

// 目标运行时树里的 app-boot 由 fixture 提供：预检脚本的职责是取用它并分类，
// 判定规则本身属于上游，不在这个测试里复刻 semver。
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function buildFixture({ bundles, plugins, exemptions, shippedBundles = [] }) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-preflight-'))
  const appDir = join(base, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  const moduleRoot = join(appDir, 'node_modules')
  writeJson(join(appDir, 'package.json'), { name: '@deepseek-ai/dsh', version: runtimeVersion })
  writeJson(join(moduleRoot, '@deepseek-ai', 'dsh-app-boot', 'package.json'), {
    name: '@deepseek-ai/dsh-app-boot',
    version: runtimeVersion,
    main: 'lib/index.js',
    type: 'module',
  })
  const appBoot = join(moduleRoot, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
  mkdirSync(dirname(appBoot), { recursive: true })
  writeFileSync(appBoot, [
    `export function getDshRuntimeVersion() { return ${JSON.stringify(runtimeVersion)} }`,
    'export function evaluatePluginCompatibility(manifest, exemptions = {}, version = getDshRuntimeVersion()) {',
    '  const peers = {}',
    '  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {',
    "    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue",
    '    if (!String(range).includes(version)) peers[name] = range',
    '  }',
    '  if (Object.keys(peers).length === 0) return undefined',
    '  const key = `${manifest.name}@${manifest.version}`',
    '  return { name: manifest.name, version: manifest.version, runtimeVersion: version, peers, exempted: (exemptions[key] ?? []).includes(version) }',
    '}',
    'export function resolveBundleDir(binName, packageName, installAnchor, profileDir) {',
    '  const candidates = [join(dirname(installAnchor), "node_modules", packageName), join(profileDir, "node_modules", packageName)]',
    '  const found = candidates.find((candidate) => existsSync(join(candidate, "package.json")))',
    '  if (found === undefined) throw new Error(`${binName}: cannot resolve ${packageName}`)',
    '  return found',
    '}',
    'import { existsSync } from "node:fs"',
    'import { dirname, join } from "node:path"',
    '',
  ].join('\n'))
  for (const name of shippedBundles) {
    writeJson(join(moduleRoot, name, 'package.json'), { name, version: runtimeVersion })
  }
  const profileDir = join(base, 'profile')
  writeJson(join(profileDir, 'package.json'), { name: 'dsh-profile-web', dsh: { profile: { bundles } } })
  for (const [name, manifest] of Object.entries(plugins)) {
    writeJson(join(profileDir, 'node_modules', name, 'package.json'), manifest)
  }
  if (exemptions !== undefined) writeJson(join(profileDir, 'compatibility.json'), exemptions)
  return { base, moduleRoot, profileDir }
}

const run = (fixture, ...args) => spawnSync(process.execPath, [script, fixture.moduleRoot, fixture.profileDir, ...args], {
  encoding: 'utf8',
})

const lastLine = (text) => text.trimEnd().split('\n').at(-1)

const allOk = buildFixture({
  bundles: ['@deepseek-ai/dsh-base', 'plugin-ok'],
  shippedBundles: ['@deepseek-ai/dsh-base'],
  plugins: {
    'plugin-ok': { name: 'plugin-ok', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': runtimeVersion } },
  },
})
try {
  const ok = run(allOk)
  assert.equal(ok.status, 0, ok.stderr)
  // 随运行时发布的内置 bundle 不在 profile 的 node_modules 里，必须解析成功而不是算成未装载。
  assert.match(lastLine(ok.stdout), /^摘要：共 2 个插件，2 个可用，0 个在新版本下会被禁用，0 个未装载$/)
  // 全可用时带上失败旗标也应该放行。
  assert.equal(run(allOk, '--fail-on-incompatible').status, 0)
  const json = JSON.parse(run(allOk, '--json').stdout)
  assert.equal(json.runtimeVersion, runtimeVersion)
  assert.deepEqual(json.counts, { bundles: 2, ok: 2, exempted: 0, incompatible: 0, missing: 0, unreadable: 0 })
} finally {
  rmSync(allOk.base, { recursive: true, force: true })
}

const mixed = buildFixture({
  bundles: ['plugin-ok', 'plugin-old', 'plugin-absent'],
  plugins: {
    'plugin-ok': { name: 'plugin-ok', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': runtimeVersion } },
    'plugin-old': { name: 'plugin-old', version: '0.1.0', peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' } },
  },
})
try {
  const report = run(mixed)
  assert.equal(report.status, 0, report.stderr)
  assert.match(report.stdout, /- plugin-old@0\.1\.0/)
  assert.match(report.stdout, /"\@deepseek-ai\/dsh-tools":"\^0\.1\.0-rc\.6"/)
  // 处置提示必须能直接抄进 compatibility.json：精确包@版本 与 目标运行时版本。
  assert.match(report.stdout, /"plugin-old@0\.1\.0": \["9\.9\.9"\]/)
  assert.match(lastLine(report.stdout), /^摘要：共 3 个插件，1 个可用，1 个在新版本下会被禁用，1 个未装载$/)
  assert.equal(run(mixed, '--fail-on-incompatible').status, 3)
  assert.equal(run(mixed, '--fail-on-incompatible', '--json').status, 3)
} finally {
  rmSync(mixed.base, { recursive: true, force: true })
}

// 已豁免的插件照旧加载（上游会打警告但不禁用），因此不算阻塞项。
const exempted = buildFixture({
  bundles: ['plugin-old'],
  plugins: {
    'plugin-old': { name: 'plugin-old', version: '0.1.0', peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' } },
  },
  exemptions: { 'plugin-old@0.1.0': [runtimeVersion] },
})
try {
  const report = run(exempted, '--fail-on-incompatible')
  assert.equal(report.status, 0, report.stderr)
  assert.match(report.stdout, /另 1 个已豁免/)
  assert.match(lastLine(report.stdout), /^摘要：共 1 个插件，0 个可用，0 个在新版本下会被禁用，0 个未装载$/)
  const json = JSON.parse(run(exempted, '--json').stdout)
  assert.equal(json.counts.exempted, 1)
  assert.equal(json.results[0].status, 'exempted')
} finally {
  rmSync(exempted.base, { recursive: true, force: true })
}

// 参数错误与自检失败都要有独立的退出码：调用方据此决定是报错还是跳过预检。
assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2)
assert.equal(spawnSync(process.execPath, [script, allOk.moduleRoot, '--bogus'], { encoding: 'utf8' }).status, 2)
const noAppBoot = mkdtempSync(join(tmpdir(), 'dsh-preflight-empty-'))
try {
  assert.equal(spawnSync(process.execPath, [script, noAppBoot], { encoding: 'utf8' }).status, 1)
} finally {
  rmSync(noAppBoot, { recursive: true, force: true })
}

console.log('profile plugin preflight smoke: ok')
