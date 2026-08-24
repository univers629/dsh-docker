#!/bin/sh
set -eu

export NODE_PATH="/app/dsh/node_modules:/data/dsh/profiles/node_modules:${NODE_PATH:-}"

if [ "$(id -u)" != 0 ]; then
  echo "[dsh] the container entrypoint requires UID 0" >&2
  exit 77
fi

/usr/local/bin/configure-nginx-auth

# Detect the actual container userspace and architecture. These values do not
# imply access to the host kernel, host filesystem, or Docker daemon.
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

DSH_CONTAINER_USER=root
DSH_CONTAINER_UID=0
DSH_CONTAINER_GID=0
DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"
DSH_HOST_ACCESS="${DSH_HOST_ACCESS:-mounted-paths-only}"
DSH_WRITABLE_PATHS="${DSH_WRITABLE_PATHS:-/data/dsh,/data/home,/data/mcp,/data/agents,/workspace}"
DSH_SYSTEM_PACKAGES_PERSISTENT="${DSH_SYSTEM_PACKAGES_PERSISTENT:-true}"
DSH_CAN_INSTALL_SYSTEM_PACKAGES=true
if [ -S /var/run/docker.sock ]; then
  DSH_DOCKER_SOCKET_AVAILABLE=true
else
  DSH_DOCKER_SOCKET_AVAILABLE=false
fi
export DSH_SYSTEM_OS DSH_SYSTEM_RELEASE DSH_SYSTEM_ARCH \
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
      gsub(/@@DSH_PERMISSION_MODE@@/, ENVIRON["DSH_PERMISSION_MODE"])
      gsub(/@@DSH_HOST_ACCESS@@/, ENVIRON["DSH_HOST_ACCESS"])
      gsub(/@@DSH_WRITABLE_PATHS@@/, ENVIRON["DSH_WRITABLE_PATHS"])
      gsub(/@@DSH_SYSTEM_PACKAGES_PERSISTENT@@/, ENVIRON["DSH_SYSTEM_PACKAGES_PERSISTENT"])
      gsub(/@@DSH_CAN_INSTALL_SYSTEM_PACKAGES@@/, ENVIRON["DSH_CAN_INSTALL_SYSTEM_PACKAGES"])
      gsub(/@@DSH_DOCKER_SOCKET_AVAILABLE@@/, ENVIRON["DSH_DOCKER_SOCKET_AVAILABLE"])
      print
    }
  ' "$template" > "$temporary"

  install -m 600 "$temporary" "$target"
  rm -f "$temporary"
}

mkdir -p /workspace /data/dsh/profiles
rm -rf "$DSH_HOME/profiles/node_modules" "$DSH_HOME/node_modules" 2>/dev/null || true

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
  install -m 600 /usr/local/share/dsh-home/cordis.patch.yml "$DSH_HOME/cordis.patch.yml"
fi

find /data -name "*credentials*" -exec chmod 600 {} + 2>/dev/null || true
find /data -name ".*credentials*" -exec chmod 600 {} + 2>/dev/null || true
if [ -d "$HOME/.ssh" ]; then
  chmod 700 "$HOME/.ssh"
  find "$HOME/.ssh" -type f -exec chmod 600 {} + 2>/dev/null || true
  find "$HOME/.ssh" -type f -name "*.pub" -exec chmod 644 {} + 2>/dev/null || true
  find "$HOME/.ssh" -type f -name "known_hosts*" -exec chmod 644 {} + 2>/dev/null || true
fi

render_container_skill

if [ -f "$DSH_HOME/.credentials.yaml" ]; then
  chmod 600 "$DSH_HOME/.credentials.yaml" 2>/dev/null || true
fi
if [ ! -f "$HOME/.npmrc" ]; then
  printf "prefix=%s/.npm-global\n" "$HOME" > "$HOME/.npmrc"
fi

# The final DSH process keeps this PID, allowing the control helper to signal
# only the intended service process.
printf '%s\n' "$$" > /run/dsh.pid
chmod 644 /run/dsh.pid

nginx -c /usr/local/share/dsh/nginx.conf -g "daemon off;" &
sleep 1
echo "[dsh] starting DSH as root inside the container" >&2
exec /usr/local/bin/dsh "$@"
