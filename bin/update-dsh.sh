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

# 新版本起来了就没什么可回滚的，旧版本目录可以放掉。
# 回滚必须在本进程内完成：$OLD_DIR 在 $WORK_DIR 里，而 trap EXIT 会删掉整个
# $WORK_DIR，脚本一退出备份就没了。
rollback_to_previous() {
  echo "[dsh-update] 新版本未能就绪，回滚到更新前的版本" >&2
  rm -rf "$APP_DIR"
  if ! mv "$OLD_DIR" "$APP_DIR"; then
    write_status failed "DSH 已更新但无法启动，且回滚失败；请手动重建容器。原版本备份在 $OLD_DIR"
    return 1
  fi
  # 换回旧目录后目录内容变了，Supervisor 会重新拉起它。这里只负责把备份放回去并
  # 触发一次重启，就绪与否交给下面统一判断。
  "$RESTART_EXECUTABLE" check >/dev/null 2>&1 || {
    write_status failed 'DSH 已回滚到上一版本，但容器内 Supervisor 当前不可用，请手动执行 restart-dsh request'
    return 1
  }
  "$RESTART_EXECUTABLE" request 1 </dev/null >/dev/null 2>&1 || true
  if "$RESTART_EXECUTABLE" wait-ready "${DSH_UPDATE_ROLLBACK_TIMEOUT:-120}"; then
    write_status failed "DSH $NEW_VERSION 未能在超时时间内就绪，已自动回滚到更新前的版本，服务保持可用"
    return 0
  fi
  write_status failed "DSH $NEW_VERSION 未能就绪，回滚后服务仍未恢复，请检查容器日志"
  return 1
}

if [ "${DSH_UPDATE_NO_RESTART:-false}" != true ]; then
  if ! "$RESTART_EXECUTABLE" check; then
    write_status failed 'DSH 已更新，但容器内 Supervisor 当前不可用，请手动执行 restart-dsh request'
    exit 1
  fi
  # 同步等待旧子进程退出并由 Supervisor 拉起新进程，避免更新完成信号
  # 早于端口释放/插件树启动，导致网页看到半启动状态或 EADDRINUSE。
  #
  # 超时不能只报错就退出：这时 /app/dsh 已经是起不来的新版本，supervisor 会拿同一套
  # 坏目录无限重试，容器重启也清不掉，页面持续 502 且只能人工去修。所以这里把备份换
  # 回去，让服务继续可用——更新失败不该等于站点挂掉。
  if ! "$RESTART_EXECUTABLE" request 1 </dev/null >/dev/null 2>&1 || ! "$RESTART_EXECUTABLE" wait-ready "${DSH_UPDATE_READY_TIMEOUT:-120}"; then
    if [ "${DSH_UPDATE_NO_ROLLBACK:-false}" = true ]; then
      write_status failed 'DSH 已更新，但新进程未在超时时间内就绪，请检查容器日志'
      exit 1
    fi
    rollback_to_previous || exit 1
    # 回滚成功时状态已经是 failed 且说明了原因，退出码保持非零：
    # 调用方要能看出这次更新没有成功。
    exit 1
  fi
fi

