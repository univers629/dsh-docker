import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const files = Object.fromEntries(await Promise.all([
  ['compose', 'docker-compose.yml'],
  ['systemCompose', 'docker-compose.system.yml'],
  ['dockerfile', 'Dockerfile'],
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
assert.match(files.systemCompose, /dsh-system-usr-bin/)
assert.match(files.systemCompose, /dsh-system-usr-bin:\/usr\/bin/)
assert.match(files.systemCompose, /dsh-system-var-lib:\/var\/lib/)
assert.match(files.systemCompose, /device: \.\/data\/system\/usr\/bin/)
assert.doesNotMatch(files.systemCompose, /target: \/usr\/sbin/)
assert.doesNotMatch(files.dockerfile, /dsh-toolchain-apt|DSH_TOOLCHAIN_ROOT|XDG_DATA_DIRS=.*toolchain/)
assert.match(files.dockerfile, /profile\.d\/dsh-toolchain\.sh/)

assert.match(files.entrypoint, /true\|1\|yes\|on/)
assert.match(files.entrypoint, /false\|0\|no\|off/)
assert.match(files.entrypoint, /invalid DSH_RUN_AS_ROOT/)
assert.match(files.entrypoint, /DSH_RUN_AS_ROOT=true.*requires the container entrypoint/s)
assert.doesNotMatch(files.entrypoint, /\/data\/home\/tmp/)
assert.match(files.entrypoint, /exec gosu node \/usr\/local\/bin\/dsh/)
assert.match(files.entrypoint, /exec \/usr\/local\/bin\/dsh/)

for (const flag of ['--root', '--run-as-root', '--user', '--normal-user', '--no-root']) {
  assert.ok(files.installSh.includes(flag), `install.sh missing ${flag}`)
}
assert.match(files.installSh, /未知参数/)
assert.match(files.installSh, /set_compose_env DSH_RUN_AS_ROOT/)
assert.match(files.installSh, /fetch origin main/)
assert.match(files.installSh, /merge --ff-only FETCH_HEAD/)
assert.match(files.installSh, /compose .*build dsh/)
assert.match(files.installSh, /compose .*up -d --force-recreate/)
assert.match(files.installSh, /docker-compose\.system\.yml/)
assert.match(files.installSh, /data\/system\/var\/lib/)
assert.match(files.installPs1, /compose build dsh/)
assert.match(files.installPs1, /compose up -d --force-recreate/)
assert.doesNotMatch(files.installPs1, /docker-compose\.system\.yml/)
assert.match(files.installPs1, /\[switch\]\$Root/)
assert.match(files.installPs1, /\[switch\]\$User/)
assert.match(files.installPs1, /Set-ComposeEnvValue/)
assert.match(files.installPs1, /DSH_RUN_AS_ROOT/)
assert.match(files.installPs1, /fetch origin main/)
assert.match(files.installPs1, /merge --ff-only FETCH_HEAD/)
assert.match(files.installPs1, /compose up -d --force-recreate/)
assert.match(files.envExample, /^DSH_RUN_AS_ROOT=false$/m)

console.log('run mode smoke: ok')
