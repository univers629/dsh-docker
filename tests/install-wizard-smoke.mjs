import assert from 'node:assert/strict'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseBrokerConfig } from '../bin/dsh-key-broker-policy.mjs'

const read = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [compose, dockerfile, entrypoint, authConfig, nginx, installSh, installPs1, envExample, dshSh, dshBat, readmeZh, readmeEn, isolatedCompose, keyAdminCompose] = await Promise.all([
  'docker-compose.yml', 'Dockerfile', 'bin/entrypoint.sh', 'bin/configure-nginx-auth', 'nginx/dsh-nginx.conf',
  'install.sh', 'install.ps1', '.env.example', 'dsh.sh', 'dsh.bat', 'README.md', 'README.en.md',
  'docker-compose.isolated.yml', 'docker-compose.keys-admin.yml',
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
// 只看动作分发之后那一段：upgrade 用的函数定义在 switch 之前，也含同一条构建命令，
// 而这里要检查的是安装分支里"先拉、拉不到再本机构建"的顺序。
const powershellDispatch = installPs1.slice(installPs1.indexOf('switch ($DshAction) {'))
assert.ok(
  powershellDispatch.indexOf('docker pull $imageRef') < powershellDispatch.indexOf('docker compose build dsh'),
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

for (const action of ['install', 'configure', 'update', 'model-key', 'key-panel', 'start', 'stop', 'restart', 'logs', 'status', 'delete']) {
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
  ['--model-id', '$ModelId'],
  ['--no-model-settings-seed', '$NoModelSettingsSeed'],
  ['--key-admin', '$KeyAdmin'],
  ['--no-key-admin', '$NoKeyAdmin'],
  ['--key-admin-bind', '$KeyAdminBind'],
  ['--key-admin-port', '$KeyAdminPort'],
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
// 向导做过一次减法：官方上游只问密钥。API 形态、固定请求头、模型 id、限额这四问都被删了，
// 因为它们都不是秘密（隔离要保护的只有密钥），而且都能在密钥管理面板里改。这里用"必须不存在"
// 锁住这次减法，防止以后有人把问答一条条加回来。
for (const removed of [
  '1) OpenAI 兼容，不额外收窄端点（chat/completions、responses、embeddings 都放行）',
  '4) Anthropic Messages（认证头 x-api-key，自动带 anthropic-version）',
  '一行一个 name=value，回车结束。示例：user-agent=codex_cli_rs/0.101.0',
  '模型 id（多个用逗号分隔）',
  '每分钟请求上限（0 = 不限）',
  '每日请求配额（0 = 不限）',
  '需要固定请求头',
]) {
  assert.ok(!installSh.includes(removed), `install.sh 不该再问：${removed}`)
  assert.ok(!installPs1.includes(removed), `install.ps1 不该再问：${removed}`)
}
// 自建网关的 base_url 忘了版本段就是上游 404，这一问留着，提示也必须两边一致。
for (const option of [
  '不在内置默认表里，base_url 照上游文档原样填，注意带上版本段：',
  '    OpenAI 兼容网关一般是 https://<域名>/v1，Anthropic 兼容的一般不带 /v1。',
  '    这里填的是真实上游地址；DSH 容器那边填什么由安装器自己算。',
  '上游名字（小写字母开头，只能用小写字母、数字和短横线）',
  '的 API 密钥（不回显，留空 = 跳过）',
]) {
  assert.ok(installSh.includes(option), `install.sh 缺少上游问答：${option}`)
  assert.ok(installPs1.includes(option), `install.ps1 缺少上游问答：${option}`)
}
// 模型清单不再问人，改为保存前向上游要一次。少了这一步，目录外的自建网关会因为
// 一个模型都没有被 DSH 的 settings 校验整条丢掉，WebUI 上就是"卡片没出现且没有报错"。
assert.ok(installSh.includes('discover_broker_models'), 'install.sh 缺少模型清单发现步骤')
assert.ok(installPs1.includes('Invoke-BrokerModelDiscovery'), 'install.ps1 缺少模型清单发现步骤')
for (const helper of ['bin/discover-upstream-models.mjs', 'bin/dsh-upstream-models.mjs']) {
  assert.ok(existsSync(new URL(`../${helper}`, import.meta.url)), `缺少 ${helper}`)
}
// 同一次发现还要修 base_url 的版本段。少了它就是用户报过的那个现象：面板/安装器
// 能拉到模型清单（拉取会同时试 /models 和 /v1/models），而 DSH 发请求时一个版本段
// 都不补，于是每个请求都落在上游根路径上，网页里显示成 403 或 "API key is invalid"。
assert.ok(installSh.includes('set_broker_base_url'), 'install.sh 缺少 base_url 版本段修正')
assert.ok(installSh.includes('baseurl)'), 'install.sh 没有处理发现脚本的 baseurl 行')
assert.ok(installPs1.includes("'baseurl'"), 'install.ps1 没有处理发现脚本的 baseurl 行')
// 推理强度档位只在密钥管理面板里设（向导不问），所以两个安装器重新配置同名上游时
// 必须把 dsh.reasoningEfforts 继承下来，否则一次"重新配置"就把强度菜单弄没了。
for (const [label, source] of [['install.sh', installSh], ['install.ps1', installPs1]]) {
  assert.ok(source.includes('reasoningEfforts'), `${label} 合并 keys.json 时没保留 reasoningEfforts`)
}
// 上游名字的规则必须三处一致：两个安装器 + 面板策略。不一致就会出现"装的时候能填、
// 面板里改不了"这种只在某一端复现的问题。
assert.ok(installSh.includes("''|[!a-z]*|*[!a-z0-9-]*|*-|*--*"), 'install.sh 的上游名字规则没跟上')
for (const source of [installPs1, await read('bin/dsh-key-admin-policy.mjs')]) {
  assert.ok(
    source.includes('^[a-z][a-z0-9]*(-[a-z0-9]+)*$') || source.includes('^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$'),
    '上游名字规则三处不一致',
  )
}
// keys.json 里的 dsh 段是面板和 DSH 之间唯一的形态/模型清单来源，两个安装器都要写。
assert.ok(installSh.includes('\\"dsh\\"'), 'install.sh 没写 keys.json 的 dsh 段')
assert.ok(installPs1.includes("$entry['dsh']"), 'install.ps1 没写 keys.json 的 dsh 段')
// 出站模式的说明也必须逐字一致：这是用户唯一能看到的策略说明。
for (const line of [
  '1) open：容器直接访问任意外网地址。',
  '2) blocklist：出站经 dsh-egress 代理，默认放行，只挡黑名单里的域名。',
  '    内置黑名单是常见的一键公网隧道服务（cloudflared 快速隧道、ngrok、cpolar 等），',
  '    它们能把容器里的端口发布到公网，等于把模型密钥代理变成别人能用的免费网关。',
  '    Agent 的网页搜索、文档站、第三方下载都照常可用。',
  '3) allowlist：出站经 dsh-egress 代理，只放行白名单里的域名，其余返回 403。',
  '    内置白名单覆盖 Debian、npm、PyPI、GitHub、ghcr.io、nodejs.org、astral.sh，',
  '    足够 apt / pip / npm / git 正常工作；网页搜索和文档站要自己补域名。',
  '    填写的域名会追加在内置白名单之后（内置的软件源始终放行），留空表示只用内置白名单。',
]) {
  assert.ok(installSh.includes(line), `install.sh 缺少出站模式说明：${line}`)
  assert.ok(installPs1.includes(line), `install.ps1 缺少出站模式说明：${line}`)
}
// 追加语义是策略层的默认值，compose 必须把开关透出来，否则 .env 里写了也不生效。
assert.match(isolatedCompose, /DSH_EGRESS_ALLOWED_HOSTS_MODE: "\$\{DSH_EGRESS_ALLOWED_HOSTS_MODE:-append\}"/)
// 出站策略文件是安装器、代理、面板三方的契约，所以这几条都要钉住。
// 1) 两个安装器都要建目录并写策略文件。
assert.ok(installSh.includes('mkdir -p data/auth data/secret data/broker data/egress'), 'install.sh 没建 data/egress')
assert.ok(installPs1.includes("'data\\egress'"), 'install.ps1 没建 data\\egress')
assert.ok(installSh.includes('write_egress_policy'), 'install.sh 没写出站策略文件')
assert.ok(installPs1.includes('Write-EgressPolicy'), 'install.ps1 没写出站策略文件')
// 2) 安装器只写 mode：内置域名表不能在 shell 里再抄一份，否则默认清单会有两个来源。
assert.equal(installSh.includes('trycloudflare'), false, 'install.sh 不该复制内置黑名单')
assert.equal(installPs1.includes('trycloudflare'), false, 'install.ps1 不该复制内置黑名单')
// 3) 策略文件里的模式优先于 .env：否则在面板里切过模式，重跑安装器会被 .env 顶回去。
assert.ok(installSh.includes('egress_policy_mode'), 'install.sh 要先看策略文件里的模式')
assert.ok(installPs1.includes('Get-EgressPolicyMode'), 'install.ps1 要先看策略文件里的模式')
// 4) blocklist 与 allowlist 都要叠加隔离 compose，只有 open 不叠加。
assert.match(installSh, /"\$PENDING_EGRESS_MODE" != open/)
assert.match(installPs1, /\$egressMode -ne 'open'/)
// 5) 挂载方向：代理只读，面板可写。反了就等于把出站策略交给了另一个容器。
assert.match(isolatedCompose, /\.\/data\/egress:\/etc\/dsh-egress:ro/)
assert.match(keyAdminCompose, /\.\/data\/egress:\/etc\/dsh-egress$/m)
assert.match(isolatedCompose, /DSH_EGRESS_POLICY_FILE: \/etc\/dsh-egress\/policy\.json/)
assert.match(keyAdminCompose, /DSH_KEY_ADMIN_EGRESS_POLICY: \/etc\/dsh-egress\/policy\.json/)
assert.match(installPs1, /\[string\]\$ModelKeysFile = ''/)
assert.match(installPs1, /\[switch\]\$NoModelBroker/)
assert.match(installPs1, /\[ValidateSet\('',\s*'open',\s*'blocklist',\s*'allowlist'\)\]/)
assert.match(installPs1, /\[string\[\]\]\$EgressAllow = @\(\)/)
assert.match(installPs1, /\[switch\]\$UsernsPreflight/)
assert.match(installPs1, /\[string\[\]\]\$ModelId = @\(\)/)
assert.match(installPs1, /\[switch\]\$NoModelSettingsSeed/)

// ---------------------------------------------------------------------------
// 模型配置种子：安装器要替用户把供应商写进 DSH 自己的配置，而不是只打印在摘要里
// ---------------------------------------------------------------------------
// 真正合并 YAML 的那一半必须存在，而且只依赖策略模块（宿主上没有 yaml 库）。
for (const file of ['bin/dsh-model-settings-policy.mjs', 'bin/seed-dsh-model-settings.mjs']) {
  assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `missing ${file}`)
}
assert.ok(installSh.includes('seed_dsh_model_settings'), 'install.sh 必须调用写配置的那一步')
assert.ok(installPs1.includes('Invoke-DshModelSettingsSeed'), 'install.ps1 必须调用写配置的那一步')
// 借镜像里的 node 之前必须先算出镜像引用：model-key 动作没走过 obtain_dsh_image，
// 空字符串交给 docker run 只会得到 invalid reference format。
assert.match(installSh, /^node_tool_image\(\) \{$/m)
assert.match(installPs1, /^function Get-NodeToolImage \{$/m)
assert.ok(installSh.includes('seed_dsh_model_settings "$(node_tool_image)"'), 'install.sh 的 model-key 没走 node_tool_image')
assert.ok(installPs1.includes('Invoke-DshModelSettingsSeed -Image (Get-NodeToolImage $envFile)'), 'install.ps1 的 model-key 没走 Get-NodeToolImage')
// 写盘位置是 DSH 官方那两份文件，路径不能各写一套。
for (const [label, source] of [['install.sh', installSh], ['install.ps1', installPs1]]) {
  assert.match(source, /data[\\/]dsh[\\/]settings\.yaml/, `${label} 必须指名 data/dsh/settings.yaml`)
  assert.ok(source.includes('seed-dsh-model-settings.mjs'), `${label} 必须调用 seed 脚本`)
}
// base_url 里的版本段属于 keys.json 里的上游地址，DSH 侧只写 /u/<name>：
// 两边都补一次就会变成 /v1/v1/responses。旧的 *UrlSuffix 助手必须彻底消失。
for (const [label, source] of [['install.sh', installSh], ['install.ps1', installPs1]]) {
  assert.ok(!source.includes('UrlSuffix'), `${label} 仍留着 base_url 版本段助手`)
  assert.doesNotMatch(source, /\/u\/\$\{?name\}?\/v1/, `${label} 仍在 base_url 后面补 /v1`)
  assert.doesNotMatch(source, /\/u\/\$\(?upstream\)?\/v1/, `${label} 仍在 base_url 后面补 /v1`)
}
// Gemini 走的是 /models/...，把放行前缀写成 /v1beta/models 会让每个请求都 403。
for (const [label, source] of [['install.sh', installSh], ['install.ps1', installPs1]]) {
  assert.match(source, /'\/models'?[ ,]'?\/v1beta\/models'?/, `${label} 的 gemini 必须同时放行 /models 与 /v1beta/models`)
}
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
const shellModelKey = installSh.slice(installSh.indexOf('add_model_key() {'), installSh.indexOf('manage_key_admin() {'))
assert.ok(shellModelKey.includes('./dsh.sh start'), 'install.sh model-key must start the sidecar through dsh.sh')
assert.ok(!shellModelKey.includes('force-recreate'), 'install.sh model-key must never recreate the dsh container')
assert.ok(shellModelKey.includes('set_compose_env DSH_MODEL_BROKER on'), 'install.sh model-key must flip the switch in .env')
const powershellModelKey = installPs1.slice(installPs1.indexOf("    'model-key' {"), installPs1.indexOf("    'key-panel' {"))
assert.ok(powershellModelKey.includes('.\\dsh.bat start'), 'install.ps1 model-key must start the sidecar through dsh.bat')
assert.ok(!powershellModelKey.includes('force-recreate'), 'install.ps1 model-key must never recreate the dsh container')
assert.ok(
  powershellModelKey.includes("Set-ComposeEnvValue $envFile 'DSH_MODEL_BROKER' 'on'"),
  'install.ps1 model-key must flip the switch in .env',
)
for (const readme of [readmeZh, readmeEn]) {
  assert.ok(readme.includes('model-key'), 'README must document the model-key action')
}

// ---------------------------------------------------------------------------
// 模型密钥管理面板（dsh-key-admin）：两个安装器的开关、问答与核验必须一致
// ---------------------------------------------------------------------------
assert.match(installSh, /^configure_key_admin\(\) \{$/m)
assert.match(installPs1, /^function Resolve-KeyAdmin \{$/m)
assert.match(installSh, /^write_key_admin_token\(\) \{$/m)
assert.match(installPs1, /^function Write-KeyAdminToken \{$/m)
assert.match(installSh, /^assert_key_admin\(\) \{$/m)
assert.match(installPs1, /^function Assert-KeyAdmin \{$/m)
assert.match(installSh, /^ensure_broker_config_placeholder\(\) \{$/m)
assert.match(installPs1, /^function Initialize-BrokerConfigPlaceholder \{$/m)
// 面板的问答文案是用户唯一能看到的策略说明，两边必须一字不差。
for (const line of [
  '模型密钥管理面板：',
  '    浏览器里填密钥、按上游拉一次模型列表、设固定请求头（originator / version /',
  '    User-Agent 这些），保存后直接写进 DSH 的模型配置，不用再回终端。',
  '启用模型密钥管理面板',
  '终端里没填密钥。还有一种填法：',
  '    启用模型密钥管理面板，装完在浏览器里填密钥、按上游拉一次模型列表、设固定请求头，',
  '    保存后直接写进 DSH 的模型配置。面板是独立容器，dsh 容器连不到它。',
  '现在不填密钥，装完在密钥管理面板里填',
]) {
  assert.ok(installSh.includes(line), `install.sh 缺少面板问答：${line}`)
  assert.ok(installPs1.includes(line), `install.ps1 缺少面板问答：${line}`)
}
// 叠加顺序：keys.yml → keys-admin.yml → isolated.yml。面板服务复用 broker 的网络定义，
// 反过来叠加的话 dsh-admin 网络还不存在。
assert.ok(
  installSh.indexOf('COMPOSE_ARGS+=(-f docker-compose.keys.yml)') < installSh.indexOf('COMPOSE_ARGS+=(-f docker-compose.keys-admin.yml)')
    && installSh.indexOf('COMPOSE_ARGS+=(-f docker-compose.keys-admin.yml)') < installSh.indexOf('COMPOSE_ARGS+=(-f docker-compose.isolated.yml)'),
  'install.sh must add the key-admin overlay between the keys and isolated overlays',
)
assert.ok(
  installPs1.indexOf("@('-f','docker-compose.keys.yml')") < installPs1.indexOf("@('-f','docker-compose.keys-admin.yml')")
    && installPs1.indexOf("@('-f','docker-compose.keys-admin.yml')") < installPs1.indexOf("@('-f','docker-compose.isolated.yml')"),
  'install.ps1 must add the key-admin overlay between the keys and isolated overlays',
)
// 面板持有全部真实密钥，所以"dsh 容器连不到它"是必须实测的前提，不能只写在文档里。
for (const [label, source] of [['install.sh', installSh], ['install.ps1', installPs1]]) {
  assert.ok(source.includes('8090/healthz'), `${label} must probe the panel health endpoint`)
  assert.ok(source.includes("net.connect(8090, 'dsh-key-admin')"), `${label} must prove dsh cannot reach the panel`)
  assert.ok(source.includes('dsh-key-admin'), `${label} delete flow must know about dsh-key-admin`)
}
// 令牌不进 .env，只落 data/broker/admin.token。
assert.match(installSh, /data\/broker\/admin\.token/)
assert.match(installPs1, /data\\broker\\admin\.token/)
assert.doesNotMatch(installSh, /set_compose_env \S*ADMIN_TOKEN/)
assert.doesNotMatch(installPs1, /Set-ComposeEnvValue [^\n]*'DSH_KEY_ADMIN_TOKEN'/)
assert.doesNotMatch(envExample, /ADMIN_TOKEN/)
assert.match(envExample, /^DSH_KEY_ADMIN=off$/m)
assert.match(envExample, /^DSH_KEY_ADMIN_BIND_HOST=127\.0\.0\.1$/m)
assert.match(envExample, /^DSH_KEY_ADMIN_HOST_PORT=3082$/m)
// 占位密钥两边必须一字不差：面板每次都把代理托管上游的引用写成这个值，两边不一致
// 会让每次保存都误报"这个引用里存着真实密钥"，还会反复改写 .credentials.yaml。
const placeholderKey = /MODEL_BROKER_PLACEHOLDER_KEY="([^"]+)"/.exec(installSh)?.[1] ?? ''
assert.ok(placeholderKey.length > 0, 'install.sh must define MODEL_BROKER_PLACEHOLDER_KEY')
assert.ok(
  keyAdminCompose.includes('DSH_KEY_ADMIN_PLACEHOLDER: "' + placeholderKey + '"'),
  'docker-compose.keys-admin.yml must pin the same placeholder key as install.sh',
)
assert.ok(
  installPs1.includes("$ModelBrokerPlaceholderKey = '" + placeholderKey + "'"),
  'install.ps1 must use the same placeholder key as install.sh',
)
// 补填面板同样不许重建 dsh。
const shellKeyPanel = installSh.slice(installSh.indexOf('manage_key_admin() {'), installSh.indexOf('cleanup_pending_env() {'))
assert.ok(shellKeyPanel.includes('./dsh.sh start'), 'install.sh key-panel must start the sidecar through dsh.sh')
assert.ok(!shellKeyPanel.includes('force-recreate'), 'install.sh key-panel must never recreate the dsh container')
const powershellKeyPanel = installPs1.slice(installPs1.indexOf("    'key-panel' {"), installPs1.indexOf("    'update' {"))
assert.ok(powershellKeyPanel.includes('.\\dsh.bat start'), 'install.ps1 key-panel must start the sidecar through dsh.bat')
assert.ok(!powershellKeyPanel.includes('force-recreate'), 'install.ps1 key-panel must never recreate the dsh container')
// 运行脚本两边都要按 .env 叠加面板，并在 status 里报告它。
assert.match(dshSh, /COMPOSE_ARGS\+=\(-f docker-compose\.keys-admin\.yml\)/)
assert.match(dshSh, /report_sidecar dsh-key-admin/)
assert.match(dshBat, /-f docker-compose\.keys-admin\.yml/)
assert.match(dshBat, /report_sidecar dsh-key-admin/)

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
