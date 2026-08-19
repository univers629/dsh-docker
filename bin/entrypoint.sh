#!/bin/sh
set -eu

export NODE_PATH="/app/dsh/node_modules:/data/dsh/profiles/node_modules:${NODE_PATH:-}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/home/tmp /workspace /data/dsh/profiles
  rm -rf /home/node 2>/dev/null || true
  ln -sfn /data/home /home/node
  chown -h node:node /home/node 2>/dev/null || true
  
  # 清理旧的 profiles/node_modules 软链缓存，确保全新绝对路径映射
  rm -rf "$DSH_HOME/profiles/node_modules" "$DSH_HOME/node_modules" 2>/dev/null || true
  
  chown -R node:node /data /workspace
  chmod -R u+rwX,g+rwX /data /workspace
  find /data -name "*credentials*" -exec chmod 600 {} + 2>/dev/null || true
  find /data -name ".*credentials*" -exec chmod 600 {} + 2>/dev/null || true
  if [ -d "$HOME/.ssh" ]; then
    chmod 700 "$HOME/.ssh"
    find "$HOME/.ssh" -type f -exec chmod 600 {} + 2>/dev/null || true
    find "$HOME/.ssh" -type f -name "*.pub" -exec chmod 644 {} + 2>/dev/null || true
    find "$HOME/.ssh" -type f -name "known_hosts*" -exec chmod 644 {} + 2>/dev/null || true
  fi
fi

if [ -f "$DSH_HOME/.credentials.yaml" ]; then
  chmod 600 "$DSH_HOME/.credentials.yaml" 2>/dev/null || true
fi

# 关键：以绝对路径映射建立所有工作区包及依赖的 ESM 软链通道
if [ -f /usr/local/bin/link-modules.mjs ]; then
  node /usr/local/bin/link-modules.mjs
fi

if [ ! -f "$DSH_HOME/cordis.patch.yml" ]; then
  install -o node -g node -m 600 /etc/dsh-home/cordis.patch.yml "$DSH_HOME/cordis.patch.yml"
fi

mkdir -p "$DSH_HOME/skills/container-environment"
cp -f /etc/dsh-home/skills/container-environment/SKILL.md "$DSH_HOME/skills/container-environment/SKILL.md"
chown -R node:node "$DSH_HOME/skills"

if [ ! -f "$HOME/.npmrc" ]; then
  printf "prefix=%s/.npm-global\n" "$HOME" > "$HOME/.npmrc"
  chown node:node "$HOME/.npmrc"
fi

if [ "$(id -u)" = "0" ]; then
  gosu node nginx -c /etc/dsh/nginx.conf -g "daemon off;" &
  sleep 1
  exec gosu node /usr/local/bin/dsh "$@"
else
  nginx -c /etc/dsh/nginx.conf -g "daemon off;" &
  sleep 1
  exec /usr/local/bin/dsh "$@"
fi