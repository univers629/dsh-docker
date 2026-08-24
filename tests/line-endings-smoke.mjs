import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Git for Windows checks out with core.autocrlf=true by default. CRLF in the
// container scripts breaks their shebang inside the image and makes git apply
// reject the DSH patches, so the checkout end-of-line must be pinned.
const root = fileURLToPath(new URL('..', import.meta.url))
const checkAttr = (attribute, file) => {
  const result = spawnSync('git', ['-c', 'safe.directory=*', 'check-attr', attribute, '--', file], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `git check-attr failed for ${file}: ${result.stderr}`)
  return result.stdout.trim().split(': ').pop()
}

const lfFiles = [
  'bin/dsh',
  'bin/dsh-supervisor',
  'bin/restart-dsh',
  'bin/manage-dsh-plugin',
  'bin/cleanup-dsh-plugin-transactions',
  'bin/configure-nginx-auth',
  'bin/entrypoint.sh',
  'bin/apply-dsh-patches.sh',
  'bin/update-dsh.sh',
  'dsh.sh',
  'install.sh',
  'install.ps1',
  'nginx/dsh-nginx.conf',
  'patches/public-local-mode.patch',
  'patches/websocket-keepalive.patch',
  'patches/workspace-session-attachment.patch',
  'dsh-home/docker-control/lib/index.js',
]
for (const file of lfFiles) {
  assert.equal(checkAttr('eol', file), 'lf', `${file} must be checked out with LF endings`)
}
for (const file of ['dsh.bat']) {
  assert.equal(checkAttr('eol', file), 'crlf', `${file} must be checked out with CRLF endings`)
}

console.log('line endings smoke: ok')
