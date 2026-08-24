import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installScript = join(root, 'install.sh')
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`].find(existsSync)
  : 'bash'

assert.ok(bash, 'bash is required for the empty-directory installer smoke test')

const bashPath = (path) => process.platform === 'win32'
  ? path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
  : path

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-install-smoke-'))
const mockBin = join(sandbox, 'bin')
const dockerLog = join(sandbox, 'docker.log')
const dockerState = join(sandbox, 'docker.state')
await mkdir(mockBin)

const gitMock = `#!/bin/sh
set -eu
if [ "$1" = clone ]; then
  mkdir -p "$3/.git"
  printf '%s\\n' 'services: {}' > "$3/docker-compose.yml"
  printf '%s\\n' '#!/bin/sh' 'exit 0' > "$3/dsh.sh"
  chmod +x "$3/dsh.sh"
  printf '%s\\n' 'services: {}' > "$3/docker-compose.system.yml"
  exit 0
fi
exit 0
`
const dockerMock = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
if [ "\${1:-}" = compose ]; then
  env_file=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = --env-file ]; then env_file="$argument"; fi
    previous="$argument"
  done
  case " $* " in
    *" build dsh "*)
      if [ "\${MOCK_FAIL_BUILD:-}" = 1 ]; then exit 42; fi
      ;;
    *" up -d --force-recreate "*)
      printf '%s\\n' "compose-env DSH_RUN_AS_ROOT=\${DSH_RUN_AS_ROOT-unset}" >> "$MOCK_DOCKER_LOG"
      awk -F= '$1 == "DSH_RUN_AS_ROOT" { print $0; exit }' "$env_file" > "$MOCK_DOCKER_STATE"
      ;;
  esac
fi
if [ "\${1:-}" = run ]; then
  printf '%s\\n' 'dsh:$2y$05$installerSmokeHash'
fi
if [ "\${1:-}" = inspect ]; then
  if [ "\${2:-}" = dsh ] && [ "\${3:-}" != --format ]; then exit 1; fi
  [ -f "$MOCK_DOCKER_STATE" ] || exit 1
  cat "$MOCK_DOCKER_STATE"
fi
if [ "\${1:-}" = exec ]; then
  if grep -q '=true$' "$MOCK_DOCKER_STATE"; then printf '%s\\n' 0; else printf '%s\\n' 1000; fi
fi
exit 0
`

for (const [name, body] of [['git', gitMock], ['docker', dockerMock]]) {
  const path = join(mockBin, name)
  await writeFile(path, body)
  await chmod(path, 0o755)
}

const runInstall = (target, args, extraEnv = {}) => spawnSync(bash, [
  '-c',
  'PATH="$MOCK_BIN:$PATH"; export PATH; exec "$INSTALL_SCRIPT" "$@"',
  'dsh-install-smoke',
  'install', '--non-interactive', '--dir', target, ...args,
], {
  cwd: sandbox,
  encoding: 'utf8',
  env: {
    ...process.env,
    ...extraEnv,
    MOCK_DOCKER_LOG: dockerLog,
    MOCK_DOCKER_STATE: dockerState,
    MOCK_BIN: bashPath(mockBin),
    INSTALL_SCRIPT: bashPath(installScript),
  },
})

try {
  const local = runInstall('local-install', ['--user', '--access', 'local'])
  assert.equal(local.status, 0, `${local.stdout}\n${local.stderr}`)
  const localEnv = await readFile(join(sandbox, 'local-install', '.env'), 'utf8')
  assert.match(localEnv, /^DSH_RUN_AS_ROOT=false$/m)
  assert.match(localEnv, /^DSH_ACCESS_MODE=local$/m)
  assert.match(localEnv, /^DSH_BIND_HOST=127\.0\.0\.1$/m)

  const basic = runInstall('basic-install', [
    '--access', 'basic',
    '--trusted-hosts', 'dsh.example.com',
  ], {
    DSH_BASIC_AUTH_USER: 'dsh',
    DSH_BASIC_AUTH_PASSWORD: 'installer-smoke-password',
  })
  assert.equal(basic.status, 0, `${basic.stdout}\n${basic.stderr}`)
  const basicEnv = await readFile(join(sandbox, 'basic-install', '.env'), 'utf8')
  const htpasswd = await readFile(join(sandbox, 'basic-install', 'data', 'auth', 'htpasswd'), 'utf8')
  assert.match(basicEnv, /^DSH_ACCESS_MODE=basic$/m)
  assert.match(basicEnv, /^DSH_RUN_AS_ROOT=true$/m)
  assert.match(basicEnv, /^DSH_TRUSTED_HOSTS=dsh\.example\.com$/m)
  assert.doesNotMatch(basicEnv, /installer-smoke-password/)
  assert.match(htpasswd, /^dsh:\$2y\$/)

  const rollback = runInstall('rollback-install', ['--user', '--access', 'local'])
  assert.equal(rollback.status, 0, `${rollback.stdout}\n${rollback.stderr}`)
  const failedRoot = runInstall('rollback-install', ['--root', '--access', 'local'], { MOCK_FAIL_BUILD: '1' })
  assert.notEqual(failedRoot.status, 0, 'Mock build failure unexpectedly succeeded.')
  const rollbackEnv = await readFile(join(sandbox, 'rollback-install', '.env'), 'utf8')
  assert.match(rollbackEnv, /^DSH_RUN_AS_ROOT=false$/m)

  const calls = await readFile(dockerLog, 'utf8')
  assert.match(calls, /compose .* build dsh/)
  assert.match(calls, /compose .* up -d --force-recreate/)
  assert.match(calls, /run --rm -i --entrypoint htpasswd dsh:local -niB dsh/)
  assert.match(calls, /compose-env DSH_RUN_AS_ROOT=unset/)
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

console.log('empty-directory installer smoke: ok')
