@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ===================================================
echo   DeepSeek Harness (DSH) 本地一键启动程序
echo ===================================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Docker，请先安装并启动 Docker Desktop 后重试。
  pause
  exit /b 1
)

echo [1/3] 正在构建并启动 DeepSeek Harness 容器...
docker compose up -d --build
if errorlevel 1 (
  echo [错误] 启动失败，请检查 Docker 是否正常运行。
  pause
  exit /b 1
)

echo [2/3] 服务正在就绪...
timeout /t 3 /nobreak >nul

echo [3/3] 正在打开浏览器访问 http://127.0.0.1:3080 ...
start "" http://127.0.0.1:3080

echo.
echo ===================================================
echo   启动完成！
echo   Web UI:   http://127.0.0.1:3080
echo   查看日志: docker compose logs -f dsh
echo   停止服务: docker compose down
echo ===================================================
echo.
pause
