#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "==================================================="
echo "  DeepSeek Harness (DSH) 本地启动程序"
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

echo "==> 正在构建并启动 DeepSeek Harness 容器..."
DOCKER compose up -d --build

echo
echo "==================================================="
echo "  启动完成！"
echo "  Web UI:   http://127.0.0.1:3080"
echo "  查看日志: docker compose logs -f dsh"
echo "  停止服务: docker compose down"
echo "==================================================="
