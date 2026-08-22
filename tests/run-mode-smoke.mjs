import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const files = Object.fromEntries(await Promise.all([
  ['compose', 'docker-compose.yml'],
  ['dockerfile', 'Dockerfile'],
  ['toolchainApt', 'bin/dsh-toolchain-apt'],
  ['entrypoint', 'bin/entrypoint.sh'],
  ['installSh', 'install.sh'],
  ['installPs1', 'install.ps1'],
  ['envExample', '.env.example'],
].map(async ([name, path]) => [name, await readFile(new URL(`../${path}`, import.meta.url), 'utf8')])))

assert.match(files.compose, /DSH_RUN_AS_ROOT:\s+"\$\{DSH_RUN_AS_ROOT:-false\}"/)
assert.match(files.compose, /security_opt:\s*\n\s*- no-new-privileges:true/)
assert.doesNotMatch(files.compose, /privileged:\s*true/)
assert.doesNotMatch(files.compose, /docker\.sock/)
const runtimeDockerfile = files.dockerfile.slice(files.dockerfile.indexOf('FROM ${NODE_IMAGE} AS runtime'))
assert.match(runtimeDockerfile, /RUN --mount=type=cache,target=\/var\/cache\/apt,sharing=locked/)
assert.match(runtimeDockerfile, /apt-get update/)
assert.doesNotMatch(runtimeDockerfile, /target=\/var\/lib\/apt/)
assert.match(files.dockerfile, /COPY bin\/dsh-toolchain-apt \/usr\/local\/bin\/dsh-toolchain-apt/)
assert.match(files.dockerfile, /ln -sf \/usr\/local\/bin\/dsh-toolchain-apt \/usr\/local\/bin\/apt/)
assert.match(files.toolchainApt, /DSH_TOOLCHAIN_ROOT/)
assert.match(files.toolchainApt, /dpkg-deb -x/)
assert.match(files.toolchainApt, /id -u/)
assert.match(files.toolchainApt, /readlink/)
assert.match(files.dockerfile, /LD_LIBRARY_PATH=.*toolchain/)
assert.match(files.dockerfile, /XDG_DATA_DIRS=.*toolchain/)
assert.match(files.dockerfile, /profile\.d\/dsh-toolchain\.sh/)

assert.match(files.entrypoint, /true\|1\|yes\|on/)
assert.match(files.entrypoint, /false\|0\|no\|off/)
assert.match(files.entrypoint, /invalid DSH_RUN_AS_ROOT/)
assert.match(files.entrypoint, /DSH_RUN_AS_ROOT=true.*requires the container entrypoint/s)
assert.match(files.entrypoint, /exec gosu node \/usr\/local\/bin\/dsh/)
assert.match(files.entrypoint, /exec \/usr\/local\/bin\/dsh/)

for (const flag of ['--root', '--run-as-root', '--user', '--normal-user', '--no-root']) {
  assert.ok(files.installSh.includes(flag), `install.sh missing ${flag}`)
}
assert.match(files.installSh, /未知参数/)
assert.match(files.installSh, /set_compose_env DSH_RUN_AS_ROOT/)
assert.match(files.installSh, /fetch origin main/)
assert.match(files.installSh, /merge --ff-only FETCH_HEAD/)
assert.match(files.installSh, /compose up -d --build --force-recreate/)
assert.match(files.installPs1, /\[switch\]\$Root/)
assert.match(files.installPs1, /\[switch\]\$User/)
assert.match(files.installPs1, /Set-ComposeEnvValue/)
assert.match(files.installPs1, /DSH_RUN_AS_ROOT/)
assert.match(files.installPs1, /fetch origin main/)
assert.match(files.installPs1, /merge --ff-only FETCH_HEAD/)
assert.match(files.installPs1, /compose up -d --build --force-recreate/)
assert.match(files.envExample, /^DSH_RUN_AS_ROOT=false$/m)

console.log('run mode smoke: ok')
