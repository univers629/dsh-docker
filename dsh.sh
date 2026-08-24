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
  USE_SYSTEM_VOLUMES=true
  SYSTEM_DIRS=(
    data/system/usr/bin data/system/usr/sbin data/system/usr/lib
    data/system/usr/share data/system/usr/include data/system/usr/libexec
    data/system/usr/games data/system/usr/src data/system/etc
    data/system/var/lib data/system/var/cache data/system/var/backups
  )
  mkdir -p "${SYSTEM_DIRS[@]}"
  COMPOSE_ARGS=(-f docker-compose.yml -f docker-compose.system.yml)
else
  USE_SYSTEM_VOLUMES=false
  COMPOSE_ARGS=(-f docker-compose.yml)
fi

PREPARE_SYSTEM_VOLUMES() {
  [ "$USE_SYSTEM_VOLUMES" = true ] || return 0

  local seed_container relative target failed
  seed_container="$(DOCKER create dsh:local)"
  failed=false
  for relative in \
    usr/bin usr/sbin usr/lib usr/share usr/include usr/libexec \
    usr/games usr/src etc var/lib var/cache var/backups; do
    target="data/system/$relative"
    if [ -z "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      echo "==> 初始化系统卷 /$relative ..."
      if ! DOCKER cp -a "$seed_container:/$relative/." "$target/"; then
        failed=true
        break
      fi
    fi
  done
  DOCKER rm -f "$seed_container" >/dev/null 2>&1 || true
  [ "$failed" = false ]
}

CLEANUP_BUILD_LEFTOVERS() {
  echo "==> 清理悬空镜像..."
  DOCKER image prune -f >/dev/null 2>&1 || true
}

case "$ACTION" in
  start|up)
    echo "==> 启动 DeepSeek Harness 容器..."
    DOCKER compose "${COMPOSE_ARGS[@]}" build dsh
    PREPARE_SYSTEM_VOLUMES
    DOCKER compose "${COMPOSE_ARGS[@]}" up -d --force-recreate
    CLEANUP_BUILD_LEFTOVERS
    echo "==> Web UI: http://127.0.0.1:3080"
    ;;
  update)
    echo "==> [1/3] 从官方源码构建最新镜像..."
    DOCKER compose "${COMPOSE_ARGS[@]}" build dsh
    PREPARE_SYSTEM_VOLUMES
    echo "==> [2/3] 重启服务..."
    DOCKER compose "${COMPOSE_ARGS[@]}" up -d --force-recreate
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
