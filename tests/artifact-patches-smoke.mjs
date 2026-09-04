import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const patchDir = join(root, 'patches')
const applier = join(root, 'bin', 'apply-dsh-artifact-patches.mjs')
const { artifactPatches } = await import(new URL('../patches/artifact-patches.mjs', import.meta.url))

// 定义自身的约束：id 唯一；marker 必须能代表“已生效”，所以它要在 replace 里、
// 又不能在 find 里，否则重入判定会把未打的补丁当成打过了。
const ids = new Set()
const optionalIds = new Set([
  'app-boot-realpath-import',
  'app-boot-realpath-package-dir',
  'public-local-mode',
  'workspace-pending-attachments-field',
  'workspace-pending-attachments-methods',
  'workspace-pending-attachments-remove',
  'workspace-pending-attachments-install-views',
  'workspace-note-attachment-on-create',
])
for (const patch of artifactPatches) {
  assert.ok(patch.id && !ids.has(patch.id), `duplicate or missing id: ${patch.id}`)
  ids.add(patch.id)
  assert.equal(Boolean(patch.optional), optionalIds.has(patch.id), `${patch.id}: optional classification changed`)
  for (const field of ['package', 'file', 'why', 'marker', 'find', 'replace']) {
    assert.equal(typeof patch[field], 'string', `${patch.id}.${field} must be a string`)
    assert.ok(patch[field].length > 0, `${patch.id}.${field} must not be empty`)
  }
  assert.ok(patch.replace.includes(patch.marker), `${patch.id}: marker missing from replace`)
  assert.ok(!patch.find.includes(patch.marker), `${patch.id}: marker must not appear in find`)
  assert.notEqual(patch.find, patch.replace, `${patch.id}: find and replace are identical`)
  assert.ok(!patch.file.startsWith('/') && !patch.file.includes('..'), `${patch.id}: file must be package-relative`)
}

const run = (moduleRoot, ...args) => spawnSync(process.execPath, [applier, moduleRoot, ...args], {
  encoding: 'utf8',
  env: { ...process.env, DSH_PATCH_DIR: patchDir },
})

/** 用每条补丁的 find 文本合成一棵假的产物树，验证应用器的真实行为。 */
function buildFixture() {
  const moduleRoot = mkdtempSync(join(tmpdir(), 'dsh-artifact-'))
  for (const patch of artifactPatches) {
    const file = join(moduleRoot, patch.package, patch.file)
    mkdirSync(dirname(file), { recursive: true })
    const existing = (() => {
      try { return readFileSync(file, 'utf8') } catch { return '' }
    })()
    writeFileSync(file, `${existing}// fixture head\n${patch.find}\n// fixture tail\n`)
  }
  return moduleRoot
}

const moduleRoot = buildFixture()
try {
  const check = run(moduleRoot, '--check')
  assert.equal(check.status, 0, `check failed: ${check.stderr}`)
  assert.match(check.stdout, /处生效, .*处已存在, 共 /)

  const first = run(moduleRoot)
  assert.equal(first.status, 0, `apply failed: ${first.stderr}`)
  for (const patch of artifactPatches) {
    const content = readFileSync(join(moduleRoot, patch.package, patch.file), 'utf8')
    assert.ok(content.includes(patch.marker), `${patch.id}: marker not written`)
  }

  // 重入必须是空操作：镜像构建和容器内更新都会在新装的树上跑一遍，
  // 而人工排查时也可能再跑一次。
  const before = artifactPatches.map(patch => readFileSync(join(moduleRoot, patch.package, patch.file), 'utf8'))
  const second = run(moduleRoot)
  assert.equal(second.status, 0, `re-apply failed: ${second.stderr}`)
  assert.match(second.stdout, new RegExp(`${artifactPatches.length} 处已存在`))
  const after = artifactPatches.map(patch => readFileSync(join(moduleRoot, patch.package, patch.file), 'utf8'))
  assert.deepEqual(after, before, 're-applying the patch set must not change any file')
} finally {
  rmSync(moduleRoot, { recursive: true, force: true })
}

// 锚点消失必须直接失败：上游改了产物形状不能被静默跳过。
const brokenRoot = buildFixture()
try {
  const target = join(brokenRoot, artifactPatches[0].package, artifactPatches[0].file)
  writeFileSync(target, '// upstream moved on\n')
  const broken = run(brokenRoot)
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /锚点未命中/)
} finally {
  rmSync(brokenRoot, { recursive: true, force: true })
}

console.log('artifact patches smoke: ok')
