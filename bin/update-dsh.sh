#!/bin/sh
set -eu

SOURCE_REPO=${DSH_UPSTREAM_REPO:-https://github.com/deepseek-ai/deepseek-harness.git}
SOURCE_REF=${DSH_UPSTREAM_REF:-master}
PATCH_DIR=${DSH_PATCH_DIR:-/etc/dsh-patches}
APP_DIR=${DSH_APP_DIR:-/app/dsh}
STATE_DIR=${DSH_UPDATE_STATE:-/data/dsh/update}
STATE_FILE="$STATE_DIR/status.json"
BUILD_FIX=${DSH_BUILD_FIX:-/usr/local/lib/dsh/build-fix.mjs}
METADATA_WRITER=${DSH_METADATA_WRITER:-/usr/local/lib/dsh/write-dsh-metadata.mjs}
STATUS_WRITER=${DSH_STATUS_WRITER:-/usr/local/lib/dsh/write-dsh-update-status.mjs}
NGINX_CONFIG=${DSH_NGINX_CONFIG:-/usr/local/share/dsh/nginx.conf}

mkdir -p "$STATE_DIR"

write_status() {
  node "$STATUS_WRITER" "$STATE_FILE" "$1" "$2" || true
}

LOCK_DIR="$STATE_DIR/.lock"
WORK_DIR=""

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  lock_pid=""
  if [ -r "$LOCK_DIR/pid" ]; then
    lock_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  fi
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    write_status running '已有一个 DSH 更新任务正在执行'
    exit 75
  fi

  # A killed container can leave the lock directory in the persistent state
  # mount. It is safe to reclaim it only when its recorded owner is gone.
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

acquire_lock
trap 'rm -rf "$LOCK_DIR" "$WORK_DIR" 2>/dev/null || true' EXIT HUP INT TERM

if [ "$(id -u)" != 0 ]; then
  write_status failed 'DSH 更新需要容器内 root 权限'
  exit 77
fi

WORK_DIR="$(mktemp -d /tmp/dsh-update.XXXXXX)"
SOURCE_DIR="$WORK_DIR/source"
write_status running '正在拉取 DSH 源码'

if ! git clone --depth 1 --branch "$SOURCE_REF" "$SOURCE_REPO" "$SOURCE_DIR"; then
  write_status failed '拉取 DSH 源码失败'
  exit 1
fi

write_status running '正在应用 DSH 补丁'
if ! /usr/local/bin/apply-dsh-patches "$SOURCE_DIR" "$PATCH_DIR"; then
  write_status failed 'DSH 补丁无法应用，当前版本保持不变'
  exit 1
fi

cd "$SOURCE_DIR"
write_status running '正在安装构建依赖'
if ! pnpm install --frozen-lockfile; then
  write_status failed 'DSH 依赖安装失败，当前版本保持不变'
  exit 1
fi

write_status running '正在编译 DSH'
if ! NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}" pnpm run build:official; then
  write_status failed 'DSH 编译失败，当前版本保持不变'
  exit 1
fi
if ! DSH_BUILD_APP_DIR="$SOURCE_DIR" NODE_PATH="$SOURCE_DIR/node_modules:/usr/local/lib/node_modules" node "$BUILD_FIX"; then
  write_status failed 'DSH 构建整理失败，当前版本保持不变'
  exit 1
fi

if ! node "$METADATA_WRITER" "$SOURCE_DIR" "$PATCH_DIR" "$SOURCE_DIR/DSH-BUILD-METADATA.json"; then
  write_status failed 'DSH 版本元数据生成失败，当前版本保持不变'
  exit 1
fi
rm -rf "$SOURCE_DIR/.git" "$SOURCE_DIR/docs" "$SOURCE_DIR/.agents" "$SOURCE_DIR/examples" "$SOURCE_DIR/node_modules/.cache"
find "$SOURCE_DIR" -name '*.tsbuildinfo' -delete 2>/dev/null || true

write_status running '正在原子替换 DSH 并检查 Nginx 配置'
OLD_DIR="$WORK_DIR/previous"
if ! mv "$APP_DIR" "$OLD_DIR"; then
  write_status failed '无法准备替换 DSH 目录，当前版本保持不变'
  exit 1
fi
if ! mv "$SOURCE_DIR" "$APP_DIR"; then
  mv "$OLD_DIR" "$APP_DIR" 2>/dev/null || true
  write_status failed '无法安装新 DSH，当前版本已恢复'
  exit 1
fi

if ! nginx -t -c "$NGINX_CONFIG"; then
  rm -rf "$APP_DIR"
  mv "$OLD_DIR" "$APP_DIR"
  write_status failed 'Nginx 配置检查失败，当前版本已恢复'
  exit 1
fi

write_status success 'DSH 更新完成，正在重启服务'

if [ "${DSH_UPDATE_NO_RESTART:-false}" != true ] && [ -f /run/dsh.pid ]; then
  kill -TERM "$(cat /run/dsh.pid)" 2>/dev/null || true
fi
