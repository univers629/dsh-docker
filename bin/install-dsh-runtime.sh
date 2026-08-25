#!/bin/sh
# 在容器内安装一套完整的 DSH 运行时：npm 预构建包 + 产物补丁 + 版本元数据。
#
# 用法: install-dsh-runtime <target-dir> [version]
#
# 镜像构建和容器内更新共用这一个脚本，所以两条路径产出的目录结构完全一致。
# 这里不克隆源码、不编译：上游把整套 @deepseek-ai/* 以预构建形式发布在 npm 上。
set -eu

TARGET_DIR=${1:?target directory is required}
VERSION=${2:-${DSH_NPM_VERSION:-latest}}
PACKAGE=${DSH_NPM_PACKAGE:-@deepseek-ai/dsh}
PATCH_DIR=${DSH_PATCH_DIR:-/etc/dsh-patches}
PATCH_APPLIER=${DSH_PATCH_APPLIER:-/usr/local/lib/dsh/apply-dsh-artifact-patches.mjs}
METADATA_WRITER=${DSH_METADATA_WRITER:-/usr/local/lib/dsh/write-dsh-metadata.mjs}

# npm 11 默认拦截依赖的安装脚本。这几个包需要脚本才能落地原生产物
# （node-pty 的 pty.node、koffi 的预编译库、subprocess 的 spawn helper）。
ALLOW_SCRIPTS=${DSH_NPM_ALLOW_SCRIPTS:-@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs}

mkdir -p "$TARGET_DIR"

echo "[dsh] 正在安装 $PACKAGE@$VERSION"
npm install --global --prefix "$TARGET_DIR" \
  --no-audit --no-fund --loglevel=warn \
  --allow-scripts="$ALLOW_SCRIPTS" \
  "$PACKAGE@$VERSION"

MODULE_ROOT="$TARGET_DIR/lib/node_modules/$PACKAGE/node_modules"
if [ ! -d "$MODULE_ROOT" ]; then
  echo "[dsh] 安装结果不含依赖目录: $MODULE_ROOT" >&2
  exit 1
fi

# 相对软链：NODE_PATH 只认 <target>/node_modules，而这个目录整体搬走后
# （容器内更新是先装到临时目录再原子替换）相对链接依然有效。
ln -sfn "lib/node_modules/$PACKAGE/node_modules" "$TARGET_DIR/node_modules"

node "$PATCH_APPLIER" "$TARGET_DIR/node_modules"
node "$METADATA_WRITER" "$TARGET_DIR" "$PATCH_DIR" "$TARGET_DIR/DSH-BUILD-METADATA.json"
