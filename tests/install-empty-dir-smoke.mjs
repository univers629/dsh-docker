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
  printf '%s\\n' 'services: {}' > "$3/docker-compose.keys.yml"
  printf '%s\\n' 'services: {}' > "$3/docker-compose.isolated.yml"
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
    *" up -d "*)
      : > "$MOCK_DOCKER_STATE"
      ;;
  esac
fi
if [ "\${1:-}" = pull ]; then
  if [ "\${MOCK_FAIL_PULL:-}" = 1 ]; then exit 18; fi
fi
if [ "\${1:-}" = run ]; then
  case " $* " in
    *hash-dsh-password*) printf '%s\\n' '$6$installerSmokeSalt$installerSmokeHash' ;;
    *) printf '%s\\n' 'dsh:$2y$05$installerSmokeHash' ;;
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
# userns 预检只看这两个字段：SecurityOptions 决定是否已启用，DockerRootDir 的
# <uid>.<gid> 后缀是 /etc/subuid 读不到时的 BASE 兜底来源。
if [ "\${1:-}" = info ] && [ "\${2:-}" = --format ]; then
  case "\${3:-}" in
    *SecurityOptions*)
      if [ "\${MOCK_USERNS:-}" = 1 ]; then
        printf '%s\\n' '[name=seccomp,profile=builtin name=cgroupns name=userns]'
      else
        printf '%s\\n' '[name=seccomp,profile=builtin name=cgroupns]'
      fi
      ;;
    *DockerRootDir*)
      if [ "\${MOCK_USERNS:-}" = 1 ]; then
        printf '%s\\n' '/var/lib/docker/165536.165536'
      else
        printf '%s\\n' '/var/lib/docker'
      fi
      ;;
  esac
  exit 0
fi
if [ "\${1:-}" = exec ]; then
  case " $* " in
    *verify-dsh-hardening*) exit 0 ;;
    # 这条必须失败：密钥配置一旦挂进 DSH 容器，密钥代理就白做了，安装器靠它反向核验。
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
  // 默认来源是预构建镜像：安装器必须拉取而不是编译，并把发布引用写进 .env。
  const local = runInstall('local-install', ['--access', 'local'])
  assert.equal(local.status, 0, `${local.stdout}\n${local.stderr}`)
  const localEnv = await readFile(join(sandbox, 'local-install', '.env'), 'utf8')
  assert.doesNotMatch(localEnv, /DSH_RUN_AS_ROOT/)
  assert.match(localEnv, /^DSH_ACCESS_MODE=local$/m)
  assert.match(localEnv, /^DSH_BIND_HOST=127\.0\.0\.1$/m)
  assert.match(localEnv, /^DSH_IMAGE_SOURCE=prebuilt$/m)
  assert.match(localEnv, /^DSH_IMAGE=ghcr\.io\/univers629\/dsh-docker:latest$/m)
  // 不带任何新参数的默认安装必须和以前完全一样：不多起 broker/egress 容器。
  assert.match(localEnv, /^DSH_MODEL_BROKER=off$/m)
  assert.match(localEnv, /^DSH_EGRESS_MODE=open$/m)
  assert.equal(existsSync(join(sandbox, 'local-install', 'data', 'broker', 'keys.json')), false)

  // 拉取失败必须退回本机构建，并且 .env 记录的是真实来源，而不是原本的选择。
  const fallback = runInstall('fallback-install', ['--access', 'local'], { MOCK_FAIL_PULL: '1' })
  assert.equal(fallback.status, 0, `${fallback.stdout}\n${fallback.stderr}`)
  const fallbackEnv = await readFile(join(sandbox, 'fallback-install', '.env'), 'utf8')
  assert.match(fallbackEnv, /^DSH_IMAGE_SOURCE=build$/m)
  assert.match(fallbackEnv, /^DSH_IMAGE=dsh:local$/m)

  const built = runInstall('build-install', ['--access', 'local', '--image-source', 'build'])
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`)
  const builtEnv = await readFile(join(sandbox, 'build-install', '.env'), 'utf8')
  assert.match(builtEnv, /^DSH_IMAGE_SOURCE=build$/m)
  assert.match(builtEnv, /^DSH_IMAGE=dsh:local$/m)

  const basic = runInstall('basic-install', [
    '--access', 'basic',
    '--image-source', 'build',
    '--trusted-hosts', 'dsh.example.com',
  ], {
    DSH_BASIC_AUTH_USER: 'dsh',
    DSH_BASIC_AUTH_PASSWORD: 'installer-smoke-password',
  })
  assert.equal(basic.status, 0, `${basic.stdout}\n${basic.stderr}`)
  const basicEnv = await readFile(join(sandbox, 'basic-install', '.env'), 'utf8')
  const htpasswd = await readFile(join(sandbox, 'basic-install', 'data', 'auth', 'htpasswd'), 'utf8')
  assert.match(basicEnv, /^DSH_ACCESS_MODE=basic$/m)
  assert.doesNotMatch(basicEnv, /DSH_RUN_AS_ROOT/)
  assert.match(basicEnv, /^DSH_TRUSTED_HOSTS=dsh\.example\.com$/m)
  assert.doesNotMatch(basicEnv, /installer-smoke-password/)
  assert.match(htpasswd, /^dsh:\$2y\$/)

  // 自定义容器 root 密码：只以 sha512crypt 哈希落盘，绝不进入 .env。
  const rootPassword = runInstall('root-password-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--root-password', 'installer-smoke-root-password',
  ])
  assert.equal(rootPassword.status, 0, `${rootPassword.stdout}\n${rootPassword.stderr}`)
  const rootHash = await readFile(join(sandbox, 'root-password-install', 'data', 'secret', 'root.hash'), 'utf8')
  assert.match(rootHash, /^\$6\$/)
  const rootPasswordEnv = await readFile(join(sandbox, 'root-password-install', '.env'), 'utf8')
  assert.doesNotMatch(rootPasswordEnv, /installer-smoke-root-password|DSH_ROOT_PASSWORD/)
  assert.doesNotMatch(await readFile(dockerLog, 'utf8'), /installer-smoke-root-password/)

  // 太短的密码必须直接拒绝，而不是静默降级。
  const weakPassword = runInstall('weak-password-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--root-password', 'short',
  ])
  assert.notEqual(weakPassword.status, 0, 'a short container root password must be rejected')
  assert.ok(!existsSync(join(sandbox, 'weak-password-install', 'data', 'secret', 'root.hash')))

  // 明确不要密码时安装照样成功，只是容器内任意特权命令保持关闭。
  const noRootPassword = runInstall('no-root-password-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--no-root-password',
  ])
  assert.equal(noRootPassword.status, 0, `${noRootPassword.stdout}\n${noRootPassword.stderr}`)
  assert.ok(!existsSync(join(sandbox, 'no-root-password-install', 'data', 'secret', 'root.hash')))

  const rollback = runInstall('rollback-install', ['--access', 'local'])
  assert.equal(rollback.status, 0, `${rollback.stdout}\n${rollback.stderr}`)
  await writeFile(join(sandbox, 'rollback-install', '.env'), 'DSH_RUN_AS_ROOT=false\nDSH_ACCESS_MODE=local\n')
  const migrated = runInstall('rollback-install', ['--access', 'local'])
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`)
  const failedInstall = runInstall('rollback-install', ['--access', 'basic', '--image-source', 'build'], { MOCK_FAIL_BUILD: '1' })
  assert.notEqual(failedInstall.status, 0, 'Mock build failure unexpectedly succeeded.')
  const rollbackEnv = await readFile(join(sandbox, 'rollback-install', '.env'), 'utf8')
  assert.match(rollbackEnv, /^DSH_ACCESS_MODE=local$/m)
  assert.doesNotMatch(rollbackEnv, /DSH_RUN_AS_ROOT/)

  // ---- 模型密钥代理 ----
  // 密钥只允许落在 data/broker/keys.json 里：.env、摘要输出、docker 命令行都不能有它。
  const deepseekKey = 'sk-test-installer-deepseek-key'
  const broker = runInstall('broker-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--model-key', `deepseek=${deepseekKey}`,
  ])
  assert.equal(broker.status, 0, `${broker.stdout}\n${broker.stderr}`)
  const brokerEnv = await readFile(join(sandbox, 'broker-install', '.env'), 'utf8')
  assert.match(brokerEnv, /^DSH_MODEL_BROKER=on$/m)
  assert.match(brokerEnv, /^DSH_MODEL_BROKER_BASE=http:\/\/dsh-key-broker:8080$/m)
  assert.ok(!brokerEnv.includes(deepseekKey), '.env must never contain a model key')
  assert.ok(!broker.stdout.includes(deepseekKey), 'the summary must never print a model key')
  const brokerKeys = JSON.parse(await readFile(join(sandbox, 'broker-install', 'data', 'broker', 'keys.json'), 'utf8'))
  assert.equal(brokerKeys.version, 1)
  assert.deepEqual(brokerKeys.upstreams.map((entry) => entry.name), ['deepseek'])
  assert.equal(brokerKeys.upstreams[0].baseUrl, 'https://api.deepseek.com')
  assert.equal(brokerKeys.upstreams[0].key, deepseekKey)
  // 摘要要给出容器内实际填法，并说明这层只保护密钥字面值、不限制额度。
  // base_url 不带 /v1：版本段属于上游 base_url，broker 会把两段拼起来，
  // 这里再补一次就变成 /v1/v1/responses。
  assert.match(broker.stdout, /base_url = http:\/\/dsh-key-broker:8080\/u\/deepseek(?!\/v1)/)
  assert.doesNotMatch(broker.stdout, /\/u\/deepseek\/v1/)
  assert.match(broker.stdout, /不限制额度消耗/)
  // 供应商必须真写进 DSH 自己的配置：只在摘要里说一遍等于让用户手抄。
  assert.match(broker.stdout, /正在把模型供应商写进 DSH 配置/)
  assert.match(broker.stdout, /模型设置: 已写进 data\/dsh\/settings\.yaml/)

  // 同名覆盖、异名保留：第二次只给 openai，deepseek 的密钥必须原样留着。
  const openaiKey = 'sk-test-installer-openai-key'
  const mergedBroker = runInstall('broker-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--model-key', `openai=${openaiKey}`,
  ])
  assert.equal(mergedBroker.status, 0, `${mergedBroker.stdout}\n${mergedBroker.stderr}`)
  const mergedKeys = JSON.parse(await readFile(join(sandbox, 'broker-install', 'data', 'broker', 'keys.json'), 'utf8'))
  assert.deepEqual(mergedKeys.upstreams.map((entry) => entry.name).sort(), ['deepseek', 'openai'])
  assert.equal(mergedKeys.upstreams.find((entry) => entry.name === 'deepseek').key, deepseekKey)
  // 版本段留在上游 base_url 里：DSH 侧只写 /u/<name>，客户端 SDK 自己补相对路径。
  assert.equal(mergedKeys.upstreams.find((entry) => entry.name === 'openai').baseUrl, 'https://api.openai.com/v1')

  // anthropic 的认证头不是 Authorization，缺 anthropic-version 会被上游 400。
  const anthropic = runInstall('anthropic-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--model-key', 'anthropic=sk-ant-test-installer-key',
  ])
  assert.equal(anthropic.status, 0, `${anthropic.stdout}\n${anthropic.stderr}`)
  const anthropicKeys = JSON.parse(await readFile(join(sandbox, 'anthropic-install', 'data', 'broker', 'keys.json'), 'utf8'))
  assert.equal(anthropicKeys.upstreams[0].headerName, 'x-api-key')
  assert.equal(anthropicKeys.upstreams[0].headerTemplate, '{key}')
  assert.equal(anthropicKeys.upstreams[0].extraHeaders['anthropic-version'], '2023-06-01')

  // 内置表以外的上游必须显式给 base_url，猜一个域名等于把密钥发到没验证过的地方。
  const unknownUpstream = runInstall('unknown-upstream-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--model-key', 'mystery=sk-test-installer-mystery-key',
  ])
  assert.equal(unknownUpstream.status, 2, 'an unknown upstream without a base URL must exit 2')
  assert.match(unknownUpstream.stderr, /--model-base-url mystery=https:\/\//)
  assert.equal(existsSync(join(sandbox, 'unknown-upstream-install', 'data', 'broker', 'keys.json')), false)

  const explicitUpstream = runInstall('explicit-upstream-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--model-key', 'mystery=sk-test-installer-mystery-key',
    '--model-base-url', 'mystery=https://api.mystery.example.com',
  ])
  assert.equal(explicitUpstream.status, 0, `${explicitUpstream.stdout}\n${explicitUpstream.stderr}`)
  const explicitKeys = JSON.parse(await readFile(join(sandbox, 'explicit-upstream-install', 'data', 'broker', 'keys.json'), 'utf8'))
  assert.equal(explicitKeys.upstreams[0].baseUrl, 'https://api.mystery.example.com')

  // 明文 base_url 直接拒绝：密钥不能走 http。
  const plaintextUpstream = runInstall('plaintext-upstream-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--model-key', 'mystery=sk-test-installer-mystery-key',
    '--model-base-url', 'mystery=http://api.mystery.example.com',
  ])
  assert.equal(plaintextUpstream.status, 2, 'a plaintext base URL must exit 2')
  assert.match(plaintextUpstream.stderr, /必须使用 https/)

  // 自动化路径：整份 keys.json 直接导入，命令行上不出现任何密钥。
  const importedKeysFile = join(sandbox, 'imported-keys.json')
  await writeFile(importedKeysFile, `${JSON.stringify({
    version: 1,
    upstreams: [{ name: 'imported', baseUrl: 'https://api.imported.example.com', key: 'sk-test-installer-imported-key' }],
  }, null, 2)}\n`)
  const importedBroker = runInstall('imported-broker-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--model-keys-file', bashPath(importedKeysFile),
  ])
  assert.equal(importedBroker.status, 0, `${importedBroker.stdout}\n${importedBroker.stderr}`)
  assert.match(await readFile(join(sandbox, 'imported-broker-install', '.env'), 'utf8'), /^DSH_MODEL_BROKER=on$/m)
  const importedKeys = JSON.parse(await readFile(join(sandbox, 'imported-broker-install', 'data', 'broker', 'keys.json'), 'utf8'))
  assert.deepEqual(importedKeys.upstreams.map((entry) => entry.name), ['imported'])

  // 自建网关：目录里没有它，必须自己给模型 id，否则 DSH 那边选不到任何模型。
  const gatewayInstall = runInstall('gateway-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--model-key', 'mygw=sk-test-installer-gateway-key',
    '--model-base-url', 'mygw=https://api.mygw.example.com/v1',
    '--model-api', 'mygw=responses',
    '--model-id', 'mygw=claude-opus-5-thinking,gpt-5.2',
  ])
  assert.equal(gatewayInstall.status, 0, `${gatewayInstall.stdout}\n${gatewayInstall.stderr}`)
  assert.match(gatewayInstall.stdout, /正在把模型供应商写进 DSH 配置/)

  // 显式关掉写配置时必须说清楚后果，而不是静默什么都不做。
  const noSeed = runInstall('no-seed-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--model-key', 'deepseek=sk-test-installer-noseed-key',
    '--no-model-settings-seed',
  ])
  assert.equal(noSeed.status, 0, `${noSeed.stdout}\n${noSeed.stderr}`)
  assert.match(noSeed.stdout, /已跳过写入 DSH 模型配置/)
  assert.doesNotMatch(noSeed.stdout, /正在把模型供应商写进 DSH 配置/)

  // 关闭必须连密钥一起清掉：只翻开关、把文件留在盘上等于密钥还在。
  const disabledBroker = runInstall('broker-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--no-model-broker',
  ])
  assert.equal(disabledBroker.status, 0, `${disabledBroker.stdout}\n${disabledBroker.stderr}`)
  assert.match(await readFile(join(sandbox, 'broker-install', '.env'), 'utf8'), /^DSH_MODEL_BROKER=off$/m)
  assert.equal(existsSync(join(sandbox, 'broker-install', 'data', 'broker', 'keys.json')), false)

  // ---- 出站隔离 ----
  const isolated = runInstall('egress-install', [
    '--access', 'local',
    '--image-source', 'build',
    '--egress', 'allowlist',
    '--egress-allow', 'a.example.com',
    '--egress-allow', '*.b.example.com',
  ])
  assert.equal(isolated.status, 0, `${isolated.stdout}\n${isolated.stderr}`)
  const isolatedEnv = await readFile(join(sandbox, 'egress-install', '.env'), 'utf8')
  assert.match(isolatedEnv, /^DSH_EGRESS_MODE=allowlist$/m)
  assert.match(isolatedEnv, /^DSH_EGRESS_ALLOWED_HOSTS=a\.example\.com,\*\.b\.example\.com$/m)
  assert.match(isolated.stdout, /自定义 2 条/)

  const badEgress = runInstall('bad-egress-install', ['--access', 'local', '--egress', 'everything'])
  assert.equal(badEgress.status, 2, 'an unknown egress mode must exit 2')
  assert.match(badEgress.stderr, /--egress 只支持 open 或 allowlist/)

  // ---- userns-remap 预检 ----
  // 未启用时只打印人工步骤，绝不代改 daemon.json，也要如实说明 Docker Desktop 不支持。
  const preflightOff = runInstall('local-install', ['--userns-preflight'])
  assert.equal(preflightOff.status, 0, `${preflightOff.stdout}\n${preflightOff.stderr}`)
  assert.match(preflightOff.stdout, /当前状态：未启用/)
  assert.match(preflightOff.stdout, /"userns-remap": "default"/)
  assert.match(preflightOff.stdout, /systemctl restart docker/)
  assert.match(preflightOff.stdout, /Docker Desktop \/ WSL2 不支持 userns-remap/)
  // 已启用时算出 BASE 并对齐绑定挂载的属主：容器 UID 1000 == 宿主 165536+1000。
  const preflightOn = runInstall('local-install', ['--userns-preflight'], { MOCK_USERNS: '1' })
  assert.equal(preflightOn.status, 0, `${preflightOn.stdout}\n${preflightOn.stderr}`)
  assert.match(preflightOn.stdout, /dockremap 起始 subuid：165536/)
  assert.match(preflightOn.stdout, /宿主 UID 166536/)
  assert.match(preflightOn.stdout, /data\/broker -> 166536:166536/)
  assert.match(preflightOn.stdout, /data\/secret -> 165536:165536/)

  const calls = await readFile(dockerLog, 'utf8')
  // 叠加顺序是契约：keys.yml 只在 broker 开启时出现，isolated.yml 只在 allowlist 下出现。
  assert.match(calls, /compose --env-file \S+ -f docker-compose\.yml -f docker-compose\.keys\.yml up -d/)
  assert.match(calls, /compose --env-file \S+ -f docker-compose\.yml -f docker-compose\.isolated\.yml up -d/)
  assert.match(calls, /compose -f docker-compose\.yml -f docker-compose\.keys\.yml build dsh/)
  assert.ok(!calls.includes(deepseekKey), 'a model key must never reach a docker command line')
  assert.ok(!calls.includes(openaiKey), 'a model key must never reach a docker command line')
  assert.match(calls, /container inspect dsh/)
  assert.match(calls, /^pull ghcr\.io\/univers629\/dsh-docker:latest$/m)
  assert.match(calls, /compose .* build dsh/)
  assert.match(calls, /compose .* up -d --no-build --force-recreate/)
  assert.match(calls, /run --rm -i --entrypoint htpasswd dsh:local -niB dsh/)
  // 写 settings.yaml 借的是镜像里的 node（宿主不一定有 yaml 库），配置从 stdin 进去，
  // 所以命令行上只能看到挂载点，不该出现任何密钥或模型 id 之外的内容。
  assert.match(calls, /run --rm -i -v \S+\/bin:\/dsh-seed:ro -v \S+\/data\/dsh:\/seed-home --entrypoint node \S+ \/dsh-seed\/seed-dsh-model-settings\.mjs --home \/seed-home/)
  assert.ok(!calls.includes('sk-test-installer-gateway-key'), 'a model key must never reach a docker command line')
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

console.log('empty-directory installer smoke: ok')
