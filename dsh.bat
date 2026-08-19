@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "DOCKER_BUILDKIT=1"
set "COMPOSE_DOCKER_CLI_BUILD=1"

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=default"

where docker >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Docker，请先安装并启动 Docker Desktop 后重试。
  pause
  exit /b 1
)

if /i "%ACTION%"=="default" goto :start_and_open
if /i "%ACTION%"=="start" goto :start
if /i "%ACTION%"=="up" goto :start
if /i "%ACTION%"=="update" goto :update
if /i "%ACTION%"=="stop" goto :stop
if /i "%ACTION%"=="down" goto :stop
if /i "%ACTION%"=="restart" goto :restart
if /i "%ACTION%"=="logs" goto :logs

echo 用法: %~nx0 [start^|update^|stop^|restart^|logs]
exit /b 0

:start_and_open
echo [1/3] 正在启动 DeepSeek Harness 容器...
docker compose up -d --build --force-recreate
if errorlevel 1 goto :error
docker image prune -f >nul 2>&1
echo [2/3] 服务正在就绪...
timeout /t 3 /nobreak >nul
echo [3/3] 正在打开浏览器访问 http://127.0.0.1:3080 ...
start "" http://127.0.0.1:3080
echo.
echo ===================================================
echo   Web UI:   http://127.0.0.1:3080
echo   查看日志: %~nx0 logs
echo   停止服务: %~nx0 stop
echo   更新源码: %~nx0 update
echo ===================================================
pause
exit /b 0

:start
docker compose up -d --build --force-recreate
docker image prune -f >nul 2>&1
exit /b %errorlevel%

:update
echo ==> 从官方源码重新拉取并构建最新镜像...
docker compose build dsh
if errorlevel 1 goto :error
docker compose up -d --force-recreate
docker image prune -f >nul 2>&1
echo ==> 更新构建完成！
exit /b 0

:stop
docker compose down
exit /b %errorlevel%

:restart
docker compose restart dsh
exit /b %errorlevel%

:logs
docker compose logs -f dsh
exit /b 0

:error
echo [错误] 操作失败，请检查 Docker 是否正常运行。
pause
exit /b 1
