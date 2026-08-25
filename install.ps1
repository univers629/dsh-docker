param(
    [Alias('Action')]
    [ValidateSet('','install','configure','update','start','stop','restart','logs','status','delete')]
    [string]$DshAction,
    [ValidateSet('','local','trusted-proxy','basic')]
    [string]$Access = '',
    [string]$BindHost = '',
    [string]$TrustedHosts = '',
    [string]$Network = '',
    [switch]$NetworkExternal,
    [switch]$NetworkInternal,
    [switch]$NonInteractive,
    [ValidateSet('','prebuilt','build')]
    [string]$ImageSource = '',
    [string]$Image = '',
    [string]$Dir = 'dsh-docker'
)

$ErrorActionPreference = 'Stop'
# 原生命令（docker/git）靠退出码判断结果；如果调用方或 profile 打开了
# PSNativeCommandUseErrorActionPreference，非零退出会变成终止错误并中断向导。
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }
if ($NetworkExternal -and $NetworkInternal) { throw '--NetworkExternal 与 --NetworkInternal 不能同时使用。' }
$interactive = -not $NonInteractive -and [Environment]::UserInteractive
$GitHubSshUrl = 'ssh://git@ssh.github.com:443/univers629/dsh-docker.git'
$GitHubHttpsUrl = 'https://github.com/univers629/dsh-docker.git'
$DefaultPrebuiltImage = if ($env:DSH_PREBUILT_IMAGE) { $env:DSH_PREBUILT_IMAGE } else { 'ghcr.io/univers629/dsh-docker:latest' }
$DefaultLocalImage = 'dsh:local'

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
    # /run/dsh.pid 由 dsh-supervisor 写入：第一行是 PID，第二行是进程启动时刻，
    # 所以只能取第一行，整读会拼出无效的 /proc 路径。
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $uid = (& docker exec dsh sh -c 'pid="$(sed -n 1p /run/dsh.pid 2>/dev/null)"; case "$pid" in ""|*[!0-9]*) exit 1 ;; esac; sed -n "s/^Uid:[[:space:]]*\([0-9]*\).*/\1/p" "/proc/$pid/status"' 2>$null | Select-Object -Last 1)
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
                & docker compose @composeArgs down --volumes --remove-orphans | Out-Host
            } finally { Pop-Location }
        }
    }

    $containerIds = @(& docker container ls -aq --filter "label=com.docker.compose.project=$projectName" 2>$null)
    $namedContainer = (& docker container inspect --format '{{.Id}}' dsh 2>$null | Select-Object -Last 1)
    if ($namedContainer) { $containerIds += $namedContainer.Trim() }
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
    $defaultNetworkProject = (& docker network inspect --format '{{ index .Labels "com.docker.compose.project" }}' dsh-private 2>$null | Select-Object -Last 1)
    if ($defaultNetworkProject -and $defaultNetworkProject.Trim() -eq $projectName) { & docker network rm dsh-private *> $null }
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
if (-not $DshAction -and $interactive) {
    $installLabel = if (Test-Path $Dir) { '重新配置并重建容器（保留挂载数据）' } else { '全新安装' }
    Write-Host "1) $installLabel`n2) 在容器内更新 DSH`n3) 启动`n4) 停止`n5) 重启`n6) 日志`n7) 状态`n8) 删除"
    switch (Ask '这次要做什么' '1') {
        '1' { $DshAction = 'install' }; '2' { $DshAction = 'update' }; '3' { $DshAction = 'start' }; '4' { $DshAction = 'stop' }
        '5' { $DshAction = 'restart' }; '6' { $DshAction = 'logs' }; '7' { $DshAction = 'status' }; '8' { $DshAction = 'delete' }
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

if ($DshAction -in @('install','configure')) {
    if ($interactive -and -not $ImageSource) {
        $imageDefault = if ($imageSource -eq 'build') { '2' } else { '1' }
        Write-Host 'Debian 13 镜像来源：1=拉取公开预构建镜像（推荐，不在本机编译 DSH）  2=在本机构建镜像（1 核 1G 机器可能超过 20 分钟）'
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
        # 预构建优先，但公网拉取可能因为网络或尚未发布而失败；这时退回本机构建，
        # 而不是让整次安装中断。回退发生在写入 .env 之前，所以配置不会记错来源。
        $env:DSH_IMAGE = $imageRef
        if ($imageSource -eq 'prebuilt') {
            Write-Host "==> 正在拉取预构建 Debian 13 镜像：$imageRef" -ForegroundColor Yellow
            docker compose pull dsh
            if ($LASTEXITCODE -ne 0) {
                Write-Host "[警告] 无法拉取 $imageRef，改为在本机构建镜像。" -ForegroundColor Yellow
                $imageSource = 'build'
                $imageRef = $DefaultLocalImage
                $env:DSH_IMAGE = $imageRef
            }
        }
        if ($imageSource -eq 'build') {
            Write-Host '==> 正在构建 DSH 镜像...' -ForegroundColor Yellow
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
            $composeKeys = @('DSH_ACCESS_MODE','DSH_BIND_HOST','DSH_TRUSTED_HOSTS','DSH_DOCKER_NETWORK','DSH_DOCKER_NETWORK_EXTERNAL','DSH_IMAGE','DSH_IMAGE_SOURCE')
            $composeExitCode = Invoke-ComposeWithEnvFile -Path $pendingEnvFile -Arguments @('up','-d','--no-build','--force-recreate') -EnvironmentKeys $composeKeys
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
