#!/bin/sh
set -eu

export NODE_PATH="/app/dsh/node_modules:/data/dsh/profiles/node_modules:${NODE_PATH:-}"

# 容器的 PID 1 仍然是 root：只有 root 能改挂载目录属主、写 /etc/shadow、以 root
# 运行特权代理并让 Nginx 主进程降权。DSH 本体、Agent 会话和 Nginx worker 都会被
# 降到非特权的 dsh 账户。
if [ "$(id -u)" != 0 ]; then
  echo "[dsh] the container entrypoint requires UID 0" >&2
  exit 77
fi

DSH_RUN_USER="${DSH_RUN_USER:-dsh}"
if ! DSH_RUN_UID="$(id -u "$DSH_RUN_USER" 2>/dev/null)"; then
  echo "[dsh] 镜像里缺少运行账户 $DSH_RUN_USER" >&2
  exit 78
fi
DSH_RUN_GID="$(id -g "$DSH_RUN_USER")"
# 运行账户的家目录取自 passwd，镜像不再给全容器设 HOME：root 侧的 docker exec
# 一旦继承 HOME=/data/home，root 跑过的 npm/npx 就会在 dsh 的缓存里留下 root
# 属主的文件，之后 dsh 自己装工具链只会拿到 EACCES。
DSH_USER_HOME="$(getent passwd "$DSH_RUN_USER" 2>/dev/null | cut -d: -f6 || true)"
[ -n "$DSH_USER_HOME" ] || DSH_USER_HOME="${DSH_USER_HOME:-/data/home}"
DSH_ROOT_HASH_FILE="${DSH_ROOT_HASH_FILE:-/root/dsh-secret/root.hash}"

# 容器 root 口令：安装器把 sha512crypt 哈希写进挂载文件，这里同步进 /etc/shadow。
# 哈希只挂在 /root 下（0700 root:root），dsh 账户既读不到文件也进不去目录，
# 所以拿不到哈希做离线爆破，只能走特权代理那条带失败锁定的接口。
DSH_ROOT_PASSWORD_CONFIGURED=false
if [ -r "$DSH_ROOT_HASH_FILE" ]; then
  root_hash="$(sed -n '1p' "$DSH_ROOT_HASH_FILE" | tr -d '\r\n')"
  case "$root_hash" in
    '$6$'*'$'*)
      printf 'root:%s\n' "$root_hash" | chpasswd -e
      DSH_ROOT_PASSWORD_CONFIGURED=true
      echo "[dsh] 已应用配置的容器 root 密码" >&2
      ;;
    *)
      echo "[dsh] $DSH_ROOT_HASH_FILE 不是 sha512crypt 哈希，已忽略" >&2
      ;;
  esac
fi
if [ "$DSH_ROOT_PASSWORD_CONFIGURED" != true ]; then
  passwd -l root >/dev/null 2>&1 || true
  echo "[dsh] 未配置容器 root 密码：特权代理只放行 apt 与 DSH 更新，dsh-root run 保持关闭" >&2
fi
# 运行账户永不设口令：它只通过 docker exec 或降权启动进入，没有可爆破的入口。
passwd -l "$DSH_RUN_USER" >/dev/null 2>&1 || true

# 特权代理的套接字目录：dsh 账户能进去连套接字，但读不到里面 root 独占的
# 失败计数文件。重启请求目录则要允许 dsh 写入。
mkdir -p /run/dsh-priv /run/dsh-state
chown "0:$DSH_RUN_GID" /run/dsh-priv /run/dsh-state
chmod 750 /run/dsh-priv
chmod 770 /run/dsh-state

export DSH_RUN_USER DSH_RUN_UID DSH_RUN_GID DSH_USER_HOME

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

DSH_CONTAINER_USER="$DSH_RUN_USER"
DSH_CONTAINER_UID="$DSH_RUN_UID"
DSH_CONTAINER_GID="$DSH_RUN_GID"
DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"
DSH_HOST_ACCESS="${DSH_HOST_ACCESS:-mounted-paths-only}"
DSH_WRITABLE_PATHS="${DSH_WRITABLE_PATHS:-/data/dsh,/data/home,/data/mcp,/data/agents,/workspace}"
# apt 装的东西只在容器可写层：本工程已不再把 /usr、/etc、/var 拆成 data/system 下的
# 绑定卷，所以系统包扛得住 restart，扛不住 docker rm / compose down / 重建。默认必须
# 是 false，否则 skill 会告诉 Agent 一个反过来的事实，让它把大工具链装进会消失的层。
DSH_SYSTEM_PACKAGES_PERSISTENT="${DSH_SYSTEM_PACKAGES_PERSISTENT:-false}"
DSH_PRIVILEGED_APT="${DSH_PRIVILEGED_APT:-nopasswd}"
DSH_PRIVILEGED_UPDATE="${DSH_PRIVILEGED_UPDATE:-nopasswd}"
# apt 依然可用：包装脚本把请求交给以 root 运行的特权代理，代理按白名单执行。
DSH_CAN_INSTALL_SYSTEM_PACKAGES=true
# 模型密钥代理与出站模式：只是把部署形态如实告诉容器内的 Agent，不是权限开关。
# 真正的边界在 Docker 网络与 dsh-key-broker / dsh-egress 两个独立容器上。
DSH_MODEL_BROKER="${DSH_MODEL_BROKER:-off}"
DSH_MODEL_BROKER_BASE="${DSH_MODEL_BROKER_BASE:-}"
# broker 开着但没给地址时回落到默认服务名：这条只在脱离 compose 直接 docker run 时
# 才会触发（compose 里已有同样的默认值），避免 skill 渲染出一个空的 base_url。
if [ "$DSH_MODEL_BROKER" = on ] && [ -z "$DSH_MODEL_BROKER_BASE" ]; then
  DSH_MODEL_BROKER_BASE=http://dsh-key-broker:8080
fi
DSH_EGRESS_MODE="${DSH_EGRESS_MODE:-open}"
DSH_EGRESS_PROXY_URL="${DSH_EGRESS_PROXY_URL:-}"
# user namespace remap 检测：宿主开了 userns-remap 时，容器里的 UID 0 在宿主上只是
# 一个普通的 subuid，逃逸出去也不是宿主 root。/proc/self/uid_map 的恒等映射
# `0 0 4294967295` 表示没有 remap。
DSH_USERNS_REMAP=false
if [ -r /proc/self/uid_map ]; then
  case "$(sed -n '1p' /proc/self/uid_map | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')" in
    '0 0 4294967295') ;;
    '') ;;
    *) DSH_USERNS_REMAP=true ;;
  esac
fi
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
  DSH_DOCKER_SOCKET_AVAILABLE DSH_PRIVILEGED_APT DSH_PRIVILEGED_UPDATE \
  DSH_ROOT_PASSWORD_CONFIGURED DSH_MODEL_BROKER DSH_MODEL_BROKER_BASE \
  DSH_EGRESS_MODE DSH_EGRESS_PROXY_URL DSH_USERNS_REMAP

# 隔离模式（DSH_EGRESS_MODE=allowlist）下的出站代理配置。
#
# 环境变量对包管理器并不够用：apt 经特权代理以 root 运行时环境被白名单清过，
# pip 与 npm 各有自己的配置优先级，git 对 https 远端也不总认 https_proxy。所以这些
# 工具的代理必须落到配置文件里。open 模式下同样要把这些文件删掉，否则从隔离模式
# 切回来之后，apt 会一直去连一个已经不存在的代理。
#
# 只碰带 `dsh-docker managed` 标记的文件：用户自己写过的配置一律保留并提示。
DSH_MANAGED_MARK='dsh-docker managed'

write_managed_file() {
  managed_path="$1"
  managed_body="$2"
  if [ -e "$managed_path" ] && ! grep -qF "$DSH_MANAGED_MARK" "$managed_path" 2>/dev/null; then
    echo "[dsh] $managed_path 已存在且不是本项目生成的，未写入出站代理配置" >&2
    return 0
  fi
  mkdir -p "$(dirname "$managed_path")"
  printf '%s\n' "$managed_body" > "$managed_path"
  chmod 644 "$managed_path"
}

remove_managed_file() {
  managed_path="$1"
  if [ -e "$managed_path" ] && grep -qF "$DSH_MANAGED_MARK" "$managed_path" 2>/dev/null; then
    rm -f "$managed_path"
  fi
}

configure_egress_proxy() {
  npm_config_path="$(npm config get globalconfig 2>/dev/null || true)"
  case "$npm_config_path" in
    /*) ;;
    *) npm_config_path=/usr/local/etc/npmrc ;;
  esac
  git_proxy="$(git config --system --get http.proxy 2>/dev/null || true)"

  if [ -z "$DSH_EGRESS_PROXY_URL" ]; then
    remove_managed_file /etc/apt/apt.conf.d/00-dsh-proxy
    remove_managed_file /etc/pip.conf
    remove_managed_file "$npm_config_path"
    # 只回收本项目写进去的那条，用户自己配的代理不动。
    case "$git_proxy" in
      *dsh-egress*)
        git config --system --unset-all http.proxy 2>/dev/null || true
        git config --system --unset-all https.proxy 2>/dev/null || true
        ;;
    esac
    return 0
  fi

  # apt.conf 用 // 注释；标记文本本身与注释语法无关，remove_managed_file 只 grep 文本。
  write_managed_file /etc/apt/apt.conf.d/00-dsh-proxy "$(printf '// %s\nAcquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' \
    "$DSH_MANAGED_MARK" "$DSH_EGRESS_PROXY_URL" "$DSH_EGRESS_PROXY_URL")"
  write_managed_file /etc/pip.conf "$(printf '# %s\n[global]\nproxy = %s\n' \
    "$DSH_MANAGED_MARK" "$DSH_EGRESS_PROXY_URL")"
  write_managed_file "$npm_config_path" "$(printf '; %s\nproxy=%s\nhttps-proxy=%s\nnoproxy=localhost,127.0.0.1,dsh,dsh-key-broker,dsh-egress,dsh-ingress\n' \
    "$DSH_MANAGED_MARK" "$DSH_EGRESS_PROXY_URL" "$DSH_EGRESS_PROXY_URL")"
  git config --system http.proxy "$DSH_EGRESS_PROXY_URL" 2>/dev/null || true
  git config --system https.proxy "$DSH_EGRESS_PROXY_URL" 2>/dev/null || true
  echo "[dsh] 出站隔离模式：apt/pip/npm/git 已指向 $DSH_EGRESS_PROXY_URL（白名单外的域名会被拒绝）" >&2
}

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
      gsub(/@@DSH_WRITABLE_PATHS@@/, ENVIRON["DSH_WRITABLE_PATHS"])
      gsub(/@@DSH_SYSTEM_PACKAGES_PERSISTENT@@/, ENVIRON["DSH_SYSTEM_PACKAGES_PERSISTENT"])
      gsub(/@@DSH_CAN_INSTALL_SYSTEM_PACKAGES@@/, ENVIRON["DSH_CAN_INSTALL_SYSTEM_PACKAGES"])
      gsub(/@@DSH_PRIVILEGED_APT@@/, ENVIRON["DSH_PRIVILEGED_APT"])
      gsub(/@@DSH_MODEL_BROKER@@/, ENVIRON["DSH_MODEL_BROKER"])
      gsub(/@@DSH_MODEL_BROKER_BASE@@/, ENVIRON["DSH_MODEL_BROKER_BASE"])
      gsub(/@@DSH_EGRESS_MODE@@/, ENVIRON["DSH_EGRESS_MODE"])
      gsub(/@@DSH_EGRESS_PROXY_URL@@/, ENVIRON["DSH_EGRESS_PROXY_URL"])
      print
    }
  ' "$template" > "$temporary"

  install -o "$DSH_RUN_UID" -g "$DSH_RUN_GID" -m 600 "$temporary" "$target"
  rm -f "$temporary"
}

# 挂载目录的属主必须跟运行账户对齐，否则降权后的 DSH 连自己的会话数据都写不了。
# 递归 chown 只在属主标记变化时执行一次（例如从旧的 root 部署升级上来）。
align_data_ownership() {
  marker="$DSH_HOME/.dsh-runtime-owner"
  expected="$DSH_RUN_UID:$DSH_RUN_GID"
  for directory in /data/dsh /data/home /data/agents /data/mcp /workspace; do
    mkdir -p "$directory"
    chown "$expected" "$directory" 2>/dev/null || true
  done
  if [ "$(sed -n '1p' "$marker" 2>/dev/null || true)" = "$expected" ]; then
    return 0
  fi
  echo "[dsh] 正在把 /data 与 /workspace 的属主对齐到 $DSH_RUN_USER($expected)..." >&2
  ownership_failed=false
  for directory in /data/dsh /data/home /data/agents /data/mcp /workspace; do
    chown -R "$expected" "$directory" 2>/dev/null || ownership_failed=true
  done
  # userns-remap 打开时，绑定挂载的宿主目录属主落在 subuid 区间之外，容器 root 在
  # 自己的 user namespace 里没有权限改它（CAP_CHOWN 只在本 namespace 内有效）。
  # 这时必须在宿主机上对齐一次，容器内无法自救，所以要把命令直接打出来。
  if [ "$ownership_failed" = true ] && [ "$DSH_USERNS_REMAP" = true ]; then
    echo "[dsh] 宿主启用了 userns-remap，容器内改不了绑定挂载的属主。" >&2
    echo "[dsh] 请在宿主机上执行（BASE 取 /etc/subuid 里 dockremap 的起始 UID）：" >&2
    echo "[dsh]   sudo chown -R \$((BASE + $DSH_RUN_UID)):\$((BASE + $DSH_RUN_GID)) ./data/dsh ./data/home ./data/agents ./data/mcp ./workspace" >&2
    echo "[dsh]   sudo chown -R \$((BASE + 0)):\$((BASE + 0)) ./data/secret ./data/auth" >&2
    echo "[dsh] 或直接执行 ./install.sh --userns-preflight，由安装器算好并对齐。" >&2
  fi
  printf '%s\n' "$expected" > "$marker"
  chown "$expected" "$marker" 2>/dev/null || true
}

# Agent 自己装工具链（npm i -g、pnpm add -g、pip install --user、cargo、go……）全都
# 写在运行账户的家目录里，所以这些目录必须存在、且属主是运行账户。npm 尤其脆弱：
# 缓存目录里只要混进一个 root 属主的文件，它就直接以 EACCES 失败，并且只会提示
# "sudo chown"——而容器里的 Agent 恰好没有 root。历史上最常见的来源是宿主机上
# `docker exec`（默认 root）跑过 npm/npx，那时镜像还给全容器设了 HOME=/data/home。
# 镜像侧已经改掉了源头，这里再补一道自愈：属主不对就改回来，别让人手工救场。
prepare_user_tool_dirs() {
  expected="$DSH_RUN_UID:$DSH_RUN_GID"
  for directory in \
    "$DSH_USER_HOME/.npm" \
    "$DSH_USER_HOME/.npm-global/bin" \
    "$DSH_USER_HOME/.local/bin" \
    "$DSH_USER_HOME/.local/share/pnpm" \
    "$DSH_USER_HOME/.cache" \
    "$DSH_USER_HOME/.config"
  do
    mkdir -p "$directory" 2>/dev/null || true
    chown "$expected" "$directory" 2>/dev/null || true
  done

  # -quit 让扫描在第一个异常属主处停下：正常情况下这是一次纯读的遍历，发现问题
  # 才付出递归 chown 的代价。跨设备的绑定挂载不跟进（-xdev），符号链接不跟随。
  offender="$(find "$DSH_USER_HOME" -xdev \( ! -uid "$DSH_RUN_UID" -o ! -gid "$DSH_RUN_GID" \) -print -quit 2>/dev/null || true)"
  [ -n "$offender" ] || return 0
  echo "[dsh] $DSH_USER_HOME 里有不属于 $DSH_RUN_USER 的文件（例如 $offender），正在改回 $expected..." >&2
  chown -Rh "$expected" "$DSH_USER_HOME" 2>/dev/null || \
    echo "[dsh] 属主修正未完全成功；如果宿主启用了 userns-remap，请在宿主机上对齐 ./data/home" >&2
}

# npm 的全局前缀必须落在运行账户可写的位置，否则 `npm i -g` 会去写 /usr/local。
# 文件可能被历史部署或 root 写坏，所以每次启动都补齐缺失的键并纠正属主。
ensure_npm_config() {
  npmrc="$DSH_USER_HOME/.npmrc"
  if [ ! -f "$npmrc" ]; then
    printf 'prefix=%s/.npm-global\ncache=%s/.npm\n' "$DSH_USER_HOME" "$DSH_USER_HOME" > "$npmrc"
  else
    grep -q '^prefix=' "$npmrc" || printf 'prefix=%s/.npm-global\n' "$DSH_USER_HOME" >> "$npmrc"
    grep -q '^cache=' "$npmrc" || printf 'cache=%s/.npm\n' "$DSH_USER_HOME" >> "$npmrc"
  fi
  chown "$DSH_RUN_UID:$DSH_RUN_GID" "$npmrc" 2>/dev/null || true
  chmod 644 "$npmrc" 2>/dev/null || true
}

mkdir -p /workspace /data/dsh/profiles /data/home /data/agents /data/mcp
rm -rf "$DSH_HOME/profiles/node_modules" "$DSH_HOME/node_modules" 2>/dev/null || true
align_data_ownership
prepare_user_tool_dirs

if [ ! -f "$DSH_HOME/cordis.patch.yml" ]; then
  install -o "$DSH_RUN_UID" -g "$DSH_RUN_GID" -m 600 \
    /usr/local/share/dsh-home/cordis.patch.yml "$DSH_HOME/cordis.patch.yml"
fi

find /data -name "*credentials*" -exec chmod 600 {} + 2>/dev/null || true
find /data -name ".*credentials*" -exec chmod 600 {} + 2>/dev/null || true
if [ -d "$DSH_USER_HOME/.ssh" ]; then
  chmod 700 "$DSH_USER_HOME/.ssh"
  find "$DSH_USER_HOME/.ssh" -type f -exec chmod 600 {} + 2>/dev/null || true
  find "$DSH_USER_HOME/.ssh" -type f -name "*.pub" -exec chmod 644 {} + 2>/dev/null || true
  find "$DSH_USER_HOME/.ssh" -type f -name "known_hosts*" -exec chmod 644 {} + 2>/dev/null || true
fi

configure_egress_proxy
render_container_skill

if [ -f "$DSH_HOME/.credentials.yaml" ]; then
  chmod 600 "$DSH_HOME/.credentials.yaml" 2>/dev/null || true
fi
ensure_npm_config

echo "[dsh] starting the in-container DSH supervisor; DSH itself will run as $DSH_RUN_USER($DSH_RUN_UID:$DSH_RUN_GID)" >&2
exec /usr/local/bin/dsh-supervisor "$@"
