#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

# Compose 里 shell 环境变量的优先级高于 .env；清掉它们，保证运行时始终使用
# 安装器写入 .env 的访问模式、绑定地址和网络配置。
unset DSH_ACCESS_MODE DSH_BIND_HOST DSH_TRUSTED_HOSTS DSH_DOCKER_NETWORK DSH_DOCKER_NETWORK_EXTERNAL
unset DSH_IMAGE DSH_IMAGE_SOURCE

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

COMPOSE_ARGS=(-f docker-compose.yml)

container_exists() {
  DOCKER container inspect dsh >/dev/null 2>&1
}

container_running() {
  [ "$(DOCKER inspect --format '{{.State.Status}}' dsh 2>/dev/null || true)" = running ]
}

# 安装器把镜像引用写进 .env；预构建安装用的是发布引用，不是 dsh:local。
env_value() {
  local key="$1" fallback="$2" value=""
  if [ -f .env ]; then
    value="$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env 2>/dev/null || true)"
  fi
  printf '%s' "${value:-$fallback}"
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

case "$ACTION" in
  start|up)
    echo "==> 启动 DeepSeek Harness 容器..."
    ensure_container
    if ! container_running; then DOCKER start dsh >/dev/null; fi
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
    DOCKER compose "${COMPOSE_ARGS[@]}" stop dsh
    ;;
  remove|down)
    echo "==> 即将删除容器可写层；/data 和 /workspace 挂载数据不会删除。"
    DOCKER compose "${COMPOSE_ARGS[@]}" down
    ;;
  restart)
    echo "==> 重启服务..."
    DOCKER compose "${COMPOSE_ARGS[@]}" restart dsh
    ;;
  logs)
    DOCKER compose "${COMPOSE_ARGS[@]}" logs -f dsh
    ;;
  shell)
    DOCKER exec -it dsh bash
    ;;
  status|ps)
    DOCKER compose "${COMPOSE_ARGS[@]}" ps
    ;;
  *)
    echo "用法: $0 [start|update|stop|restart|logs|status|shell|remove]"
    exit 1
    ;;
esac
