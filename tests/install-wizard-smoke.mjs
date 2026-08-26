import assert from 'node:assert/strict'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseBrokerConfig } from '../bin/dsh-key-broker-policy.mjs'

const read = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [compose, dockerfile, entrypoint, authConfig, nginx, installSh, installPs1, envExample, dshSh, dshBat, readmeZh, readmeEn, isolatedCompose] = await Promise.all([
  'docker-compose.yml', 'Dockerfile', 'bin/entrypoint.sh', 'bin/configure-nginx-auth', 'nginx/dsh-nginx.conf',
  'install.sh', 'install.ps1', '.env.example', 'dsh.sh', 'dsh.bat', 'README.md', 'README.en.md',
  'docker-compose.isolated.yml',
].map(read))

assert.match(compose, /DSH_ACCESS_MODE: "\$\{DSH_ACCESS_MODE:-local\}"/)
// 预构建安装把镜像引用写进 .env，Compose 必须读它而不是硬编码 dsh:local。
assert.match(compose, /image: "\$\{DSH_IMAGE:-dsh:local\}"/)
assert.match(envExample, /^DSH_IMAGE=ghcr\.io\/univers629\/dsh-docker:latest$/m)
assert.match(envExample, /^DSH_IMAGE_SOURCE=prebuilt$/m)

// 镜像来源：两条链路都要能拉预构建镜像，并在拉取失败时退回本机构建。
for (const flag of ['--image-source', '--image']) {
  assert.ok(installSh.includes(flag), `install.sh missing ${flag}`)
}
assert.match(installSh, /obtain_dsh_image\(\) \{/)
assert.ok(
  installSh.indexOf('pull_dsh_image') < installSh.indexOf('PENDING_IMAGE_SOURCE=build'),
  'install.sh must try the pull before falling back to a local build',
)
assert.ok(
  installSh.indexOf('obtain_dsh_image') < installSh.indexOf('set_compose_env DSH_IMAGE_SOURCE'),
  'install.sh must resolve the real image source before persisting it',
)
assert.match(installSh, /set_compose_env DSH_IMAGE "\$PENDING_IMAGE"/)
assert.match(installSh, /up -d --no-build --force-recreate/)
assert.match(installPs1, /\[ValidateSet\('',\s*'prebuilt',\s*'build'\)\]/)
assert.match(installPs1, /docker pull \$imageRef/)
assert.ok(
  installPs1.indexOf('docker pull $imageRef') < installPs1.indexOf('docker compose build dsh'),
  'install.ps1 must try the pull before falling back to a local build',
)
assert.match(installPs1, /Set-ComposeEnvValue \$pendingEnvFile 'DSH_IMAGE' \$imageRef/)
assert.match(installPs1, /'up','-d','--no-build','--force-recreate'/)

// 启动脚本在容器不存在时也要按 .env 记录的来源准备镜像。
assert.match(dshSh, /image_source="\$\(env_value DSH_IMAGE_SOURCE ''\)"/)
assert.match(dshSh, /DOCKER pull "\$image_ref"/)
assert.match(dshBat, /call :read_env DSH_IMAGE/)
assert.match(dshBat, /docker pull "%IMAGE_REF%"/)

// 删除必须能清掉预构建引用，它不叫 dsh:*。
assert.match(installSh, /awk -F= '\$1 == "DSH_IMAGE"/)
assert.ok(
  installPs1.includes(String.raw`$_ -match '^\s*DSH_IMAGE\s*='`),
  'install.ps1 delete must read DSH_IMAGE from .env without the wizard helpers',
)

for (const readme of [readmeZh, readmeEn]) {
  assert.ok(readme.includes('ghcr.io/univers629/dsh-docker:latest'), 'README must document the published image')
  assert.ok(
    readme.indexOf('vCPU') < readme.indexOf('install.sh | bash'),
    'README must state the host sizing guidance before the install command',
  )
}
assert.match(compose, /\.\/data\/auth:\/opt\/dsh-auth:ro/)
// The healthcheck must fail when DSH dies, so it probes DSH's own loopback
// listener next to the unconditional Nginx 204.
for (const [label, source] of [['compose', compose], ['Dockerfile', dockerfile]]) {
  assert.match(source, /127\.0\.0\.1:3080\/healthz/, `${label} must keep probing the Nginx entry`)
  assert.match(source, /DSH_WEB_PORT \|\| '3081'/, `${label} must probe the DSH web port`)
  assert.match(source, /'http:\/\/127\.0\.0\.1:' \+ dshPort \+ '\/'/, `${label} must probe DSH over HTTP`)
}
assert.match(dockerfile, /apache2-utils/)

assert.match(entrypoint, /\/usr\/local\/bin\/configure-nginx-auth/)
assert.match(authConfig, /DSH_ACCESS_MODE:-local/)
assert.match(authConfig, /basic\)/)
assert.match(authConfig, /\/opt\/dsh-auth\/htpasswd/)
assert.match(authConfig, /\/tmp\/dsh-htpasswd/)
assert.doesNotMatch(authConfig, /node:node/)
// Nginx workers run as the unprivileged dsh account, so the runtime htpasswd
// copy must be handed to that account instead of staying root-only.
assert.match(authConfig, /chown "\$\{DSH_RUN_USER:-dsh\}" "\$runtime_auth_file"/)
assert.match(authConfig, /auth_basic off/)
assert.match(nginx, /include \/tmp\/dsh-auth\.conf/)
assert.match(nginx, /^user dsh;$/m)
assert.match(nginx, /location = \/healthz/)
assert.match(nginx, /healthz \{\s+auth_basic off/s)

for (const action of ['install', 'configure', 'update', 'model-key', 'start', 'stop', 'restart', 'logs', 'status', 'delete']) {
  assert.ok(installSh.includes(action), `install.sh missing ${action}`)
  assert.ok(installPs1.includes(action), `install.ps1 missing ${action}`)
}
for (const mode of ['local', 'trusted-proxy', 'basic']) {
  assert.ok(installSh.includes(mode), `install.sh missing access mode ${mode}`)
  assert.ok(installPs1.includes(mode), `install.ps1 missing access mode ${mode}`)
}
assert.match(installSh, /< \/dev\/tty/)
assert.match(installSh, /htpasswd "\$PENDING_IMAGE" -niB/)
assert.match(installSh, /未写入 \.env/)
assert.match(installPs1, /Read-Host .* -AsSecureString/)
assert.match(installPs1, /htpasswd \$imageRef -niB/)
assert.match(installPs1, /\[Alias\('Action'\)\][\s\S]*\$DshAction/)
assert.match(installPs1, /\[ValidateSet\('',\s*'install'/)
assert.match(installPs1, /\[ValidateSet\('',\s*'local'/)
assert.doesNotMatch(installPs1, /\[string\]\$Action/)
assert.match(installPs1, /ssh:\/\/git@ssh\.github\.com:443\/univers629\/dsh-docker\.git/)
assert.match(installPs1, /Get-GitHubSshKeys/)
assert.match(installPs1, /GIT_SSH_COMMAND/)
assert.match(installPs1, /USERPROFILE/)
assert.match(installPs1, /BatchMode=yes/)
assert.match(installPs1, /Invoke-GitHubSshFetch/)
assert.match(installPs1, /remote set-url origin \$GitHubHttpsUrl/)
assert.match(installPs1, /remote set-url origin \$GitHubSshUrl/)
assert.ok(installPs1.indexOf("Label = 'HTTPS Git'") < installPs1.indexOf('foreach ($key in Get-GitHubSshKeys)'), 'HTTPS clone must run before SSH key discovery')
assert.match(installPs1, /Ensure-DockerEngine/)
assert.match(installPs1, /docker desktop start/)
assert.match(installPs1, /Docker Desktop Linux Engine 已就绪/)
assert.match(installPs1, /function Test-DshContainer/)
assert.match(installPs1, /docker container inspect dsh/)
assert.ok(installPs1.indexOf('Test-DshContainer))') < installPs1.indexOf('docker compose build dsh'), 'Windows must reject an existing container before building')
assert.match(installPs1, /Invoke-ComposeWithEnvFile/)
assert.match(installPs1, /Assert-DshHardening/)
assert.match(installPs1, /\[string\]\$RootPassword = ''/)
assert.match(installPs1, /\[switch\]\$NoRootPassword/)
assert.match(installPs1, /data\\secret\\root\.hash/)
assert.match(installSh, /--root-password/)
assert.match(installSh, /--no-root-password/)
assert.match(installSh, /data\/secret\/root\.hash/)
// The password itself must never be written into the Compose environment file.
assert.doesNotMatch(installSh, /DSH_ROOT_PASSWORD=\$/)
assert.doesNotMatch(envExample, /DSH_ROOT_PASSWORD/)
assert.match(installPs1, /\.env\.pending\./)
assert.ok(installPs1.indexOf('docker compose build dsh') < installPs1.indexOf("'.env.pending.'"), 'Windows must build before preparing the pending configuration')
assert.ok(installPs1.indexOf('Invoke-ComposeWithEnvFile -Path $pendingEnvFile') < installPs1.indexOf('Move-Item -LiteralPath $pendingEnvFile'), 'Windows must start successfully before persisting the pending configuration')
assert.doesNotMatch(installPs1, /容器内权限：1=node/)
assert.match(dshBat, /docker info --format "\{\{\.OSType\}\}"/)
assert.match(dshBat, /docker desktop start/)
assert.match(installSh, /https:\/\/github\.com\/univers629\/dsh-docker\.git/)
assert.match(installSh, /univers629\/dsh-docker\/archive\/refs\/heads\/main\.tar\.gz/)
assert.match(installPs1, /https:\/\/github\.com\/univers629\/dsh-docker\.git/)
assert.match(installPs1, /codeload\.github\.com\/univers629\/dsh-docker\/zip\/refs\/heads\/main/)
assert.match(installPs1, /Get-ChildItem -LiteralPath \$source -Force/)
assert.match(installPs1, /dsh-docker-archive-source/)
assert.match(installPs1, /docker-compose\.yml.*工程获取失败/s)
assert.match(installSh, /DSH_INSTALL_DIR:-dsh-docker/)
assert.match(installSh, /8\) 删除/)
assert.match(installSh, /请输入 DELETE 继续/)
assert.match(installSh, /container ls -aq --filter "label=com\.docker\.compose\.project=\$project_name"/)
assert.match(installSh, /volume ls -q --filter "label=com\.docker\.compose\.project=\$project_name"/)
assert.match(installSh, /label=org\.opencontainers\.image\.title=dsh-docker/)
assert.match(installSh, /builder prune -af/)
assert.doesNotMatch(installSh, /--filter name=dsh/)
assert.match(installPs1, /\$Dir = 'dsh-docker'/)
assert.match(installPs1, /8\) 删除/)
assert.match(installPs1, /请输入 DELETE 继续/)
assert.match(installPs1, /container ls -aq --filter "label=com\.docker\.compose\.project=\$projectName"/)
assert.match(installPs1, /volume ls -q --filter "label=com\.docker\.compose\.project=\$projectName"/)
assert.match(installPs1, /label=org\.opencontainers\.image\.title=dsh-docker/)
assert.match(installPs1, /builder prune -af/)
assert.doesNotMatch(installPs1, /--filter name=dsh/)
assert.match(dockerfile, /org\.opencontainers\.image\.title="dsh-docker"/)
assert.match(readmeZh, /raw\.githubusercontent\.com\/univers629\/dsh-docker\/main\/install\.sh/)
assert.match(readmeEn, /raw\.githubusercontent\.com\/univers629\/dsh-docker\/main\/install\.sh/)
assert.match(readmeZh, /install\.ps1 \| iex/)
assert.match(readmeEn, /install\.ps1 \| iex/)
assert.match(readmeZh, /Windows-supported/)
assert.match(readmeEn, /Windows-supported/)
assert.match(readmeZh, /Debian-13/)
assert.match(readmeEn, /Debian-13/)
const legacyNames = new RegExp(`${['dsh', 'docker', 'dev'].join('-')}|${['dsh', 'docker'].join('_')}`)
assert.doesNotMatch(`${installSh}\n${installPs1}\n${readmeZh}\n${readmeEn}`, legacyNames)
assert.match(envExample, /^DSH_ACCESS_MODE=local$/m)
assert.doesNotMatch(dshSh, /network connect.*dpanel-local/)

assert.match(installSh, /DSH_DELETE_DETACHED/)
assert.match(installSh, /DSH_DELETE_CONFIRMED/)
assert.match(installSh, /mktemp "\$\{TMPDIR:-\/tmp\}\/dsh-delete-XXXXXX"/)
assert.match(installPs1, /DSH_DELETE_DETACHED/)
assert.match(installPs1, /DSH_DELETE_CONFIRMED/)
assert.match(installPs1, /\[Environment\]::CurrentDirectory/)
assert.match(installPs1, /PSNativeCommandUseErrorActionPreference = \$false/)
assert.match(installPs1, /UTF8Encoding\(\$false\)[\s\S]*htpasswd \$imageRef -niB/)
assert.match(dshSh, /^unset DSH_ACCESS_MODE DSH_BIND_HOST DSH_TRUSTED_HOSTS DSH_DOCKER_NETWORK DSH_DOCKER_NETWORK_EXTERNAL$/m)
assert.match(dshBat, /set "DSH_BIND_HOST="/)

// ---------------------------------------------------------------------------
// 模型密钥代理 / 出站隔离 / userns 预检：两个安装器的开关集合必须一致
// ---------------------------------------------------------------------------
for (const [shellFlag, powershellParameter] of [
  ['--model-key', '$ModelKey'],
  ['--model-base-url', '$ModelBaseUrl'],
  ['--model-api', '$ModelApi'],
  ['--model-header', '$ModelHeader'],
  ['--model-keys-file', '$ModelKeysFile'],
  ['--no-model-broker', '$NoModelBroker'],
  ['--egress', '$Egress'],
  ['--egress-allow', '$EgressAllow'],
  ['--userns-preflight', '$UsernsPreflight'],
]) {
  assert.ok(installSh.includes(shellFlag), `install.sh missing ${shellFlag}`)
  assert.ok(installPs1.includes(powershellParameter), `install.ps1 missing ${powershellParameter}`)
}
assert.match(installPs1, /\[string\[\]\]\$ModelKey = @\(\)/)
assert.match(installPs1, /\[string\[\]\]\$ModelBaseUrl = @\(\)/)
assert.match(installPs1, /\[string\[\]\]\$ModelApi = @\(\)/)
assert.match(installPs1, /\[string\[\]\]\$ModelHeader = @\(\)/)
// 向导里的可选输入必须有对应的助手函数：少了它，"固定请求头"那一问会在运行时炸。
assert.match(installPs1, /^function Ask-Optional \{$/m)
assert.match(installSh, /^prompt_optional\(\) \{$/m)
// API 形态的问答两边必须给出同一组选项，否则"装的时候选一种、补填时选另一种"。
for (const option of [
  '1) OpenAI 兼容，不额外收窄端点（chat/completions、responses、embeddings 都放行）',
  '2) 只用 Responses（Codex 那类客户端）',
  '3) 只用 Chat Completions',
  '4) Anthropic Messages（认证头 x-api-key，自动带 anthropic-version）',
  '5) Gemini 原生（认证头 x-goog-api-key，端点 /v1beta/models）',
  '一行一个 name=value，回车结束。示例：user-agent=codex_cli_rs/0.101.0',
]) {
  assert.ok(installSh.includes(option), `install.sh 缺少形态问答：${option}`)
  assert.ok(installPs1.includes(option), `install.ps1 缺少形态问答：${option}`)
}
// 出站模式的说明也必须逐字一致：这是用户唯一能看到的策略说明。
for (const line of [
  '1) open（默认）：容器可访问任意外网地址。',
  '2) allowlist：容器只能经 dsh-egress 代理出网，白名单外的域名返回 403。',
  '    内置白名单：Debian、npm、PyPI、GitHub、ghcr.io、nodejs.org、astral.sh，',
  '    足够 apt / pip / npm / git 正常工作；其他域名需要在下一问里补充。',
  '    影响范围：Agent 访问白名单外的网页、搜索接口、第三方下载站会被拒绝。',
  '    填写的域名会追加在内置白名单之后（内置的软件源始终放行），留空表示只用内置白名单。',
]) {
  assert.ok(installSh.includes(line), `install.sh 缺少出站模式说明：${line}`)
  assert.ok(installPs1.includes(line), `install.ps1 缺少出站模式说明：${line}`)
}
// 追加语义是策略层的默认值，compose 必须把开关透出来，否则 .env 里写了也不生效。
assert.match(isolatedCompose, /DSH_EGRESS_ALLOWED_HOSTS_MODE: "\$\{DSH_EGRESS_ALLOWED_HOSTS_MODE:-append\}"/)
assert.match(installPs1, /\[string\]\$ModelKeysFile = ''/)
assert.match(installPs1, /\[switch\]\$NoModelBroker/)
assert.match(installPs1, /\[ValidateSet\('',\s*'open',\s*'allowlist'\)\]/)
assert.match(installPs1, /\[string\[\]\]\$EgressAllow = @\(\)/)
assert.match(installPs1, /\[switch\]\$UsernsPreflight/)
// 密钥参数会进 ps，所以帮助文本必须把交互输入和 --model-keys-file 说成首选。
assert.match(installSh, /--model-keys-file/)
assert.match(installSh, /会出现在 ps 里/)
assert.match(installSh, /DSH_MODEL_KEYS_FILE/)
assert.match(installPs1, /DSH_MODEL_KEYS_FILE/)

// 叠加顺序是契约：keys.yml 先把 dsh-key-broker 放进 dsh-internal，isolated.yml 才能
// 把 dsh 收进那张没有网关的网络而不切断模型请求。
assert.ok(
  installSh.indexOf('COMPOSE_ARGS+=(-f docker-compose.keys.yml)') > 0
    && installSh.indexOf('COMPOSE_ARGS+=(-f docker-compose.keys.yml)') < installSh.indexOf('COMPOSE_ARGS+=(-f docker-compose.isolated.yml)'),
  'install.sh must add the keys overlay before the isolated overlay',
)
assert.ok(
  installPs1.indexOf("@('-f','docker-compose.keys.yml')") > 0
    && installPs1.indexOf("@('-f','docker-compose.keys.yml')") < installPs1.indexOf("@('-f','docker-compose.isolated.yml')"),
  'install.ps1 must add the keys overlay before the isolated overlay',
)
// build 与 up 必须拿到同一套 -f，否则构建和启动读到的是不同的 Compose 文档。
assert.match(installSh, /docker compose "\$\{COMPOSE_ARGS\[@\]\}" build dsh/)
assert.match(installSh, /DOCKER compose --env-file "\$PENDING_ENV_FILE" "\$\{COMPOSE_ARGS\[@\]\}" up -d/)
// install.ps1 把 -f 拆到 -FileArguments 里传：Compose 要求 -f 紧跟在 compose 之后，
// 而 tests/run-mode-smoke.mjs 断言 up 的参数是那串字面量，两者只能靠拆参数同时满足。
assert.match(installPs1, /-Arguments @\('up','-d','--no-build','--force-recreate'\)[^\n]*-FileArguments \$composeFileArgs/)
assert.match(installPs1, /& docker compose --env-file \$Path @FileArguments @Arguments/)

// .env 只记开关和地址；真实密钥只允许落在 data/broker/keys.json。
assert.match(installSh, /set_compose_env DSH_MODEL_BROKER "\$PENDING_MODEL_BROKER"/)
assert.match(installSh, /set_compose_env DSH_EGRESS_MODE "\$PENDING_EGRESS_MODE"/)
assert.match(installSh, /set_compose_env DSH_EGRESS_ALLOWED_HOSTS "\$PENDING_EGRESS_ALLOWED_HOSTS"/)
assert.match(installPs1, /Set-ComposeEnvValue \$pendingEnvFile 'DSH_MODEL_BROKER' \$modelBroker/)
assert.match(installPs1, /Set-ComposeEnvValue \$pendingEnvFile 'DSH_EGRESS_MODE' \$egressMode/)
assert.doesNotMatch(installSh, /set_compose_env \S*(KEYS?|SECRET)\b/)
assert.doesNotMatch(installPs1, /Set-ComposeEnvValue [^\n]*\$(upstreamKey|ModelKey)\b/)
// 落盘权限：Linux 上 0600 + chown 1000:1000（broker 容器以 UID 1000 只读挂载它）。
assert.match(installSh, /chmod 600 "\$temporary"/)
assert.match(installSh, /chown 1000:1000 data\/broker\/keys\.json/)
assert.match(installSh, /mv "\$temporary" data\/broker\/keys\.json/)
assert.match(installPs1, /function Protect-BrokerConfigFile/)
assert.match(installPs1, /SetAccessRuleProtection\(\$true, \$false\)/)

// 启动后的核验：broker 活着，且密钥配置绝不能出现在 DSH 容器里。
for (const [label, source] of [['install.sh', installSh], ['install.ps1', installPs1]]) {
  assert.ok(source.includes('8080/healthz'), `${label} must probe the broker health endpoint`)
  // /etc/dsh-broker 是镜像里预建的只读挂载点，永远存在；按存在性判断会把一次成功的
  // 安装判成致命错误。判定口径必须是"里面为空"，与 bin/verify-dsh-hardening 一致。
  assert.ok(source.includes('ls -A /etc/dsh-broker'), `${label} must list the mount point contents, not just its existence`)
  assert.ok(
    !/ls \/etc\/dsh-broker'/.test(source),
    `${label} must not treat the pre-created mount point's existence as a failure`,
  )
  assert.ok(source.includes('3128/status'), `${label} must probe the egress proxy status endpoint`)
  for (const name of ['dsh-key-broker', 'dsh-egress', 'dsh-ingress', 'dsh-internal']) {
    assert.ok(source.includes(name), `${label} delete flow must know about ${name}`)
  }
}
// 密钥留空是有效答案（跳过密钥代理），不能再把用户卡在必填循环里；跳过时必须如实说明
// WebUI 直填的代价，并给出补填的动作。
assert.match(installSh, /留空 = 跳过/)
assert.match(installPs1, /留空 = 跳过/)
assert.doesNotMatch(installSh, /密钥不能为空/)
assert.doesNotMatch(installPs1, /密钥不能为空/)
assert.match(installSh, /^prompt_broker_upstreams\(\) \{$/m)
assert.match(installPs1, /^function Read-BrokerUpstreams \{$/m)
assert.match(installSh, /^print_broker_skipped_notice\(\) \{$/m)
assert.match(installPs1, /^function Show-BrokerSkippedNotice \{$/m)
// 补填动作绝不能重建 dsh：那会丢掉容器可写层里 apt 装的工具链。
const shellModelKey = installSh.slice(installSh.indexOf('add_model_key() {'), installSh.indexOf('cleanup_pending_env() {'))
assert.ok(shellModelKey.includes('./dsh.sh start'), 'install.sh model-key must start the sidecar through dsh.sh')
assert.ok(!shellModelKey.includes('force-recreate'), 'install.sh model-key must never recreate the dsh container')
assert.ok(shellModelKey.includes('set_compose_env DSH_MODEL_BROKER on'), 'install.sh model-key must flip the switch in .env')
const powershellModelKey = installPs1.slice(installPs1.indexOf("    'model-key' {"), installPs1.indexOf("    'update' {"))
assert.ok(powershellModelKey.includes('.\\dsh.bat start'), 'install.ps1 model-key must start the sidecar through dsh.bat')
assert.ok(!powershellModelKey.includes('force-recreate'), 'install.ps1 model-key must never recreate the dsh container')
assert.ok(
  powershellModelKey.includes("Set-ComposeEnvValue $envFile 'DSH_MODEL_BROKER' 'on'"),
  'install.ps1 model-key must flip the switch in .env',
)
for (const readme of [readmeZh, readmeEn]) {
  assert.ok(readme.includes('model-key'), 'README must document the model-key action')
}

// 叠加文件在老部署目录里不存在，删除流程必须容忍。
assert.match(installSh, /\[ -f docker-compose\.keys\.yml \] && compose_files\+=\( -f docker-compose\.keys\.yml \)/)
assert.match(installPs1, /Test-Path -LiteralPath \(Join-Path \$resolvedDir \$overlay\) -PathType Leaf/)

// userns-remap 是 daemon 级设置，安装器只许打印步骤，绝不许自己改 daemon.json 或重启 Docker。
assert.match(installSh, /name=userns/)
assert.match(installSh, /dockremap/)
const printOnlyLines = (source) => source
  .split('\n')
  .map((entry) => entry.trim())
  .filter((entry) => !entry.startsWith('#'))
  .filter((entry) => entry.includes('daemon.json') || entry.includes('systemctl'))
for (const line of printOnlyLines(installSh)) {
  assert.match(line, /^echo /, `install.sh must only print, never run: ${line}`)
}
for (const line of printOnlyLines(installPs1)) {
  assert.match(line, /^Write-Host /, `install.ps1 must only print, never run: ${line}`)
}
// Windows 上如实说明不支持，而不是假装预检通过。
assert.match(installPs1, /Docker Desktop 不支持它/)
assert.match(installPs1, /install\.sh --userns-preflight/)

// ---------------------------------------------------------------------------
// 实跑一遍：--model-key 生成的 keys.json 必须能通过 broker 自己的强校验
// ---------------------------------------------------------------------------
const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`].find(existsSync)
  : 'bash'
assert.ok(bash, 'bash is required for the wizard installer smoke test')
const bashPath = (path) => process.platform === 'win32'
  ? path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
  : path

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-wizard-smoke-'))
const mockBin = join(sandbox, 'bin')
const dockerLog = join(sandbox, 'docker.log')
await mkdir(mockBin)

// 只模拟安装器真正用到的子命令。exec 的分支是重点：ls -A /etc/dsh-broker 必须输出为空，
// 空目录才证明密钥配置没被挂进 Agent 能读的容器（那个挂载点在镜像里本来就存在）。
// MOCK_DOCKER_CONTAINER_EXISTS 用来切换"dsh 容器已存在"：install 需要它不存在，
// model-key 反过来必须要求它已经存在。
const dockerMock = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
if [ "\${1:-}" = container ] && [ "\${2:-}" = inspect ]; then
  if [ -n "\${MOCK_DOCKER_CONTAINER_EXISTS:-}" ]; then exit 0; fi
  exit 1
fi
if [ "\${1:-}" = inspect ]; then exit 1; fi
if [ "\${1:-}" = run ]; then
  case " $* " in
    *hash-dsh-password*) printf '%s\\n' '$6$wizardSmokeSalt$wizardSmokeHash' ;;
    *) printf '%s\\n' 'dsh:$2y$05$wizardSmokeHash' ;;
  esac
fi
if [ "\${1:-}" = exec ]; then
  case " $* " in
    *verify-dsh-hardening*) exit 0 ;;
    */etc/dsh-broker*) ;;
    *dsh-key-broker*) exit 0 ;;
    *dsh-egress*) printf '%s\\n' '{"status":"ok","allowedHosts":42,"activeConnections":0}' ;;
    *dsh-ingress*) exit 0 ;;
    *) printf '%s\\n' 1000 ;;
  esac
  exit 0
fi
exit 0
`
const dockerMockPath = join(mockBin, 'docker')
await writeFile(dockerMockPath, dockerMock)
await chmod(dockerMockPath, 0o755)

const prepareProject = async (name) => {
  const directory = join(sandbox, name)
  await mkdir(directory, { recursive: true })
  await cp(join(repoRoot, 'docker-compose.yml'), join(directory, 'docker-compose.yml'))
  await cp(join(repoRoot, 'docker-compose.keys.yml'), join(directory, 'docker-compose.keys.yml'))
  await cp(join(repoRoot, 'docker-compose.isolated.yml'), join(directory, 'docker-compose.isolated.yml'))
  await writeFile(join(directory, 'dsh.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(directory, 'dsh.sh'), 0o755)
  return directory
}

const runInstaller = (action, target, args, extraEnv = {}) => spawnSync(bash, [
  '-c',
  'PATH="$MOCK_BIN:$PATH"; export PATH; exec "$INSTALL_SCRIPT" "$@"',
  'dsh-wizard-smoke',
  action, '--non-interactive', '--dir', target, '--image-source', 'build', '--access', 'local', ...args,
], {
  cwd: sandbox,
  encoding: 'utf8',
  env: {
    ...process.env,
    MOCK_DOCKER_LOG: dockerLog,
    MOCK_BIN: bashPath(mockBin),
    INSTALL_SCRIPT: bashPath(join(repoRoot, 'install.sh')),
    ...extraEnv,
  },
})
const runInstall = (target, args) => runInstaller('install', target, args)

try {
  const modelKey = 'sk-test-wizard-smoke-deepseek-key'
  await prepareProject('broker')
  const broker = runInstall('broker', ['--model-key', `deepseek=${modelKey}`])
  assert.equal(broker.status, 0, `${broker.stdout}\n${broker.stderr}`)

  // broker 自己的 parseBrokerConfig 是唯一的权威校验：配置写错它会拒绝启动。
  const keysPath = join(sandbox, 'broker', 'data', 'broker', 'keys.json')
  const parsed = parseBrokerConfig(await readFile(keysPath, 'utf8'))
  assert.deepEqual([...parsed.upstreams.keys()], ['deepseek'])
  assert.equal(parsed.upstreams.get('deepseek').key, modelKey)
  assert.equal(parsed.upstreams.get('deepseek').baseUrl, 'https://api.deepseek.com')
  assert.equal(parsed.upstreams.get('deepseek').headerValue, `Bearer ${modelKey}`)

  // 这一条必须有：.env 全文不得含密钥字面值。
  const brokerEnv = await readFile(join(sandbox, 'broker', '.env'), 'utf8')
  assert.ok(!brokerEnv.includes(modelKey), '.env must never contain a model key')
  assert.match(brokerEnv, /^DSH_MODEL_BROKER=on$/m)
  assert.match(brokerEnv, /^DSH_MODEL_BROKER_BASE=http:\/\/dsh-key-broker:8080$/m)
  assert.ok(!(await readFile(dockerLog, 'utf8')).includes(modelKey), 'a model key must never reach a docker command line')

  // 关闭要连密钥一起清掉，而不只是翻开关。
  const disabled = runInstall('broker', ['--no-model-broker'])
  assert.equal(disabled.status, 0, `${disabled.stdout}\n${disabled.stderr}`)
  assert.equal(existsSync(keysPath), false, '--no-model-broker must delete data/broker/keys.json')
  assert.match(await readFile(join(sandbox, 'broker', '.env'), 'utf8'), /^DSH_MODEL_BROKER=off$/m)

  // 装的时候跳过密钥之后，model-key 必须能把 broker 补上，而且只碰 keys.json 与 .env。
  const lateKey = 'sk-test-wizard-smoke-late-key'
  const withoutContainer = runInstaller('model-key', 'broker', ['--model-key', `openai=${lateKey}`])
  assert.equal(withoutContainer.status, 1, 'model-key must refuse to run before the container exists')
  assert.match(withoutContainer.stderr, /还没有 dsh 容器/)

  const lateAdd = runInstaller('model-key', 'broker', ['--model-key', `openai=${lateKey}`], { MOCK_DOCKER_CONTAINER_EXISTS: '1' })
  assert.equal(lateAdd.status, 0, `${lateAdd.stdout}\n${lateAdd.stderr}`)
  const lateParsed = parseBrokerConfig(await readFile(keysPath, 'utf8'))
  assert.deepEqual([...lateParsed.upstreams.keys()], ['openai'])
  assert.equal(lateParsed.upstreams.get('openai').key, lateKey)
  const lateEnv = await readFile(join(sandbox, 'broker', '.env'), 'utf8')
  assert.match(lateEnv, /^DSH_MODEL_BROKER=on$/m)
  assert.ok(!lateEnv.includes(lateKey), '.env must never contain a model key')
  assert.ok(!(await readFile(dockerLog, 'utf8')).includes(lateKey), 'a model key must never reach a docker command line')

  // 非交互又没给密钥来源时必须直接报参数错误，而不是静默什么都不做。
  const lateWithoutKey = runInstaller('model-key', 'broker', [], { MOCK_DOCKER_CONTAINER_EXISTS: '1' })
  assert.equal(lateWithoutKey.status, 2, 'non-interactive model-key needs --model-key or --model-keys-file')

  // Codex 那类客户端要的是「只放行 /v1/responses + 固定 originator/version/User-Agent」，
  // 而这些必须只出现在 broker 一侧：dsh 容器里改不了，客户端也不用管。
  const codexKey = 'sk-test-wizard-smoke-codex-key'
  await prepareProject('profile')
  const profiled = runInstaller('model-key', 'profile', [
    '--model-key', `justwoker=${codexKey}`,
    '--model-base-url', 'justwoker=https://api.justwoker.icu',
    '--model-api', 'justwoker=responses',
    '--model-header', 'justwoker=user-agent=codex_cli_rs/0.101.0',
    '--model-header', 'justwoker=originator=codex_cli_rs',
    '--model-header', 'justwoker=version=0.101.0',
  ], { MOCK_DOCKER_CONTAINER_EXISTS: '1' })
  assert.equal(profiled.status, 0, `${profiled.stdout}\n${profiled.stderr}`)
  const profiledPath = join(sandbox, 'profile', 'data', 'broker', 'keys.json')
  const profiledParsed = parseBrokerConfig(await readFile(profiledPath, 'utf8'))
  const justwoker = profiledParsed.upstreams.get('justwoker')
  assert.ok(justwoker, 'the justwoker upstream must exist')
  assert.equal(justwoker.headerValue, `Bearer ${codexKey}`)
  assert.ok(justwoker.allowedPathPrefixes.includes('/v1/responses'), 'responses profile must allow /v1/responses')
  assert.ok(!justwoker.allowedPathPrefixes.includes('/v1/chat/completions'), 'responses profile must not allow chat completions')
  assert.equal(justwoker.extraHeaders['user-agent'], 'codex_cli_rs/0.101.0')
  assert.equal(justwoker.extraHeaders.originator, 'codex_cli_rs')
  assert.equal(justwoker.extraHeaders.version, '0.101.0')

  // Anthropic 形态的默认值不能被新参数改掉：认证头是 x-api-key，且自带 anthropic-version。
  const anthropicKey = 'sk-ant-test-wizard-smoke-key'
  const anthropic = runInstaller('model-key', 'profile', ['--model-key', `anthropic=${anthropicKey}`], { MOCK_DOCKER_CONTAINER_EXISTS: '1' })
  assert.equal(anthropic.status, 0, `${anthropic.stdout}\n${anthropic.stderr}`)
  const anthropicParsed = parseBrokerConfig(await readFile(profiledPath, 'utf8'))
  const anthropicUpstream = anthropicParsed.upstreams.get('anthropic')
  assert.equal(anthropicUpstream.headerName, 'x-api-key')
  assert.equal(anthropicUpstream.headerValue, anthropicKey)
  assert.equal(anthropicUpstream.extraHeaders['anthropic-version'], '2023-06-01')

  // 挂在不存在的上游名上的 --model-api 必须出警告，而不是静默丢掉。
  const orphan = runInstaller('model-key', 'profile', [
    '--model-key', `justwoker=${codexKey}`,
    '--model-base-url', 'justwoker=https://api.justwoker.icu',
    '--model-api', 'nosuch=chat',
  ], { MOCK_DOCKER_CONTAINER_EXISTS: '1' })
  assert.equal(orphan.status, 0, `${orphan.stdout}\n${orphan.stderr}`)
  assert.match(orphan.stderr, /没有名为 nosuch 的上游/)

  // 形态写错要在动到配置之前就退出，退出码 2 = 参数错误。
  const badProfile = runInstaller('model-key', 'profile', [
    '--model-key', `justwoker=${codexKey}`,
    '--model-base-url', 'justwoker=https://api.justwoker.icu',
    '--model-api', 'justwoker=grpc',
  ], { MOCK_DOCKER_CONTAINER_EXISTS: '1' })
  assert.equal(badProfile.status, 2, 'an unknown --model-api profile must fail with an argument error')
  assert.match(badProfile.stderr, /未知的 API 形态/)

  // 认证头不允许被 --model-header 覆盖：那等于绕过密钥注入。
  const badHeader = runInstaller('model-key', 'profile', [
    '--model-key', `justwoker=${codexKey}`,
    '--model-base-url', 'justwoker=https://api.justwoker.icu',
    '--model-header', 'justwoker=authorization=Bearer leaked',
  ], { MOCK_DOCKER_CONTAINER_EXISTS: '1' })
  assert.equal(badHeader.status, 2, '--model-header must refuse to override the auth header')
  assert.match(badHeader.stderr, /由密钥代理自己管理/)

  await prepareProject('egress')
  const isolated = runInstall('egress', ['--egress', 'allowlist', '--egress-allow', 'mirror.example.com'])
  assert.equal(isolated.status, 0, `${isolated.stdout}\n${isolated.stderr}`)
  const isolatedEnv = await readFile(join(sandbox, 'egress', '.env'), 'utf8')
  assert.match(isolatedEnv, /^DSH_EGRESS_MODE=allowlist$/m)
  assert.match(isolatedEnv, /^DSH_EGRESS_ALLOWED_HOSTS=mirror\.example\.com$/m)
  const calls = await readFile(dockerLog, 'utf8')
  assert.match(calls, /compose --env-file \S+ -f docker-compose\.yml -f docker-compose\.isolated\.yml up -d/)
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

console.log('install wizard smoke: ok')
