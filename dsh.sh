#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

# Compose 里 shell 环境变量的优先级高于 .env；清掉它们，保证运行时始终使用
# 安装器写入 .env 的访问模式、绑定地址和网络配置。
unset DSH_ACCESS_MODE DSH_BIND_HOST DSH_TRUSTED_HOSTS DSH_DOCKER_NETWORK DSH_DOCKER_NETWORK_EXTERNAL
unset DSH_IMAGE DSH_IMAGE_SOURCE
# 旁路服务的开关同理。这里的 -f 列表是按 .env 算出来的，如果 Compose 插值又去读宿主
# shell 里残留的值，就会出现「叠加了 keys/isolated 文件，但服务拿到的还是旧模式」
# 这种最难查的半启用状态。
unset DSH_MODEL_BROKER DSH_MODEL_BROKER_BASE DSH_EGRESS_MODE DSH_EGRESS_ALLOWED_HOSTS

ACTION="${1:-start}"

if ! command -v docker &>/dev/null; then
  echo "[错误] 未检测到 Docker，请先安装 Docker 后重试。"
  exit 1
fi

# sudo 默认 env_reset，导出的变量到不了 docker compose，插值会退回 dsh:local。
# 需要变量的调用一律走 DOCKER_ENV，用 env 在命令行上显式透传。
if docker info >/dev/null 2>&1; then
  DOCKER() { docker "$@"; }
  DOCKER_ENV() { env "$@"; }
else
  DOCKER() { sudo docker "$@"; }
  DOCKER_ENV() { sudo env "$@"; }
fi

# 安装器把镜像引用写进 .env；预构建安装用的是发布引用，不是 dsh:local。
# .env 有可能被 Windows 侧的编辑器存成 CRLF，尾随的 CR 会让 "on" / "allowlist"
# 这类相等比较全部失配，所以在这里就把它剥掉。
env_value() {
  local key="$1" fallback="$2" value=""
  if [ -f .env ]; then
    value="$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env 2>/dev/null | tr -d '\r' || true)"
  fi
  printf '%s' "${value:-$fallback}"
}

# --- Compose 叠加文件与旁路容器 ---
#
# 密钥代理和出站代理都是独立容器，各自定义在一个叠加文件里，开关写在 .env：
#   DSH_MODEL_BROKER=on        → 叠加 docker-compose.keys.yml（dsh-key-broker）
#   DSH_EGRESS_MODE=allowlist  → 叠加 docker-compose.isolated.yml（dsh-egress + dsh-ingress）
# 顺序不能反：isolated 里的 !reset / !override 要作用在前面两个文件合并出来的结果上。
#
# 叠加文件不存在时只警告并按未启用处理：老部署目录里没有这两个文件，而 docker compose
# 遇到缺失的 -f 会直接失败退出——那样连 stop / logs / status 这些只读操作都会一起废掉。
COMPOSE_ARGS=(-f docker-compose.yml)
SIDECAR_SERVICES=()
BROKER_ENABLED=false
EGRESS_ENABLED=false

if [ "$(env_value DSH_MODEL_BROKER off)" = on ]; then
  if [ -f docker-compose.keys.yml ]; then
    COMPOSE_ARGS+=(-f docker-compose.keys.yml)
    SIDECAR_SERVICES+=(dsh-key-broker)
    BROKER_ENABLED=true
  else
    echo "[警告] .env 里 DSH_MODEL_BROKER=on，但目录里没有 docker-compose.keys.yml，已按未启用处理。" >&2
  fi
fi
if [ "$(env_value DSH_EGRESS_MODE open)" = allowlist ]; then
  if [ -f docker-compose.isolated.yml ]; then
    COMPOSE_ARGS+=(-f docker-compose.isolated.yml)
    SIDECAR_SERVICES+=(dsh-egress dsh-ingress)
    EGRESS_ENABLED=true
  else
    echo "[警告] .env 里 DSH_EGRESS_MODE=allowlist，但目录里没有 docker-compose.isolated.yml，已按 open 处理。" >&2
  fi
fi

container_exists() {
  DOCKER container inspect dsh >/dev/null 2>&1
}

container_running() {
  [ "$(DOCKER inspect --format '{{.State.Status}}' dsh 2>/dev/null || true)" = running ]
}

ensure_image() {
  local image_ref image_source
  image_ref="$(env_value DSH_IMAGE dsh:local)"
  image_source="$(env_value DSH_IMAGE_SOURCE '')"
  if DOCKER image inspect "$image_ref" >/dev/null 2>&1; then
    return 0
  fi
  if [ "$image_source" = prebuilt ]; then
    echo "==> 首次创建容器，正在拉取预构建 Debian 13 镜像：$image_ref"
    DOCKER pull "$image_ref"
    return 0
  fi
  echo "==> 首次创建容器，正在构建 Debian 13 镜像..."
  DOCKER_ENV DSH_IMAGE="$image_ref" DOCKER_BUILDKIT=1 \
    docker compose "${COMPOSE_ARGS[@]}" build dsh
}

ensure_container() {
  if container_exists; then return 0; fi
  ensure_image
  DOCKER compose "${COMPOSE_ARGS[@]}" up -d --no-build dsh
}

# 旁路容器单独补：用户可能是在已有部署上才把 .env 的开关打开的，这时 dsh 容器已经
# 存在，ensure_container 会直接返回，旁路容器就永远起不来。缺失的才 up（避免顺带
# 重建 dsh），已存在但停着的直接 start。
ensure_sidecars() {
  local service missing=()
  [ "${#SIDECAR_SERVICES[@]}" -gt 0 ] || return 0
  for service in "${SIDECAR_SERVICES[@]}"; do
    if ! DOCKER container inspect "$service" >/dev/null 2>&1; then
      missing+=("$service")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    DOCKER compose "${COMPOSE_ARGS[@]}" up -d --no-build "${missing[@]}"
  fi
  for service in "${SIDECAR_SERVICES[@]}"; do
    if [ "$(DOCKER inspect --format '{{.State.Status}}' "$service" 2>/dev/null || true)" != running ]; then
      DOCKER start "$service" >/dev/null 2>&1 || true
    fi
  done
}

# 旁路容器的状态探针。broker 和 egress 容器都是 read_only + 非 root，所以只能用
# node -e 打回环上的 /status，绝不能依赖写临时文件。
# 脚本刻意不用箭头函数：同一段源码要原样搬进 dsh.bat，而 cmd 里 `>` 即使在引号内也
# 容易踩坑，避免出现比留着可读性更划算。
status_probe() {
  printf '%s' "const url='http://127.0.0.1:$1/status';fetch(url).then(function(response){return response.text()}).then(function(text){try{console.log(JSON.stringify(JSON.parse(text),null,2))}catch(error){console.log(text)}}).catch(function(error){console.error(url+' : '+error.message);process.exitCode=1})"
}

# 探针前置检查：容器不存在或没运行时给一句能照着做的话，而不是让 docker exec 抛
# 一行英文错误。
require_sidecar() {
  local service="$1"
  if ! DOCKER container inspect "$service" >/dev/null 2>&1; then
    echo "[错误] $service 容器不存在，请先运行 $0 start。" >&2
    return 1
  fi
  if [ "$(DOCKER inspect --format '{{.State.Status}}' "$service" 2>/dev/null || true)" != running ]; then
    echo "[错误] $service 容器当前未运行，请先运行 $0 start。" >&2
    return 1
  fi
}

# status 里顺带把三个旁路容器的存在与健康状态列出来：它们不发布端口也没有 Web 界面，
# compose ps 之外没有别的地方能看到它们是不是活着。
report_sidecar() {
  local name="$1" label="$2" enabled="$3" switch="$4" state health
  state="$(DOCKER inspect --format '{{.State.Status}}' "$name" 2>/dev/null || true)"
  if [ -z "$state" ]; then
    if [ "$enabled" = true ]; then
      printf '  %-15s %s：已启用但容器不存在，运行 %s start 创建\n' "$name" "$label" "$0"
    else
      printf '  %-15s %s：未启用（在 .env 里设置 %s 后重新 start）\n' "$name" "$label" "$switch"
    fi
    return 0
  fi
  health="$(DOCKER inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}无健康检查{{end}}' "$name" 2>/dev/null || true)"
  printf '  %-15s %s：%s（健康：%s）\n' "$name" "$label" "$state" "${health:-未知}"
}

case "$ACTION" in
  start|up)
    echo "==> 启动 DeepSeek Harness 容器..."
    ensure_container
    if ! container_running; then DOCKER start dsh >/dev/null; fi
    ensure_sidecars
    echo "==> Web UI: http://127.0.0.1:3080"
    ;;
  update)
    if ! container_exists; then
      echo "[错误] 容器尚未创建，请先运行 ./dsh.sh start。" >&2
      exit 1
    fi
    if ! container_running; then
      echo "[错误] 容器当前未运行，请先运行 ./dsh.sh start。" >&2
      exit 1
    fi
    echo "==> 在现有 Debian 13 容器内更新 DSH..."
    DOCKER exec dsh /usr/local/bin/update-dsh
    ;;
  stop)
    echo "==> 停止服务..."
    DOCKER compose "${COMPOSE_ARGS[@]}" stop dsh ${SIDECAR_SERVICES[@]+"${SIDECAR_SERVICES[@]}"}
    ;;
  remove|down)
    echo "==> 即将删除容器可写层；/data 和 /workspace 挂载数据不会删除。"
    DOCKER compose "${COMPOSE_ARGS[@]}" down
    ;;
  restart)
    echo "==> 重启服务..."
    DOCKER compose "${COMPOSE_ARGS[@]}" restart dsh ${SIDECAR_SERVICES[@]+"${SIDECAR_SERVICES[@]}"}
    ;;
  logs)
    # 默认跟随全部服务：隔离模式下 ingress / egress / broker 的日志和 dsh 自己的
    # 一样重要（被拒的出站请求只会出现在 egress 的审计日志里）。`logs <服务>` 只跟一个。
    shift || true
    if [ "$#" -gt 0 ]; then
      DOCKER compose "${COMPOSE_ARGS[@]}" logs -f "$@"
    else
      DOCKER compose "${COMPOSE_ARGS[@]}" logs -f
    fi
    ;;
  keys)
    if [ "$BROKER_ENABLED" != true ]; then
      echo "模型密钥代理未启用（.env 里 DSH_MODEL_BROKER 不是 on）：模型密钥现在直接放在 DSH 容器里，"
      echo "容器内任何进程（包括被提示注入的 Agent）都能读到它。"
      # 补填密钥不需要重建容器：docker-compose.keys.yml 只新增 dsh-key-broker，不改 dsh
      # 服务的定义，所以别让用户去手写 JSON 或重装——安装器有专门的动作干这件事。
      echo "启用方法：在这个目录里运行 ./install.sh model-key，按提示填上游名字、base_url 和密钥。"
      echo "它只写 data/broker/keys.json（0600）、翻 .env 里的开关、再新增 dsh-key-broker 容器，"
      echo "不会重建 dsh，容器里 apt 装过的东西不会丢。之后把 DSH 模型设置里的 base_url 改成"
      echo "http://dsh-key-broker:8080/u/<上游名字>/v1，api key 填任意占位串即可。"
      exit 0
    fi
    require_sidecar dsh-key-broker
    echo "==> dsh-key-broker /status："
    if ! DOCKER exec dsh-key-broker node -e "$(status_probe 8080)"; then
      echo "[错误] 读不到 dsh-key-broker 的 /status，容器可能刚起来或配置有问题，见 $0 logs dsh-key-broker。" >&2
      exit 1
    fi
    echo
    echo "说明：这里只显示上游名字与用量，密钥只存在于 data/broker/keys.json 与 broker 容器内存中。"
    echo "      它不会出现在这条输出、DSH 容器、compose 文件或 broker 的审计日志里。"
    ;;
  egress)
    if [ "$EGRESS_ENABLED" != true ]; then
      echo "出站白名单未启用（.env 里 DSH_EGRESS_MODE 不是 allowlist）：容器当前可以直接访问任意公网地址，"
      echo "被提示注入的 Agent 可以把数据 POST 到任何地方。"
      echo "启用方法：在 .env 里设置 DSH_EGRESS_MODE=allowlist（要额外放行域名就再写 DSH_EGRESS_ALLOWED_HOSTS），"
      echo "然后运行 $0 start。"
      exit 0
    fi
    require_sidecar dsh-egress
    echo "==> dsh-egress /status："
    if ! DOCKER exec dsh-egress node -e "$(status_probe 3128)"; then
      echo "[错误] 读不到 dsh-egress 的 /status，容器可能刚起来或配置有问题，见 $0 logs dsh-egress。" >&2
      exit 1
    fi
    echo
    echo "说明：allowlist 模式下 dsh 容器只挂 internal 网络，出网只有 dsh-egress 这一条路，"
    echo "      白名单外的域名会被直接拒绝。被拒的请求见 $0 logs dsh-egress。"
    ;;
  shell)
    # 默认进入非特权的 dsh 账户：这正是 DSH 与 Agent 实际运行的身份。
    DOCKER exec -it -u dsh dsh bash -l
    ;;
  root-shell)
    echo "==> 以容器 root 打开 shell（仅宿主机管理员通道，容器内无法这样提权）。"
    DOCKER exec -it dsh bash -l
    ;;
  verify)
    DOCKER exec dsh /usr/local/bin/verify-dsh-hardening
    ;;
  status|ps)
    DOCKER compose "${COMPOSE_ARGS[@]}" ps
    echo
    echo "==> 旁路容器："
    report_sidecar dsh-key-broker "模型密钥代理" "$BROKER_ENABLED" DSH_MODEL_BROKER=on
    report_sidecar dsh-egress "出站白名单代理" "$EGRESS_ENABLED" DSH_EGRESS_MODE=allowlist
    report_sidecar dsh-ingress "宿主 3080 入口" "$EGRESS_ENABLED" DSH_EGRESS_MODE=allowlist
    ;;
  *)
    echo "用法: $0 [start|update|stop|restart|logs [服务]|status|shell|root-shell|verify|keys|egress|remove]"
    echo "  keys    显示模型密钥代理（dsh-key-broker）的上游与用量，不显示密钥"
    echo "  egress  显示出站白名单代理（dsh-egress）的白名单规模与放行/拒绝计数"
    exit 1
    ;;
esac