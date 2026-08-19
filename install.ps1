# DeepSeek Harness Docker (DSH-Docker) - Windows One-Line Installer
$ErrorActionPreference = "Stop"

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
}

Set-Location $targetDir

Write-Host "==> [2/3] 正在本地构建并启动 DeepSeek Harness 容器..." -ForegroundColor Yellow
docker compose up -d --build

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
