#!/bin/sh
set -eu

export NODE_PATH="/app/dsh/node_modules:/data/dsh/profiles/node_modules:${NODE_PATH:-}"

/usr/local/bin/configure-nginx-auth

if [ "$(id -u)" = "0" ]; then
  mkdir -p /workspace /data/dsh/profiles
  rm -rf /home/node 2>/dev/null || true
  ln -sfn /data/home /home/node
  chown -h node:node /home/node 2>/dev/null || true
  
  # 清理旧的 profiles/node_modules 软链缓存
  rm -rf "$DSH_HOME/profiles/node_modules" "$DSH_HOME/node_modules" 2>/dev/null || true
  
  # 执行模块绝对路径软链映射
  if [ -f /usr/local/bin/link-modules.mjs ]; then
    node /usr/local/bin/link-modules.mjs
  fi

  if [ -f /usr/local/bin/install-docker-control.mjs ]; then
    node /usr/local/bin/install-docker-control.mjs
  fi

  if [ -f /usr/local/bin/patch-profile-plugins.mjs ]; then
    node /usr/local/bin/patch-profile-plugins.mjs
  fi

  if [ ! -f "$DSH_HOME/cordis.patch.yml" ]; then
    install -o node -g node -m 600 /etc/dsh-home/cordis.patch.yml "$DSH_HOME/cordis.patch.yml"
  fi

  mkdir -p "$DSH_HOME/skills/container-environment"
  cp -f /etc/dsh-home/skills/container-environment/SKILL.md "$DSH_HOME/skills/container-environment/SKILL.md"

  # 关键：递归且包含软链接(-h)将 /data 和 /workspace 归属完整转移给 node 用户
  chown -R -h node:node /data /workspace /home/node 2>/dev/null || chown -R node:node /data /workspace /home/node 2>/dev/null || true
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

if [ ! -f "$HOME/.npmrc" ]; then
  printf "prefix=%s/.npm-global\n" "$HOME" > "$HOME/.npmrc"
  chown node:node "$HOME/.npmrc" 2>/dev/null || true
fi

# Record the entrypoint PID before exec. The final dsh process keeps this PID,
# allowing the plugin helper to signal only the intended DSH process.
printf '%s\n' "$$" > /run/dsh.pid
chmod 644 /run/dsh.pid

case "${DSH_RUN_AS_ROOT:-true}" in
  true|1|yes|on)
    DSH_RUN_AS_ROOT=true
    ;;
  false|0|no|off|'')
    DSH_RUN_AS_ROOT=false
    ;;
  *)
    echo "[dsh] invalid DSH_RUN_AS_ROOT=${DSH_RUN_AS_ROOT}; expected true or false" >&2
    exit 64
    ;;
esac

if [ "$DSH_RUN_AS_ROOT" = true ] && [ "$(id -u)" != 0 ]; then
  echo "[dsh] DSH_RUN_AS_ROOT=true requires the container entrypoint to run as UID 0" >&2
  exit 77
fi

if [ "$(id -u)" = "0" ]; then
  # Nginx creates its temp directories as the configured worker user when they
  # do not exist. This image runs the master and worker as `node`, while the
  # distro default user is `nobody`; pre-create the paths explicitly so large
  # proxied JS/assets never fail when Nginx spills a response to disk.
  mkdir -p \
    /tmp/nginx-body \
    /tmp/nginx-proxy \
    /tmp/nginx-fcgi \
    /tmp/nginx-uwsgi \
    /tmp/nginx-scgi
  chown -R node:node \
    /tmp/nginx-body \
    /tmp/nginx-proxy \
    /tmp/nginx-fcgi \
    /tmp/nginx-uwsgi \
    /tmp/nginx-scgi
  chmod 700 \
    /tmp/nginx-body \
    /tmp/nginx-proxy \
    /tmp/nginx-fcgi \
    /tmp/nginx-uwsgi \
    /tmp/nginx-scgi
  gosu node nginx -c /etc/dsh/nginx.conf -g "daemon off;" &
  sleep 1
  if [ "$DSH_RUN_AS_ROOT" = true ]; then
    echo "[dsh] starting DSH as root inside the container (explicit opt-in)" >&2
    exec /usr/local/bin/dsh "$@"
  fi
  echo "[dsh] starting DSH as unprivileged node inside the container" >&2
  exec gosu node /usr/local/bin/dsh "$@"
else
  nginx -c /etc/dsh/nginx.conf -g "daemon off;" &
  sleep 1
  echo "[dsh] starting DSH as current container user" >&2
  exec /usr/local/bin/dsh "$@"
fi
