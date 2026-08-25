import assert from 'node:assert/strict'
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// 服务器上当前用户通常不在 docker 组，安装器于是走 sudo 分支。sudo 默认 env_reset，
// 所以 `export DSH_IMAGE` 到不了 docker compose，插值会退回 dsh:local——安装器就会去
// docker.io 拉一个根本不存在的 library/dsh:local。这个用例把 sudo 的行为原样模拟出来，
// 断言镜像引用仍然抵达 docker compose。
const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installScript = join(root, 'install.sh')
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`].find(existsSync)
  : 'bash'

assert.ok(bash, 'bash is required for the sudo installer smoke test')

const bashPath = (path) => process.platform === 'win32'
  ? path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\\\', '/')
  : path

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-sudo-smoke-'))
const mockBin = join(sandbox, 'bin')
const dockerLog = join(sandbox, 'docker.log')
const dockerState = join(sandbox, 'docker.state')
await mkdir(mockBin)

// docker info 失败，强制安装器选择 sudo 分支；每次调用都连同插值结果一起记录。
const dockerMock = `#!/bin/sh
set -eu
printf '%s | DSH_IMAGE=%s\\n' "$*" "\${DSH_IMAGE:-<unset>}" >> "$MOCK_DOCKER_LOG"
if [ "\${1:-}" = info ]; then exit 1; fi
if [ "\${1:-}" = compose ]; then
  case " $* " in
    *" up -d "*) : > "$MOCK_DOCKER_STATE" ;;
  esac
fi
if [ "\${1:-}" = inspect ]; then
  if [ "\${2:-}" = dsh ] && [ "\${3:-}" != --format ]; then printf '%s\\n' '[]'; exit 1; fi
  [ -f "$MOCK_DOCKER_STATE" ] || exit 1
  cat "$MOCK_DOCKER_STATE"
fi
if [ "\${1:-}" = container ] && [ "\${2:-}" = inspect ] && [ "\${3:-}" = dsh ]; then
  printf '%s\\n' '[]'
  exit 1
fi
if [ "\${1:-}" = exec ]; then
  printf '%s\\n' 0
fi
exit 0
`

// 真 sudo 只保留白名单里的变量。这里额外放行 MOCK_* 是因为桩脚本要用它们写日志，
// 被测的 DSH_* 依旧照真实行为清空。
const sudoMock = `#!/bin/sh
set -eu
exec env -i \\
  PATH="$PATH" \\
  HOME="\${HOME:-/tmp}" \\
  MOCK_DOCKER_LOG="$MOCK_DOCKER_LOG" \\
  MOCK_DOCKER_STATE="$MOCK_DOCKER_STATE" \\
  "$@"
`

for (const [name, mock] of [['docker', dockerMock], ['sudo', sudoMock]]) {
  const path = join(mockBin, name)
  await writeFile(path, mock)
  await chmod(path, 0o755)
}

const runInstall = async (target, args) => {
  const directory = join(sandbox, target)
  await mkdir(directory, { recursive: true })
  await cp(join(root, 'docker-compose.yml'), join(directory, 'docker-compose.yml'))
  return spawnSync(bash, [
    '-c',
    'PATH="$MOCK_BIN:$PATH"; export PATH; exec "$INSTALL_SCRIPT" "$@"',
    'dsh-sudo-smoke',
    'install', '--non-interactive', '--dir', target, ...args,
  ], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MOCK_DOCKER_LOG: dockerLog,
      MOCK_DOCKER_STATE: dockerState,
      MOCK_BIN: bashPath(mockBin),
      INSTALL_SCRIPT: bashPath(installScript),
    },
  })
}

const lastCall = (log, prefix, needle) => log
  .split('\n')
  .filter((line) => line.startsWith(prefix) && line.includes(needle))
  .at(-1)

try {
  const prebuilt = await runInstall('prebuilt-install', ['--access', 'local'])
  assert.equal(prebuilt.status, 0, `${prebuilt.stdout}\n${prebuilt.stderr}`)
  const log = await readFile(dockerLog, 'utf8')
  // 拉取把引用写在命令行上，所以它完全不依赖环境传递。
  const pull = lastCall(log, 'pull ', 'ghcr.io')
  assert.ok(pull, 'installer never pulled the prebuilt reference')
  assert.match(pull, /^pull ghcr\.io\/univers629\/dsh-docker:latest \| /)

  const built = await runInstall('build-install', ['--access', 'local', '--image-source', 'build'])
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`)
  const buildLog = await readFile(dockerLog, 'utf8')
  const build = lastCall(buildLog, 'compose ', ' build dsh')
  assert.ok(build, 'installer never reached docker compose build')
  assert.match(build, /DSH_IMAGE=dsh:local$/)

  // 启动仍然靠 --env-file，sudo 保留工作目录，所以这条不需要透传变量。
  const up = lastCall(buildLog, 'compose ', ' up -d ')
  assert.ok(up, 'installer never reached docker compose up')
  assert.match(up, /--env-file \.env\.pending\./)
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

console.log('sudo installer smoke: ok')
