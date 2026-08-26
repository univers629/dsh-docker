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

assert.ok(bash, 'bash is required for the external-network installer smoke test')

const bashPath = (path) => process.platform === 'win32'
  ? path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
  : path

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-network-smoke-'))
const mockBin = join(sandbox, 'bin')
const dockerLog = join(sandbox, 'docker.log')
await mkdir(mockBin)

const gitMock = `#!/bin/sh
set -eu
if [ "\$1" = clone ]; then
  mkdir -p "\$3/.git"
  printf '%s\\n' 'services: {}' > "\$3/docker-compose.yml"
  printf '%s\\n' '#!/bin/sh' 'exit 0' > "\$3/dsh.sh"
  chmod +x "\$3/dsh.sh"
  printf '%s\\n' 'services: {}' > "\$3/docker-compose.keys.yml"
  printf '%s\\n' 'services: {}' > "\$3/docker-compose.isolated.yml"
  exit 0
fi
exit 0
`

// 只模拟安装器真正用到的 docker 子命令；MOCK_NETWORKS 是"已存在"的网络清单。
const dockerMock = `#!/bin/sh
set -eu
printf '%s\\n' "\$*" >> "\$MOCK_DOCKER_LOG"
if [ "\${1:-}" = network ]; then
  case "\${2:-}" in
    ls)
      for name in \${MOCK_NETWORKS:-}; do printf '%s\\n' "\$name"; done
      exit 0
      ;;
    inspect)
      shift 2
      format=""
      if [ "\${1:-}" = --format ]; then format="\$2"; shift 2; fi
      wanted="\${1:-}"
      for name in \${MOCK_NETWORKS:-}; do
        if [ "\$name" = "\$wanted" ]; then
          if [ -n "\$format" ]; then printf '%s\\n' "\${MOCK_NETWORK_PROJECT:-}"; fi
          exit 0
        fi
      done
      exit 1
      ;;
    create) exit 0 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = container ] && [ "\${2:-}" = inspect ]; then exit 1; fi
if [ "\${1:-}" = run ]; then
  case " $* " in
    *hash-dsh-password*) printf '%s\\n' '\$6\$networkSmokeSalt\$networkSmokeHash' ;;
    *) printf '%s\\n' 'dsh:\$2y\$05\$networkSmokeHash' ;;
  esac
fi
if [ "\${1:-}" = exec ]; then
  case " $* " in
    *verify-dsh-hardening*) exit 0 ;;
    # 密钥配置绝不能挂进 DSH 容器，安装器靠这条命令失败来反向核验。
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

for (const [name, body] of [['git', gitMock], ['docker', dockerMock]]) {
  const path = join(mockBin, name)
  await writeFile(path, body)
  await chmod(path, 0o755)
}

const runInstall = (target, args, networks, networkProject = '') => spawnSync(bash, [
  '-c',
  'PATH="$MOCK_BIN:$PATH"; export PATH; exec "$INSTALL_SCRIPT" "$@"',
  'dsh-network-smoke',
  'install', '--non-interactive', '--dir', target, ...args,
], {
  cwd: sandbox,
  encoding: 'utf8',
  env: {
    ...process.env,
    MOCK_DOCKER_LOG: dockerLog,
    MOCK_NETWORKS: networks,
    MOCK_NETWORK_PROJECT: networkProject,
    MOCK_BIN: bashPath(mockBin),
    INSTALL_SCRIPT: bashPath(installScript),
  },
})

const proxyArgs = ['--access', 'trusted-proxy', '--trusted-hosts', 'dsh.example.com', '--network-external']

try {
  const missing = runInstall('missing-network', [...proxyArgs, '--network', 'dsh-proxy'], 'bridge host none')
  assert.notEqual(missing.status, 0, 'a missing external network must fail the install')
  assert.match(missing.stderr, /docker network create dsh-proxy/)
  assert.match(missing.stderr, /docker network connect dsh-proxy/)
  assert.equal(existsSync(join(sandbox, 'missing-network', '.env')), false, 'a failed install must not persist .env')

  const reserved = runInstall('reserved-network', [...proxyArgs, '--network', 'dsh-private'], 'bridge host none')
  assert.notEqual(reserved.status, 0, 'dsh-private must be rejected as an external network')
  assert.match(reserved.stderr, /dsh-private 是 DSH 自己管理的内部网络名/)

  const existing = runInstall('existing-network', [...proxyArgs, '--network', 'proxy-net'], 'bridge host none proxy-net')
  assert.equal(existing.status, 0, `${existing.stdout}\n${existing.stderr}`)
  const env = await readFile(join(sandbox, 'existing-network', '.env'), 'utf8')
  assert.match(env, /^DSH_DOCKER_NETWORK=proxy-net$/m)
  assert.match(env, /^DSH_DOCKER_NETWORK_EXTERNAL=true$/m)
  assert.match(env, /^DSH_ACCESS_MODE=trusted-proxy$/m)

  // 老部署里 dsh-private 可能被写成外部网络；如果它其实是 Compose 自己建的，就静默改回内部管理。
  const legacyBootstrap = runInstall('legacy-network', ['--access', 'local'], 'bridge host none')
  assert.equal(legacyBootstrap.status, 0, `${legacyBootstrap.stdout}\n${legacyBootstrap.stderr}`)
  await writeFile(join(sandbox, 'legacy-network', '.env'),
    'DSH_ACCESS_MODE=trusted-proxy\nDSH_BIND_HOST=127.0.0.1\nDSH_TRUSTED_HOSTS=dsh.example.com\nDSH_DOCKER_NETWORK=dsh-private\nDSH_DOCKER_NETWORK_EXTERNAL=true\n')
  const migrated = runInstall('legacy-network', ['--access', 'trusted-proxy', '--trusted-hosts', 'dsh.example.com'],
    'bridge host none dsh-private', 'dsh-docker')
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`)
  assert.match(migrated.stdout, /已改回由 DSH 自己管理/)
  const migratedEnv = await readFile(join(sandbox, 'legacy-network', '.env'), 'utf8')
  assert.match(migratedEnv, /^DSH_DOCKER_NETWORK=dsh-private$/m)
  assert.match(migratedEnv, /^DSH_DOCKER_NETWORK_EXTERNAL=false$/m)

  // 手工创建、并非 Compose 管理的同名网络仍按外部网络照旧使用。
  await writeFile(join(sandbox, 'legacy-network', '.env'),
    'DSH_ACCESS_MODE=trusted-proxy\nDSH_BIND_HOST=127.0.0.1\nDSH_TRUSTED_HOSTS=dsh.example.com\nDSH_DOCKER_NETWORK=dsh-private\nDSH_DOCKER_NETWORK_EXTERNAL=true\n')
  const keptExternal = runInstall('legacy-network', ['--access', 'trusted-proxy', '--trusted-hosts', 'dsh.example.com'],
    'bridge host none dsh-private')
  assert.equal(keptExternal.status, 0, `${keptExternal.stdout}\n${keptExternal.stderr}`)
  const keptEnv = await readFile(join(sandbox, 'legacy-network', '.env'), 'utf8')
  assert.match(keptEnv, /^DSH_DOCKER_NETWORK_EXTERNAL=true$/m)

  // 隔离模式和外部代理网络必须能共存：dsh 退到 dsh-internal，dsh-ingress 顶替
  // dsh 这个名字接在外部网络上，所以 DPanel 侧写的 http://dsh:3080 不用改。
  const isolatedProxy = runInstall('isolated-network', [
    ...proxyArgs,
    '--network', 'proxy-net',
    '--egress', 'allowlist',
    '--egress-allow', 'registry.example.com',
  ], 'bridge host none proxy-net')
  assert.equal(isolatedProxy.status, 0, `${isolatedProxy.stdout}\n${isolatedProxy.stderr}`)
  const isolatedProxyEnv = await readFile(join(sandbox, 'isolated-network', '.env'), 'utf8')
  assert.match(isolatedProxyEnv, /^DSH_DOCKER_NETWORK=proxy-net$/m)
  assert.match(isolatedProxyEnv, /^DSH_DOCKER_NETWORK_EXTERNAL=true$/m)
  assert.match(isolatedProxyEnv, /^DSH_EGRESS_MODE=allowlist$/m)
  assert.match(isolatedProxyEnv, /^DSH_EGRESS_ALLOWED_HOSTS=registry\.example\.com$/m)
  assert.match(isolatedProxyEnv, /^DSH_MODEL_BROKER=off$/m)

  const calls = await readFile(dockerLog, 'utf8')
  assert.match(calls, /compose --env-file \S+ -f docker-compose\.yml -f docker-compose\.isolated\.yml up -d/)
  // broker 没开就绝不能叠加 keys.yml，否则会凭空多起一个容器。
  assert.doesNotMatch(calls, /docker-compose\.keys\.yml/)
  assert.match(calls, /network inspect proxy-net/)
  assert.doesNotMatch(calls, /network create/, 'non-interactive installs must never create a network implicitly')
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

console.log('external-network installer smoke: ok')
