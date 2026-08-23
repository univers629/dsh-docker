param(
    [Alias('Action')]
    [ValidateSet('','install','configure','update','start','stop','restart','logs','status')]
    [string]$DshAction,
    [switch]$Root,
    [switch]$User,
    [ValidateSet('','local','trusted-proxy','basic')]
    [string]$Access = '',
    [string]$BindHost = '',
    [string]$TrustedHosts = '',
    [string]$Network = '',
    [switch]$NetworkExternal,
    [switch]$NetworkInternal,
    [switch]$NonInteractive,
    [string]$Dir = 'dsh-docker'
)

$ErrorActionPreference = 'Stop'
if ($Root -and $User) { throw '--Root 与 --User 不能同时使用。' }
if ($NetworkExternal -and $NetworkInternal) { throw '--NetworkExternal 与 --NetworkInternal 不能同时使用。' }
$interactive = -not $NonInteractive -and [Environment]::UserInteractive

function Set-ComposeEnvValue {
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = if (Test-Path -LiteralPath $Path) { @([IO.File]::ReadAllLines($Path)) } else { @() }
    $pattern = '^\s*' + [regex]::Escape($Key) + '\s*='
    $found = $false
    $updated = foreach ($line in $lines) {
        if ($line -match $pattern) {
            if (-not $found) { $found = $true; "$Key=$Value" }
        } else { $line }
    }
    if (-not $found) { $updated += "$Key=$Value" }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, (($updated -join [Environment]::NewLine) + [Environment]::NewLine), $utf8NoBom)
}

function Get-ComposeEnvValue {
    param([string]$Path, [string]$Key, [string]$Fallback)
    if (-not (Test-Path -LiteralPath $Path)) { return $Fallback }
    $line = [IO.File]::ReadAllLines($Path) | Where-Object { $_ -match '^\s*' + [regex]::Escape($Key) + '\s*=' } | Select-Object -First 1
    if ($line) { return ($line -replace '^\s*[^=]+=', '') }
    return $Fallback
}

function Ask {
    param([string]$Message, [string]$Default)
    $answer = Read-Host "$Message [$Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
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

function Fetch-Project {
    if (-not (Test-Path $Dir)) {
        Write-Host '==> 正在获取工程文件...' -ForegroundColor Yellow
        if (Get-Command git -ErrorAction SilentlyContinue) {
            git clone https://github.com/univers629/dsh-docker.git $Dir
        } else {
            $zip = Join-Path $Dir 'archive.zip'
            New-Item -ItemType Directory -Path $Dir -Force | Out-Null
            Invoke-WebRequest -Uri 'https://github.com/univers629/dsh-docker/archive/refs/heads/main.zip' -OutFile $zip
            Expand-Archive -Path $zip -DestinationPath (Join-Path $Dir 'temp') -Force
            Copy-Item (Join-Path $Dir 'temp\dsh-docker-main\*') $Dir -Recurse -Force
            Remove-Item (Join-Path $Dir 'temp'), $zip -Recurse -Force
        }
    } elseif (Test-Path (Join-Path $Dir '.git')) {
        Write-Host '==> 正在同步工程文件...' -ForegroundColor Yellow
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '已有 Git 工程但未检测到 Git。' }
        git -C $Dir diff --quiet; if ($LASTEXITCODE -ne 0) { throw "$Dir 存在未提交修改。" }
        git -C $Dir diff --cached --quiet; if ($LASTEXITCODE -ne 0) { throw "$Dir 存在已暂存修改。" }
        git -C $Dir fetch origin main
        if ($LASTEXITCODE -ne 0) { throw '无法从 GitHub 获取最新工程文件。' }
        git -C $Dir merge --ff-only FETCH_HEAD
        if ($LASTEXITCODE -ne 0) { throw '本地工程无法 fast-forward 到 origin/main。' }
    } else { throw "$Dir 已存在但不是 Git 工程。" }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw '未检测到 Docker，请先安装并启动 Docker Desktop。' }
if (-not $DshAction -and $interactive) {
    $installLabel = if (Test-Path $Dir) { '重新配置并启动（保留数据）' } else { '全新安装' }
    Write-Host "1) $installLabel`n2) 更新源码并重建`n3) 启动`n4) 停止`n5) 重启`n6) 日志`n7) 状态"
    switch (Ask '这次要做什么' '1') {
        '1' { $DshAction = 'install' }; '2' { $DshAction = 'update' }; '3' { $DshAction = 'start' }; '4' { $DshAction = 'stop' }
        '5' { $DshAction = 'restart' }; '6' { $DshAction = 'logs' }; '7' { $DshAction = 'status' }
        default { throw '无效操作。' }
    }
} elseif (-not $DshAction) { $DshAction = 'install' }

if ($DshAction -in @('install','configure','update')) { Fetch-Project }
elseif (-not (Test-Path (Join-Path $Dir 'docker-compose.yml'))) { throw "未找到 $Dir，请先执行安装。" }
Set-Location $Dir
$env:DOCKER_BUILDKIT = '1'; $env:COMPOSE_DOCKER_CLI_BUILD = '1'
$envFile = Join-Path (Get-Location) '.env'
$runAsRoot = if ($Root) { 'true' } elseif ($User) { 'false' } else { Get-ComposeEnvValue $envFile 'DSH_RUN_AS_ROOT' 'false' }
$accessMode = if ($Access) { $Access } else { Get-ComposeEnvValue $envFile 'DSH_ACCESS_MODE' 'local' }
$bind = if ($BindHost) { $BindHost } else { Get-ComposeEnvValue $envFile 'DSH_BIND_HOST' '127.0.0.1' }
$trusted = if ($TrustedHosts) { $TrustedHosts } else { Get-ComposeEnvValue $envFile 'DSH_TRUSTED_HOSTS' '' }
$networkName = if ($Network) { $Network } else { Get-ComposeEnvValue $envFile 'DSH_DOCKER_NETWORK' 'dsh-private' }
$networkExternalValue = if ($NetworkExternal) { 'true' } elseif ($NetworkInternal) { 'false' } else { Get-ComposeEnvValue $envFile 'DSH_DOCKER_NETWORK_EXTERNAL' 'false' }
$basicUser = $env:DSH_BASIC_AUTH_USER
$basicPassword = $env:DSH_BASIC_AUTH_PASSWORD
$writeBasicAuth = $false

if ($DshAction -in @('install','configure')) {
    if ($interactive -and -not $Root -and -not $User) {
        $runDefault = if ($runAsRoot -eq 'true') { '2' } else { '1' }
        $runAsRoot = if ((Ask '容器内权限：1=node（推荐） 2=root' $runDefault) -eq '2') { 'true' } else { 'false' }
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
            if ($LASTEXITCODE -eq 0 -and -not $Network -and $networkName -eq 'dsh-private') { $networkName = 'dpanel-local' }
            if (-not $Network) { $networkName = Ask '反向代理使用的 Docker 网络' $networkName }
            $networkExternalValue = 'true'
        } else {
            $networkName = 'dsh-private'; $networkExternalValue = 'false'; $bind = '127.0.0.1'
        }
        $bind = Ask '宿主机端口绑定地址（推荐 127.0.0.1）' $bind
    }
    if ($bind -in @('0.0.0.0','::','[::]','*')) { throw '为避免绕过认证，不能使用通配绑定地址。' }
    if ($networkExternalValue -eq 'true') { docker network inspect $networkName *> $null; if ($LASTEXITCODE -ne 0) { throw "外部 Docker 网络 $networkName 不存在。" } }
    New-Item -ItemType Directory -Path (Join-Path (Get-Location) 'data\auth') -Force | Out-Null
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
    Set-ComposeEnvValue $envFile 'DSH_RUN_AS_ROOT' $runAsRoot
    Set-ComposeEnvValue $envFile 'DSH_ACCESS_MODE' $accessMode
    Set-ComposeEnvValue $envFile 'DSH_BIND_HOST' $bind
    Set-ComposeEnvValue $envFile 'DSH_TRUSTED_HOSTS' $trusted
    Set-ComposeEnvValue $envFile 'DSH_DOCKER_NETWORK' $networkName
    Set-ComposeEnvValue $envFile 'DSH_DOCKER_NETWORK_EXTERNAL' $networkExternalValue
}

switch ($DshAction) {
    { $_ -in @('install','configure') } {
        docker compose build dsh
        if ($LASTEXITCODE -ne 0) { throw 'DSH 镜像构建失败。' }
        if ($accessMode -eq 'basic' -and $writeBasicAuth) {
            $hashLine = $basicPassword | docker run --rm -i --entrypoint htpasswd dsh:local -niB $basicUser
            if ($LASTEXITCODE -ne 0) { throw 'Basic Auth bcrypt 哈希生成失败。' }
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [IO.File]::WriteAllText((Join-Path (Get-Location) 'data\auth\htpasswd'), (($hashLine -join [Environment]::NewLine) + [Environment]::NewLine), $utf8NoBom)
            $basicPassword = $null; $env:DSH_BASIC_AUTH_PASSWORD = $null
            Write-Host '==> Basic Auth 凭据已使用 bcrypt 哈希保存，未写入 .env。' -ForegroundColor Yellow
        }
        docker compose up -d --force-recreate
        if ($LASTEXITCODE -ne 0) { throw 'DSH 容器启动失败。' }
    }
    'update' { & .\dsh.bat update }
    'start' { & .\dsh.bat start }
    'stop' { & .\dsh.bat stop }
    'restart' { & .\dsh.bat restart }
    'logs' { & .\dsh.bat logs }
    'status' { docker compose ps }
}
if ($DshAction -in @('install','configure')) { Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:3080' }
Write-Host "完成：$DshAction`n工程目录：$(Get-Location)`n管理：.\dsh.bat [start|update|stop|restart|logs|status]" -ForegroundColor Green
