#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

# Compose 里 shell 环境变量的优先级高于 .env；清掉它们，保证运行时始终使用
# 安装器写入 .env 的访问模式、绑定地址和网络配置。
unset DSH_ACCESS_MODE DSH_BIND_HOST DSH_TRUSTED_HOSTS DSH_DOCKER_NETWORK DSH_DOCKER_NETWORK_EXTERNAL

ACTION="${1:-start}"

if ! command -v docker &>/dev/null; then
  echo "[错误] 未检测到 Docker，请先安装 Docker 后重试。"
  exit 1
fi

if docker info >/dev/null 2>&1; then
  DOCKER() { docker "$@"; }
else
  DOCKER() { sudo docker "$@"; }
fi

COMPOSE_ARGS=(-f docker-compose.yml)

container_exists() {
  DOCKER container inspect dsh >/dev/null 2>&1
}

container_running() {
  [ "$(DOCKER inspect --format '{{.State.Status}}' dsh 2>/dev/null || true)" = running ]
}

ensure_image() {
  if ! DOCKER image inspect dsh:local >/dev/null 2>&1; then
    echo "==> 首次创建容器，正在构建 Debian 13 镜像..."
    DOCKER compose "${COMPOSE_ARGS[@]}" build dsh
  fi
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
