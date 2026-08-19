@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ===================================================
echo   DeepSeek Harness 官方源码一键更新与本地构建
echo ===================================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Docker，请先安装并启动 Docker Desktop 后重试。
  pause
  exit /b 1
)

echo [1/3] 正在从官方源码重新拉取并构建最新镜像...
docker compose build --no-cache dsh
if errorlevel 1 (
  echo [错误] 构建失败，请检查网络或 Docker 状态。
  pause
  exit /b 1
)

echo [2/3] 正在重启 DeepSeek Harness 服务...
docker compose up -d
if errorlevel 1 (
  echo [错误] 启动失败。
  pause
  exit /b 1
)

echo [3/3] 正在自动清理临时构建缓存...
docker image prune -f

echo.
echo ===================================================
echo   更新构建完成！
echo   Web UI:   http://127.0.0.1:3080
echo   查看日志: docker compose logs -f dsh
echo ===================================================
echo.
pause
