import assert from 'node:assert/strict'
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// 一键安装：无 TTY 的 curl|bash 直灌（不显式给 --non-interactive）必须走一键默认值——
// basic 认证 + 随机账密 + 随机容器 root 密码 + broker off + egress open，全程零提问，
// 且随机凭据只在结尾回显、绝不写进 .env。
const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installScript = join(root, 'install.sh')
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`].find(existsSync)
  : 'bash'

assert.ok(bash, 'bash is required for the quick-install smoke test')

const bashPath = (path) => process.platform === 'win32'
  ? path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
  : path

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-quick-smoke-'))
const mockBin = join(sandbox, 'bin')
const dockerLog = join(sandbox, 'docker.log')
const dockerState = join(sandbox, 'docker.state')
await mkdir(mockBin)

const dockerMock = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
if [ "\${1:-}" = compose ]; then
  case " $* " in
    *" build dsh "*) ;;
    *" up -d "*) : > "$MOCK_DOCKER_STATE" ;;
  esac
fi
if [ "\${1:-}" = pull ]; then :; fi
if [ "\${1:-}" = run ]; then
  case " $* " in
    *hash-dsh-password*) printf '%s\\n' '$6$quickSmokeSalt$quickSmokeHash' ;;
    *) printf '%s\\n' 'dsh:$2y$05$quickSmokeHash' ;;
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
  case " $* " in
    *verify-dsh-hardening*) exit 0 ;;
    */etc/dsh-broker*) exit 1 ;;
    *dsh-key-broker*) exit 0 ;;
    *dsh-egress*) printf '%s\\n' '{"status":"ok","allowedHosts":42,"activeConnections":0}' ;;
    *dsh-ingress*) exit 0 ;;
    *) printf '%s\\n' 1000 ;;
  esac
  exit 0
fi
exit 0
`

await writeFile(join(mockBin, 'docker'), dockerMock)
await chmod(join(mockBin, 'docker'), 0o755)

const prepareProject = async (name) => {
  const directory = join(sandbox, name)
  await mkdir(directory, { recursive: true })
  await cp(join(root, 'docker-compose.yml'), join(directory, 'docker-compose.yml'))
  await cp(join(root, 'docker-compose.keys.yml'), join(directory, 'docker-compose.keys.yml'))
  await cp(join(root, 'docker-compose.isolated.yml'), join(directory, 'docker-compose.isolated.yml'))
  // quick 安装默认 basic 访问模式：该模式的 htpasswd 单文件挂载叠加层必须在场。
  await cp(join(root, 'docker-compose.basic-auth.yml'), join(directory, 'docker-compose.basic-auth.yml'))
  return directory
}

// 不传 --non-interactive，模拟没有 TTY 的 curl|bash 直灌（spawnSync 默认无 tty）。
const runQuick = (target, args = []) => spawnSync(bash, [
  '-c',
  'PATH="$MOCK_BIN:$PATH"; export PATH; exec "$INSTALL_SCRIPT" "$@"',
  'dsh-quick-smoke',
  '--dir', target, ...args,
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

try {
  await prepareProject('quick')
  const quick = runQuick('quick')
  assert.equal(quick.status, 0, `${quick.stdout}\n${quick.stderr}`)

  // 出站/代理默认关闭，访问模式默认 basic。
  const env = await readFile(join(sandbox, 'quick', '.env'), 'utf8')
  assert.match(env, /^DSH_ACCESS_MODE=basic$/m, 'quick install must default to basic auth')
  assert.match(env, /^DSH_MODEL_BROKER=off$/m, 'quick install must keep the model broker off')
  assert.match(env, /^DSH_EGRESS_MODE=open$/m, 'quick install must keep egress open')
  assert.match(env, /^DSH_BIND_HOST=127\.0\.0\.1$/m)

  // 随机账密只落哈希，绝不进 .env。
  assert.doesNotMatch(env, /DSH_BASIC_AUTH_PASSWORD/)
  assert.doesNotMatch(env, /DSH_ROOT_PASSWORD/)
  assert.match(await readFile(join(sandbox, 'quick', 'data', 'auth', 'htpasswd'), 'utf8'), /^dsh:\$2y\$/)
  assert.match(await readFile(join(sandbox, 'quick', 'data', 'secret', 'root.hash'), 'utf8'), /^\$6\$/)

  // 结尾必须回显访问入口 + 随机密码（只这一次），且密码不在开头的新横幅里。
  const out = quick.stdout
  assert.match(out, /访问入口\s+http:\/\/127\.0\.0\.1:3080/, 'quick summary must print the access URL')
  assert.match(out, /登录用户名\s+dsh/, 'quick summary must print the basic-auth user')
  assert.match(out, /登录密码\s+\S{16,}\s*（只显示这一次）/, 'quick summary must print the generated basic password once')
  assert.match(out, /容器 root\s+\S{16,}\s*（只显示这一次）/, 'quick summary must print the generated root password once')

  // 从输出里抓出生成的两个密码，确认它们不落盘于明文。
  const basicPw = /登录密码\s+(\S+?)\s*（只显示这一次）/.exec(out)?.[1] ?? ''
  const rootPw = /容器 root\s+(\S+?)\s*（只显示这一次）/.exec(out)?.[1] ?? ''
  assert.ok(basicPw.length >= 16, 'generated basic password must be >= 16 chars')
  assert.ok(rootPw.length >= 16, 'generated root password must be >= 16 chars')
  assert.match(basicPw, /[a-z]/, 'basic password must include lowercase')
  assert.match(basicPw, /[A-Z]/, 'basic password must include uppercase')
  assert.match(basicPw, /[0-9]/, 'basic password must include a digit')
  assert.ok(!env.includes(basicPw), '.env must not contain the generated basic password')
  assert.ok(!env.includes(rootPw), '.env must not contain the generated root password')
  assert.ok(!(await readFile(dockerLog, 'utf8')).includes(basicPw), 'generated password must never reach a docker command line')

  // 显式 --quick 与无 TTY 直灌等价。
  await prepareProject('explicit')
  const explicit = runQuick('explicit', ['--quick'])
  assert.equal(explicit.status, 0, `${explicit.stdout}\n${explicit.stderr}`)
  assert.match(await readFile(join(sandbox, 'explicit', '.env'), 'utf8'), /^DSH_ACCESS_MODE=basic$/m)

  // 显式 --non-interactive 不允许生成随机账号：它需要旧语义（local 默认 + 显式参数）。
  // 无 access 参数时默认 local，不应出现 basic 凭据。
  await prepareProject('noninteractive')
  const ni = spawnSync(bash, [
    '-c', 'PATH="$MOCK_BIN:$PATH"; exec "$INSTALL_SCRIPT" "$@"', 'dsh-quick-smoke',
    'install', '--non-interactive', '--dir', 'noninteractive',
  ], {
    cwd: sandbox, encoding: 'utf8',
    env: { ...process.env, MOCK_DOCKER_LOG: dockerLog, MOCK_DOCKER_STATE: dockerState, MOCK_BIN: bashPath(mockBin), INSTALL_SCRIPT: bashPath(installScript) },
  })
  assert.equal(ni.status, 0, `${ni.stdout}\n${ni.stderr}`)
  assert.match(await readFile(join(sandbox, 'noninteractive', '.env'), 'utf8'), /^DSH_ACCESS_MODE=local$/m, '--non-interactive keeps the old local default')
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

console.log('quick-install smoke: ok')