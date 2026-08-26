import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Git for Windows checks out with core.autocrlf=true by default. CRLF in the
// container scripts breaks their shebang inside the image, and CRLF in the
// artifact patch definitions would make every anchor miss, so the checkout
// end-of-line must be pinned.
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
  'bin/install-dsh-runtime.sh',
  'bin/dsh-privileged-policy.mjs',
  'bin/dsh-privileged-helper.mjs',
  'bin/dsh-root',
  'bin/dsh-apt-shim',
  'bin/dsh-sudo-shim',
  'bin/dsh-update-shim',
  'bin/hash-dsh-password',
  'bin/verify-dsh-hardening',
  'bin/update-dsh.sh',
  // 旁路服务这一层：broker / egress 的策略与进程、ingress 的 Nginx 配置，以及两个
  // compose 叠加文件。它们全部会被 COPY 进镜像或直接交给 docker compose，CRLF 会让
  // shebang、Nginx 指令和 YAML 缩进同时出问题。
  'bin/dsh-key-broker-policy.mjs',
  'bin/dsh-key-broker.mjs',
  'bin/dsh-egress-policy.mjs',
  'bin/dsh-egress-proxy.mjs',
  'nginx/dsh-ingress.conf',
  'docker-compose.keys.yml',
  'docker-compose.isolated.yml',
  'dsh.sh',
  'install.sh',
  'install.ps1',
  'nginx/dsh-nginx.conf',
  'patches/artifact-patches.mjs',
  'bin/apply-dsh-artifact-patches.mjs',
  'bin/prepare-profile-modules.mjs',
  'dsh-home/docker-control/lib/index.js',
]
for (const file of lfFiles) {
  assert.equal(checkAttr('eol', file), 'lf', `${file} must be checked out with LF endings`)
}
for (const file of ['dsh.bat']) {
  assert.equal(checkAttr('eol', file), 'crlf', `${file} must be checked out with CRLF endings`)
}

console.log('line endings smoke: ok')
