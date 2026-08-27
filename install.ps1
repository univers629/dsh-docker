param(
    [Alias('Action')]
    [ValidateSet('','install','configure','update','model-key','key-panel','start','stop','restart','logs','status','delete')]
    [string]$DshAction,
    [ValidateSet('','local','trusted-proxy','basic')]
    [string]$Access = '',
    [string]$BindHost = '',
    [string]$TrustedHosts = '',
    [string]$Network = '',
    [switch]$NetworkExternal,
    [switch]$NetworkInternal,
    [switch]$NonInteractive,
    [string]$RootPassword = '',
    [switch]$NoRootPassword,
    [string[]]$ModelKey = @(),
    [string[]]$ModelBaseUrl = @(),
    [string[]]$ModelApi = @(),
    [string[]]$ModelHeader = @(),
    [string[]]$ModelId = @(),
    [string]$ModelKeysFile = '',
    [switch]$NoModelBroker,
    [switch]$NoModelSettingsSeed,
    [switch]$KeyAdmin,
    [switch]$NoKeyAdmin,
    [string]$KeyAdminBind = '',
    [string]$KeyAdminPort = '',
    [ValidateSet('','open','allowlist')]
    [string]$Egress = '',
    [string[]]$EgressAllow = @(),
    [switch]$UsernsPreflight,
    [ValidateSet('','prebuilt','build')]
    [string]$ImageSource = '',
    [string]$Image = '',
    [string]$Dir = 'dsh-docker'
)

$ErrorActionPreference = 'Stop'
# 原生命令（docker/git）靠退出码判断结果；如果调用方或 profile 打开了
# PSNativeCommandUseErrorActionPreference，非零退出会变成终止错误并中断向导。
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }
if ($NetworkExternal -and $NetworkInternal) { throw '-NetworkExternal 与 -NetworkInternal 不能同时使用。' }
if ($KeyAdmin -and $NoKeyAdmin) { throw '-KeyAdmin 与 -NoKeyAdmin 不能同时使用。' }
$interactive = -not $NonInteractive -and [Environment]::UserInteractive
$GitHubSshUrl = 'ssh://git@ssh.github.com:443/univers629/dsh-docker.git'
$GitHubHttpsUrl = 'https://github.com/univers629/dsh-docker.git'
$DefaultPrebuiltImage = if ($env:DSH_PREBUILT_IMAGE) { $env:DSH_PREBUILT_IMAGE } else { 'ghcr.io/univers629/dsh-docker:latest' }
$DefaultLocalImage = 'dsh:local'
# 容器内只填占位密钥，真实密钥由 dsh-key-broker 在转发时注入，所以这个地址是契约的
# 一部分：compose 用它渲染 DSH_MODEL_BROKER_BASE，摘要用它拼出给 Agent 的 base_url。
$ModelBrokerBase = 'http://dsh-key-broker:8080'
$ModelBrokerPlaceholderKey = 'dsh-broker-placeholder'
# 密钥管理面板的默认发布位置。回环是刻意的默认值：发布到 0.0.0.0 之后 dsh 容器能经宿主
# 网关回连这个端口，网络隔离就白做了。
$DefaultKeyAdminBindHost = '127.0.0.1'
$DefaultKeyAdminPort = '3082'
$KeyAdminOverride = if ($KeyAdmin) { 'on' } elseif ($NoKeyAdmin) { 'off' } else { '' }
$KeyAdminBindHost = ''
$KeyAdminPortValue = ''
$KeyAdminTokenState = ''
if (-not $ModelKeysFile -and $env:DSH_MODEL_KEYS_FILE) { $ModelKeysFile = $env:DSH_MODEL_KEYS_FILE }
# 收集到的上游先留在内存里，写盘之后立刻清空（和 $rootPassword 一样的处理）。
$BrokerUpstreams = New-Object System.Collections.ArrayList
# 上游名 → API 形态。写 DSH 模型配置时要靠它决定自定义路由的 wire 协议。
$BrokerProfiles = @{}
# 上游名 → 要写进 DSH settings.yaml 的模型 id（逗号分隔）。内置目录里的上游可以留空：
# 那种情况下沿用 DSH 自带的整份模型清单。
$BrokerModels = @{}
$composeFileArgs = @('-f','docker-compose.yml')

# ---------------------------------------------------------------------------
# 模型密钥代理（dsh-key-broker）
#
# 这一整段只为一件事服务：真实模型密钥不要出现在 DSH 容器里。那个容器里的 Agent 以
# danger-full-access 运行，放进去的密钥不需要"骗"它说出来，一条 cat 就够了。所以密钥
# 只写 data\broker\keys.json（只被 broker 容器只读挂载），.env 里只留开关和地址。
# ---------------------------------------------------------------------------

# 内置 base_url 只是省掉常见上游的手输。其它上游必须显式给 -ModelBaseUrl：
# 猜错 base_url 等于把密钥发到一个我们没验证过的域名，宁可报错退出。
#
# 这些值抄的是 DSH 内置模型目录（pi-ai catalog）里同名 provider 的 base_url，版本段
# （/v1、/v1beta 等）必须留在这里：DSH 侧填的是 <代理>/u/<上游名>，客户端 SDK 只会往后
# 接 /chat/completions、/responses、/v1/messages、/models/... 这类相对路径。名字与目录
# 对上还有一个好处：写 settings.yaml 时能直接沿用目录里的整份模型清单。
function Get-ModelDefaultBaseUrl {
    param([string]$Name)
    switch ($Name) {
        'deepseek' { return 'https://api.deepseek.com' }
        'openai' { return 'https://api.openai.com/v1' }
        'anthropic' { return 'https://api.anthropic.com' }
        'google' { return 'https://generativelanguage.googleapis.com/v1beta' }
        'nvidia' { return 'https://integrate.api.nvidia.com/v1' }
        'openrouter' { return 'https://openrouter.ai/api/v1' }
        'groq' { return 'https://api.groq.com/openai/v1' }
        'xai' { return 'https://api.x.ai/v1' }
        'moonshotai' { return 'https://api.moonshot.ai/v1' }
        'together' { return 'https://api.together.ai/v1' }
        'cerebras' { return 'https://api.cerebras.ai/v1' }
        'mistral' { return 'https://api.mistral.ai' }
        'zai' { return 'https://api.z.ai/api/coding/paas/v4' }
    }
    return ''
}

# 这里只挡明显写错的（明文、内嵌凭据、带 query）。严格校验在 broker 的
# parseBrokerConfig 里，配置写错它会直接拒绝启动，所以早报错比晚报错好。
function Test-UpstreamBaseUrl {
    param([string]$Url)
    if ($Url -notmatch '^https://.+') { throw "base_url 必须使用 https（密钥不能走明文）：$Url" }
    if ($Url -match '[?#]') { throw "base_url 不允许带 query 或 fragment：$Url" }
    if ($Url -match '@') { throw "base_url 不允许内嵌凭据：$Url" }
}

# 优先级：显式传入 > -ModelBaseUrl > 内置默认表 > 报错。
function Resolve-UpstreamBaseUrl {
    param([string]$Name, [string]$Explicit, [hashtable]$Overrides)
    $url = ''
    if ($Explicit) { $url = $Explicit }
    elseif ($Overrides -and $Overrides.ContainsKey($Name)) { $url = $Overrides[$Name] }
    else { $url = Get-ModelDefaultBaseUrl $Name }
    if (-not $url) { throw "上游 $Name 没有内置 base_url，请显式指定：-ModelBaseUrl $Name=https://..." }
    Test-UpstreamBaseUrl $url
    return $url
}

# API 形态（profile）→ 认证头与放行的路径前缀。口径必须和 install.sh 的
# broker_profile_* 完全一致，否则两个平台会写出不同的 keys.json。
function Get-BrokerProfileHeaderName {
    param([string]$Profile)
    switch ($Profile) {
        'messages' { return 'x-api-key' }
        'gemini' { return 'x-goog-api-key' }
        default { return 'authorization' }
    }
}

function Get-BrokerProfileHeaderTemplate {
    param([string]$Profile)
    if ($Profile -in @('messages','gemini')) { return '{key}' }
    return 'Bearer {key}'
}

# 收窄到这个形态真正会用到的端点。代理本来就默认拒绝名单外的路径，选形态只是再紧一层。
function Get-BrokerProfilePath {
    param([string]$Profile)
    switch ($Profile) {
        'chat' { return @('/v1/chat/completions','/chat/completions','/v1/models','/models') }
        'responses' { return @('/v1/responses','/responses','/v1/models','/models') }
        'messages' { return @('/v1/messages','/messages','/v1/models','/models') }
        'gemini' { return @('/models','/v1beta/models') }
        default { return @() }
    }
}

# Anthropic 缺 anthropic-version 会被上游直接 400，所以这个头跟着形态一起给。
function Get-BrokerProfileHeader {
    param([string]$Profile)
    if ($Profile -eq 'messages') { return [ordered]@{ 'anthropic-version' = '2023-06-01' } }
    return [ordered]@{}
}

# 没显式选形态时按上游名猜一个。猜错也只是路径前缀宽一点，不会写错认证头。
function Get-BrokerDefaultProfile {
    param([string]$Name)
    switch ($Name) {
        'anthropic' { return 'messages' }
        'claude' { return 'messages' }
        'gemini' { return 'gemini' }
        'google' { return 'gemini' }
        'googleai' { return 'gemini' }
        default { return 'any' }
    }
}

function Test-BrokerProfile {
    param([string]$Profile)
    if ($Profile -notin @('any','chat','responses','messages','gemini')) {
        throw "未知的 API 形态：$Profile（可选 any、chat、responses、messages、gemini）"
    }
}

# 认证头由 profile 决定，而客户端自带的认证材料会被 broker 剥掉。额外请求头因此不允许
# 覆盖这些名字：那等于让一份配置悄悄绕过密钥注入。逐跳头也拦掉，转发时它们本来就会被丢。
$BrokerForbiddenHeaders = @(
    'authorization','proxy-authorization','api-key','x-api-key','x-goog-api-key','x-auth-token',
    'cookie','set-cookie','host','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto',
    'x-real-ip','content-length','connection','keep-alive','transfer-encoding','upgrade','te','trailer'
)

# 返回归一化后的 name=value；调用方自己决定是报错还是重问。
function Format-BrokerHeader {
    param([string]$Spec)
    if ($Spec -notmatch '^[^=]+=.+$') { throw "请求头需要 name=value 格式，两边都不能为空：$Spec" }
    $headerName = ($Spec -replace '=.*$','').ToLowerInvariant()
    $headerValue = $Spec -replace '^[^=]+=',''
    if ($headerName -notmatch '^[a-z0-9][a-z0-9-]*$') { throw "不是合法的 HTTP 头名：$headerName" }
    if ($headerName -in $BrokerForbiddenHeaders) { throw "请求头 $headerName 由密钥代理自己管理，不能在这里覆盖。" }
    return "$headerName=$headerValue"
}

# -ModelApi / -ModelHeader 的解析。参数校验单独做一遍，否则报错时机取决于上游出现的
# 顺序，很难看懂；查询时按上游名小写匹配，和 keys.json 的命名规则一致。
function Test-ModelSpecFormat {
    foreach ($spec in @($script:ModelApi)) {
        if ($spec -notmatch '^[^=]+=.+$') { throw '-ModelApi 需要 NAME=PROFILE 格式。' }
        Test-BrokerProfile (($spec -replace '^[^=]+=','').ToLowerInvariant())
    }
    foreach ($spec in @($script:ModelHeader)) {
        if ($spec -notmatch '^[^=]+=[^=]+=.+$') { throw '-ModelHeader 需要 NAME=HEADER=VALUE 格式。' }
        Format-BrokerHeader ($spec -replace '^[^=]+=','') | Out-Null
    }
    foreach ($spec in @($script:ModelId)) {
        if ($spec -notmatch '^[^=]+=.+$') { throw '-ModelId 需要 NAME=ID 格式（多个 id 用逗号分隔）。' }
    }
}

# 同一个上游可以给多条 -ModelId，也可以在一条里用逗号分隔，最后合成一条逗号分隔串。
function Get-ModelIdOverride {
    param([string]$Name)
    $ids = @()
    foreach ($spec in @($script:ModelId)) {
        if (($spec -replace '=.*$','').ToLowerInvariant() -ne $Name) { continue }
        $ids += ($spec -replace '^[^=]+=','')
    }
    return ($ids -join ',')
}

function Get-ModelApiOverride {
    param([string]$Name)
    foreach ($spec in @($script:ModelApi)) {
        if (($spec -replace '=.*$','').ToLowerInvariant() -eq $Name) {
            return ($spec -replace '^[^=]+=','').ToLowerInvariant()
        }
    }
    return ''
}

# 同一个上游可以给多条 -ModelHeader，逗号运算符保证只有一条时也返回数组。
function Get-ModelHeaderOverrides {
    param([string]$Name)
    $pairs = @()
    foreach ($spec in @($script:ModelHeader)) {
        if (($spec -replace '=.*$','').ToLowerInvariant() -ne $Name) { continue }
        $pairs += (Format-BrokerHeader ($spec -replace '^[^=]+=',''))
    }
    return ,$pairs
}

# -ModelApi / -ModelHeader 挂在一个没给密钥的上游名上时静默丢掉最难查，所以点出来。
function Show-UnmatchedModelSpecWarning {
    foreach ($spec in @(@($script:ModelApi) + @($script:ModelHeader) + @($script:ModelId))) {
        if (-not $spec) { continue }
        $specName = ($spec -replace '=.*$','').ToLowerInvariant()
        if (@($BrokerUpstreams | Where-Object { $_.name -eq $specName }).Count -gt 0) { continue }
        Write-Host "[警告] 没有名为 $specName 的上游，对应的 -ModelApi / -ModelHeader / -ModelId 不会生效。" -ForegroundColor Yellow
    }
}

# 上游的 API 形态：内存里没有这个上游时（例如选了「保留现有配置」，名字是从 keys.json
# 里捞的）退回 any——那只影响端点收窄的宽窄，不影响认证头写对写错。
function Get-BrokerUpstreamProfile {
    param([string]$Name)
    if ($BrokerProfiles.ContainsKey($Name)) { return $BrokerProfiles[$Name] }
    return 'any'
}

function Add-BrokerUpstream {
    param(
        [string]$Name, [string]$BaseUrl, [string]$Key,
        [int]$RequestsPerMinute = 0, [int]$DailyRequestBudget = 0,
        [string]$ApiProfile = '', [string[]]$ExtraHeader = @(), [string]$ModelIds = ''
    )
    $normalized = $Name.ToLowerInvariant()
    # 规则不能比 DSH 自己宽：官方「添加自定义提供方」用 ^[a-z][a-z0-9]*(-[a-z0-9]+)*$，
    # 首字符必须是小写字母（凭据引用名是 POSIX 标识符，不能以数字开头）。
    if ($normalized -notmatch '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' -or $normalized.Length -gt 32) {
        throw "上游名字要以小写字母开头，之后只能是小写字母、数字和单个短横线，最多 32 个字符：$normalized"
    }
    if (-not $Key) { throw "上游 $normalized 的密钥为空。" }
    if (-not $ApiProfile) { $ApiProfile = Get-BrokerDefaultProfile $normalized }
    Test-BrokerProfile $ApiProfile
    $entry = [ordered]@{ name = $normalized; baseUrl = $BaseUrl; key = $Key }
    # 只有偏离 broker 默认值时才写出来：把默认值抄进配置只会在 broker 改默认值之后
    # 变成静默的行为分叉。
    $headerName = Get-BrokerProfileHeaderName $ApiProfile
    $headerTemplate = Get-BrokerProfileHeaderTemplate $ApiProfile
    if ($headerName -ne 'authorization' -or $headerTemplate -ne 'Bearer {key}') {
        $entry['headerName'] = $headerName
        $entry['headerTemplate'] = $headerTemplate
    }
    $profilePaths = @(Get-BrokerProfilePath $ApiProfile)
    if ($profilePaths.Count -gt 0) { $entry['allowedPathPrefixes'] = $profilePaths }
    # 形态自带的头（例如 anthropic-version）在前，用户自己填的在后：同名时以用户的为准。
    $headers = Get-BrokerProfileHeader $ApiProfile
    foreach ($spec in @($ExtraHeader)) {
        if (-not $spec) { continue }
        $pair = Format-BrokerHeader $spec
        $headers[($pair -replace '=.*$','')] = ($pair -replace '^[^=]+=','')
    }
    if ($headers.Count -gt 0) { $entry['extraHeaders'] = $headers }
    $BrokerProfiles[$normalized] = $ApiProfile
    $BrokerModels[$normalized] = $ModelIds
    # dsh 这个字段 broker 自己会忽略（它的解析器丢掉未知字段），存的是"DSH 侧要怎么填"：
    # 形态和模型清单。不写的话密钥管理面板打开这条上游时看到的是空清单，用户会以为
    # 安装时填的东西丢了，一保存还会把已经问到的模型清单覆盖掉。
    $entry['dsh'] = [ordered]@{
        api = $ApiProfile
        models = @(($ModelIds -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
    # 可选字段能省就省：把 broker 的默认值抄一份进 keys.json，只会在 broker 改默认值之后
    # 变成静默的行为分叉，也让人更难看出哪些限制是自己真的设过的。
    if ($RequestsPerMinute -gt 0) { $entry['requestsPerMinute'] = $RequestsPerMinute }
    if ($DailyRequestBudget -gt 0) { $entry['dailyRequestBudget'] = $DailyRequestBudget }
    # 同名上游以最后一次为准，和 keys.json 的合并语义保持一致。
    foreach ($item in @($BrokerUpstreams | Where-Object { $_.name -eq $normalized })) { $BrokerUpstreams.Remove($item) | Out-Null }
    $BrokerUpstreams.Add($entry) | Out-Null
}

# Windows 上没有 UID 概念，Docker Desktop 的绑定挂载也不按宿主属主映射，所以这里做不了
# install.sh 的 chown 1000:1000；能做的是把宿主侧的可读范围收到当前用户，失败只警告。
function Protect-BrokerConfigFile {
    param([string]$Path)
    try {
        $acl = Get-Acl -LiteralPath $Path
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')))
        Set-Acl -LiteralPath $Path -AclObject $acl
    } catch {
        Write-Host "[警告] 无法收紧 $Path 的 ACL：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# 把"该在 DSH 里怎么填"从摘要变成实际配置。口径与 install.sh 的 seed_dsh_model_settings
# 完全一致：写 data\dsh\settings.yaml 的 llm-pi-ai.providers 与 agent-default-model，
# 以及 data\dsh\.credentials.yaml 的 refs（只放占位串）。合并交给镜像里的 node——
# 那里才有 yaml 库（改 YAML 要保住用户已有的注释和配置）和 DSH 内置模型目录。
function Invoke-DshModelSettingsSeed {
    param([string]$Image, [string]$BrokerConfig, [bool]$Enabled)
    if ($NoModelSettingsSeed) {
        Write-Host '==> 已跳过写入 DSH 模型配置（-NoModelSettingsSeed）：供应商与模型请在 WebUI 里自己加。' -ForegroundColor Yellow
        return
    }
    if (-not $Enabled) { return }
    $names = @(Get-BrokerUpstreamNames $BrokerConfig)
    if ($names.Count -eq 0) { return }
    if (-not $Image) {
        Write-Host '[警告] 不知道该用哪个镜像来写 DSH 模型配置，已跳过。' -ForegroundColor Yellow
        return
    }
    # model-key 只检查工程存在、不同步源码，所以老部署的工程目录里可能还没有这个脚本。
    if (-not (Test-Path -LiteralPath 'bin\seed-dsh-model-settings.mjs' -PathType Leaf)) {
        Write-Host '[警告] 工程目录里没有 bin\seed-dsh-model-settings.mjs，跳过写 DSH 模型配置。' -ForegroundColor Yellow
        Write-Host '       先更新工程文件（重新跑一次安装或 git pull），再执行 install.ps1 model-key。' -ForegroundColor Yellow
        return
    }
    $dshHomeDir = Join-Path (Get-Location) 'data\dsh'
    New-Item -ItemType Directory -Path $dshHomeDir -Force | Out-Null
    $upstreams = @()
    foreach ($name in $names) {
        $models = @()
        if ($BrokerModels.ContainsKey($name)) {
            $models = @(($BrokerModels[$name] -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        }
        $upstreams += [ordered]@{ name = $name; shape = (Get-BrokerUpstreamProfile $name); models = $models }
    }
    $payload = [ordered]@{
        brokerBase = $ModelBrokerBase
        placeholder = $ModelBrokerPlaceholderKey
        upstreams = $upstreams
    } | ConvertTo-Json -Depth 6 -Compress
    Write-Host '==> 正在把模型供应商写进 DSH 配置（data\dsh\settings.yaml）：' -ForegroundColor Yellow
    $seedScriptDir = Join-Path (Get-Location) 'bin'
    $previousOutputEncoding = $OutputEncoding
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    try {
        $payload | docker run --rm -i -v "${seedScriptDir}:/dsh-seed:ro" -v "${dshHomeDir}:/seed-home" `
            --entrypoint node $Image /dsh-seed/seed-dsh-model-settings.mjs --home /seed-home
    } finally { $OutputEncoding = $previousOutputEncoding }
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[警告] 没能替 DSH 写模型配置。WebUI 的「设置 → 模型」里可以自己加：' -ForegroundColor Yellow
        Write-Host "       base_url = $ModelBrokerBase/u/<上游名>，API 密钥填占位串 $ModelBrokerPlaceholderKey。" -ForegroundColor Yellow
    }
}

# 替"DSH 内置目录之外的上游"向上游问一次模型清单。
#
# 这一步不是省一次输入：DSH 对目录外的路由要求至少一个模型 id，缺了就拒绝整条路由，
# 而拒绝的表现是 WebUI 的模型页不多出卡片、也不报任何错。向导以前靠追问用户手写模型
# id 来避免它，但那是把上游文档的活推给了用户，跳过一次就装出一个"填了密钥却选不到
# 模型"的部署。密钥这时就在手上，直接问上游最省事；问不出来才提示手动补。
#
# 密钥全程走 stdin，不进任何进程的命令行（Windows 上 docker run 的参数同样会被别的
# 进程看到）。宿主没有 node 时借镜像里那个，和合并 keys.json 同一个理由。
function Invoke-BrokerModelDiscovery {
    param([string]$Image)
    if ($BrokerUpstreams.Count -eq 0) { return }
    $discoverScript = Join-Path (Get-Location) 'bin\discover-upstream-models.mjs'
    if (-not (Test-Path -LiteralPath $discoverScript -PathType Leaf)) { return }
    $pending = @()
    foreach ($entry in @($BrokerUpstreams)) {
        $name = [string]$entry.name
        if (Get-ModelDefaultBaseUrl $name) { continue }
        $models = ''
        if ($BrokerModels.ContainsKey($name)) { $models = [string]$BrokerModels[$name] }
        if ($models) { continue }
        $pending += [ordered]@{
            name = $name
            baseUrl = [string]$entry.baseUrl
            key = [string]$entry.key
            shape = (Get-BrokerUpstreamProfile $name)
        }
    }
    if ($pending.Count -eq 0) { return }
    Write-Host '==> 这些上游不在 DSH 内置模型目录里，正在向上游问它们的模型清单...' -ForegroundColor Yellow
    $payload = [ordered]@{ upstreams = $pending } | ConvertTo-Json -Depth 6 -Compress
    $binDir = Join-Path (Get-Location) 'bin'
    $previousOutputEncoding = $OutputEncoding
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $output = @()
    try {
        if (Get-Command node -ErrorAction SilentlyContinue) {
            $output = @($payload | & node $discoverScript 2>$null)
        } else {
            if (-not $Image) { $Image = $DefaultPrebuiltImage }
            $output = @($payload | docker run --rm -i -v "${binDir}:/dsh-bin:ro" `
                --entrypoint node $Image /dsh-bin/discover-upstream-models.mjs 2>$null)
        }
    } catch {
        Write-Host "[警告] 问模型清单时出错：$($_.Exception.Message)" -ForegroundColor Yellow
    } finally { $OutputEncoding = $previousOutputEncoding }
    $payload = $null
    foreach ($line in $output) {
        $parts = [string]$line -split "`t"
        if ($parts.Count -lt 3) { continue }
        $name = $parts[1]
        switch ($parts[0]) {
            'baseurl' {
                # base_url 少写一个 /v1 时，面板里"拉取模型列表"照样成功（它会同时试
                # /models 和 /v1/models），可 DSH 走代理发的请求全落在上游根路径上，
                # 换回来 403/404。所以这一项必须当场改掉，而不是只提示一句。
                if (-not $parts[2]) { continue }
                foreach ($entry in @($BrokerUpstreams | Where-Object { $_.name -eq $name })) {
                    $entry['baseUrl'] = $parts[2]
                }
                Write-Host "    ${name}：base_url 少了版本段，已改成 $($parts[2])（否则 DSH 发出的请求全会被上游拒掉）。"
            }
            'models' {
                if (-not $parts[2]) { continue }
                $BrokerModels[$name] = $parts[2]
                foreach ($entry in @($BrokerUpstreams | Where-Object { $_.name -eq $name })) {
                    $entry['dsh'] = [ordered]@{
                        api = (Get-BrokerUpstreamProfile $name)
                        models = @(($parts[2] -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
                    }
                }
                $count = @(($parts[2] -split ',') | Where-Object { $_ }).Count
                Write-Host "    ${name}：问到 $count 个模型 id，已写进 DSH 的模型清单。"
            }
            'failed' {
                Write-Host "[警告] 上游 $name 的模型清单问不出来：$($parts[2])" -ForegroundColor Yellow
                Write-Host '       DSH 要求内置目录之外的上游至少有一个模型 id，所以它暂时不会出现在' -ForegroundColor Yellow
                Write-Host '       「设置 → 模型」里。装完在密钥管理面板的"模型清单"里手写一个再保存即可。' -ForegroundColor Yellow
            }
        }
    }
}

function Write-BrokerConfig {
    param([string]$Path)
    if ($BrokerUpstreams.Count -eq 0) { return }
    $kept = @()
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        # 现有配置里可能还有这次没提到的上游，整体覆盖会把它们丢掉。
        $names = @($BrokerUpstreams | ForEach-Object { $_.name })
        $existing = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
        if ($existing.upstreams) { $kept = @($existing.upstreams | Where-Object { $_.name -notin $names }) }
        # 向导不问推理强度档位（那是密钥管理面板里的事），但重新配置同名上游时不能把它丢掉：
        # 没有 dsh.reasoningEfforts，DSH 的模型页就不显示推理强度菜单。
        foreach ($entry in @($BrokerUpstreams)) {
            if (-not $entry['dsh'] -or $entry['dsh'].Contains('reasoningEfforts')) { continue }
            $before = @($existing.upstreams | Where-Object { $_.name -eq $entry.name }) | Select-Object -First 1
            $levels = @()
            if ($before -and $before.dsh -and $before.dsh.reasoningEfforts) { $levels = @($before.dsh.reasoningEfforts) }
            if ($levels.Count -gt 0) { $entry['dsh']['reasoningEfforts'] = $levels }
        }
    }
    $document = [ordered]@{ version = 1; upstreams = @($kept + @($BrokerUpstreams)) }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    $temporary = "$Path.tmp." + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($temporary, (($document | ConvertTo-Json -Depth 8) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Protect-BrokerConfigFile $temporary
    Move-Item -LiteralPath $temporary -Destination $Path -Force
    $BrokerUpstreams.Clear()
    Write-Host "==> 模型密钥已写入 $Path，未写入 .env。" -ForegroundColor Yellow
}

function Clear-BrokerConfig {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    # 只翻开关、把文件留在盘上等于密钥还在，所以关闭必须连密钥一起清掉。
    Remove-Item -LiteralPath $Path -Force
    Write-Host "==> 已删除 $Path（模型密钥代理已关闭）。" -ForegroundColor Yellow
}

function Import-ModelKeysFile {
    param([string]$Source, [string]$Path)
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "读不到 -ModelKeysFile 指定的文件：$Source" }
    $content = [IO.File]::ReadAllText($Source)
    # 只做最基本的形状检查：完整校验在 broker 的 parseBrokerConfig 里，写错了它会拒绝启动。
    if ($content -notmatch '"upstreams"') { throw "$Source 里没有 upstreams 字段，不像是 keys.json。" }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    $temporary = "$Path.tmp." + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($temporary, $content, (New-Object System.Text.UTF8Encoding($false)))
    Protect-BrokerConfigFile $temporary
    Move-Item -LiteralPath $temporary -Destination $Path -Force
    Write-Host "==> 已从 $Source 导入模型密钥配置。" -ForegroundColor Yellow
}

# 上游名字不是秘密，可以进摘要和日志；密钥永远不进。
function Get-BrokerUpstreamNames {
    param([string]$Path)
    if ($BrokerUpstreams.Count -gt 0) { return @($BrokerUpstreams | ForEach-Object { $_.name }) }
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        # 选了"保留现有配置"时内存里没有上游列表，只为摘要从文件里读一遍名字。
        try {
            $document = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
            if ($document.upstreams) { return @($document.upstreams | ForEach-Object { $_.name }) }
        } catch { }
    }
    return @()
}

# 交互式收集一个或多个上游。安装向导和 model-key 动作共用这一段：两处问答必须完全一致，
# 否则"装的时候跳过、之后再补"会变成两套语义。结果进 $BrokerUpstreams，是否启用由调用方
# 按它是否为空来决定。
#
# 密钥处直接回车是有效答案，不是输入错误：
#   - 还没填过任何上游 → 什么都不收集，调用方按"不启用"处理；
#   - 已经填过 → 只是不再加下一个，前面填好的保留。
function Read-BrokerUpstreams {
    $addMoreUpstreams = $true
    while ($addMoreUpstreams) {
        $upstreamName = ''
        while (-not $upstreamName) {
            $candidate = (Ask '上游名字（小写字母开头，只能用小写字母、数字和短横线）' 'deepseek').ToLowerInvariant()
            if ($candidate -match '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' -and $candidate.Length -le 32) { $upstreamName = $candidate }
            else { Write-Host '上游名字要以小写字母开头，之后只能是小写字母、数字和单个短横线，最多 32 个字符。' -ForegroundColor Red }
        }
        # base_url 内置表里有就不问：deepseek、openai、anthropic、google、nvidia 这些
        # 上游的地址不是用户该记的东西。表里没有才问，因为自建网关的地址无从猜测。
        $upstreamBase = Get-ModelDefaultBaseUrl $upstreamName
        if (-not $upstreamBase) {
            # 版本段是这里最常漏的一项，漏了就是上游 404，而那时候人已经在 WebUI 里找不到原因了。
            Write-Host ''
            Write-Host "$upstreamName 不在内置默认表里，base_url 照上游文档原样填，注意带上版本段："
            Write-Host '    OpenAI 兼容网关一般是 https://<域名>/v1，Anthropic 兼容的一般不带 /v1。'
            Write-Host '    这里填的是真实上游地址；DSH 容器那边填什么由安装器自己算。'
            while (-not $upstreamBase) {
                $candidate = Ask "$upstreamName 的 base_url" ''
                try { Test-UpstreamBaseUrl $candidate; $upstreamBase = $candidate }
                catch { Write-Host $_.Exception.Message -ForegroundColor Red }
            }
        }
        $upstreamKey = ''
        while (-not $upstreamKey) {
            $candidate = Ask-Secret "$upstreamName 的 API 密钥（不回显，留空 = 跳过）"
            if (-not $candidate) {
                if ($BrokerUpstreams.Count -gt 0) { Write-Host "已跳过 $upstreamName，前面填好的上游保留。" -ForegroundColor Yellow }
                return
            }
            if ($candidate -ne (Ask-Secret "再次输入 $upstreamName 的 API 密钥")) {
                Write-Host '两次输入不一致，请重试。' -ForegroundColor Red
                continue
            }
            $upstreamKey = $candidate
        }
        # 认证头形态、固定请求头、模型清单、限额都不在这里问：
        #   - 形态按上游名推断（Get-BrokerDefaultProfile），认证头因此不会写错；
        #   - 模型清单由 Invoke-BrokerModelDiscovery 向上游问，问不出来才需要人介入；
        #   - 这四样都能在密钥管理面板里改，而且它们都不是秘密，唯一必须在这里给的是密钥。
        # 命令行给过 -ModelApi / -ModelHeader / -ModelId 时沿用，不再重复追问。
        $upstreamProfile = Get-ModelApiOverride $upstreamName
        # 不能再套一层 @()：Get-ModelHeaderOverrides 已经用 ,$pairs 保住了数组，
        # 外面再包一次会变成"一个元素是数组的数组"，传给 [string[]] 参数时被拼成一整行。
        $upstreamHeaders = Get-ModelHeaderOverrides $upstreamName
        $upstreamModels = Get-ModelIdOverride $upstreamName
        Add-BrokerUpstream -Name $upstreamName -BaseUrl $upstreamBase -Key $upstreamKey `
            -ApiProfile $upstreamProfile -ExtraHeader $upstreamHeaders -ModelIds $upstreamModels
        $upstreamKey = $null
        $addMoreUpstreams = Ask-YesNo '再添加一个上游' $false
    }
}

# 跳过密钥代理时必须把代价讲清楚，而不是静默放过：不开代理就只剩"密钥写进容器"这一条路，
# 而容器里的 Agent 能读到它。同时给出补填的办法，否则用户只会以为要重装。
function Show-BrokerSkippedNotice {
    Write-Host '==> 本次不启用密钥代理。' -ForegroundColor Yellow
    Write-Host '    现在填密钥的地方就只有 DSH 的 WebUI，而 WebUI 跑在 DSH 容器里：填进去的密钥' -ForegroundColor Yellow
    Write-Host '    就落在容器内，容器里的 Agent（以及在容器内拿到 root 的人）一条 cat 就能读到。' -ForegroundColor Yellow
    Write-Host '    想改成真实密钥不进容器：在工程目录里执行 .\install.ps1 -DshAction model-key 补填，' -ForegroundColor Yellow
    Write-Host '    它只新增 dsh-key-broker 容器，不重建 dsh，容器里 apt 装过的东西不会丢。' -ForegroundColor Yellow
}

# 密钥代理的核验分两半，缺一半都不算通过：
#   1) broker 自己活着（/healthz 必须是 204）；
#   2) DSH 容器里的 /etc/dsh-broker 是空的——这是整个设计的前提，一旦那份配置被挂进了
#      Agent 能读的容器，密钥就等于没搬走，这时宁可让安装失败。
function Assert-ModelBroker {
    Write-Host '==> 正在核验模型密钥代理（dsh-key-broker）...' -ForegroundColor Yellow
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & docker exec dsh-key-broker node -e "fetch('http://127.0.0.1:8080/healthz').then((response) => process.exit(response.status === 204 ? 0 : 1)).catch(() => process.exit(1))" *> $null
        if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) { throw 'dsh-key-broker 未在 30 秒内让 /healthz 返回 204。查看原因：docker logs dsh-key-broker（配置写错时 broker 会拒绝启动）。' }
    Write-Host '==> 已核验 dsh-key-broker /healthz = 204' -ForegroundColor Green
    # /etc/dsh-broker 在镜像里就已经建好（broker 容器根文件系统是 read_only，只读挂载点
    # 必须预先存在），所以"目录存在"永远成立，不能当成失败信号。真正要拦的是里面出现了
    # 内容，判定口径与 bin/verify-dsh-hardening 的 check_broker_mount() 一致。
    $brokerEntries = @(& docker exec dsh sh -c 'ls -A /etc/dsh-broker 2>/dev/null' 2>$null | Where-Object { $_ -and $_.ToString().Trim() })
    if ($brokerEntries.Count -gt 0) { throw 'DSH 容器里的 /etc/dsh-broker 不是空的：密钥配置被挂进了 Agent 可读的容器，密钥代理会完全失去意义。请检查 docker-compose.keys.yml 有没有被改过。' }
    Write-Host '==> 已核验 DSH 容器内 /etc/dsh-broker 为空（真实密钥不在 Agent 可达范围内）' -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 模型密钥管理面板（dsh-key-admin）
#
# 它补的是"密钥只能在安装向导里填"这个缺口。面板刻意不做进 DSH 自己的 WebUI：那个页面
# 跑在 dsh 容器里，填进去的密钥就落在 Agent 能读的地方。三条边界缺一条这个面板就成了
# 新的攻击面：
#   1. 面板只挂 dsh-admin 网络，dsh 容器不在其中，跨网桥流量被 Docker 自己拦掉；
#   2. 宿主端口默认只发布在 127.0.0.1：发布到 0.0.0.0 的话 dsh 容器能经网关回连；
#   3. 所有 /api 都要令牌，令牌写 data\broker\admin.token，不进 .env。
# ---------------------------------------------------------------------------

function Get-KeyAdminTokenFile { Join-Path (Get-Location) 'data\broker\admin.token' }

function Read-KeyAdminToken {
    $tokenFile = Get-KeyAdminTokenFile
    if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) { return '' }
    return ([IO.File]::ReadAllText($tokenFile)).Trim()
}

# 面板令牌。48 个十六进制字符（192 bit）。已有令牌就保留：重跑安装不该让人重新去翻一遍。
function Write-KeyAdminToken {
    param([bool]$Enabled)
    if (-not $Enabled) { return }
    $tokenFile = Get-KeyAdminTokenFile
    New-Item -ItemType Directory -Path (Split-Path -Parent $tokenFile) -Force | Out-Null
    if ((Test-Path -LiteralPath $tokenFile -PathType Leaf) -and (Get-Item -LiteralPath $tokenFile).Length -gt 0) {
        $script:KeyAdminTokenState = 'kept'
        return
    }
    $bytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    [IO.File]::WriteAllText($tokenFile, ($token + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Protect-BrokerConfigFile $tokenFile
    $script:KeyAdminTokenState = 'new'
    Write-Host '==> 已生成密钥管理面板令牌：data\broker\admin.token，未写入 .env。' -ForegroundColor Yellow
}

# 面板要能从零开始：容器先起来，第一把密钥在页面上填。broker 的挂载是一份文件，文件不
# 存在的话 Docker 会把挂载点建成目录，broker 直接启动失败，所以先落一份空的。空的
# upstreams 是合法状态：这时 broker 对每个 /u/ 请求都回 503。
function Initialize-BrokerConfigPlaceholder {
    param([string]$Path)
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and (Get-Item -LiteralPath $Path).Length -gt 0) { return }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    [IO.File]::WriteAllText($Path, "{`n  `"version`": 1,`n  `"upstreams`": []`n}`n", (New-Object System.Text.UTF8Encoding($false)))
    Protect-BrokerConfigFile $Path
    Write-Host '==> 已创建空的 data\broker\keys.json：密钥留到面板里填。' -ForegroundColor Yellow
}

function Resolve-KeyAdmin {
    param([string]$EnvFile, [bool]$BrokerOn, [bool]$Interactive)
    $value = Get-ComposeEnvValue $EnvFile 'DSH_KEY_ADMIN' 'off'
    if ($value -notin @('on','off')) { $value = 'off' }
    if ($script:KeyAdminOverride) { $value = $script:KeyAdminOverride }
    if (-not $script:KeyAdminBindHost) {
        $script:KeyAdminBindHost = if ($KeyAdminBind) { $KeyAdminBind } else { Get-ComposeEnvValue $EnvFile 'DSH_KEY_ADMIN_BIND_HOST' $DefaultKeyAdminBindHost }
    }
    if (-not $script:KeyAdminPortValue) {
        $script:KeyAdminPortValue = if ($KeyAdminPort) { $KeyAdminPort } else { Get-ComposeEnvValue $EnvFile 'DSH_KEY_ADMIN_HOST_PORT' $DefaultKeyAdminPort }
    }
    if ($script:KeyAdminPortValue -notmatch '^[0-9]+$') { throw "面板端口必须是数字：$($script:KeyAdminPortValue)" }
    if ([int]$script:KeyAdminPortValue -lt 1 -or [int]$script:KeyAdminPortValue -gt 65535) { throw "面板端口超出范围：$($script:KeyAdminPortValue)" }
    # 面板依附密钥代理：它改的就是 broker 那份 keys.json，broker 关着的话面板没有意义。
    if (-not $BrokerOn -or -not (Test-Path -LiteralPath 'docker-compose.keys-admin.yml' -PathType Leaf)) { return 'off' }
    if (-not $Interactive -or $script:KeyAdminOverride) { return $value }
    Write-Host '模型密钥管理面板：'
    Write-Host '    浏览器里填密钥、按上游拉一次模型列表、设固定请求头（originator / version /'
    Write-Host '    User-Agent 这些），保存后直接写进 DSH 的模型配置，不用再回终端。'
    Write-Host "    它是独立容器，默认只发布在 $($script:KeyAdminBindHost):$($script:KeyAdminPortValue)，"
    Write-Host '    dsh 容器连不到它；访问要一个令牌，令牌在 data\broker\admin.token。'
    if (Ask-YesNo '启用模型密钥管理面板' $true) { return 'on' }
    return 'off'
}

# 面板的核验分两半：它自己活着，以及 dsh 容器确实连不到它。第二条是整个隔离设计的前提
# ——面板持有全部真实密钥，Agent 一旦能打到它，密钥代理就白搭了。
function Assert-KeyAdmin {
    Write-Host '==> 正在核验模型密钥管理面板（dsh-key-admin）...' -ForegroundColor Yellow
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & docker exec dsh-key-admin node -e "fetch('http://127.0.0.1:8090/healthz').then((response) => process.exit(response.status === 204 ? 0 : 1)).catch(() => process.exit(1))" *> $null
        if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) { throw 'dsh-key-admin 未在 30 秒内让 /healthz 返回 204。查看原因：docker logs dsh-key-admin（读不到令牌时它会直接退出）。' }
    Write-Host '==> 已核验 dsh-key-admin /healthz = 204' -ForegroundColor Green
    & docker exec dsh node -e "const net = require('node:net'); const socket = net.connect(8090, 'dsh-key-admin'); socket.on('connect', () => { socket.destroy(); process.exit(0) }); socket.on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 4000)" *> $null
    if ($LASTEXITCODE -eq 0) { throw 'dsh 容器能连到 dsh-key-admin:8090：面板对 Agent 可达，真实密钥等于没有隔离。请检查 docker-compose.keys-admin.yml 的 networks 有没有被改过（面板只能在 dsh-admin 上）。' }
    Write-Host '==> 已核验 dsh 容器连不到 dsh-key-admin（面板不在 Agent 可达的网络里）' -ForegroundColor Green
    if ($script:KeyAdminBindHost -notin @('127.0.0.1','localhost','[::1]','::1')) {
        Write-Host "[警告] 面板发布在 $($script:KeyAdminBindHost)，不是回环地址：宿主网络上的人只要拿到令牌就能改密钥，dsh 容器也可能经宿主网关回连这个端口。远程使用请改回 127.0.0.1 并走 SSH 隧道。" -ForegroundColor Yellow
    }
}

# 令牌只在本次新生成时回显一次：已有令牌的部署重跑安装时把它再打一遍，等于把长期凭据
# 抄进终端记录和滚动缓冲区，没有任何必要。
function Show-KeyAdminAccess {
    param([bool]$Enabled)
    if (-not $Enabled) { return }
    Write-Host "模型密钥面板：http://$($script:KeyAdminBindHost):$($script:KeyAdminPortValue)/" -ForegroundColor Green
    $token = Read-KeyAdminToken
    if ($script:KeyAdminTokenState -eq 'new' -and $token) {
        Write-Host "  访问令牌：$token" -ForegroundColor Green
        Write-Host "  （只回显这一次；随时可以从 $(Get-KeyAdminTokenFile) 再取）" -ForegroundColor Green
    } else {
        Write-Host "  访问令牌：见 $(Get-KeyAdminTokenFile)" -ForegroundColor Green
    }
    if ($script:KeyAdminBindHost -in @('127.0.0.1','localhost','[::1]','::1')) {
        Write-Host "  远程访问：ssh -N -L $($script:KeyAdminPortValue):127.0.0.1:$($script:KeyAdminPortValue) <用户名@宿主地址>" -ForegroundColor Green
    }
}

function Assert-EgressIsolation {
    param([string]$ProbeHost)
    Write-Host '==> 正在核验出站白名单代理（dsh-egress）...' -ForegroundColor Yellow
    $payload = ''
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $payload = ((& docker exec dsh-egress node -e "fetch('http://127.0.0.1:3128/status').then(async (response) => { if (response.status !== 200) { process.exit(1) } process.stdout.write(await response.text()) }).catch(() => process.exit(1))" 2>$null) -join '')
        if ($LASTEXITCODE -eq 0 -and $payload -match '"status":"ok"') { break }
        $payload = ''
        Start-Sleep -Seconds 1
    }
    if (-not $payload) { throw 'dsh-egress 未在 30 秒内从 /status 返回可用的 JSON。查看原因：docker logs dsh-egress。' }
    Write-Host "==> 已核验 dsh-egress /status：$payload" -ForegroundColor Green
    # 隔离之后 dsh 自己不再发布端口，宿主的 3080 全靠 dsh-ingress 顶着，所以这一条必须
    # 单独探一次，否则"装完了但打不开"要等用户点链接时才发现。
    $listening = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & docker exec dsh-ingress node -e "const net = require('node:net'); const socket = net.connect(3080, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); process.exit(0) }); socket.on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 4000)" *> $null
        if ($LASTEXITCODE -eq 0) { $listening = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $listening) { throw 'dsh-ingress 的 3080 监听未在 30 秒内就绪，隔离模式下宿主入口会不通。查看原因：docker logs dsh-ingress。' }
    Write-Host '==> 已核验 dsh-ingress 容器内 3080 已监听' -ForegroundColor Green
    # 宿主侧只警告不失败：端口发布是否可达还取决于宿主防火墙和 Docker 的端口转发时序，
    # 那些都不是安装器能修的，容器内的监听才是它的责任范围。
    $probe = $ProbeHost.Trim('[', ']')
    $reachable = $false
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        $client = New-Object Net.Sockets.TcpClient
        try { if ($client.ConnectAsync($probe, 3080).Wait(2000)) { $reachable = $client.Connected } }
        catch { }
        finally { $client.Dispose() }
        if ($reachable) { break }
        Start-Sleep -Seconds 1
    }
    if ($reachable) { Write-Host "==> 已核验宿主 ${probe}:3080 可连接（由 dsh-ingress 发布）" -ForegroundColor Green }
    else { Write-Host "[警告] 宿主 ${probe}:3080 暂时连不上；请确认防火墙放行，并用 docker ps 确认 dsh-ingress 在运行。" -ForegroundColor Yellow }
}

# userns-remap 预检。Windows 上不做任何"检测式的成功"：Docker Desktop 的 Linux 引擎
# 跑在 WSL2 里，根本不支持 userns-remap（docker run --userns 只接受 host），在
# daemon.json 里写 userns-remap 也不会生效。假装成功只会给出虚假的安全感。
function Invoke-UsernsPreflight {
    Write-Host '==> user namespace remap 预检'
    Write-Host '    当前平台：Windows + Docker Desktop（Linux 引擎跑在 WSL2 里）'
    Write-Host '    结论：这台机器上无法启用 userns-remap。Docker Desktop 不支持它，docker run --userns'
    Write-Host '          只接受 host，往 daemon.json 里写 "userns-remap": "default" 也不会生效。'
    Write-Host '    要用上这一层纵深防御（容器 UID 0 在宿主上只是一个普通 subuid，逃逸出去也不是宿主'
    Write-Host '    root），需要把 DSH 部署到 Linux 宿主，并在那台机器上执行：'
    Write-Host '      ./install.sh --userns-preflight'
    Write-Host '    它会检测宿主是否已启用 userns-remap，取出 dockremap 的起始 subuid，并把绑定挂载'
    Write-Host '    目录的属主对齐到对应的宿主 UID（容器内改不了，CAP_CHOWN 只在本 namespace 内有效）。'
}

function Set-ComposeEnvValue {
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = if (Test-Path -LiteralPath $Path) { @([IO.File]::ReadAllLines($Path)) } else { @() }
    $pattern = '^\s*' + [regex]::Escape($Key) + '\s*='
    $found = $false
    $updated = @(foreach ($line in $lines) {
        if ($line -match $pattern) {
            if (-not $found) { $found = $true; "$Key=$Value" }
        } else { $line }
    })
    if (-not $found) { $updated += "$Key=$Value" }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, (($updated -join [Environment]::NewLine) + [Environment]::NewLine), $utf8NoBom)
}

function Remove-ComposeEnvValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $pattern = '^\s*' + [regex]::Escape($Key) + '\s*='
    $lines = @([IO.File]::ReadAllLines($Path) | Where-Object { $_ -notmatch $pattern })
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $content = if ($lines.Count) { ($lines -join [Environment]::NewLine) + [Environment]::NewLine } else { '' }
    [IO.File]::WriteAllText($Path, $content, $utf8NoBom)
}

function Get-ComposeEnvValue {
    param([string]$Path, [string]$Key, [string]$Fallback)
    if (-not (Test-Path -LiteralPath $Path)) { return $Fallback }
    $line = [IO.File]::ReadAllLines($Path) | Where-Object { $_ -match '^\s*' + [regex]::Escape($Key) + '\s*=' } | Select-Object -First 1
    if ($line) { return ($line -replace '^\s*[^=]+=', '') }
    return $Fallback
}

function Invoke-ComposeWithEnvFile {
    # FileArguments 单独收 -f：叠加文件由密钥代理和出站模式决定，必须紧跟在 compose
    # 后面，而调用方只关心自己那条子命令。
    param([string]$Path, [string[]]$Arguments, [string[]]$EnvironmentKeys, [string[]]$FileArguments = @())
    $previous = @{}
    foreach ($key in $EnvironmentKeys) {
        $previous[$key] = [pscustomobject]@{
            Exists = Test-Path -LiteralPath "Env:$key"
            Value = [Environment]::GetEnvironmentVariable($key, 'Process')
        }
        Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
    }
    try {
        & docker compose --env-file $Path @FileArguments @Arguments | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        foreach ($key in $EnvironmentKeys) {
            if ($previous[$key].Exists) { [Environment]::SetEnvironmentVariable($key, $previous[$key].Value, 'Process') }
            else { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
        }
    }
    return $exitCode
}

# DSH 必须以非 root 的 dsh 账户（UID 1000）运行；容器的能力集、no_new_privs、
# Docker socket 与 /proc 挂载状态再由容器内的自检脚本实际验证一遍。
function Assert-DshHardening {
    # /run/dsh.pid 由 dsh-supervisor 写入：第一行是 PID，第二行是进程启动时刻，
    # 所以只能取第一行，整读会拼出无效的 /proc 路径。
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $uid = (& docker exec dsh sh -c 'pid="$(sed -n 1p /run/dsh.pid 2>/dev/null)"; case "$pid" in ""|*[!0-9]*) exit 1 ;; esac; sed -n "s/^Uid:[[:space:]]*\([0-9]*\).*/\1/p" "/proc/$pid/status"' 2>$null | Select-Object -Last 1)
        if ($LASTEXITCODE -eq 0 -and $uid -match '^\d+$') {
            if ($uid.Trim() -ne '1000') {
                throw "DSH 进程 UID 核验失败：期望 1000（非特权 dsh 账户），实际为 $($uid.Trim())。"
            }
            Write-Host '==> 已核验 DSH 进程 UID：1000（dsh 账户）' -ForegroundColor Green
            Write-Host '==> 正在核验容器加固状态...' -ForegroundColor Yellow
            & docker exec dsh /usr/local/bin/verify-dsh-hardening | Out-Host
            if ($LASTEXITCODE -ne 0) { throw '容器加固自检未通过，请按上面的失败项排查后重试。' }
            return
        }
        Start-Sleep -Seconds 1
    }
    throw 'DSH 容器已创建，但无法在 120 秒内核验主进程 UID。'
}

function Ask {
    param([string]$Message, [string]$Default)
    $answer = Read-Host "$Message [$Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
}

# 允许留空的提问：回车返回空串，用来收「可选值」和「填到不想填为止」的循环。
# 与 Ask 的区别是空串是合法答案，所以不能回落到默认值。
function Ask-Optional {
    param([string]$Message, [string]$Default = '')
    $hint = if ($Default) { "[当前 $Default，回车表示清空]" } else { '（可留空）' }
    $answer = Read-Host "$Message$hint"
    if ($null -eq $answer) { return '' }
    return $answer.Trim()
}

function Ask-Secret {
    param([string]$Message)
    $secure = Read-Host $Message -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Ask-YesNo {
    param([string]$Message, [bool]$Default = $true)
    $hint = if ($Default) { 'Y/n' } else { 'y/N' }
    while ($true) {
        $answer = Read-Host "$Message [$hint]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
        if ($answer -match '^(y|yes)$') { return $true }
        if ($answer -match '^(n|no)$') { return $false }
    }
}

function Get-ProxyNetworkCandidates {
    $names = @(& docker network ls --format '{{.Name}}' 2>$null)
    return @($names | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notin @('bridge','host','none','dsh-private','dsh-docker_default') })
}

# Compose 从不代建 external 网络，它必须先存在。全新机器上反向代理面板往往还没部署，
# 所以交互模式下允许安装器现在就建好，之后再把反代容器接进同一网络。
function Assert-ExternalNetwork {
    param([string]$Name, [bool]$Interactive)
    # 已存在的网络一律照旧使用，避免改动老部署已经写进 .env 的配置。
    docker network inspect $Name *> $null
    if ($LASTEXITCODE -eq 0) { return }
    if ($Name -eq 'dsh-private') {
        throw "dsh-private 是 DSH 自己管理的内部网络名，不能当作外部网络。`n请填写反向代理容器所在的网络名，或换一个新名字（例如 dsh-proxy）。"
    }
    if ($Interactive -and (Ask-YesNo "外部 Docker 网络 $Name 还不存在，现在创建它" $true)) {
        & docker network create --label dsh.created-by=dsh-docker-installer $Name | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "创建 Docker 网络 $Name 失败。" }
        Write-Host "==> 已创建 Docker 网络 $Name。" -ForegroundColor Green
        Write-Host "    部署反向代理后执行：docker network connect $Name <反代容器名>"
        return
    }
    throw "外部 Docker 网络 $Name 不存在。`n创建：docker network create $Name`n接入反代：docker network connect $Name <反代容器名>"
}

function Get-DockerEngineOs {
    try {
        $engineOs = (& docker info --format '{{.OSType}}' 2>$null | Select-Object -Last 1)
        if ($LASTEXITCODE -eq 0 -and $engineOs) { return $engineOs.Trim().ToLowerInvariant() }
    } catch { }
    return $null
}

function Test-DshContainer {
    & docker container inspect dsh *> $null
    return ($LASTEXITCODE -eq 0)
}

# 需要"一个带 node 的镜像"时用哪个 tag。model-key 这条路径不重建 dsh，所以本次安装
# 并没有选过镜像；空字符串直接交给 docker run 只会得到 invalid reference format。
# 顺序：.env 里记着的 > 现有 dsh 容器实际在用的 > 预构建镜像。
function Get-NodeToolImage {
    param([string]$EnvFile)
    $image = Get-ComposeEnvValue $EnvFile 'DSH_IMAGE' ''
    if (-not $image) {
        $inspected = & docker container inspect dsh --format '{{.Config.Image}}' 2>$null
        if ($LASTEXITCODE -eq 0 -and $inspected) { $image = "$inspected".Trim() }
    }
    if (-not $image) { $image = $DefaultPrebuiltImage }
    return $image
}

function Confirm-DshDelete {
    if ($env:DSH_DELETE_CONFIRMED -eq '1') { return }
    if ($NonInteractive) { throw '删除是破坏性操作，需要交互确认；请不要使用 -NonInteractive。' }
    Write-Host "[警告] 将删除 dsh 容器、DSH 镜像（dsh:* 与 .env 记录的预构建引用）、本项目挂载和网络、全局 Docker 构建缓存，以及 $Dir。" -ForegroundColor Yellow
    $answer = Read-Host '请输入 DELETE 继续，其他输入取消'
    if ($answer -ne 'DELETE') { Write-Host '已取消。'; exit 0 }
}

# 当脚本自身位于将被删除的目录内时，先复制到临时目录并从副本继续，
# 同时把进程当前目录移出目标目录，避免脚本文件被删除或目录被占用。
function Invoke-DshDetachedDelete {
    param([string]$TargetDir)
    if ($env:DSH_DELETE_DETACHED -eq '1') { return $null }
    if (-not $PSCommandPath) { return $null }
    if (-not (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)) { return $null }
    if (-not (Test-Path -LiteralPath $TargetDir -PathType Container)) { return $null }
    $resolvedTarget = (Resolve-Path -LiteralPath $TargetDir).Path.TrimEnd('\')
    $selfDir = (Split-Path -Parent $PSCommandPath).TrimEnd('\')
    if (-not ($selfDir -eq $resolvedTarget -or $selfDir.StartsWith($resolvedTarget + '\', [StringComparison]::OrdinalIgnoreCase))) { return $null }
    $parentDir = Split-Path -Parent $resolvedTarget
    if ($parentDir -and (Test-Path -LiteralPath $parentDir -PathType Container)) {
        Set-Location -LiteralPath $parentDir
        [Environment]::CurrentDirectory = $parentDir
    }
    $tempScript = Join-Path ([IO.Path]::GetTempPath()) ('dsh-delete-{0}.ps1' -f [guid]::NewGuid().ToString('N'))
    Copy-Item -LiteralPath $PSCommandPath -Destination $tempScript -Force
    Write-Host "==> 删除脚本位于将被删除的目录内，已复制到 $tempScript 后从副本继续。" -ForegroundColor Yellow
    $hostExe = (Get-Process -Id $PID).Path
    if (-not $hostExe) { $hostExe = 'powershell.exe' }
    $exitCode = 0
    $env:DSH_DELETE_DETACHED = '1'
    $env:DSH_DELETE_CONFIRMED = '1'
    try {
        & $hostExe -NoProfile -ExecutionPolicy Bypass -File $tempScript -DshAction delete -Dir $resolvedTarget | Out-Host
        if ($null -ne $LASTEXITCODE) { $exitCode = $LASTEXITCODE }
    } finally {
        $env:DSH_DELETE_DETACHED = $null
        $env:DSH_DELETE_CONFIRMED = $null
        Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
    }
    return $exitCode
}

function Remove-DshProject {
    Confirm-DshDelete
    $projectName = 'dsh-docker'
    if (Test-DshContainer) {
        $detectedProject = (& docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' dsh 2>$null | Select-Object -Last 1)
        if ($detectedProject -and $detectedProject -ne '<no value>') { $projectName = $detectedProject.Trim() }
    }

    $resolvedDir = $null
    if (Test-Path -LiteralPath $Dir -PathType Container) {
        $resolvedDir = (Resolve-Path -LiteralPath $Dir).Path
        $composeFile = Join-Path $resolvedDir 'docker-compose.yml'
        # 当前版本的工程不再包含 docker-compose.system.yml；仅当目标目录是旧版安装
        # （曾把 /usr、/etc、/var 拆成 data/system 下的绑定卷）时才叠加它，以便清掉遗留卷。
        $systemFile = Join-Path $resolvedDir 'docker-compose.system.yml'
        if ((Test-Path -LiteralPath $composeFile -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $resolvedDir 'Dockerfile') -PathType Leaf)) {
            Push-Location $resolvedDir
            try {
                $composeArgs = @('-p',$projectName,'-f','docker-compose.yml')
                if (Test-Path -LiteralPath $systemFile -PathType Leaf) { $composeArgs += @('-f','docker-compose.system.yml') }
                # 密钥代理与出站隔离的叠加文件同样要带上，否则 down 看不到 dsh-key-broker /
                # dsh-egress / dsh-ingress 这几个服务，它们会连着 dsh-internal 网络一起留下来。
                # 老部署目录里没有这两个文件，所以必须逐个判断存在性。
                foreach ($overlay in @('docker-compose.keys.yml','docker-compose.keys-admin.yml','docker-compose.isolated.yml')) {
                    if (Test-Path -LiteralPath (Join-Path $resolvedDir $overlay) -PathType Leaf) { $composeArgs += @('-f',$overlay) }
                }
                & docker compose @composeArgs down --volumes --remove-orphans | Out-Host
            } finally { Pop-Location }
        }
    }

    $containerIds = @(& docker container ls -aq --filter "label=com.docker.compose.project=$projectName" 2>$null)
    # 兜底按名字删：叠加文件缺失、或者容器被手工从项目里摘掉时，标签过滤都找不到它们。
    foreach ($name in @('dsh','dsh-key-broker','dsh-key-admin','dsh-egress','dsh-ingress')) {
        $namedContainer = (& docker container inspect --format '{{.Id}}' $name 2>$null | Select-Object -Last 1)
        if ($namedContainer) { $containerIds += $namedContainer.Trim() }
    }
    foreach ($id in @($containerIds | Where-Object { $_ } | Sort-Object -Unique)) { & docker container rm -f $id *> $null }

    # 预构建安装用的引用不叫 dsh:*，而且多架构清单未必带上项目标签，所以要按
    # .env 里记录的引用精确删除一次。这里内联读取 .env，让删除流程不依赖
    # 向导前半部分的辅助函数。
    if ($resolvedDir) {
        $envPath = Join-Path $resolvedDir '.env'
        if (Test-Path -LiteralPath $envPath -PathType Leaf) {
            $imageLine = [IO.File]::ReadAllLines($envPath) | Where-Object { $_ -match '^\s*DSH_IMAGE\s*=' } | Select-Object -First 1
            $configuredImage = if ($imageLine) { ($imageLine -replace '^\s*[^=]+=', '').Trim() } else { '' }
            if ($configuredImage -and $configuredImage -ne 'dsh:local') { & docker image rm -f $configuredImage *> $null }
        }
    }
    $imageRefs = @(& docker image ls --format '{{.Repository}}:{{.Tag}}' --filter 'reference=dsh:*' 2>$null | Sort-Object -Unique)
    foreach ($ref in $imageRefs) { if ($ref) { & docker image rm -f $ref *> $null } }
    $imageIds = @(& docker image ls -q --filter "label=com.docker.compose.project=$projectName" 2>$null | Sort-Object -Unique)
    foreach ($id in $imageIds) { if ($id) { & docker image rm -f $id *> $null } }
    $imageIds = @(& docker image ls -q --filter 'label=org.opencontainers.image.title=dsh-docker' 2>$null | Sort-Object -Unique)
    foreach ($id in $imageIds) { if ($id) { & docker image rm -f $id *> $null } }

    $volumeIds = @(& docker volume ls -q --filter "label=com.docker.compose.project=$projectName" 2>$null)
    foreach ($id in $volumeIds) { if ($id) { & docker volume rm -f $id *> $null } }
    $networkIds = @(& docker network ls -q --filter "label=com.docker.compose.project=$projectName" 2>$null)
    foreach ($id in $networkIds) { if ($id) { & docker network rm $id *> $null } }
    $installerNetworks = @(& docker network ls -q --filter 'label=dsh.created-by=dsh-docker-installer' 2>$null)
    foreach ($id in $installerNetworks) {
        if (-not $id) { continue }
        # 只删安装器自己建的代理网络，且必须没有任何容器还接在上面。
        $attached = (& docker network inspect --format '{{ len .Containers }}' $id 2>$null | Select-Object -Last 1)
        if ($attached -and $attached.Trim() -eq '0') { & docker network rm $id *> $null }
    }
    foreach ($name in @('dsh-private','dsh-internal','dsh-admin')) {
        $defaultNetworkProject = (& docker network inspect --format '{{ index .Labels "com.docker.compose.project" }}' $name 2>$null | Select-Object -Last 1)
        if ($defaultNetworkProject -and $defaultNetworkProject.Trim() -eq $projectName) { & docker network rm $name *> $null }
    }
    & docker builder prune -af | Out-Host

    if ($resolvedDir) {
        $normalizedDir = $resolvedDir.TrimEnd('\')
        $root = [IO.Path]::GetPathRoot($resolvedDir).TrimEnd('\')
        $profile = [Environment]::GetFolderPath('UserProfile').TrimEnd('\')
        if ($normalizedDir -eq $root -or $normalizedDir -eq $profile) { throw "拒绝删除不安全的工程目录：$resolvedDir" }
        if ((Test-Path -LiteralPath (Join-Path $resolvedDir 'install.ps1') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $resolvedDir 'docker-compose.yml') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $resolvedDir 'Dockerfile') -PathType Leaf)) {
            $currentPath = (Get-Location).Path.TrimEnd('\')
            if ($currentPath -eq $normalizedDir -or $currentPath.StartsWith($normalizedDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
                Set-Location (Split-Path -Parent $resolvedDir)
            }
            # Windows 会锁定进程当前目录，Set-Location 不改变进程 cwd，这里显式移出目标目录。
            [Environment]::CurrentDirectory = (Get-Location).Path
            Remove-Item -LiteralPath $resolvedDir -Recurse -Force
        } else {
            Write-Host "==> $resolvedDir 不是可识别的 dsh-docker 工程，已保留。"
        }
    }
    Write-Host '==> DSH 删除完成。' -ForegroundColor Green
}

function Get-DockerDesktopExecutable {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    return $null
}

function Ensure-DockerEngine {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw '未检测到 Docker，请先安装 Docker Desktop。'
    }

    $engineOs = Get-DockerEngineOs
    if ($engineOs -eq 'linux') { return }
    if ($engineOs -eq 'windows') {
        throw 'DSH 需要 Linux 容器。请在 Docker Desktop 菜单中选择“Switch to Linux containers”后重试。'
    }

    Write-Host '==> Docker Desktop Linux Engine 未运行，正在启动...' -ForegroundColor Yellow
    $startRequested = $false
    try {
        & docker desktop start *> $null
        $startRequested = ($LASTEXITCODE -eq 0)
    } catch { }

    if (-not $startRequested) {
        $desktop = Get-DockerDesktopExecutable
        if ($desktop) {
            Start-Process -FilePath $desktop -WindowStyle Hidden
            $startRequested = $true
        } elseif (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue) {
            $startRequested = $true
        }
    }
    if (-not $startRequested) {
        throw '无法自动启动 Docker Desktop。请手动启动 Docker Desktop 后重试。'
    }

    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    $nextNotice = [DateTime]::UtcNow
    while ([DateTime]::UtcNow -lt $deadline) {
        $engineOs = Get-DockerEngineOs
        if ($engineOs -eq 'linux') {
            Write-Host '==> Docker Desktop Linux Engine 已就绪。' -ForegroundColor Green
            return
        }
        if ($engineOs -eq 'windows') {
            throw 'Docker Desktop 当前使用 Windows Containers。请切换到 Linux containers 后重试。'
        }
        if ([DateTime]::UtcNow -ge $nextNotice) {
            Write-Host '    等待 Docker Engine 就绪...'
            $nextNotice = [DateTime]::UtcNow.AddSeconds(10)
        }
        Start-Sleep -Seconds 2
    }
    throw 'Docker Desktop Linux Engine 在 3 分钟内未就绪。请打开 Docker Desktop 查看启动错误后重试。'
}

function Get-GitHubSshKeys {
    $userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $sshDir = Join-Path $userHome '.ssh'
    if (-not (Test-Path -LiteralPath $sshDir -PathType Container)) { return @() }

    $preferred = @('github', 'github_ed25519', 'id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa')
    $ignored = @('config', 'authorized_keys', 'known_hosts', 'known_hosts.old')
    $files = @(Get-ChildItem -LiteralPath $sshDir -File -Force -ErrorAction SilentlyContinue)
    $keys = [Collections.Generic.List[string]]::new()

    foreach ($name in $preferred) {
        $file = $files | Where-Object { $_.Name -eq $name } | Select-Object -First 1
        if ($file) { $keys.Add($file.FullName) }
    }
    foreach ($file in $files) {
        if ($ignored -contains $file.Name -or $file.Extension -eq '.pub' -or $keys -contains $file.FullName) { continue }
        try {
            $header = Get-Content -LiteralPath $file.FullName -TotalCount 1 -ErrorAction Stop
            if ($header -match 'BEGIN .* PRIVATE KEY') { $keys.Add($file.FullName) }
        } catch { }
    }
    return @($keys)
}

function Get-GitSshCommand {
    param([string]$Key)
    $command = 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new'
    if ($Key) { $command += " -i `"$Key`" -o IdentitiesOnly=yes" }
    return $command
}

function Invoke-WithGitSsh {
    param([string]$SshCommand, [scriptblock]$Operation)
    $previous = $env:GIT_SSH_COMMAND
    try {
        if ($SshCommand) { $env:GIT_SSH_COMMAND = $SshCommand }
        else { Remove-Item Env:GIT_SSH_COMMAND -ErrorAction SilentlyContinue }
        & $Operation | Out-Host
        return ($LASTEXITCODE -eq 0)
    } catch {
        Write-Warning "Git 调用失败：$($_.Exception.Message)"
        return $false
    } finally {
        if ($null -eq $previous) { Remove-Item Env:GIT_SSH_COMMAND -ErrorAction SilentlyContinue }
        else { $env:GIT_SSH_COMMAND = $previous }
    }
}

function Invoke-GitHubClone {
    param([string]$Destination)
    $attempts = [Collections.Generic.List[object]]::new()
    $attempts.Add([pscustomobject]@{ Label = 'HTTPS Git'; Url = $GitHubHttpsUrl; Ssh = $null })
    foreach ($key in Get-GitHubSshKeys) {
        $attempts.Add([pscustomobject]@{ Label = "SSH key $([IO.Path]::GetFileName($key))"; Url = $GitHubSshUrl; Ssh = (Get-GitSshCommand $key) })
    }
    $currentSsh = if ($env:GIT_SSH_COMMAND) { $env:GIT_SSH_COMMAND } else { Get-GitSshCommand '' }
    $attempts.Add([pscustomobject]@{ Label = 'SSH agent/config'; Url = $GitHubSshUrl; Ssh = $currentSsh })

    foreach ($attempt in $attempts) {
        Write-Host "==> 尝试通过 $($attempt.Label) 获取工程..." -ForegroundColor Yellow
        $ok = Invoke-WithGitSsh $attempt.Ssh { & git clone $attempt.Url $Destination }
        if ($ok) { return $true }
        if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue }
    }
    return $false
}

function Invoke-GitHubSshFetch {
    param([string]$Directory)
    foreach ($key in Get-GitHubSshKeys) {
        $ssh = Get-GitSshCommand $key
        $ok = Invoke-WithGitSsh $ssh { & git -C $Directory fetch origin main }
        if ($ok) { return $true }
    }
    $currentSsh = if ($env:GIT_SSH_COMMAND) { $env:GIT_SSH_COMMAND } else { Get-GitSshCommand '' }
    $ok = Invoke-WithGitSsh $currentSsh { & git -C $Directory fetch origin main }
    return $ok
}

function Fetch-ArchiveProject {
    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("dsh-docker-download-" + [guid]::NewGuid().ToString('N'))
    $zip = Join-Path $temporaryRoot 'source.zip'
    $extract = Join-Path $temporaryRoot 'extract'
    $targetExisted = Test-Path -LiteralPath $Dir
    try {
        New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
        Invoke-WebRequest -UseBasicParsing -Uri 'https://codeload.github.com/univers629/dsh-docker/zip/refs/heads/main' -OutFile $zip
        Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
        $source = Join-Path $extract 'dsh-docker-main'
        if (-not (Test-Path -LiteralPath (Join-Path $source 'docker-compose.yml'))) {
            throw '下载的工程压缩包结构不完整。'
        }
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
        Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Dir $_.Name) -Recurse -Force
        }
        Set-Content -LiteralPath (Join-Path $Dir '.dsh-docker-archive-source') -Value 'codeload.github.com' -Encoding utf8
    } catch {
        if (-not $targetExisted -and (Test-Path -LiteralPath $Dir)) {
            Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw "无法从 GitHub 下载 dsh-docker 工程：$($_.Exception.Message)"
    } finally {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Fetch-Project {
    if (-not (Test-Path $Dir)) {
        Write-Host '==> 正在获取工程文件...' -ForegroundColor Yellow
        if ((Get-Command git -ErrorAction SilentlyContinue) -and (Invoke-GitHubClone $Dir)) {
            return
        }
        Write-Warning 'HTTPS 和 SSH Git 均失败，将改用 GitHub ZIP 下载。'
        Fetch-ArchiveProject
    } elseif (Test-Path (Join-Path $Dir '.git')) {
        Write-Host '==> 正在同步工程文件...' -ForegroundColor Yellow
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '已有 Git 工程但未检测到 Git。' }
        git -C $Dir diff --quiet; if ($LASTEXITCODE -ne 0) { throw "$Dir 存在未提交修改。" }
        git -C $Dir diff --cached --quiet; if ($LASTEXITCODE -ne 0) { throw "$Dir 存在已暂存修改。" }
        $origin = ((git -C $Dir remote get-url origin 2>$null) | Select-Object -First 1)
        $origin = if ($origin) { $origin.Trim() } else { '' }
        $officialOrigin = $origin -match 'github\.com(?::|/)univers629/dsh-docker(?:\.git)?/?$'
        if ($officialOrigin) {
            if ($origin -ne $GitHubHttpsUrl) {
                git -C $Dir remote set-url origin $GitHubHttpsUrl
                if ($LASTEXITCODE -ne 0) { throw '无法将官方远端切换为 HTTPS。' }
            }
            Write-Host '==> 尝试通过 HTTPS Git 更新工程...' -ForegroundColor Yellow
            $fetched = Invoke-WithGitSsh $null { & git -C $Dir fetch origin main }
            if (-not $fetched) {
                Write-Warning 'HTTPS Git 更新失败，将改用用户 SSH 密钥。'
                git -C $Dir remote set-url origin $GitHubSshUrl
                if ($LASTEXITCODE -eq 0) { $fetched = Invoke-GitHubSshFetch $Dir }
            }
        } else {
            $currentSsh = if ($env:GIT_SSH_COMMAND) { $env:GIT_SSH_COMMAND } else { $null }
            $fetched = Invoke-WithGitSsh $currentSsh { & git -C $Dir fetch origin main }
        }
        if (-not $fetched) { throw '无法通过 HTTPS 或 SSH 从 GitHub 获取最新工程文件。' }
        git -C $Dir merge --ff-only FETCH_HEAD
        if ($LASTEXITCODE -ne 0) { throw '本地工程无法 fast-forward 到 origin/main。' }
    } elseif (Test-Path (Join-Path $Dir '.dsh-docker-archive-source')) {
        Write-Host '==> 正在通过 GitHub ZIP 同步工程文件...' -ForegroundColor Yellow
        Fetch-ArchiveProject
    } else { throw "$Dir 已存在但不是 dsh-docker 工程。" }
}

Ensure-DockerEngine
# --userns-preflight 只做宿主检查，不该被"这次要做什么"的菜单挡住，也不需要工程目录。
if ($UsernsPreflight) {
    Invoke-UsernsPreflight
    exit 0
}

if (-not $DshAction -and $interactive) {
    $installLabel = if (Test-Path $Dir) { '重新配置并重建容器（保留挂载数据）' } else { '全新安装' }
    Write-Host "1) $installLabel`n2) 在容器内更新 DSH`n3) 启动`n4) 停止`n5) 重启`n6) 日志`n7) 状态`n8) 删除`n9) 补填模型 API 密钥（只新增密钥代理容器，不重建 dsh）`n10) 模型密钥管理面板（浏览器里填密钥、拉模型列表，不重建 dsh）"
    switch (Ask '这次要做什么' '1') {
        '1' { $DshAction = 'install' }; '2' { $DshAction = 'update' }; '3' { $DshAction = 'start' }; '4' { $DshAction = 'stop' }
        '5' { $DshAction = 'restart' }; '6' { $DshAction = 'logs' }; '7' { $DshAction = 'status' }; '8' { $DshAction = 'delete' }
        '9' { $DshAction = 'model-key' }
        '10' { $DshAction = 'key-panel' }
        default { throw '无效操作。' }
    }
} elseif (-not $DshAction) { $DshAction = 'install' }

if ($DshAction -eq 'delete') {
    if (-not (Test-Path -LiteralPath (Join-Path $Dir 'docker-compose.yml') -PathType Leaf) -and
        (Test-Path -LiteralPath 'docker-compose.yml' -PathType Leaf) -and
        (Test-Path -LiteralPath 'Dockerfile' -PathType Leaf) -and
        (Test-Path -LiteralPath 'install.ps1' -PathType Leaf)) {
        $Dir = (Get-Location).Path
    }
    Confirm-DshDelete
    $env:DSH_DELETE_CONFIRMED = '1'
    try {
        $detachedExit = Invoke-DshDetachedDelete -TargetDir $Dir
        if ($null -ne $detachedExit) { exit $detachedExit }
        Remove-DshProject
    } finally {
        $env:DSH_DELETE_CONFIRMED = $null
        $env:DSH_DELETE_DETACHED = $null
    }
    exit 0
}

if ($DshAction -in @('install','configure','update')) { Fetch-Project }
if (-not (Test-Path (Join-Path $Dir 'docker-compose.yml'))) { throw "未找到 $Dir 的 docker-compose.yml，工程获取失败。" }
Set-Location $Dir
if ($DshAction -in @('install','configure') -and (Test-DshContainer)) {
    throw "dsh 容器已经存在；为保护容器内 apt 软件和系统修改，安装器不会隐式重建它。`n使用 .\dsh.bat start|restart 管理现有容器；如需全新系统，请明确执行 .\dsh.bat remove 后再安装。"
}
$env:DOCKER_BUILDKIT = '1'; $env:COMPOSE_DOCKER_CLI_BUILD = '1'
$envFile = Join-Path (Get-Location) '.env'
$accessMode = if ($Access) { $Access } else { Get-ComposeEnvValue $envFile 'DSH_ACCESS_MODE' 'local' }
$bind = if ($BindHost) { $BindHost } else { Get-ComposeEnvValue $envFile 'DSH_BIND_HOST' '127.0.0.1' }
$trusted = if ($TrustedHosts) { $TrustedHosts } else { Get-ComposeEnvValue $envFile 'DSH_TRUSTED_HOSTS' '' }
$networkName = if ($Network) { $Network } else { Get-ComposeEnvValue $envFile 'DSH_DOCKER_NETWORK' 'dsh-private' }
$networkExternalValue = if ($NetworkExternal) { 'true' } elseif ($NetworkInternal) { 'false' } else { Get-ComposeEnvValue $envFile 'DSH_DOCKER_NETWORK_EXTERNAL' 'false' }
# 兼容旧配置：以前的向导会把 DSH 自管的 dsh-private 默认填成"外部网络"。
# 如果这个网络确实是 Compose 自己建的，就改回内部管理，避免安装器直接报错。
if ($networkName -eq 'dsh-private' -and $networkExternalValue -eq 'true' -and -not $NetworkExternal) {
    $legacyProject = (& docker network inspect --format '{{ index .Labels "com.docker.compose.project" }}' dsh-private 2>$null | Select-Object -Last 1)
    if ($legacyProject -and $legacyProject.Trim() -and $legacyProject.Trim() -ne '<no value>') {
        Write-Host '==> 旧配置把 dsh-private 记成了外部网络；已改回由 DSH 自己管理（网络名不变）。'
        $networkExternalValue = 'false'
    }
}
$imageSource = if ($ImageSource) { $ImageSource } else { Get-ComposeEnvValue $envFile 'DSH_IMAGE_SOURCE' 'prebuilt' }
if ($imageSource -notin @('prebuilt','build')) { $imageSource = 'prebuilt' }
$basicUser = $env:DSH_BASIC_AUTH_USER
$basicPassword = $env:DSH_BASIC_AUTH_PASSWORD
$writeBasicAuth = $false
$rootPassword = if ($RootPassword) { $RootPassword } else { $env:DSH_ROOT_PASSWORD }
$writeRootPassword = $false
$rootHashFile = Join-Path (Get-Location) 'data\secret\root.hash'
$brokerConfigFile = Join-Path (Get-Location) 'data\broker\keys.json'
$modelBroker = Get-ComposeEnvValue $envFile 'DSH_MODEL_BROKER' 'off'
if ($modelBroker -notin @('on','off')) { $modelBroker = 'off' }
$keyAdmin = 'off'
$egressMode = if ($Egress) { $Egress } else { Get-ComposeEnvValue $envFile 'DSH_EGRESS_MODE' 'open' }
if ($egressMode -notin @('open','allowlist')) { $egressMode = 'open' }
$egressAllowed = if ($EgressAllow.Count -gt 0) { ($EgressAllow -join ',') } else { Get-ComposeEnvValue $envFile 'DSH_EGRESS_ALLOWED_HOSTS' '' }

if ($DshAction -in @('install','configure')) {
    if ($interactive -and -not $ImageSource) {
        $imageDefault = if ($imageSource -eq 'build') { '2' } else { '1' }
        Write-Host 'Debian 13 镜像来源：1=拉取公开预构建镜像（推荐）  2=在本机构建镜像（不编译 DSH 源码，约几分钟）'
        $imageSource = switch (Ask '请选择' $imageDefault) { '2' {'build'}; default {'prebuilt'} }
    }
    if ($Image) { $imageRef = $Image }
    elseif ($imageSource -eq 'build') { $imageRef = $DefaultLocalImage }
    else {
        $imageRef = Get-ComposeEnvValue $envFile 'DSH_IMAGE' $DefaultPrebuiltImage
        # 旧安装的 .env 里记着本机构建的标签；切换到预构建时必须换成发布引用。
        if ($imageRef -eq $DefaultLocalImage) { $imageRef = $DefaultPrebuiltImage }
    }
    if ($interactive -and -not $Access) {
        $accessDefault = switch ($accessMode) { 'trusted-proxy' {'2'}; 'basic' {'3'}; default {'1'} }
        $accessMode = switch (Ask "访问保护：1=本机/SSH  2=已有 Access/面板  3=内置 Basic Auth" $accessDefault) { '2' {'trusted-proxy'}; '3' {'basic'}; default {'local'} }
    }
    if ($accessMode -eq 'local') { $bind = '127.0.0.1'; $trusted = ''; $networkName = 'dsh-private'; $networkExternalValue = 'false' }
    elseif ($interactive) {
        $trusted = Ask '公网域名或 trusted host（多个用逗号分隔）' $(if ($trusted) { $trusted } else { 'agent.example.com' })
        $defaultRoute = if ($networkExternalValue -eq 'true') { '2' } else { '1' }
        $proxyRoute = Ask '反向代理在哪里：1=宿主机 2=Docker 容器/面板' $defaultRoute
        if ($proxyRoute -eq '2') {
            docker network inspect dpanel-local *> $null
            $dpanelExists = $LASTEXITCODE -eq 0
            if (-not $Network) {
                $defaultNetwork = if ($networkName -eq 'dsh-private') { '' } else { $networkName }
                if (-not $defaultNetwork -and $dpanelExists) { $defaultNetwork = 'dpanel-local' }
                Write-Host '    DSH 会加入这个网络，反向代理用 http://dsh:3080 访问它。'
                if (-not $defaultNetwork) {
                    $candidates = Get-ProxyNetworkCandidates
                    if ($candidates.Count -gt 0) {
                        Write-Host "    宿主机现有的网络：$($candidates -join ' ')"
                        $defaultNetwork = $candidates[0]
                    } else {
                        Write-Host '    宿主机还没有可用网络：面板未部署时直接回车用 dsh-proxy，安装器会先征求同意再创建它。'
                        $defaultNetwork = 'dsh-proxy'
                    }
                }
                $networkName = Ask '反向代理所在的 Docker 网络' $defaultNetwork
            }
            $networkExternalValue = 'true'
        } else {
            $networkName = 'dsh-private'; $networkExternalValue = 'false'; $bind = '127.0.0.1'
        }
        $bind = Ask '宿主机端口绑定地址（推荐 127.0.0.1）' $bind
    }
    if ($bind -in @('0.0.0.0','::','[::]','*')) { throw '为避免绕过认证，不能使用通配绑定地址。' }
    if ($networkExternalValue -eq 'true') { Assert-ExternalNetwork -Name $networkName -Interactive:([bool]$interactive) }
    New-Item -ItemType Directory -Path (Join-Path (Get-Location) 'data\auth') -Force | Out-Null
    # data\secret 只存容器 root 口令哈希，容器里只挂到 dsh 账户进不去的 /root/dsh-secret。
    New-Item -ItemType Directory -Path (Join-Path (Get-Location) 'data\secret') -Force | Out-Null
    # data\broker 存模型密钥，只被 dsh-key-broker 容器只读挂载，不出现在 DSH 容器的挂载表里。
    New-Item -ItemType Directory -Path (Join-Path (Get-Location) 'data\broker') -Force | Out-Null
    $authFile = Join-Path (Get-Location) 'data\auth\htpasswd'
    $replaceAuth = -not (Test-Path $authFile)
    if ($accessMode -eq 'basic' -and $interactive -and -not $replaceAuth) { $replaceAuth = -not (Ask-YesNo '保留现有 Basic Auth 用户名和密码' $true) }
    if ($accessMode -eq 'basic' -and $replaceAuth) {
        if ($interactive) {
            $basicUser = Ask 'Basic Auth 用户名' $(if ($basicUser) { $basicUser } else { 'dsh' })
            do { $basicPassword = Ask-Secret 'Basic Auth 密码（至少 12 个字符）'; if ($basicPassword.Length -lt 12) { Write-Host '密码至少需要 12 个字符。' -ForegroundColor Red } } while ($basicPassword.Length -lt 12)
            do { $again = Ask-Secret '再次输入密码'; if ($again -ne $basicPassword) { Write-Host '两次密码不一致。' -ForegroundColor Red } } while ($again -ne $basicPassword)
        } elseif (-not $basicUser -or -not $basicPassword -or $basicPassword.Length -lt 12) {
            throw '非交互 Basic Auth 首次配置需要 DSH_BASIC_AUTH_USER 和至少 12 位的 DSH_BASIC_AUTH_PASSWORD。'
        }
        if ($basicUser -notmatch '^[A-Za-z0-9._-]+$') { throw 'Basic Auth 用户名包含不支持的字符。' }
        $writeBasicAuth = $true
    }
    # 容器 root 密码：降权后的 dsh 账户要执行任意特权命令必须提供它，校验走带失败
    # 锁定的特权代理。不设置就等于关掉这条提权路径，apt 与 DSH 更新仍然可用。
    if ($NoRootPassword) {
        $rootPassword = $null
        if (Test-Path -LiteralPath $rootHashFile) { Remove-Item -LiteralPath $rootHashFile -Force }
    } elseif ($rootPassword) {
        if ($rootPassword.Length -lt 12) { throw '容器 root 密码至少需要 12 个字符。' }
        $writeRootPassword = $true
    } elseif ($interactive) {
        $keepRootPassword = $false
        if (Test-Path -LiteralPath $rootHashFile) { $keepRootPassword = Ask-YesNo '保留现有的容器 root 密码' $true }
        if (-not $keepRootPassword) {
            Write-Host '容器 root 密码（用于容器内的特权命令：dsh-root run <命令> 或 sudo <命令>）：'
            Write-Host '    不设置也能用 apt 安装软件和更新 DSH，只是任意特权命令保持关闭。'
            if (Ask-YesNo '现在设置容器 root 密码' $true) {
                do { $rootPassword = Ask-Secret '容器 root 密码（至少 12 个字符）'; if ($rootPassword.Length -lt 12) { Write-Host '密码至少需要 12 个字符。' -ForegroundColor Red } } while ($rootPassword.Length -lt 12)
                do { $againRoot = Ask-Secret '再次输入容器 root 密码'; if ($againRoot -ne $rootPassword) { Write-Host '两次密码不一致。' -ForegroundColor Red } } while ($againRoot -ne $rootPassword)
                $writeRootPassword = $true
            } else {
                $rootPassword = $null
                if (Test-Path -LiteralPath $rootHashFile) { Remove-Item -LiteralPath $rootHashFile -Force }
            }
        }
    }

    # ---- 模型密钥代理 ----
    $baseUrlOverrides = @{}
    foreach ($spec in @($ModelBaseUrl)) {
        # 先统一检查格式，否则报错时机会取决于上游出现的顺序，很难看懂。
        if ($spec -notmatch '^[^=]+=.+$') { throw '-ModelBaseUrl 需要 NAME=URL 格式。' }
        $baseUrlOverrides[($spec -replace '=.*$','').ToLowerInvariant()] = ($spec -replace '^[^=]+=','')
    }
    Test-ModelSpecFormat
    if ($NoModelBroker) {
        $modelBroker = 'off'
        Clear-BrokerConfig $brokerConfigFile
    } else {
        if ($ModelKeysFile) {
            Import-ModelKeysFile $ModelKeysFile $brokerConfigFile
            $modelBroker = 'on'
        }
        foreach ($spec in @($ModelKey)) {
            # 报错文案里不能回显 spec：格式写错时它整体可能就是一段密钥。
            if ($spec -notmatch '^[^=]+=.+$') { throw '-ModelKey 需要 NAME=KEY 格式，且两边都不能为空。' }
            $upstreamName = ($spec -replace '=.*$','').ToLowerInvariant()
            Add-BrokerUpstream -Name $upstreamName -Key ($spec -replace '^[^=]+=','') `
                -BaseUrl (Resolve-UpstreamBaseUrl -Name $upstreamName -Explicit '' -Overrides $baseUrlOverrides) `
                -ApiProfile (Get-ModelApiOverride $upstreamName) -ExtraHeader (Get-ModelHeaderOverrides $upstreamName) `
                -ModelIds (Get-ModelIdOverride $upstreamName)
            $modelBroker = 'on'
        }
        if (@($ModelKey).Count -gt 0) { Show-UnmatchedModelSpecWarning }
        if (-not $interactive) {
            # 非交互的默认行为必须和以前完全一样：既没给密钥、盘上也没有配置，就保持 off，
            # 否则一条不带新参数的老安装命令会突然多起来一个容器。
            if ($BrokerUpstreams.Count -eq 0 -and -not (Test-Path -LiteralPath $brokerConfigFile -PathType Leaf)) { $modelBroker = 'off' }
            elseif (Test-Path -LiteralPath $brokerConfigFile -PathType Leaf) { $modelBroker = 'on' }
        } elseif ($BrokerUpstreams.Count -eq 0 -and -not $ModelKeysFile) {
            # 命令行已经把密钥给全了就不再追问：自动化和交互混用时不该被问答打断。
            Write-Host '模型 API 密钥放在哪里：'
            Write-Host '    DSH 容器里的 Agent 以 danger-full-access 运行。密钥放在那个容器里的话，提示注入'
            Write-Host '    根本不需要骗它说出来，一条 cat 就够了；容器内被拿到 root 也一样。'
            Write-Host "    开启后真实密钥只留在 data\broker\keys.json 和独立的 dsh-key-broker 容器里，"
            Write-Host "    DSH 容器只拿到占位密钥和 $ModelBrokerBase 这个地址。"
            Write-Host '    手上没有密钥就先跳过：下面回答 n，或在密钥那一步直接回车。装完之后随时可以用'
            Write-Host '    .\install.ps1 -DshAction model-key 补填，那条命令不重建 dsh，容器里 apt 装过的东西不会丢。'
            $keepBrokerConfig = $false
            if (Test-Path -LiteralPath $brokerConfigFile -PathType Leaf) { $keepBrokerConfig = Ask-YesNo '保留现有模型密钥配置' $true }
            if ($keepBrokerConfig) {
                $modelBroker = 'on'
                Write-Host '==> 保留 data\broker\keys.json，本次完全不改动其中的密钥。' -ForegroundColor Yellow
            } elseif (Ask-YesNo '把模型 API 密钥搬到独立的密钥代理容器' $true) {
                Read-BrokerUpstreams
                # 一个上游都没收集到（密钥处直接回车）就按"本次不启用"处理。以前这里是必填
                # 死循环，想先把环境装起来的人只能 Ctrl-C，反而更容易把安装打断在一半。
                if ($BrokerUpstreams.Count -eq 0) {
                    # 但"没在终端里填"不等于"不想要密钥代理"：先把代理和面板装上、keys.json 留空，
                    # 剩下的在浏览器里做，这样填错一个 base_url 也不必重跑一遍安装向导。
                    $offerPanel = (Test-Path -LiteralPath 'docker-compose.keys-admin.yml' -PathType Leaf) -and -not $KeyAdminOverride
                    $takePanel = $false
                    if ($offerPanel) {
                        Write-Host '终端里没填密钥。还有一种填法：'
                        Write-Host '    启用模型密钥管理面板，装完在浏览器里填密钥、按上游拉一次模型列表、设固定请求头，'
                        Write-Host '    保存后直接写进 DSH 的模型配置。面板是独立容器，dsh 容器连不到它。'
                        $takePanel = Ask-YesNo '现在不填密钥，装完在密钥管理面板里填' $true
                    }
                    if ($takePanel) {
                        $modelBroker = 'on'
                        # 置成 on 后 Resolve-KeyAdmin 会跳过重复提问，直接沿用这个决定。
                        $KeyAdminOverride = 'on'
                        Initialize-BrokerConfigPlaceholder $brokerConfigFile
                    } else {
                        $modelBroker = 'off'
                        Show-BrokerSkippedNotice
                    }
                }
            } else {
                $modelBroker = 'off'
                Show-BrokerSkippedNotice
            }
        }
    }

    # ---- 模型密钥管理面板 ----
    $keyAdmin = Resolve-KeyAdmin -EnvFile $envFile -BrokerOn ($modelBroker -eq 'on') -Interactive ([bool]$interactive)

    # ---- 出站模式 ----
    if ($interactive -and -not $Egress) {
        Write-Host '容器出站网络：'
        Write-Host '1) open（默认）：容器可访问任意外网地址。'
        Write-Host '2) allowlist：容器只能经 dsh-egress 代理出网，白名单外的域名返回 403。'
        Write-Host '    内置白名单：Debian、npm、PyPI、GitHub、ghcr.io、nodejs.org、astral.sh，'
        Write-Host '    足够 apt / pip / npm / git 正常工作；其他域名需要在下一问里补充。'
        Write-Host '    影响范围：Agent 访问白名单外的网页、搜索接口、第三方下载站会被拒绝。'
        Write-Host '    不受影响：模型请求（dsh-key-broker 独立出网）；宿主 3080 改由 dsh-ingress'
        Write-Host '    发布，反向代理仍写 http://dsh:3080。'
        $egressDefault = if ($egressMode -eq 'allowlist') { '2' } else { '1' }
        $egressMode = switch (Ask '请选择' $egressDefault) { '2' {'allowlist'}; default {'open'} }
    }
    if ($egressMode -eq 'allowlist' -and $interactive -and $EgressAllow.Count -eq 0) {
        Write-Host '    填写的域名会追加在内置白名单之后（内置的软件源始终放行），留空表示只用内置白名单。'
        Write-Host '    Agent 需要访问的网页或 API 域名也填在这里，例如 www.google.com,*.wikipedia.org。'
        $hint = if ($egressAllowed) { "[当前 $egressAllowed，回车表示清空]" } else { '（可留空）' }
        $egressAllowed = (Read-Host "额外放行的域名（逗号分隔，支持 *.example.com）$hint").Trim()
    }

    # 叠加顺序是契约的一部分，不能按别的顺序拼：keys.yml 先把 dsh-key-broker 放进
    # dsh-internal，isolated.yml 才能把 dsh 收进那张没有网关的网络而不切断模型请求。
    $composeFileArgs = @('-f','docker-compose.yml')
    if ($modelBroker -eq 'on') {
        if (-not (Test-Path -LiteralPath 'docker-compose.keys.yml' -PathType Leaf)) {
            throw '需要 docker-compose.keys.yml 才能启用模型密钥代理，但工程目录里没有它。请更新工程源码，或用 -NoModelBroker 关闭密钥代理。'
        }
        $composeFileArgs += @('-f','docker-compose.keys.yml')
        if ($keyAdmin -eq 'on') {
            if (-not (Test-Path -LiteralPath 'docker-compose.keys-admin.yml' -PathType Leaf)) {
                throw '需要 docker-compose.keys-admin.yml 才能启用密钥管理面板，但工程目录里没有它。请更新工程源码，或用 -NoKeyAdmin 关闭面板。'
            }
            $composeFileArgs += @('-f','docker-compose.keys-admin.yml')
        }
    } elseif ($keyAdmin -eq 'on') {
        Write-Host '[警告] 密钥代理关着，密钥管理面板不会启动（它管理的就是代理那份密钥配置）。' -ForegroundColor Yellow
        $keyAdmin = 'off'
    }
    if ($egressMode -eq 'allowlist') {
        if (-not (Test-Path -LiteralPath 'docker-compose.isolated.yml' -PathType Leaf)) {
            throw '需要 docker-compose.isolated.yml 才能启用出站白名单模式，但工程目录里没有它。请更新工程源码，或用 -Egress open 保持直连出网。'
        }
        $composeFileArgs += @('-f','docker-compose.isolated.yml')
    }
}

switch ($DshAction) {
    { $_ -in @('install','configure') } {
        # 预构建优先，但公网拉取可能因为网络或尚未发布而失败；这时退回本机构建，
        # 而不是让整次安装中断。回退发生在写入 .env 之前，所以配置不会记错来源。
        $env:DSH_IMAGE = $imageRef
        if ($imageSource -eq 'prebuilt') {
            Write-Host "==> 正在拉取预构建 Debian 13 镜像：$imageRef" -ForegroundColor Yellow
            # 拉取不经过 Compose：引用直接交给守护进程，插值出问题时也不会拉错镜像。
            docker pull $imageRef
            if ($LASTEXITCODE -ne 0) {
                Write-Host "[警告] 无法拉取 $imageRef，改为在本机构建镜像。" -ForegroundColor Yellow
                $imageSource = 'build'
                $imageRef = $DefaultLocalImage
                $env:DSH_IMAGE = $imageRef
            }
        }
        if ($imageSource -eq 'build') {
            Write-Host '==> 正在构建 DSH 镜像...' -ForegroundColor Yellow
            # 构建只需要基文件：只有 dsh 服务带 build 段，叠加文件里的三个旁路服务都直接
            # 复用 ${DSH_IMAGE}，不参与构建，所以这里不叠加 -f 与启动时并不矛盾。
            docker compose build dsh
            if ($LASTEXITCODE -ne 0) { throw 'DSH 镜像构建失败。' }
        }
        if ($accessMode -eq 'basic' -and $writeBasicAuth) {
            # Windows PowerShell 5.1 的 $OutputEncoding 默认是 ASCII，会把非 ASCII
            # 密码字符替换成 '?' 并生成错误的哈希，所以显式使用无 BOM 的 UTF-8。
            $previousOutputEncoding = $OutputEncoding
            $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
            try {
                $hashLine = $basicPassword | docker run --rm -i --entrypoint htpasswd $imageRef -niB $basicUser
            } finally { $OutputEncoding = $previousOutputEncoding }
            if ($LASTEXITCODE -ne 0) { throw 'Basic Auth bcrypt 哈希生成失败。' }
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [IO.File]::WriteAllText((Join-Path (Get-Location) 'data\auth\htpasswd'), (($hashLine -join [Environment]::NewLine) + [Environment]::NewLine), $utf8NoBom)
            $basicPassword = $null; $env:DSH_BASIC_AUTH_PASSWORD = $null
            Write-Host '==> Basic Auth 凭据已使用 bcrypt 哈希保存，未写入 .env。' -ForegroundColor Yellow
        }
        if ($writeRootPassword) {
            # 明文密码只经过一次管道交给容器里的 openssl；宿主机上只留 sha512crypt 哈希。
            $previousOutputEncoding = $OutputEncoding
            $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
            try {
                $rootHashLine = $rootPassword | docker run --rm -i --entrypoint /usr/local/bin/hash-dsh-password $imageRef
            } finally { $OutputEncoding = $previousOutputEncoding }
            if ($LASTEXITCODE -ne 0) { throw '容器 root 密码哈希生成失败。' }
            $rootHash = @($rootHashLine)[-1]
            if ($rootHash -notmatch '^\$6\$') { throw '容器 root 密码哈希格式异常，未写入。' }
            [IO.File]::WriteAllText($rootHashFile, ($rootHash + "`n"), (New-Object System.Text.UTF8Encoding($false)))
            $rootPassword = $null
            $env:DSH_ROOT_PASSWORD = $null
            Write-Host '==> 容器 root 密码已用 sha512crypt 哈希保存到 data\secret\root.hash，未写入 .env。' -ForegroundColor Yellow
        }
        Invoke-BrokerModelDiscovery -Image $imageRef
        Write-BrokerConfig $brokerConfigFile
        Write-KeyAdminToken ($keyAdmin -eq 'on')
        Invoke-DshModelSettingsSeed -Image $imageRef -BrokerConfig $brokerConfigFile -Enabled ($modelBroker -eq 'on')
        $pendingEnvFile = Join-Path (Get-Location) ('.env.pending.' + $PID + '.' + [guid]::NewGuid().ToString('N'))
        try {
            if (Test-Path -LiteralPath $envFile) { Copy-Item -LiteralPath $envFile -Destination $pendingEnvFile }
            else { [IO.File]::WriteAllText($pendingEnvFile, '', (New-Object System.Text.UTF8Encoding($false))) }
            Remove-ComposeEnvValue $pendingEnvFile 'DSH_RUN_AS_ROOT'
            Set-ComposeEnvValue $pendingEnvFile 'DSH_ACCESS_MODE' $accessMode
            Set-ComposeEnvValue $pendingEnvFile 'DSH_BIND_HOST' $bind
            Set-ComposeEnvValue $pendingEnvFile 'DSH_TRUSTED_HOSTS' $trusted
            Set-ComposeEnvValue $pendingEnvFile 'DSH_DOCKER_NETWORK' $networkName
            Set-ComposeEnvValue $pendingEnvFile 'DSH_DOCKER_NETWORK_EXTERNAL' $networkExternalValue
            Set-ComposeEnvValue $pendingEnvFile 'DSH_IMAGE' $imageRef
            Set-ComposeEnvValue $pendingEnvFile 'DSH_IMAGE_SOURCE' $imageSource
            # 这四个键只是开关和地址，真实密钥永远不进 .env。
            Set-ComposeEnvValue $pendingEnvFile 'DSH_MODEL_BROKER' $modelBroker
            Set-ComposeEnvValue $pendingEnvFile 'DSH_MODEL_BROKER_BASE' $ModelBrokerBase
            Set-ComposeEnvValue $pendingEnvFile 'DSH_KEY_ADMIN' $keyAdmin
            Set-ComposeEnvValue $pendingEnvFile 'DSH_KEY_ADMIN_BIND_HOST' $KeyAdminBindHost
            Set-ComposeEnvValue $pendingEnvFile 'DSH_KEY_ADMIN_HOST_PORT' $KeyAdminPortValue
            Set-ComposeEnvValue $pendingEnvFile 'DSH_EGRESS_MODE' $egressMode
            Set-ComposeEnvValue $pendingEnvFile 'DSH_EGRESS_ALLOWED_HOSTS' $egressAllowed
            $composeKeys = @('DSH_ACCESS_MODE','DSH_BIND_HOST','DSH_TRUSTED_HOSTS','DSH_DOCKER_NETWORK','DSH_DOCKER_NETWORK_EXTERNAL','DSH_IMAGE','DSH_IMAGE_SOURCE','DSH_MODEL_BROKER','DSH_MODEL_BROKER_BASE','DSH_KEY_ADMIN','DSH_KEY_ADMIN_BIND_HOST','DSH_KEY_ADMIN_HOST_PORT','DSH_EGRESS_MODE','DSH_EGRESS_ALLOWED_HOSTS')
            $composeExitCode = Invoke-ComposeWithEnvFile -Path $pendingEnvFile -Arguments @('up','-d','--no-build','--force-recreate') -EnvironmentKeys $composeKeys -FileArguments $composeFileArgs
            if ($composeExitCode -ne 0) { throw 'DSH 容器启动失败，原配置未被覆盖。' }
            Move-Item -LiteralPath $pendingEnvFile -Destination $envFile -Force
            $pendingEnvFile = $null
            Assert-DshHardening
            if ($modelBroker -eq 'on') { Assert-ModelBroker }
            if ($keyAdmin -eq 'on') { Assert-KeyAdmin }
            if ($egressMode -eq 'allowlist') { Assert-EgressIsolation -ProbeHost $bind }
        } finally {
            if ($pendingEnvFile -and (Test-Path -LiteralPath $pendingEnvFile)) {
                Remove-Item -LiteralPath $pendingEnvFile -Force -ErrorAction SilentlyContinue
            }
        }
    }
    'model-key' {
        # 给已经装好的部署补填模型密钥。单独做一个动作的理由：install/configure 见到 dsh
        # 容器存在就会直接拒绝执行（那是为了保护容器可写层里 apt 装的东西），而
        # docker-compose.keys.yml 只新增 dsh-key-broker、不改 dsh 服务的定义，所以补填
        # 密钥根本不需要重建 dsh。
        if ($NoModelBroker) { throw 'model-key 是补填密钥的动作，不能和 -NoModelBroker 一起用。' }
        if (-not (Test-Path -LiteralPath 'docker-compose.keys.yml' -PathType Leaf)) { throw '工程目录里没有 docker-compose.keys.yml，请先更新工程文件后重试。' }
        if (-not (Test-DshContainer)) { throw '还没有 dsh 容器，请先执行安装。' }
        $keyBaseOverrides = @{}
        foreach ($spec in @($ModelBaseUrl)) {
            if ($spec -notmatch '^[^=]+=.+$') { throw '-ModelBaseUrl 需要 NAME=URL 格式。' }
            $keyBaseOverrides[($spec -replace '=.*$','').ToLowerInvariant()] = ($spec -replace '^[^=]+=','')
        }
        Test-ModelSpecFormat
        if ($ModelKeysFile) { Import-ModelKeysFile $ModelKeysFile $brokerConfigFile }
        foreach ($spec in @($ModelKey)) {
            # 报错文案里不能回显 spec：格式写错时它整体可能就是一段密钥。
            if ($spec -notmatch '^[^=]+=.+$') { throw '-ModelKey 需要 NAME=KEY 格式，且两边都不能为空。' }
            $keyUpstreamName = ($spec -replace '=.*$','').ToLowerInvariant()
            Add-BrokerUpstream -Name $keyUpstreamName -Key ($spec -replace '^[^=]+=','') `
                -BaseUrl (Resolve-UpstreamBaseUrl -Name $keyUpstreamName -Explicit '' -Overrides $keyBaseOverrides) `
                -ApiProfile (Get-ModelApiOverride $keyUpstreamName) -ExtraHeader (Get-ModelHeaderOverrides $keyUpstreamName) `
                -ModelIds (Get-ModelIdOverride $keyUpstreamName)
        }
        if (@($ModelKey).Count -gt 0) { Show-UnmatchedModelSpecWarning }
        if ($BrokerUpstreams.Count -eq 0 -and -not $ModelKeysFile) {
            if (-not $interactive) { throw '非交互模式下 model-key 需要 -ModelKey NAME=KEY 或 -ModelKeysFile PATH。' }
            Write-Host '补填模型 API 密钥：'
            Write-Host "    真实密钥只会写进 $brokerConfigFile 与 dsh-key-broker 容器，"
            Write-Host "    DSH 容器只拿到占位密钥和 $ModelBrokerBase 这个地址。同名上游会被覆盖。"
            Read-BrokerUpstreams
            if ($BrokerUpstreams.Count -eq 0) {
                Write-Host '==> 没有填任何密钥，配置未改动。' -ForegroundColor Yellow
                break
            }
        }
        Invoke-BrokerModelDiscovery -Image (Get-NodeToolImage $envFile)
        Write-BrokerConfig $brokerConfigFile
        if (-not (Test-Path -LiteralPath $brokerConfigFile -PathType Leaf)) { throw "$brokerConfigFile 仍然不存在，.env 未改动。" }
        Set-ComposeEnvValue $envFile 'DSH_MODEL_BROKER' 'on'
        Set-ComposeEnvValue $envFile 'DSH_MODEL_BROKER_BASE' $ModelBrokerBase
        # 面板归 -DshAction key-panel 管，这里不追问；只沿用 .env 里已有的决定，让这次 start
        # 顺带把已经开着的面板带起来，并在后面把隔离再核验一遍。
        if (-not $KeyAdminOverride) {
            $KeyAdminOverride = if ((Get-ComposeEnvValue $envFile 'DSH_KEY_ADMIN' 'off') -eq 'on') { 'on' } else { 'off' }
        }
        $keyAdmin = Resolve-KeyAdmin -EnvFile $envFile -BrokerOn $true -Interactive $false
        Write-KeyAdminToken ($keyAdmin -eq 'on')
        Set-ComposeEnvValue $envFile 'DSH_KEY_ADMIN' $keyAdmin
        if ($keyAdmin -eq 'on') {
            Set-ComposeEnvValue $envFile 'DSH_KEY_ADMIN_BIND_HOST' $KeyAdminBindHost
            Set-ComposeEnvValue $envFile 'DSH_KEY_ADMIN_HOST_PORT' $KeyAdminPortValue
        }
        # 只叫 dsh.bat start：它按 .env 算出叠加文件，只把缺失的旁路容器 up 起来，不动 dsh。
        Write-Host '==> 正在启动 dsh-key-broker（不重建 dsh 容器）...' -ForegroundColor Yellow
        & .\dsh.bat start
        if ($LASTEXITCODE -ne 0) { throw '启动失败。密钥已写入 data\broker\keys.json，修好后可以重试。' }
        Assert-ModelBroker
        if ($keyAdmin -eq 'on') { Assert-KeyAdmin }
        Invoke-DshModelSettingsSeed -Image (Get-NodeToolImage $envFile) -BrokerConfig $brokerConfigFile -Enabled $true
        Write-Host '==> 密钥代理已就绪。DSH 的 settings.yaml 与 .credentials.yaml 都是热加载的，' -ForegroundColor Green
        Write-Host '    刷新一下 WebUI 就能在「设置 → 模型」里看到这些供应商，密钥框里是占位串。' -ForegroundColor Green
        Write-Host '    容器内那份 skill 文档上的 DSH_MODEL_BROKER 仍显示安装时的值，要等下次重建容器才会刷新——那只是说明文字，不影响代理生效。' -ForegroundColor Yellow
        Show-KeyAdminAccess ($keyAdmin -eq 'on')
    }
    'key-panel' {
        # 给已经装好的部署开或关模型密钥管理面板。和 model-key 同一个理由：
        # docker-compose.keys-admin.yml 只新增 dsh-key-admin 服务，完全不碰 dsh 服务的定义，
        # 所以不需要重建 dsh 容器，容器可写层里 apt 装过的东西不会丢。
        if (-not (Test-Path -LiteralPath 'docker-compose.keys-admin.yml' -PathType Leaf)) {
            throw '工程目录里没有 docker-compose.keys-admin.yml，请先更新工程文件后重试（在工程目录里 git pull，或重新跑一次安装命令选"重新配置"）。'
        }
        if (-not (Test-DshContainer)) { throw '还没有 dsh 容器，请先执行安装。' }
        if ($KeyAdminOverride -eq 'off') {
            Set-ComposeEnvValue $envFile 'DSH_KEY_ADMIN' 'off'
            Write-Host '==> 已在 .env 里关闭面板（DSH_KEY_ADMIN=off），正在移除 dsh-key-admin 容器...' -ForegroundColor Yellow
            docker rm -f dsh-key-admin *> $null
            Write-Host '==> 面板已关闭。datarokerkeys.json 与 admin.token 都保持原样，密钥不受影响。' -ForegroundColor Green
            break
        }
        if ($NoModelBroker) { throw '面板管理的就是密钥代理里的密钥，不能和 -NoModelBroker 一起用。' }
        # 面板离不开 broker：它写的那份 keys.json 就是 broker 的配置。broker 还没开就一起开，
        # keys.json 允许是空的（这时 broker 对每个 /u/ 请求回 503），第一把密钥在页面上填。
        Initialize-BrokerConfigPlaceholder $brokerConfigFile
        $KeyAdminOverride = 'on'
        $keyAdmin = Resolve-KeyAdmin -EnvFile $envFile -BrokerOn $true -Interactive $false
        if ($keyAdmin -ne 'on') { throw '无法启用面板，请检查上面的提示。' }
        Write-KeyAdminToken $true
        Set-ComposeEnvValue $envFile 'DSH_MODEL_BROKER' 'on'
        Set-ComposeEnvValue $envFile 'DSH_MODEL_BROKER_BASE' $ModelBrokerBase
        Set-ComposeEnvValue $envFile 'DSH_KEY_ADMIN' 'on'
        Set-ComposeEnvValue $envFile 'DSH_KEY_ADMIN_BIND_HOST' $KeyAdminBindHost
        Set-ComposeEnvValue $envFile 'DSH_KEY_ADMIN_HOST_PORT' $KeyAdminPortValue
        Write-Host '==> 正在启动 dsh-key-admin（不重建 dsh 容器）...' -ForegroundColor Yellow
        & .\dsh.bat start
        if ($LASTEXITCODE -ne 0) { throw '启动失败。.env 已更新，修好后可以重新执行 -DshAction key-panel。' }
        Assert-ModelBroker
        Assert-KeyAdmin
        Write-Host '==> 面板已就绪。在页面上保存上游后它会直接写 data\dsh\settings.yaml 与 .credentials.yaml，' -ForegroundColor Green
        Write-Host '    DSH 热加载这两份文件，刷新 WebUI 就能在「设置 → 模型」里选到。' -ForegroundColor Green
        Show-KeyAdminAccess $true
    }
    'update' { & .\dsh.bat update }
    'start' { & .\dsh.bat start }
    'stop' { & .\dsh.bat stop }
    'restart' { & .\dsh.bat restart }
    'logs' { & .\dsh.bat logs }
    'status' {
        # status 不走安装问答，内存里没有本次配置，所以叠加文件只能从已落盘的 .env 反推。
        # 不带这两个文件的话 dsh-key-broker / dsh-egress / dsh-ingress 不在本次 Compose
        # 文档里，ps 会把它们当孤儿容器直接忽略，看起来像是"旁路服务没起来"。
        $statusFileArgs = @('-f','docker-compose.yml')
        if ((Get-ComposeEnvValue '.env' 'DSH_MODEL_BROKER' 'off') -eq 'on' -and (Test-Path -LiteralPath 'docker-compose.keys.yml' -PathType Leaf)) {
            $statusFileArgs += @('-f','docker-compose.keys.yml')
            if ((Get-ComposeEnvValue '.env' 'DSH_KEY_ADMIN' 'off') -eq 'on' -and (Test-Path -LiteralPath 'docker-compose.keys-admin.yml' -PathType Leaf)) {
                $statusFileArgs += @('-f','docker-compose.keys-admin.yml')
            }
        }
        if ((Get-ComposeEnvValue '.env' 'DSH_EGRESS_MODE' 'open') -eq 'allowlist' -and (Test-Path -LiteralPath 'docker-compose.isolated.yml' -PathType Leaf)) {
            $statusFileArgs += @('-f','docker-compose.isolated.yml')
        }
        docker compose @statusFileArgs ps
    }
}
if ($DshAction -in @('install','configure')) { Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:3080' }
if ($DshAction -in @('install','configure')) {
    $rootPasswordState = if (Test-Path -LiteralPath $rootHashFile) { '已设置（容器内 dsh-root run / sudo <命令> 可用，连续错误会锁定）' } else { '未设置（容器内任意特权命令关闭；apt 与 DSH 更新不受影响）' }
    Write-Host "运行账户：dsh (UID 1000)，容器已 cap_drop ALL + no-new-privileges" -ForegroundColor Green
    Write-Host "容器 root 密码：$rootPasswordState" -ForegroundColor Green
    if ($modelBroker -eq 'on') {
        Write-Host "模型密钥代理：开（dsh-key-broker；真实密钥只在 data\broker\keys.json 与该容器内）" -ForegroundColor Green
        foreach ($name in Get-BrokerUpstreamNames $brokerConfigFile) {
            Write-Host "  - ${name}: DSH 侧 base_url = $ModelBrokerBase/u/$name，密钥是占位串 $ModelBrokerPlaceholderKey" -ForegroundColor Green
        }
        if (@(Get-BrokerUpstreamNames $brokerConfigFile).Count -eq 0) {
            Write-Host '还没有任何上游：现在向 DSH 发模型请求会得到 503，请先在下面的面板里填一把密钥。' -ForegroundColor Yellow
        } elseif ($NoModelSettingsSeed) {
            Write-Host '模型设置：未写入（-NoModelSettingsSeed），请在 WebUI 的「设置 → 模型」里自己加供应商' -ForegroundColor Yellow
        } else {
            Write-Host '模型设置：已写进 data\dsh\settings.yaml，WebUI 的「设置 → 模型」里可直接选模型' -ForegroundColor Green
        }
        Write-Host '作用范围：只保证密钥字面值不进入 dsh 容器，不限制额度消耗，也不阻止数据外发。' -ForegroundColor Yellow
        Write-Host '  容器里的 Agent 用占位密钥仍可发起请求，因此建议为每个上游设置' -ForegroundColor Yellow
        Write-Host '  requestsPerMinute / dailyRequestBudget，并按需启用 allowlist 出站模式。' -ForegroundColor Yellow
    } else {
        Write-Host '模型密钥代理：关（密钥若写进容器内的配置或环境，容器里的 Agent 一条 cat 就能读到）' -ForegroundColor Green
    }
    Show-KeyAdminAccess ($keyAdmin -eq 'on')
    if ($egressMode -eq 'allowlist') {
        Write-Host '出站模式：allowlist（dsh 不直连外网，出站只经过 dsh-egress；宿主 3080 由 dsh-ingress 发布）' -ForegroundColor Green
        if ($egressAllowed) {
            Write-Host "白名单：内置白名单 + 自定义 $(@($egressAllowed -split ',' | Where-Object { $_ }).Count) 条（DSH_EGRESS_ALLOWED_HOSTS）" -ForegroundColor Green
        } else {
            Write-Host '白名单：仅内置白名单（Debian / npm / PyPI / GitHub / ghcr.io / nodejs.org / astral.sh）' -ForegroundColor Green
        }
    } else {
        Write-Host '出站模式：open（容器可访问任意外网地址，出站流量不做域名限制）' -ForegroundColor Green
    }
}
Write-Host "完成：$DshAction`n工程目录：$(Get-Location)`n管理：.\dsh.bat [start|update|stop|restart|logs|status|shell|remove]" -ForegroundColor Green
