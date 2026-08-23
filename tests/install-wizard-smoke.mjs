import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [compose, dockerfile, entrypoint, authConfig, nginx, installSh, installPs1, envExample, dshSh, readmeZh, readmeEn] = await Promise.all([
  'docker-compose.yml', 'Dockerfile', 'bin/entrypoint.sh', 'bin/configure-nginx-auth', 'nginx/dsh-nginx.conf',
  'install.sh', 'install.ps1', '.env.example', 'dsh.sh', 'README.md', 'README.en.md',
].map(read))

assert.match(compose, /DSH_ACCESS_MODE: "\$\{DSH_ACCESS_MODE:-local\}"/)
assert.match(compose, /\.\/data\/auth:\/opt\/dsh-auth:ro/)
assert.match(compose, /127\.0\.0\.1:3080\/healthz/)
assert.match(dockerfile, /apache2-utils/)
assert.match(dockerfile, /127\.0\.0\.1:3080\/healthz/)

assert.match(entrypoint, /\/usr\/local\/bin\/configure-nginx-auth/)
assert.match(authConfig, /DSH_ACCESS_MODE:-local/)
assert.match(authConfig, /basic\)/)
assert.match(authConfig, /\/opt\/dsh-auth\/htpasswd/)
assert.match(authConfig, /\/tmp\/dsh-htpasswd/)
assert.match(authConfig, /chown node:node/)
assert.match(authConfig, /auth_basic off/)
assert.match(nginx, /include \/tmp\/dsh-auth\.conf/)
assert.match(nginx, /location = \/healthz/)
assert.match(nginx, /healthz \{\s+auth_basic off/s)

for (const action of ['install', 'configure', 'update', 'start', 'stop', 'restart', 'logs', 'status']) {
  assert.ok(installSh.includes(action), `install.sh missing ${action}`)
  assert.ok(installPs1.includes(action), `install.ps1 missing ${action}`)
}
for (const mode of ['local', 'trusted-proxy', 'basic']) {
  assert.ok(installSh.includes(mode), `install.sh missing access mode ${mode}`)
  assert.ok(installPs1.includes(mode), `install.ps1 missing access mode ${mode}`)
}
assert.match(installSh, /< \/dev\/tty/)
assert.match(installSh, /htpasswd dsh:local -niB/)
assert.match(installSh, /未写入 \.env/)
assert.match(installPs1, /Read-Host .* -AsSecureString/)
assert.match(installPs1, /htpasswd dsh:local -niB/)
assert.match(installSh, /https:\/\/github\.com\/univers629\/dsh-docker\.git/)
assert.match(installSh, /univers629\/dsh-docker\/archive\/refs\/heads\/main\.tar\.gz/)
assert.match(installPs1, /https:\/\/github\.com\/univers629\/dsh-docker\.git/)
assert.match(installPs1, /univers629\/dsh-docker\/archive\/refs\/heads\/main\.zip/)
assert.match(installPs1, /temp\\dsh-docker-main\\\*/)
assert.match(installSh, /DSH_INSTALL_DIR:-dsh-docker/)
assert.match(installPs1, /\$Dir = 'dsh-docker'/)
assert.match(dockerfile, /org\.opencontainers\.image\.title="dsh-docker"/)
assert.match(readmeZh, /raw\.githubusercontent\.com\/univers629\/dsh-docker\/main\/install\.sh/)
assert.match(readmeEn, /raw\.githubusercontent\.com\/univers629\/dsh-docker\/main\/install\.ps1/)
const legacyNames = new RegExp(`${['dsh', 'docker', 'dev'].join('-')}|${['dsh', 'docker'].join('_')}`)
assert.doesNotMatch(`${installSh}\n${installPs1}\n${readmeZh}\n${readmeEn}`, legacyNames)
assert.match(envExample, /^DSH_ACCESS_MODE=local$/m)
assert.doesNotMatch(dshSh, /network connect.*dpanel-local/)

console.log('install wizard smoke: ok')
