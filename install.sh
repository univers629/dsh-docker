#!/usr/bin/env bash
set -euo pipefail

RUN_AS_ROOT_OVERRIDE=""
for arg in "$@"; do
  case "$arg" in
    --root|--run-as-root)
      if [ "$RUN_AS_ROOT_OVERRIDE" = false ]; then
        echo "[错误] --root 与 --user 不能同时使用。" >&2
        exit 2
      fi
      RUN_AS_ROOT_OVERRIDE=true
      ;;
    --user|--normal-user|--no-root)
      if [ "$RUN_AS_ROOT_OVERRIDE" = true ]; then
        echo "[错误] --root 与 --user 不能同时使用。" >&2
        exit 2
      fi
      RUN_AS_ROOT_OVERRIDE=false
      ;;
    *)
      echo "[错误] 未知参数：$arg（支持 --root 或 --user）。" >&2
      exit 2
      ;;
  esac
done

set_compose_env() {
  local key="$1" value="$2" file=".env" temporary
  temporary="$(mktemp "${file}.tmp.XXXXXX")"
  if [ -f "$file" ]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { replaced = 0 }
      $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
        if (!replaced) { print key "=" value; replaced = 1 }
        next
      }
      { print }
      END { if (!replaced) print key "=" value }
    ' "$file" > "$temporary"
  else
    printf '%s=%s\n' "$key" "$value" > "$temporary"
  fi
  mv "$temporary" "$file"
}

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
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    chown -R "$SUDO_USER:$SUDO_USER" "$TARGET_DIR" 2>/dev/null || true
  fi
fi

cd "$TARGET_DIR"
chmod +x dsh.sh 2>/dev/null || true

if [ -n "$RUN_AS_ROOT_OVERRIDE" ]; then
  set_compose_env DSH_RUN_AS_ROOT "$RUN_AS_ROOT_OVERRIDE"
  echo "==> DSH 运行模式：$([ "$RUN_AS_ROOT_OVERRIDE" = true ] && printf 'root（仅容器内）' || printf '普通用户 node')"
fi

echo "==> [2/2] 正在本地构建并启动 DeepSeek Harness 容器..."
DOCKER compose up -d --build --force-recreate

if DOCKER network inspect dpanel-local >/dev/null 2>&1; then
  echo "==> 检测到 dpanel 面板环境，已自动打通 dpanel 容器反代网桥！"
  DOCKER network connect --alias dsh.pod.dpanel.local dpanel-local dsh 2>/dev/null || true
fi

echo
echo "==================================================="
echo "  安装完成！"
echo "  Web UI:   http://127.0.0.1:3080"
echo "  日常管理: ./dsh.sh [start|update|stop|logs]"
echo "==================================================="
