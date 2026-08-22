#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

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

if [ "$(uname -s)" = Linux ]; then
  SYSTEM_DIRS=(
    data/system/usr/bin data/system/usr/lib data/system/usr/share
    data/system/usr/include data/system/usr/libexec
    data/system/usr/games data/system/etc data/system/var/lib data/system/var/cache
  )
  mkdir -p "${SYSTEM_DIRS[@]}"
  COMPOSE_ARGS=(-f docker-compose.yml -f docker-compose.system.yml)
else
  COMPOSE_ARGS=(-f docker-compose.yml)
fi

ENSURE_NETWORKS() {
  if DOCKER network inspect dpanel-local >/dev/null 2>&1; then
    DOCKER network connect --alias dsh.pod.dpanel.local dpanel-local dsh 2>/dev/null || true
  fi
}

CLEANUP_BUILD_LEFTOVERS() {
  echo "==> 清理悬空镜像..."
  DOCKER image prune -f >/dev/null 2>&1 || true
}

case "$ACTION" in
  start|up)
    echo "==> 启动 DeepSeek Harness 容器..."
    DOCKER compose "${COMPOSE_ARGS[@]}" up -d --build --force-recreate
    ENSURE_NETWORKS
    CLEANUP_BUILD_LEFTOVERS
    echo "==> Web UI: http://127.0.0.1:3080"
    ;;
  update)
    echo "==> [1/3] 从官方源码构建最新镜像..."
    DOCKER compose "${COMPOSE_ARGS[@]}" build dsh
    echo "==> [2/3] 重启服务..."
    DOCKER compose "${COMPOSE_ARGS[@]}" up -d --force-recreate
    ENSURE_NETWORKS
    echo "==> [3/3] 自动清理悬空垃圾镜像..."
    CLEANUP_BUILD_LEFTOVERS
    echo "==> 更新构建完成！"
    ;;
  stop|down)
    echo "==> 停止服务..."
    DOCKER compose "${COMPOSE_ARGS[@]}" down
    ;;
  restart)
    echo "==> 重启服务..."
    DOCKER compose "${COMPOSE_ARGS[@]}" restart dsh
    ENSURE_NETWORKS
    ;;
  logs)
    DOCKER compose "${COMPOSE_ARGS[@]}" logs -f dsh
    ;;
  status|ps)
    DOCKER compose "${COMPOSE_ARGS[@]}" ps
    ;;
  *)
    echo "用法: $0 [start|update|stop|restart|logs|status]"
    exit 1
    ;;
esac
