#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

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

ENSURE_NETWORKS() {
  if DOCKER network inspect dpanel-local >/dev/null 2>&1; then
    DOCKER network connect --alias dsh.pod.dpanel.local dpanel-local dsh 2>/dev/null || true
  fi
}

case "$ACTION" in
  start|up)
    echo "==> 启动 DeepSeek Harness 容器..."
    DOCKER compose up -d --build
    ENSURE_NETWORKS
    echo "==> Web UI: http://127.0.0.1:3080"
    ;;
  update)
    echo "==> [1/3] 从官方源码构建最新镜像..."
    DOCKER compose build --no-cache dsh
    echo "==> [2/3] 重启服务..."
    DOCKER compose up -d
    ENSURE_NETWORKS
    echo "==> [3/3] 自动清理临时构建缓存..."
    DOCKER image prune -f
    echo "==> 更新构建完成！"
    ;;
  stop|down)
    echo "==> 停止服务..."
    DOCKER compose down
    ;;
  restart)
    echo "==> 重启服务..."
    DOCKER compose restart dsh
    ENSURE_NETWORKS
    ;;
  logs)
    DOCKER compose logs -f dsh
    ;;
  status|ps)
    DOCKER compose ps
    ;;
  *)
    echo "用法: $0 [start|update|stop|restart|logs|status]"
    exit 1
    ;;
esac
