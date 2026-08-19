#!/usr/bin/env bash
set -euo pipefail

echo "==================================================="
echo "  DeepSeek Harness (DSH) 一键安装与启动程序"
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

TARGET_DIR="dsh-docker"
if [ ! -d "$TARGET_DIR" ]; then
  echo "==> [1/2] 正在获取工程文件..."
  if command -v git &>/dev/null; then
    git clone https://github.com/univers629/dsh-docker-dev.git "$TARGET_DIR"
  else
    mkdir -p "$TARGET_DIR"
    curl -fsSL https://github.com/univers629/dsh-docker-dev/archive/refs/heads/main.tar.gz | tar -xz -C "$TARGET_DIR" --strip-components=1
  fi
fi

cd "$TARGET_DIR"
chmod +x dsh.sh 2>/dev/null || true

echo "==> [2/2] 正在本地构建并启动 DeepSeek Harness 容器..."
DOCKER compose up -d --build

echo
echo "==================================================="
echo "  安装完成！"
echo "  Web UI:   http://127.0.0.1:3080"
echo "  日常管理: ./dsh.sh [start|update|stop|logs]"
echo "==================================================="
