@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "DOCKER_BUILDKIT=1"
set "COMPOSE_DOCKER_CLI_BUILD=1"

rem Compose 里环境变量优先于 .env；清掉它们，保证运行时使用 .env 中的配置。
set "DSH_ACCESS_MODE="
set "DSH_BIND_HOST="
set "DSH_TRUSTED_HOSTS="
set "DSH_DOCKER_NETWORK="
set "DSH_DOCKER_NETWORK_EXTERNAL="
set "DSH_IMAGE="
set "DSH_IMAGE_SOURCE="

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=default"

where docker >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Docker，请先安装 Docker Desktop 后重试。
  pause
  exit /b 1
)

call :ensure_docker
if errorlevel 1 exit /b 1

if /i "%ACTION%"=="default" goto :start_and_open
if /i "%ACTION%"=="start" goto :start
if /i "%ACTION%"=="up" goto :start
if /i "%ACTION%"=="update" goto :update
if /i "%ACTION%"=="stop" goto :stop
if /i "%ACTION%"=="restart" goto :restart
if /i "%ACTION%"=="logs" goto :logs
if /i "%ACTION%"=="status" goto :status
if /i "%ACTION%"=="ps" goto :status
if /i "%ACTION%"=="shell" goto :shell
if /i "%ACTION%"=="remove" goto :remove
if /i "%ACTION%"=="down" goto :remove

echo 用法: %~nx0 [start^|update^|stop^|restart^|logs^|status^|shell^|remove]
exit /b 1

:ensure_container
docker container inspect dsh >nul 2>nul
if not errorlevel 1 exit /b 0
call :read_env DSH_IMAGE
set "IMAGE_REF=%ENV_VALUE%"
if "%IMAGE_REF%"=="" set "IMAGE_REF=dsh:local"
call :read_env DSH_IMAGE_SOURCE
set "IMAGE_SOURCE=%ENV_VALUE%"
docker image inspect "%IMAGE_REF%" >nul 2>nul
if errorlevel 1 (
  if /i "%IMAGE_SOURCE%"=="prebuilt" (
    echo ==^> 首次创建容器，正在拉取预构建 Debian 13 镜像：%IMAGE_REF%
    rem 拉取不经过 Compose：引用直接交给守护进程，插值出问题时也不会拉错镜像。
    docker pull "%IMAGE_REF%"
  ) else (
    echo ==^> 首次创建容器，正在构建 Debian 13 镜像...
    docker compose build dsh
  )
  if errorlevel 1 exit /b 1
)
docker compose up -d --no-build dsh
exit /b %errorlevel%

:start_container
call :ensure_container
if errorlevel 1 exit /b 1
set "CONTAINER_STATUS="
for /f "delims=" %%i in ('docker inspect --format "{{.State.Status}}" dsh 2^>nul') do set "CONTAINER_STATUS=%%i"
if /i "%CONTAINER_STATUS%"=="running" exit /b 0
docker start dsh >nul
exit /b %errorlevel%

:start_and_open
echo [1/3] 正在启动 DeepSeek Harness 容器...
call :start_container
if errorlevel 1 goto :error
echo [2/3] 服务正在就绪...
timeout /t 3 /nobreak >nul
echo [3/3] 正在打开浏览器访问 http://127.0.0.1:3080 ...
start "" http://127.0.0.1:3080
echo.
echo ===================================================
echo   Web UI:   http://127.0.0.1:3080
echo   查看日志: %~nx0 logs
echo   停止服务: %~nx0 stop
echo   更新 DSH: %~nx0 update
echo ===================================================
pause
exit /b 0

:start
call :start_container
exit /b %errorlevel%

:update
docker container inspect dsh >nul 2>nul
if errorlevel 1 (
  echo [错误] 容器尚未创建，请先运行 %~nx0 start。
  exit /b 1
)
set "CONTAINER_STATUS="
for /f "delims=" %%i in ('docker inspect --format "{{.State.Status}}" dsh 2^>nul') do set "CONTAINER_STATUS=%%i"
if /i not "%CONTAINER_STATUS%"=="running" (
  echo [错误] 容器当前未运行，请先运行 %~nx0 start。
  exit /b 1
)
echo ==^> 在现有 Debian 13 容器内更新 DSH...
docker exec dsh /usr/local/bin/update-dsh
exit /b %errorlevel%

:stop
docker compose stop dsh
exit /b %errorlevel%

:remove
echo ==^> 即将删除容器可写层；/data 和 /workspace 挂载数据不会删除。
docker compose down
exit /b %errorlevel%

:restart
docker compose restart dsh
exit /b %errorlevel%

:logs
docker compose logs -f dsh
exit /b 0

:shell
docker exec -it dsh bash
exit /b %errorlevel%

:status
docker compose ps
exit /b %errorlevel%

rem 读取 .env 中的一个键；安装器把镜像引用和来源写在那里。
:read_env
set "ENV_VALUE="
if not exist ".env" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="%~1" set "ENV_VALUE=%%b"
)
exit /b 0

:ensure_docker
set "DOCKER_OS="
for /f "delims=" %%i in ('docker info --format "{{.OSType}}" 2^>nul') do set "DOCKER_OS=%%i"
if /i "%DOCKER_OS%"=="linux" exit /b 0
if /i "%DOCKER_OS%"=="windows" (
  echo [错误] DSH 需要 Linux 容器。请在 Docker Desktop 中切换到 Linux containers。
  pause
  exit /b 1
)

echo ==^> Docker Desktop Linux Engine 未运行，正在启动...
docker desktop start >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
    start "" /min "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
  ) else if exist "%LocalAppData%\Docker\Docker Desktop.exe" (
    start "" /min "%LocalAppData%\Docker\Docker Desktop.exe"
  ) else (
    echo [错误] 无法自动启动 Docker Desktop，请手动启动后重试。
    pause
    exit /b 1
  )
)

set /a DOCKER_WAIT=0
:wait_docker
set "DOCKER_OS="
for /f "delims=" %%i in ('docker info --format "{{.OSType}}" 2^>nul') do set "DOCKER_OS=%%i"
if /i "%DOCKER_OS%"=="linux" (
  echo ==^> Docker Desktop Linux Engine 已就绪。
  exit /b 0
)
if /i "%DOCKER_OS%"=="windows" (
  echo [错误] Docker Desktop 当前使用 Windows Containers，请切换到 Linux containers。
  pause
  exit /b 1
)
if %DOCKER_WAIT% geq 180 (
  echo [错误] Docker Desktop Linux Engine 在 3 分钟内未就绪，请打开 Docker Desktop 检查。
  pause
  exit /b 1
)
timeout /t 2 /nobreak >nul
set /a DOCKER_WAIT+=2
goto :wait_docker

:error
echo [错误] 操作失败，请检查 Docker 是否正常运行。
pause
exit /b 1
