import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const files = Object.fromEntries(await Promise.all([
  ['compose', 'docker-compose.yml'],
  ['dockerfile', 'Dockerfile'],
  ['entrypoint', 'bin/entrypoint.sh'],
  ['skill', 'dsh-home/skills/container-environment/SKILL.md'],
  ['dshSh', 'dsh.sh'],
  ['dshBat', 'dsh.bat'],
  ['installSh', 'install.sh'],
  ['installPs1', 'install.ps1'],
  ['envExample', '.env.example'],
].map(async ([name, path]) => [name, await readFile(new URL('../' + path, import.meta.url), 'utf8')])))

assert.match(files.compose, /^\s+user:\s+"0:0"$/m)
assert.match(files.compose, /security_opt:\s*\n\s*- no-new-privileges:true/)
assert.doesNotMatch(files.compose, /privileged:\s*true/)
assert.doesNotMatch(files.compose, /docker\.sock/)
assert.doesNotMatch(files.compose, /DSH_RUN_AS_ROOT/)

assert.match(files.dockerfile, /ARG DEBIAN_IMAGE=debian:13-slim/)
assert.match(files.dockerfile, /FROM \$\{DEBIAN_IMAGE\} AS runtime/)
assert.match(files.dockerfile, /DSH_UPDATE_STATE=\/data\/dsh\/update/)
assert.match(files.dockerfile, /DSH_NGINX_CONFIG=\/usr\/local\/share\/dsh\/nginx\.conf/)
const runtimeDockerfile = files.dockerfile.slice(files.dockerfile.indexOf('FROM ' + '$' + '{DEBIAN_IMAGE} AS runtime'))
assert.match(runtimeDockerfile, /RUN --mount=type=cache,target=\/var\/cache\/apt,sharing=locked/)
assert.match(runtimeDockerfile, /apt-get update/)
assert.match(runtimeDockerfile, /^\s+make \\$/m)
assert.match(runtimeDockerfile, /^\s+gcc \\$/m)
assert.match(runtimeDockerfile, /^\s+g\+\+ \\$/m)
assert.doesNotMatch(runtimeDockerfile, /\bgosu\b|useradd|groupadd|node:node|--chown=node/)

assert.equal(existsSync(new URL('../docker-compose.system.yml', import.meta.url)), false, 'legacy system compose overlay must not ship in the project')
assert.match(files.compose, /DSH_SYSTEM_PACKAGES_PERSISTENT:\s*"true"/)
assert.doesNotMatch(files.dshSh, /docker-compose\.system\.yml/)
assert.match(files.installSh, /delete[\s\S]*docker-compose\.system\.yml/)
assert.doesNotMatch(files.dockerfile, /dsh-toolchain-apt|DSH_TOOLCHAIN_ROOT|XDG_DATA_DIRS=.*toolchain/)
assert.match(files.dockerfile, /profile\.d\/dsh-toolchain\.sh/)

assert.match(files.entrypoint, /entrypoint requires UID 0/)
assert.match(files.entrypoint, /DSH_CONTAINER_USER=root/)
assert.match(files.entrypoint, /DSH_CONTAINER_UID=0/)
assert.match(files.entrypoint, /DSH_CAN_INSTALL_SYSTEM_PACKAGES=true/)
assert.match(files.entrypoint, /exec \/usr\/local\/bin\/dsh-supervisor/)
assert.match(files.entrypoint, /mkdir -p \/workspace \/data\/dsh\/profiles \/data\/home \/data\/agents \/data\/mcp/)
assert.match(files.dockerfile, /COPY bin\/dsh-supervisor \/usr\/local\/bin\/dsh-supervisor/)
assert.match(files.dockerfile, /COPY bin\/restart-dsh \/usr\/local\/bin\/restart-dsh/)
assert.doesNotMatch(files.entrypoint, /gosu|node:node|id -u node|DSH_RUN_AS_ROOT/)
assert.doesNotMatch(files.entrypoint, /\/data\/home\/tmp/)

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
  assert.match(files.skill, new RegExp('@@' + variable + '@@'))
}
const skillPlaceholders = new Set([...files.skill.matchAll(/@@([A-Z0-9_]+)@@/g)].map(([, name]) => name))
for (const variable of skillPlaceholders) {
  assert.match(files.entrypoint, new RegExp('@@' + variable + '@@'), 'entrypoint does not render ' + variable)
}

assert.doesNotMatch(files.installSh, /--run-as-root|--normal-user|--no-root/)
assert.match(files.installSh, /remove_compose_env DSH_RUN_AS_ROOT/)
assert.match(files.installSh, /assert_dsh_root/)
assert.match(files.installSh, /sed -n 1p \/run\/dsh\.pid/)
assert.doesNotMatch(files.installSh, /cat \/run\/dsh\.pid/)
assert.match(files.installSh, /未知参数/)
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

assert.match(files.dshBat, /docker exec dsh \/usr\/local\/bin\/update-dsh/)
assert.match(files.dshBat, /docker compose stop dsh/)
assert.match(files.dshBat, /docker compose up -d --no-build dsh/)
assert.doesNotMatch(files.dshBat, /up -d --force-recreate/)
assert.doesNotMatch(files.dshBat, /docker image prune/)

assert.match(files.installPs1, /compose build dsh/)
assert.match(files.installPs1, /Invoke-ComposeWithEnvFile/)
assert.match(files.installPs1, /Assert-DshRoot/)
assert.match(files.installPs1, /sed -n 1p \/run\/dsh\.pid/)
assert.doesNotMatch(files.installPs1, /cat \/run\/dsh\.pid/)
assert.match(files.installPs1, /delete[\s\S]*docker-compose\.system\.yml/)
assert.doesNotMatch(files.installPs1, /\[switch\]\$Root|\[switch\]\$User/)
assert.match(files.installPs1, /Remove-ComposeEnvValue \$pendingEnvFile 'DSH_RUN_AS_ROOT'/)
assert.match(files.installPs1, /fetch origin main/)
assert.match(files.installPs1, /merge --ff-only FETCH_HEAD/)
assert.match(files.installPs1, /-Arguments @\('up','-d','--force-recreate'\)/)
assert.doesNotMatch(files.envExample, /DSH_RUN_AS_ROOT/)
assert.match(files.dockerfile, /COPY dsh-home\/ \/usr\/local\/share\/dsh-home\//)
assert.match(files.dockerfile, /COPY nginx\/dsh-nginx\.conf \/usr\/local\/share\/dsh\/nginx\.conf/)
assert.doesNotMatch(files.entrypoint, /\/etc\/dsh-home/)

console.log('root-only runtime smoke: ok')
