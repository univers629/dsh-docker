param(
    [Alias('Action')]
    [ValidateSet('','install','configure','update','start','stop','restart','logs','status')]
    [string]$DshAction,
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
if ($NetworkExternal -and $NetworkInternal) { throw '--NetworkExternal 与 --NetworkInternal 不能同时使用。' }
$interactive = -not $NonInteractive -and [Environment]::UserInteractive
$GitHubSshUrl = 'ssh://git@ssh.github.com:443/univers629/dsh-docker.git'
$GitHubHttpsUrl = 'https://github.com/univers629/dsh-docker.git'

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
    param([string]$Path, [string[]]$Arguments, [string[]]$EnvironmentKeys)
    $previous = @{}
    foreach ($key in $EnvironmentKeys) {
        $previous[$key] = [pscustomobject]@{
            Exists = Test-Path -LiteralPath "Env:$key"
            Value = [Environment]::GetEnvironmentVariable($key, 'Process')
        }
        Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
    }
    try {
        & docker compose --env-file $Path @Arguments | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        foreach ($key in $EnvironmentKeys) {
            if ($previous[$key].Exists) { [Environment]::SetEnvironmentVariable($key, $previous[$key].Value, 'Process') }
            else { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
        }
    }
    return $exitCode
}

function Assert-DshRoot {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $uid = (& docker exec dsh sh -c 'pid="$(cat /run/dsh.pid 2>/dev/null)" || exit 1; sed -n "s/^Uid:[[:space:]]*\([0-9]*\).*/\1/p" "/proc/$pid/status"' 2>$null | Select-Object -Last 1)
        if ($LASTEXITCODE -eq 0 -and $uid -match '^\d+$') {
            if ($uid.Trim() -ne '0') {
                throw "DSH 进程 UID 核验失败：期望 0，实际为 $($uid.Trim())。"
            }
            Write-Host '==> 已核验 DSH 进程 UID：0' -ForegroundColor Green
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
if (-not $DshAction -and $interactive) {
    $installLabel = if (Test-Path $Dir) { '重新配置并重建容器（保留挂载数据）' } else { '全新安装' }
    Write-Host "1) $installLabel`n2) 在容器内更新 DSH`n3) 启动`n4) 停止`n5) 重启`n6) 日志`n7) 状态"
    switch (Ask '这次要做什么' '1') {
        '1' { $DshAction = 'install' }; '2' { $DshAction = 'update' }; '3' { $DshAction = 'start' }; '4' { $DshAction = 'stop' }
        '5' { $DshAction = 'restart' }; '6' { $DshAction = 'logs' }; '7' { $DshAction = 'status' }
        default { throw '无效操作。' }
    }
} elseif (-not $DshAction) { $DshAction = 'install' }

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
$basicUser = $env:DSH_BASIC_AUTH_USER
$basicPassword = $env:DSH_BASIC_AUTH_PASSWORD
$writeBasicAuth = $false

if ($DshAction -in @('install','configure')) {
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
            $composeKeys = @('DSH_ACCESS_MODE','DSH_BIND_HOST','DSH_TRUSTED_HOSTS','DSH_DOCKER_NETWORK','DSH_DOCKER_NETWORK_EXTERNAL')
            $composeExitCode = Invoke-ComposeWithEnvFile -Path $pendingEnvFile -Arguments @('up','-d','--force-recreate') -EnvironmentKeys $composeKeys
            if ($composeExitCode -ne 0) { throw 'DSH 容器启动失败，原配置未被覆盖。' }
            Move-Item -LiteralPath $pendingEnvFile -Destination $envFile -Force
            $pendingEnvFile = $null
            Assert-DshRoot
        } finally {
            if ($pendingEnvFile -and (Test-Path -LiteralPath $pendingEnvFile)) {
                Remove-Item -LiteralPath $pendingEnvFile -Force -ErrorAction SilentlyContinue
            }
        }
    }
    'update' { & .\dsh.bat update }
    'start' { & .\dsh.bat start }
    'stop' { & .\dsh.bat stop }
    'restart' { & .\dsh.bat restart }
    'logs' { & .\dsh.bat logs }
    'status' { docker compose ps }
}
if ($DshAction -in @('install','configure')) { Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:3080' }
Write-Host "完成：$DshAction`n工程目录：$(Get-Location)`n管理：.\dsh.bat [start|update|stop|restart|logs|status|shell|remove]" -ForegroundColor Green
