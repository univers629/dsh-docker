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
elif [ -d "$TARGET_DIR/.git" ]; then
  echo "==> [1/2] 正在同步工程文件..."
  if ! git -C "$TARGET_DIR" diff --quiet || ! git -C "$TARGET_DIR" diff --cached --quiet; then
    echo "[错误] $TARGET_DIR 中存在未提交的源码修改，已停止以避免覆盖。请先提交、保存或清理这些修改后重试。" >&2
    exit 1
  fi
  if ! git -C "$TARGET_DIR" fetch origin main; then
    echo "[错误] 无法从 GitHub 获取最新工程文件，已保留现有安装。" >&2
    exit 1
  fi
  if ! git -C "$TARGET_DIR" merge --ff-only FETCH_HEAD; then
    echo "[错误] 本地工程无法 fast-forward 到 origin/main，请手动处理后重试。" >&2
    exit 1
  fi
else
  echo "[错误] $TARGET_DIR 已存在但不是 Git 工程，无法安全更新。请移动该目录后重试。" >&2
  exit 1
fi

cd "$TARGET_DIR"
chmod +x dsh.sh 2>/dev/null || true

if [ "$(uname -s)" = Linux ]; then
  SYSTEM_DIRS=(
    data/system/usr/bin data/system/usr/lib data/system/usr/share
    data/system/usr/sbin data/system/usr/include data/system/usr/libexec
    data/system/usr/games data/system/etc data/system/var/lib data/system/var/cache
  )
  mkdir -p "${SYSTEM_DIRS[@]}"
  COMPOSE_ARGS=(-f docker-compose.yml -f docker-compose.system.yml)
else
  COMPOSE_ARGS=(-f docker-compose.yml)
fi

if [ -n "$RUN_AS_ROOT_OVERRIDE" ]; then
  set_compose_env DSH_RUN_AS_ROOT "$RUN_AS_ROOT_OVERRIDE"
  echo "==> DSH 运行模式：$([ "$RUN_AS_ROOT_OVERRIDE" = true ] && printf 'root（仅容器内）' || printf '普通用户 node')"
fi

echo "==> [2/2] 正在本地构建并启动 DeepSeek Harness 容器..."
DOCKER compose "${COMPOSE_ARGS[@]}" up -d --build --force-recreate

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
