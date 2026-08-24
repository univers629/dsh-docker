#!/bin/sh
set -eu

export NODE_PATH="/app/dsh/node_modules:/data/dsh/profiles/node_modules:${NODE_PATH:-}"

/usr/local/bin/configure-nginx-auth

# Normalize the runtime policy before the setup below and expose the actual
# container facts to DSH and its skills. These values describe the container;
# they never imply access to the host kernel or host filesystem.
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

if [ -z "${DSH_SYSTEM_ARCH:-}" ]; then
  DSH_SYSTEM_ARCH="$(uname -m 2>/dev/null || printf 'unknown')"
fi
if [ -z "${DSH_SYSTEM_OS:-}" ] || [ -z "${DSH_SYSTEM_RELEASE:-}" ]; then
  if [ -r /etc/os-release ]; then
    . /etc/os-release
  fi
  DSH_SYSTEM_OS="${DSH_SYSTEM_OS:-${NAME:-Linux}}"
  DSH_SYSTEM_RELEASE="${DSH_SYSTEM_RELEASE:-${VERSION_ID:-unknown}}"
fi
if [ -z "${DSH_SYSTEM_PACKAGE_ARCH:-}" ]; then
  DSH_SYSTEM_PACKAGE_ARCH="$(dpkg --print-architecture 2>/dev/null || printf '%s' "$DSH_SYSTEM_ARCH")"
fi
if [ -z "${DSH_SYSTEM_ABI:-}" ]; then
  DSH_SYSTEM_ABI="$(gcc -dumpmachine 2>/dev/null || dpkg-architecture -qDEB_HOST_GNU_TYPE 2>/dev/null || printf '%s-linux-gnu' "$DSH_SYSTEM_ARCH")"
fi
if [ -z "${DSH_SYSTEM_LIBC:-}" ]; then
  if ldd --version 2>&1 | grep -qi musl; then
    DSH_SYSTEM_LIBC=musl
  else
    DSH_SYSTEM_LIBC=glibc
  fi
fi

if [ "$DSH_RUN_AS_ROOT" = true ]; then
  DSH_CONTAINER_USER=root
  DSH_CONTAINER_UID=0
  DSH_CONTAINER_GID=0
else
  DSH_CONTAINER_USER=node
  DSH_CONTAINER_UID="$(id -u node 2>/dev/null || printf '1000')"
  DSH_CONTAINER_GID="$(id -g node 2>/dev/null || printf '1000')"
fi

DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"
DSH_HOST_ACCESS="${DSH_HOST_ACCESS:-mounted-paths-only}"
DSH_WRITABLE_PATHS="${DSH_WRITABLE_PATHS:-/data/dsh,/data/home,/data/mcp,/data/agents,/workspace}"
DSH_SYSTEM_PACKAGES_PERSISTENT="${DSH_SYSTEM_PACKAGES_PERSISTENT:-false}"
if [ "$DSH_RUN_AS_ROOT" = true ]; then
  DSH_CAN_INSTALL_SYSTEM_PACKAGES=true
else
  DSH_CAN_INSTALL_SYSTEM_PACKAGES=false
fi
if [ -S /var/run/docker.sock ]; then
  DSH_DOCKER_SOCKET_AVAILABLE=true
else
  DSH_DOCKER_SOCKET_AVAILABLE=false
fi
export DSH_RUN_AS_ROOT DSH_SYSTEM_OS DSH_SYSTEM_RELEASE DSH_SYSTEM_ARCH \
  DSH_SYSTEM_PACKAGE_ARCH DSH_SYSTEM_ABI DSH_SYSTEM_LIBC DSH_CONTAINER_USER \
  DSH_CONTAINER_UID DSH_CONTAINER_GID \
  DSH_PERMISSION_MODE DSH_HOST_ACCESS DSH_WRITABLE_PATHS \
  DSH_SYSTEM_PACKAGES_PERSISTENT DSH_CAN_INSTALL_SYSTEM_PACKAGES \
  DSH_DOCKER_SOCKET_AVAILABLE

render_container_skill() {
  template=/usr/local/share/dsh-home/skills/container-environment/SKILL.md
  target="$DSH_HOME/skills/container-environment/SKILL.md"
  temporary="${target}.tmp.$$"

  mkdir -p "$(dirname "$target")"
  awk '
    {
      gsub(/@@DSH_SYSTEM_ARCH@@/, ENVIRON["DSH_SYSTEM_ARCH"])
      gsub(/@@DSH_SYSTEM_OS@@/, ENVIRON["DSH_SYSTEM_OS"])
      gsub(/@@DSH_SYSTEM_RELEASE@@/, ENVIRON["DSH_SYSTEM_RELEASE"])
      gsub(/@@DSH_SYSTEM_PACKAGE_ARCH@@/, ENVIRON["DSH_SYSTEM_PACKAGE_ARCH"])
      gsub(/@@DSH_SYSTEM_ABI@@/, ENVIRON["DSH_SYSTEM_ABI"])
      gsub(/@@DSH_SYSTEM_LIBC@@/, ENVIRON["DSH_SYSTEM_LIBC"])
      gsub(/@@DSH_CONTAINER_USER@@/, ENVIRON["DSH_CONTAINER_USER"])
      gsub(/@@DSH_CONTAINER_UID@@/, ENVIRON["DSH_CONTAINER_UID"])
      gsub(/@@DSH_CONTAINER_GID@@/, ENVIRON["DSH_CONTAINER_GID"])
      gsub(/@@DSH_RUN_AS_ROOT@@/, ENVIRON["DSH_RUN_AS_ROOT"])
      gsub(/@@DSH_PERMISSION_MODE@@/, ENVIRON["DSH_PERMISSION_MODE"])
      gsub(/@@DSH_HOST_ACCESS@@/, ENVIRON["DSH_HOST_ACCESS"])
      gsub(/@@DSH_WRITABLE_PATHS@@/, ENVIRON["DSH_WRITABLE_PATHS"])
      gsub(/@@DSH_SYSTEM_PACKAGES_PERSISTENT@@/, ENVIRON["DSH_SYSTEM_PACKAGES_PERSISTENT"])
      gsub(/@@DSH_CAN_INSTALL_SYSTEM_PACKAGES@@/, ENVIRON["DSH_CAN_INSTALL_SYSTEM_PACKAGES"])
      gsub(/@@DSH_DOCKER_SOCKET_AVAILABLE@@/, ENVIRON["DSH_DOCKER_SOCKET_AVAILABLE"])
      print
    }
  ' "$template" > "$temporary"

  if [ "$(id -u)" = 0 ]; then
    install -o node -g node -m 600 "$temporary" "$target"
    rm -f "$temporary"
  else
    chmod 600 "$temporary"
    mv -f "$temporary" "$target"
  fi
}

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
    install -o node -g node -m 600 /usr/local/share/dsh-home/cordis.patch.yml "$DSH_HOME/cordis.patch.yml"
  fi

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

render_container_skill

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
  gosu node nginx -c /usr/local/share/dsh/nginx.conf -g "daemon off;" &
  sleep 1
  if [ "$DSH_RUN_AS_ROOT" = true ]; then
    echo "[dsh] starting DSH as root inside the container (explicit opt-in)" >&2
    exec /usr/local/bin/dsh "$@"
  fi
  echo "[dsh] starting DSH as unprivileged node inside the container" >&2
  exec gosu node /usr/local/bin/dsh "$@"
else
  nginx -c /usr/local/share/dsh/nginx.conf -g "daemon off;" &
  sleep 1
  echo "[dsh] starting DSH as current container user" >&2
  exec /usr/local/bin/dsh "$@"
fi
