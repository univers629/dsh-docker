import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-docker-control-bootstrap-'))
const profile = join(root, 'profiles', 'web')
const source = resolve('dsh-home/docker-control')
const installer = resolve('bin/install-docker-control.mjs')

try {
  const result = spawnSync(process.execPath, [installer], {
    cwd: resolve('.'),
    env: { ...process.env, DSH_DOCKER_CONTROL_SOURCE: source, DSH_PROFILE_ROOT: profile },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'dsh-docker-control',
  ])
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n')
  assert.match(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'), /nodeLinker: hoisted/)
  assert.equal(readFileSync(join(profile, 'node_modules', 'dsh-docker-control', 'package.json'), 'utf8')
    .includes('dsh-docker-control'), true)

  const beforeSecondRun = readFileSync(join(profile, 'package.json'), 'utf8')
  const second = spawnSync(process.execPath, [installer], {
    cwd: resolve('.'),
    env: { ...process.env, DSH_DOCKER_CONTROL_SOURCE: source, DSH_PROFILE_ROOT: profile },
    encoding: 'utf8',
  })
  assert.equal(second.status, 0, second.stderr || second.stdout)
  assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), beforeSecondRun)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('docker-control bootstrap smoke: ok')
