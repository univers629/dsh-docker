#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "==================================================="
echo "  DeepSeek Harness 源码一键构建与更新"
echo "==================================================="
echo

if ! command -v docker &>/dev/null; then
  echo "[错误] 未检测到 Docker，请先安装 Docker 后重试。"
  exit 1
fi

if docker info >/dev/null 2>&1; then
  DOCKER() { docker "$@"; }
else
  DOCKER() { sudo docker "$@"; }
fi

echo "==> [1/3] 从官方源码构建最新镜像..."
DOCKER compose build --no-cache dsh

echo "==> [2/3] 重启服务..."
DOCKER compose up -d

echo "==> [3/3] 自动清理临时构建缓存..."
DOCKER image prune -f

echo
echo "==================================================="
echo "  更新构建完成！"
echo "  Web UI:   http://127.0.0.1:3080"
echo "  查看日志: docker compose logs -f dsh"
echo "==================================================="