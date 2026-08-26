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
rem 旁路服务的开关同理。下面的 -f 列表是按 .env 算出来的，如果 Compose 插值又去读
rem 宿主环境里残留的值，就会变成「叠加了 keys/isolated 文件、但服务拿到的还是旧模式」
rem 这种最难查的半启用状态。
set "DSH_MODEL_BROKER="
set "DSH_MODEL_BROKER_BASE="
set "DSH_EGRESS_MODE="
set "DSH_EGRESS_ALLOWED_HOSTS="

rem 旁路容器的状态探针。broker 和 egress 容器都是 read_only + 非 root，所以只能用
rem node -e 打回环上的 /status，绝不能依赖写临时文件。这两段源码和 dsh.sh 里的
rem status_probe 保持一致，并且刻意不用箭头函数：cmd 即使在引号里也容易把 > 吃掉。
set "PROBE_BROKER=const url='http://127.0.0.1:8080/status';fetch(url).then(function(response){return response.text()}).then(function(text){try{console.log(JSON.stringify(JSON.parse(text),null,2))}catch(error){console.log(text)}}).catch(function(error){console.error(url+' : '+error.message);process.exitCode=1})"
set "PROBE_EGRESS=const url='http://127.0.0.1:3128/status';fetch(url).then(function(response){return response.text()}).then(function(text){try{console.log(JSON.stringify(JSON.parse(text),null,2))}catch(error){console.log(text)}}).catch(function(error){console.error(url+' : '+error.message);process.exitCode=1})"

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

call :resolve_compose_files

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
if /i "%ACTION%"=="root-shell" goto :root_shell
if /i "%ACTION%"=="verify" goto :verify
if /i "%ACTION%"=="keys" goto :keys
if /i "%ACTION%"=="egress" goto :egress
if /i "%ACTION%"=="remove" goto :remove
if /i "%ACTION%"=="down" goto :remove

echo 用法: %~nx0 [start^|update^|stop^|restart^|logs [服务]^|status^|shell^|root-shell^|verify^|keys^|egress^|remove]
echo   keys    显示模型密钥代理（dsh-key-broker）的上游与用量，不显示密钥
echo   egress  显示出站白名单代理（dsh-egress）的白名单规模与放行/拒绝计数
exit /b 1

rem --- Compose 叠加文件与旁路容器 ---
rem
rem 密钥代理和出站代理都是独立容器，各自定义在一个叠加文件里，开关写在 .env：
rem   DSH_MODEL_BROKER=on        叠加 docker-compose.keys.yml（dsh-key-broker）
rem   DSH_EGRESS_MODE=allowlist  叠加 docker-compose.isolated.yml（dsh-egress + dsh-ingress）
rem 顺序不能反：isolated 里的 !reset / !override 要作用在前面两个文件合并出来的结果上。
rem
rem 叠加文件不存在时只警告并按未启用处理：老部署目录里没有这两个文件，而
rem docker compose 遇到缺失的 -f 会直接失败退出，那样连 stop / logs / status 这些
rem 只读操作都会一起废掉。
:resolve_compose_files
set "COMPOSE_FILES=-f docker-compose.yml"
set "SIDECARS="
set "BROKER_ENABLED="
set "EGRESS_ENABLED="
call :read_env DSH_MODEL_BROKER
if /i "%ENV_VALUE%"=="on" (
  if exist "docker-compose.keys.yml" (
    set "COMPOSE_FILES=%COMPOSE_FILES% -f docker-compose.keys.yml"
    set "SIDECARS=%SIDECARS% dsh-key-broker"
    set "BROKER_ENABLED=1"
  ) else (
    echo [警告] .env 里 DSH_MODEL_BROKER=on，但目录里没有 docker-compose.keys.yml，已按未启用处理。
  )
)
call :read_env DSH_EGRESS_MODE
if /i "%ENV_VALUE%"=="allowlist" (
  if exist "docker-compose.isolated.yml" (
    set "COMPOSE_FILES=%COMPOSE_FILES% -f docker-compose.isolated.yml"
    set "SIDECARS=%SIDECARS% dsh-egress dsh-ingress"
    set "EGRESS_ENABLED=1"
  ) else (
    echo [警告] .env 里 DSH_EGRESS_MODE=allowlist，但目录里没有 docker-compose.isolated.yml，已按 open 处理。
  )
)
exit /b 0

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
    docker compose %COMPOSE_FILES% build dsh
  )
  if errorlevel 1 exit /b 1
)
docker compose %COMPOSE_FILES% up -d --no-build dsh
exit /b %errorlevel%

rem 旁路容器单独补：用户可能是在已有部署上才打开 .env 开关的，这时 dsh 容器已经存在，
rem ensure_container 直接返回，旁路容器就永远起不来。缺失的才 up（避免顺带重建 dsh），
rem 已存在但停着的直接 start。
:ensure_sidecars
if "%SIDECARS%"=="" exit /b 0
for %%s in (%SIDECARS%) do (
  docker container inspect %%s >nul 2>nul
  if errorlevel 1 (
    docker compose %COMPOSE_FILES% up -d --no-build %%s
  ) else (
    docker start %%s >nul 2>nul
  )
)
exit /b 0

:start_container
call :ensure_container
if errorlevel 1 exit /b 1
set "CONTAINER_STATUS="
for /f "delims=" %%i in ('docker inspect --format "{{.State.Status}}" dsh 2^>nul') do set "CONTAINER_STATUS=%%i"
if /i not "%CONTAINER_STATUS%"=="running" docker start dsh >nul
call :ensure_sidecars
exit /b 0

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
docker compose %COMPOSE_FILES% stop dsh%SIDECARS%
exit /b %errorlevel%

:remove
echo ==^> 即将删除容器可写层；/data 和 /workspace 挂载数据不会删除。
docker compose %COMPOSE_FILES% down
exit /b %errorlevel%

:restart
docker compose %COMPOSE_FILES% restart dsh%SIDECARS%
exit /b %errorlevel%

rem 默认跟随全部服务：隔离模式下 ingress / egress / broker 的日志和 dsh 自己的一样
rem 重要（被拒的出站请求只会出现在 egress 的审计日志里）。`logs 服务名` 只跟一个。
:logs
if "%~2"=="" (
  docker compose %COMPOSE_FILES% logs -f
) else (
  docker compose %COMPOSE_FILES% logs -f %~2
)
exit /b 0

:shell
rem 默认进入非特权的 dsh 账户：这正是 DSH 与 Agent 实际运行的身份。
docker exec -it -u dsh dsh bash -l
exit /b %errorlevel%

:root_shell
echo ==^> 以容器 root 打开 shell（仅宿主机管理员通道，容器内无法这样提权）。
docker exec -it dsh bash -l
exit /b %errorlevel%

:verify
docker exec dsh /usr/local/bin/verify-dsh-hardening
exit /b %errorlevel%

:keys
if not "%BROKER_ENABLED%"=="1" (
  echo 模型密钥代理未启用（.env 里 DSH_MODEL_BROKER 不是 on）：模型密钥现在直接放在 DSH 容器里，
  echo 容器内任何进程（包括被提示注入的 Agent）都能读到它。
  rem 补填密钥不需要重建容器：docker-compose.keys.yml 只新增 dsh-key-broker，不改 dsh
  rem 服务的定义，所以别让用户去手写 JSON 或重装——安装器有专门的动作干这件事。
  echo 启用方法：在这个目录里运行 .\install.ps1 -DshAction model-key，按提示填上游名字、base_url 和密钥。
  echo 它只写 data\broker\keys.json、翻 .env 里的开关、再新增 dsh-key-broker 容器，不会重建 dsh，
  echo 容器里 apt 装过的东西不会丢。之后把 DSH 模型设置里的 base_url 改成
  echo http://dsh-key-broker:8080/u/^<上游名字^>/v1，api key 填任意占位串即可。
  exit /b 0
)
call :require_sidecar dsh-key-broker
if errorlevel 1 exit /b 1
echo ==^> dsh-key-broker /status：
docker exec dsh-key-broker node -e "%PROBE_BROKER%"
if errorlevel 1 (
  echo [错误] 读不到 dsh-key-broker 的 /status，容器可能刚起来或配置有问题，见 %~nx0 logs dsh-key-broker。
  exit /b 1
)
echo.
echo 说明：这里只显示上游名字与用量，密钥只存在于 data/broker/keys.json 与 broker 容器内存中。
echo       它不会出现在这条输出、DSH 容器、compose 文件或 broker 的审计日志里。
exit /b 0

:egress
if not "%EGRESS_ENABLED%"=="1" (
  echo 出站白名单未启用（.env 里 DSH_EGRESS_MODE 不是 allowlist）：容器当前可以直接访问任意公网地址，
  echo 被提示注入的 Agent 可以把数据 POST 到任何地方。
  echo 启用方法：在 .env 里设置 DSH_EGRESS_MODE=allowlist（要额外放行域名就再写 DSH_EGRESS_ALLOWED_HOSTS），
  echo 然后运行 %~nx0 start。
  exit /b 0
)
call :require_sidecar dsh-egress
if errorlevel 1 exit /b 1
echo ==^> dsh-egress /status：
docker exec dsh-egress node -e "%PROBE_EGRESS%"
if errorlevel 1 (
  echo [错误] 读不到 dsh-egress 的 /status，容器可能刚起来或配置有问题，见 %~nx0 logs dsh-egress。
  exit /b 1
)
echo.
echo 说明：allowlist 模式下 dsh 容器只挂 internal 网络，出网只有 dsh-egress 这一条路，
echo       白名单外的域名会被直接拒绝。被拒的请求见 %~nx0 logs dsh-egress。
exit /b 0

:status
docker compose %COMPOSE_FILES% ps
echo.
echo ==^> 旁路容器：
call :report_sidecar dsh-key-broker "模型密钥代理" "%BROKER_ENABLED%" "DSH_MODEL_BROKER=on"
call :report_sidecar dsh-egress "出站白名单代理" "%EGRESS_ENABLED%" "DSH_EGRESS_MODE=allowlist"
call :report_sidecar dsh-ingress "宿主 3080 入口" "%EGRESS_ENABLED%" "DSH_EGRESS_MODE=allowlist"
exit /b 0

rem 探针前置检查：容器不存在或没运行时给一句能照着做的话，而不是让 docker exec 抛
rem 一行英文错误。
:require_sidecar
docker container inspect %~1 >nul 2>nul
if errorlevel 1 (
  echo [错误] %~1 容器不存在，请先运行 %~nx0 start。
  exit /b 1
)
set "SC_STATE="
for /f "delims=" %%i in ('docker inspect --format "{{.State.Status}}" %~1 2^>nul') do set "SC_STATE=%%i"
if /i not "%SC_STATE%"=="running" (
  echo [错误] %~1 容器当前未运行，请先运行 %~nx0 start。
  exit /b 1
)
exit /b 0

rem status 里顺带把三个旁路容器的存在与健康状态列出来：它们不发布端口也没有 Web
rem 界面，compose ps 之外没有别的地方能看到它们是不是活着。
:report_sidecar
set "SC_NAME=%~1"
set "SC_LABEL=%~2"
set "SC_ENABLED=%~3"
set "SC_SWITCH=%~4"
set "SC_STATE="
for /f "delims=" %%i in ('docker inspect --format "{{.State.Status}}" %SC_NAME% 2^>nul') do set "SC_STATE=%%i"
if "%SC_STATE%"=="" (
  if "%SC_ENABLED%"=="1" (
    echo   %SC_NAME% %SC_LABEL%：已启用但容器不存在，运行 %~nx0 start 创建
  ) else (
    echo   %SC_NAME% %SC_LABEL%：未启用（在 .env 里设置 %SC_SWITCH% 后重新 start）
  )
  exit /b 0
)
set "SC_HEALTH="
for /f "delims=" %%i in ('docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}无健康检查{{end}}" %SC_NAME% 2^>nul') do set "SC_HEALTH=%%i"
if "%SC_HEALTH%"=="" set "SC_HEALTH=未知"
echo   %SC_NAME% %SC_LABEL%：%SC_STATE%（健康：%SC_HEALTH%）
exit /b 0

rem 读取 .env 中的一个键；安装器把镜像引用、来源和旁路开关都写在那里。
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