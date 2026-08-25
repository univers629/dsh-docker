#!/bin/sh
# 容器内更新 DSH：安装上游发布在 npm 上的预构建包，重新打产物补丁，
# 原子替换运行时目录，再让 Supervisor 只重启 DSH 进程（容器保持存活）。
#
# 这里不克隆源码、不编译，所以 1c1g 机器也能在几分钟内更新完。
set -eu

VERSION=${1:-${DSH_UPDATE_VERSION:-latest}}
PACKAGE=${DSH_NPM_PACKAGE:-@deepseek-ai/dsh}
APP_DIR=${DSH_APP_DIR:-/app/dsh}
STATE_DIR=${DSH_UPDATE_STATE:-/data/dsh/update}
STATE_FILE="$STATE_DIR/status.json"
STATUS_WRITER=${DSH_STATUS_WRITER:-/usr/local/lib/dsh/write-dsh-update-status.mjs}
INSTALLER=${DSH_RUNTIME_INSTALLER:-/usr/local/bin/install-dsh-runtime}
NGINX_CONFIG=${DSH_NGINX_CONFIG:-/usr/local/share/dsh/nginx.conf}
RESTART_EXECUTABLE=${DSH_RESTART_EXECUTABLE:-/usr/local/bin/restart-dsh}

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

  # 容器被强杀会把锁目录留在持久挂载里。只有记录的持有者已经消失时才回收。
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
STAGE_DIR="$WORK_DIR/runtime"

write_status running "正在安装 $PACKAGE@$VERSION 并重新打补丁"
if ! "$INSTALLER" "$STAGE_DIR" "$VERSION"; then
  write_status failed 'DSH 安装或补丁失败，当前版本保持不变'
  exit 1
fi

write_status running '正在原子替换 DSH 并检查 Nginx 配置'
OLD_DIR="$WORK_DIR/previous"
if ! mv "$APP_DIR" "$OLD_DIR"; then
  write_status failed '无法准备替换 DSH 目录，当前版本保持不变'
  exit 1
fi
if ! mv "$STAGE_DIR" "$APP_DIR"; then
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

NEW_VERSION="$(node -e 'const {readFileSync}=require("node:fs");try{process.stdout.write(JSON.parse(readFileSync(process.argv[1],"utf8")).version??"unknown")}catch{process.stdout.write("unknown")}' "$APP_DIR/DSH-BUILD-METADATA.json" 2>/dev/null || printf 'unknown')"
write_status success "DSH 已更新到 $NEW_VERSION，正在重启 DSH 进程"

if [ "${DSH_UPDATE_NO_RESTART:-false}" != true ]; then
  if ! "$RESTART_EXECUTABLE" check; then
    write_status failed 'DSH 已更新，但容器内 Supervisor 当前不可用，请手动执行 restart-dsh request'
    exit 1
  fi
  setsid "$RESTART_EXECUTABLE" request 1 </dev/null >/dev/null 2>&1 &
fi
