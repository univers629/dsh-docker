import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const files = Object.fromEntries(await Promise.all([
  ['compose', 'docker-compose.yml'],
  ['systemCompose', 'docker-compose.system.yml'],
  ['dockerfile', 'Dockerfile'],
  ['entrypoint', 'bin/entrypoint.sh'],
  ['skill', 'dsh-home/skills/container-environment/SKILL.md'],
  ['dshSh', 'dsh.sh'],
  ['installSh', 'install.sh'],
  ['installPs1', 'install.ps1'],
  ['envExample', '.env.example'],
].map(async ([name, path]) => [name, await readFile(new URL(`../${path}`, import.meta.url), 'utf8')])))

assert.match(files.compose, /DSH_RUN_AS_ROOT:\s+"\$\{DSH_RUN_AS_ROOT:-true\}"/)
assert.match(files.compose, /security_opt:\s*\n\s*- no-new-privileges:true/)
assert.doesNotMatch(files.compose, /privileged:\s*true/)
assert.doesNotMatch(files.compose, /docker\.sock/)
assert.match(files.dockerfile, /ARG DEBIAN_IMAGE=debian:13-slim/)
assert.match(files.dockerfile, /FROM \$\{DEBIAN_IMAGE\} AS runtime/)
assert.match(files.dockerfile, /DSH_UPDATE_STATE=\/data\/dsh\/update/)
assert.match(files.dockerfile, /DSH_NGINX_CONFIG=\/usr\/local\/share\/dsh\/nginx\.conf/)
const runtimeDockerfile = files.dockerfile.slice(files.dockerfile.indexOf('FROM ${DEBIAN_IMAGE} AS runtime'))
assert.match(runtimeDockerfile, /RUN --mount=type=cache,target=\/var\/cache\/apt,sharing=locked/)
assert.match(runtimeDockerfile, /apt-get update/)
assert.match(runtimeDockerfile, /^\s+make \\$/m)
assert.match(runtimeDockerfile, /^\s+gcc \\$/m)
assert.match(runtimeDockerfile, /^\s+g\+\+ \\$/m)
assert.match(files.systemCompose, /dsh-system-usr-bin/)
assert.match(files.compose, /DSH_SYSTEM_PACKAGES_PERSISTENT:\s*"true"/)
assert.doesNotMatch(files.dshSh, /docker-compose\.system\.yml/)
assert.doesNotMatch(files.installSh, /docker-compose\.system\.yml/)
assert.doesNotMatch(files.dockerfile, /dsh-toolchain-apt|DSH_TOOLCHAIN_ROOT|XDG_DATA_DIRS=.*toolchain/)
assert.match(files.dockerfile, /profile\.d\/dsh-toolchain\.sh/)

assert.match(files.entrypoint, /true\|1\|yes\|on/)
assert.match(files.entrypoint, /false\|0\|no\|off/)
assert.match(files.entrypoint, /DSH_RUN_AS_ROOT:-true/)
assert.match(files.entrypoint, /invalid DSH_RUN_AS_ROOT/)
assert.match(files.entrypoint, /DSH_RUN_AS_ROOT=true.*requires the container entrypoint/s)
assert.doesNotMatch(files.entrypoint, /\/data\/home\/tmp/)
assert.match(files.entrypoint, /exec gosu node \/usr\/local\/bin\/dsh/)
assert.match(files.entrypoint, /exec \/usr\/local\/bin\/dsh/)
for (const variable of [
  'DSH_SYSTEM_OS',
  'DSH_SYSTEM_RELEASE',
  'DSH_SYSTEM_ARCH',
  'DSH_SYSTEM_PACKAGE_ARCH',
  'DSH_SYSTEM_ABI',
  'DSH_SYSTEM_LIBC',
  'DSH_CONTAINER_USER',
  'DSH_CONTAINER_UID',
  'DSH_CONTAINER_GID',
  'DSH_PERMISSION_MODE',
  'DSH_HOST_ACCESS',
  'DSH_WRITABLE_PATHS',
  'DSH_SYSTEM_PACKAGES_PERSISTENT',
  'DSH_CAN_INSTALL_SYSTEM_PACKAGES',
  'DSH_DOCKER_SOCKET_AVAILABLE',
]) {
  assert.match(files.entrypoint, new RegExp(variable))
  assert.match(files.skill, new RegExp(`@@${variable}@@`))
}
const skillPlaceholders = new Set([...files.skill.matchAll(/@@([A-Z0-9_]+)@@/g)].map(([, name]) => name))
for (const variable of skillPlaceholders) {
  assert.match(files.entrypoint, new RegExp(`@@${variable}@@`), `entrypoint does not render ${variable}`)
}

for (const flag of ['--root', '--run-as-root', '--user', '--normal-user', '--no-root']) {
  assert.ok(files.installSh.includes(flag), `install.sh missing ${flag}`)
}
assert.match(files.installSh, /未知参数/)
assert.match(files.installSh, /set_compose_env DSH_RUN_AS_ROOT/)
assert.doesNotMatch(files.installSh, /fetch origin main/)
assert.doesNotMatch(files.installSh, /merge --ff-only FETCH_HEAD/)
assert.match(files.installSh, /compose .*build dsh/)
assert.match(files.installSh, /compose .*up -d --force-recreate/)
assert.doesNotMatch(files.installSh, /DOCKER image prune/)
assert.doesNotMatch(files.dshSh, /PREPARE_SYSTEM_VOLUMES/)
assert.match(files.dshSh, /DOCKER exec dsh \/usr\/local\/bin\/update-dsh/)
assert.match(files.dshSh, /compose .*stop dsh/)
assert.match(files.dshSh, /up -d --no-build dsh/)
assert.doesNotMatch(files.dshSh, /up -d --force-recreate/)
assert.match(files.installPs1, /compose build dsh/)
assert.match(files.installPs1, /Invoke-ComposeWithEnvFile/)
assert.doesNotMatch(files.installPs1, /docker-compose\.system\.yml/)
assert.match(files.installPs1, /\[switch\]\$Root/)
assert.match(files.installPs1, /\[switch\]\$User/)
assert.match(files.installPs1, /Set-ComposeEnvValue/)
assert.match(files.installPs1, /DSH_RUN_AS_ROOT/)
assert.match(files.installPs1, /fetch origin main/)
assert.match(files.installPs1, /merge --ff-only FETCH_HEAD/)
assert.match(files.installPs1, /-Arguments @\('up','-d','--force-recreate'\)/)
assert.match(files.envExample, /^DSH_RUN_AS_ROOT=true$/m)
assert.match(files.dockerfile, /COPY dsh-home\/ \/usr\/local\/share\/dsh-home\//)
assert.match(files.dockerfile, /COPY nginx\/dsh-nginx\.conf \/usr\/local\/share\/dsh\/nginx\.conf/)
assert.doesNotMatch(files.entrypoint, /\/etc\/dsh-home/)

console.log('run mode smoke: ok')
