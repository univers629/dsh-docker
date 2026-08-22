param(
    [switch]$Root,
    [switch]$User
)

# DeepSeek Harness Docker (DSH-Docker) - Windows One-Line Installer
$ErrorActionPreference = "Stop"

$extraArgs = @($args)
if ($extraArgs -contains "--root" -or $extraArgs -contains "--run-as-root") { $Root = $true }
if ($extraArgs -contains "--user" -or $extraArgs -contains "--normal-user" -or $extraArgs -contains "--no-root") { $User = $true }
if ($Root -and $User) { throw "--Root/--root 与 --User/--user 不能同时使用。" }
foreach ($extraArg in $extraArgs) {
    if ($extraArg -notin @("--root", "--run-as-root", "--user", "--normal-user", "--no-root")) {
        throw "未知参数：$extraArg（支持 -Root 或 -User）。"
    }
}

function Set-ComposeEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $lines = if (Test-Path -LiteralPath $Path) { @([IO.File]::ReadAllLines($Path)) } else { @() }
    $pattern = "^\s*" + [regex]::Escape($Key) + "\s*="
    $found = $false
    $updated = foreach ($line in $lines) {
        if ($line -match $pattern) {
            if (-not $found) {
                $found = $true
                "$Key=$Value"
            }
        } else {
            $line
        }
    }
    if (-not $found) { $updated += "$Key=$Value" }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, (($updated -join [Environment]::NewLine) + [Environment]::NewLine), $utf8NoBom)
}

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "  DeepSeek Harness (DSH) 一键安装与启动程序" -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "[错误] 未检测到 Docker，请先安装并启动 Docker Desktop 后重试。" -ForegroundColor Red
    exit 1
}

$targetDir = "dsh-docker"
if (-not (Test-Path $targetDir)) {
    Write-Host "==> [1/3] 正在获取工程文件..." -ForegroundColor Yellow
    if (Get-Command git -ErrorAction SilentlyContinue) {
        git clone https://github.com/univers629/dsh-docker-dev.git $targetDir
    } else {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        $zipUrl = "https://github.com/univers629/dsh-docker-dev/archive/refs/heads/main.zip"
        $zipFile = "$targetDir\archive.zip"
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile
        Expand-Archive -Path $zipFile -DestinationPath "$targetDir\temp" -Force
        Copy-Item -Path "$targetDir\temp\dsh-docker-dev-main\*" -Destination $targetDir -Recurse -Force
        Remove-Item -Path "$targetDir\temp", $zipFile -Recurse -Force
    }
} elseif (Test-Path (Join-Path $targetDir ".git")) {
    Write-Host "==> [1/3] 正在同步工程文件..." -ForegroundColor Yellow
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "检测到已有 Git 工程，但系统未安装 Git，无法安全更新。"
    }
    $trackedChanges = git -C $targetDir diff --quiet; $trackedExit = $LASTEXITCODE
    git -C $targetDir diff --cached --quiet; $cachedExit = $LASTEXITCODE
    if ($trackedExit -ne 0 -or $cachedExit -ne 0) {
        throw "$targetDir 中存在未提交的源码修改，已停止以避免覆盖。请先提交、保存或清理这些修改后重试。"
    }
    git -C $targetDir fetch origin main
    if ($LASTEXITCODE -ne 0) { throw "无法从 GitHub 获取最新工程文件，已保留现有安装。" }
    git -C $targetDir merge --ff-only FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw "本地工程无法 fast-forward 到 origin/main，请手动处理后重试。" }
} else {
    throw "$targetDir 已存在但不是 Git 工程，无法安全更新。请移动该目录后重试。"
}

Set-Location $targetDir

if ($Root -or $User) {
    $runAsRoot = if ($Root) { "true" } else { "false" }
    Set-ComposeEnvValue -Path (Join-Path (Get-Location) ".env") -Key "DSH_RUN_AS_ROOT" -Value $runAsRoot
    $modeLabel = if ($Root) { "root（仅容器内）" } else { "普通用户 node" }
    Write-Host "==> DSH 运行模式：$modeLabel" -ForegroundColor Yellow
}

Write-Host "==> [2/3] 正在本地构建并启动 DeepSeek Harness 容器..." -ForegroundColor Yellow
docker compose up -d --build --force-recreate

Write-Host "==> [3/3] 正在打开浏览器访问 Web UI..." -ForegroundColor Green
Start-Sleep -Seconds 3
Start-Process "http://127.0.0.1:3080"

Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "  Web UI:       http://127.0.0.1:3080" -ForegroundColor White
Write-Host "  工程目录:     $(Get-Location)" -ForegroundColor White
Write-Host "  日常管理:     .\dsh.bat [start|update|stop|logs]" -ForegroundColor White
Write-Host "===================================================" -ForegroundColor Cyan
