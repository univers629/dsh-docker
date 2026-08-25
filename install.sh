#!/usr/bin/env bash
set -euo pipefail

ACTION=""
ACCESS_MODE_OVERRIDE=""
BIND_HOST_OVERRIDE=""
TRUSTED_HOSTS_OVERRIDE=""
NETWORK_OVERRIDE=""
NETWORK_EXTERNAL_OVERRIDE=""
IMAGE_SOURCE_OVERRIDE=""
IMAGE_OVERRIDE=""
INTERACTIVE=auto
TARGET_DIR="${DSH_INSTALL_DIR:-dsh-docker}"
PROMPT_RESULT=""
PENDING_BASIC_USER="${DSH_BASIC_AUTH_USER:-}"
PENDING_BASIC_PASSWORD="${DSH_BASIC_AUTH_PASSWORD:-}"
PENDING_ACCESS_MODE=""
PENDING_BIND_HOST=""
PENDING_TRUSTED_HOSTS=""
PENDING_NETWORK=""
PENDING_NETWORK_EXTERNAL=""
PENDING_IMAGE=""
PENDING_IMAGE_SOURCE=""
PENDING_ENV_FILE=""

DEFAULT_PREBUILT_IMAGE="${DSH_PREBUILT_IMAGE:-ghcr.io/univers629/dsh-docker:latest}"
DEFAULT_LOCAL_IMAGE="dsh:local"

usage() {
  cat <<'EOF'
用法：install.sh [操作] [选项]

操作：install（默认）、configure、update（容器内更新 DSH）、start、stop、restart、logs、status、delete（删除）
选项：
  --access local|trusted-proxy|basic
  --bind-host ADDRESS             Docker 发布端口绑定地址
  --trusted-hosts HOSTS           逗号分隔的公网 host[:port]
  --network NAME                  与 Docker 反向代理共享的外部网络
  --network-external / --network-internal
  --image-source prebuilt|build   prebuilt 拉取已发布镜像，build 在本机编译
  --image REF                     自定义镜像引用（默认按来源推导）
  --non-interactive               不显示问答，使用参数或安全默认值
  --dir PATH                      工程目录（默认 ./dsh-docker）
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    install|configure|update|start|stop|restart|logs|status|delete)
      ACTION="$1"
      ;;
    --action)
      [ "$#" -ge 2 ] || { echo "[错误] --action 缺少值。" >&2; exit 2; }
      shift
      ACTION="$1"
      ;;
    --action=*) ACTION="${1#*=}" ;;
    --access)
      [ "$#" -ge 2 ] || { echo "[错误] --access 缺少值。" >&2; exit 2; }
      shift
      ACCESS_MODE_OVERRIDE="$1"
      ;;
    --access=*) ACCESS_MODE_OVERRIDE="${1#*=}" ;;
    --bind-host)
      [ "$#" -ge 2 ] || { echo "[错误] --bind-host 缺少值。" >&2; exit 2; }
      shift
      BIND_HOST_OVERRIDE="$1"
      ;;
    --bind-host=*) BIND_HOST_OVERRIDE="${1#*=}" ;;
    --trusted-hosts)
      [ "$#" -ge 2 ] || { echo "[错误] --trusted-hosts 缺少值。" >&2; exit 2; }
      shift
      TRUSTED_HOSTS_OVERRIDE="$1"
      ;;
    --trusted-hosts=*) TRUSTED_HOSTS_OVERRIDE="${1#*=}" ;;
    --network)
      [ "$#" -ge 2 ] || { echo "[错误] --network 缺少值。" >&2; exit 2; }
      shift
      NETWORK_OVERRIDE="$1"
      ;;
    --network=*) NETWORK_OVERRIDE="${1#*=}" ;;
    --image-source)
      [ "$#" -ge 2 ] || { echo "[错误] --image-source 缺少值。" >&2; exit 2; }
      shift
      IMAGE_SOURCE_OVERRIDE="$1"
      ;;
    --image-source=*) IMAGE_SOURCE_OVERRIDE="${1#*=}" ;;
    --image)
      [ "$#" -ge 2 ] || { echo "[错误] --image 缺少值。" >&2; exit 2; }
      shift
      IMAGE_OVERRIDE="$1"
      ;;
    --image=*) IMAGE_OVERRIDE="${1#*=}" ;;
    --network-external) NETWORK_EXTERNAL_OVERRIDE=true ;;
    --network-internal) NETWORK_EXTERNAL_OVERRIDE=false ;;
    --non-interactive|-y|--yes) INTERACTIVE=false ;;
    --dir)
      [ "$#" -ge 2 ] || { echo "[错误] --dir 缺少值。" >&2; exit 2; }
      shift
      TARGET_DIR="$1"
      ;;
    --dir=*) TARGET_DIR="${1#*=}" ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[错误] 未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$ACTION" in
  ''|install|configure|update|start|stop|restart|logs|status|delete) ;;
  *) echo "[错误] 未知操作：$ACTION" >&2; exit 2 ;;
esac
case "$ACCESS_MODE_OVERRIDE" in
  ''|local|trusted-proxy|basic) ;;
  *) echo "[错误] --access 只支持 local、trusted-proxy 或 basic。" >&2; exit 2 ;;
esac
case "$IMAGE_SOURCE_OVERRIDE" in
  ''|prebuilt|build) ;;
  *) echo "[错误] --image-source 只支持 prebuilt 或 build。" >&2; exit 2 ;;
esac

if [ "$INTERACTIVE" = auto ]; then
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    INTERACTIVE=true
  else
    INTERACTIVE=false
  fi
fi

prompt() {
  local message="$1" default="${2:-}" answer
  while :; do
    if [ -n "$default" ]; then
      printf '%s [%s]: ' "$message" "$default" > /dev/tty
    else
      printf '%s: ' "$message" > /dev/tty
    fi
    IFS= read -r answer < /dev/tty || exit 1
    answer="${answer:-$default}"
    if [ -n "$answer" ]; then
      PROMPT_RESULT="$answer"
      return
    fi
  done
}

prompt_secret() {
  local message="$1" answer
  printf '%s: ' "$message" > /dev/tty
  IFS= read -r -s answer < /dev/tty || exit 1
  printf '\n' > /dev/tty
  PROMPT_RESULT="$answer"
}

prompt_yes_no() {
  local message="$1" default="$2" answer
  while :; do
    prompt "$message" "$default"
    answer="$PROMPT_RESULT"
    case "$answer" in
      y|Y|yes|YES|是) PROMPT_RESULT=true; return ;;
      n|N|no|NO|否) PROMPT_RESULT=false; return ;;
      *) echo "请输入 y 或 n。" > /dev/tty ;;
    esac
  done
}

echo "==================================================="
echo "  DeepSeek Harness (DSH) 安装与管理向导"
echo "==================================================="
echo

if [ -z "$ACTION" ]; then
  if [ "$INTERACTIVE" = true ]; then
    if [ -d "$TARGET_DIR" ]; then
      echo "1) 重新配置并重建容器（保留挂载数据）"
    else
      echo "1) 全新安装"
    fi
    echo "2) 在容器内更新 DSH"
    echo "3) 启动"
    echo "4) 停止"
    echo "5) 重启"
    echo "6) 查看日志"
    echo "7) 查看状态"
    echo "8) 删除"
    prompt "这次要做什么" "1"
    case "$PROMPT_RESULT" in
      1) ACTION=install ;;
      2) ACTION=update ;;
      3) ACTION=start ;;
      4) ACTION=stop ;;
      5) ACTION=restart ;;
      6) ACTION=logs ;;
      7) ACTION=status ;;
      8) ACTION=delete ;;
      *) echo "[错误] 无效选项。" >&2; exit 2 ;;
    esac
  else
    ACTION=install
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[错误] 未检测到 Docker，请先安装 Docker 后重试。" >&2
  exit 1
fi

# sudo 默认 env_reset，导出的变量到不了 docker compose，插值会退回 dsh:local。
# 需要变量的调用一律走 DOCKER_ENV，用 env 在命令行上显式透传。
if docker info >/dev/null 2>&1; then
  DOCKER() { docker "$@"; }
  DOCKER_ENV() { env "$@"; }
elif command -v sudo >/dev/null 2>&1; then
  DOCKER() { sudo docker "$@"; }
  DOCKER_ENV() { sudo env "$@"; }
else
  echo "[错误] 当前用户无权访问 Docker，且系统没有 sudo。" >&2
  exit 1
fi

fetch_project() {
  if [ ! -d "$TARGET_DIR" ]; then
    echo "==> 正在获取工程文件..."
    if command -v git >/dev/null 2>&1; then
      git clone https://github.com/univers629/dsh-docker.git "$TARGET_DIR"
    else
      mkdir -p "$TARGET_DIR"
      curl -fsSL https://github.com/univers629/dsh-docker/archive/refs/heads/main.tar.gz \
        | tar -xz -C "$TARGET_DIR" --strip-components=1
    fi
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
      chown -R "$SUDO_USER:$SUDO_USER" "$TARGET_DIR" 2>/dev/null || true
    fi
  elif [ -f "$TARGET_DIR/docker-compose.yml" ]; then
    echo "==> 使用现有工程文件；不会自动同步或更新项目源码。"
  else
    echo "[错误] $TARGET_DIR 已存在但不是 Git 工程，请移动该目录后重试。" >&2
    exit 1
  fi
}

require_project() {
  if [ ! -f "$TARGET_DIR/docker-compose.yml" ]; then
    echo "[错误] 未找到 $TARGET_DIR。请先在向导中选择安装。" >&2
    exit 1
  fi
}

container_exists() {
  DOCKER container inspect dsh >/dev/null 2>&1
}

confirm_delete() {
  local answer
  if [ "${DSH_DELETE_CONFIRMED:-}" = 1 ]; then
    return 0
  fi
  if [ "$INTERACTIVE" != true ]; then
    echo "[错误] delete 是破坏性操作，需要交互确认；请不要使用 --non-interactive。" >&2
    exit 2
  fi
  echo "[警告] 将删除 dsh 容器、DSH 镜像（dsh:* 与 .env 记录的预构建引用）、本项目 Compose 挂载和网络、全局 Docker 构建缓存，以及 $TARGET_DIR。"
  printf '请输入 DELETE 继续，其他输入取消: ' > /dev/tty
  IFS= read -r answer < /dev/tty || exit 1
  if [ "$answer" != DELETE ]; then
    echo "已取消。"
    exit 0
  fi
}

resolve_self_path() {
  local dir base
  case "${0:-}" in
    ''|bash|-bash|sh|-sh|dash|-dash) return 1 ;;
  esac
  [ -f "$0" ] || return 1
  dir="$(dirname -- "$0")"
  base="$(basename -- "$0")"
  dir="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$dir" "$base"
}

# 当脚本自身位于将被删除的目录内时，先把自己复制到临时目录再从副本继续，
# 避免脚本文件和工作目录在执行过程中被删掉。
detach_delete() {
  local self target_abs tmp_copy status
  [ "${DSH_DELETE_DETACHED:-}" = 1 ] && return 0
  self="$(resolve_self_path)" || return 0
  [ -d "$TARGET_DIR" ] || return 0
  target_abs="$(cd "$TARGET_DIR" && pwd -P)" || return 0
  case "$self" in
    "$target_abs"/*) ;;
    *) return 0 ;;
  esac
  cd "$(dirname -- "$target_abs")" 2>/dev/null || true
  tmp_copy="$(mktemp "${TMPDIR:-/tmp}/dsh-delete-XXXXXX")" || return 0
  cat -- "$self" > "$tmp_copy"
  chmod +x "$tmp_copy"
  echo "==> 删除脚本位于将被删除的目录内，已复制到 $tmp_copy 后从副本继续。"
  status=0
  DSH_DELETE_DETACHED=1 DSH_DELETE_CONFIRMED=1 bash "$tmp_copy" delete --dir "$target_abs" || status=$?
  rm -f -- "$tmp_copy"
  exit "$status"
}

delete_project() {
  local project_name=dsh-docker image_refs ref ids id target_abs network_ids network_project container_ids
  local configured_image
  confirm_delete

  if container_exists; then
    project_name="$(DOCKER inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' dsh 2>/dev/null || true)"
    case "$project_name" in ''|'<no value>') project_name=dsh-docker ;; esac
  fi

  if [ -f "$TARGET_DIR/docker-compose.yml" ]; then
    (
      cd "$TARGET_DIR"
      compose_files=(-f docker-compose.yml)
      # 当前版本的工程不再包含 docker-compose.system.yml；仅当目标目录是
      # 旧版安装（曾把 /usr、/etc、/var 拆成 data/system 下的绑定卷）时才叠加它，
      # 以便一次性清掉那些遗留卷。
      [ -f docker-compose.system.yml ] && compose_files+=( -f docker-compose.system.yml )
      DOCKER compose -p "$project_name" "${compose_files[@]}" down --volumes --remove-orphans
    ) || true
  fi

  container_ids="$(DOCKER container ls -aq --filter "label=com.docker.compose.project=$project_name" 2>/dev/null || true)"
  while IFS= read -r id; do
    [ -n "$id" ] && DOCKER container rm -f "$id" >/dev/null 2>&1 || true
  done <<< "$container_ids"
  DOCKER container rm -f dsh >/dev/null 2>&1 || true
  # 预构建安装用的引用不叫 dsh:*，而且多架构清单未必带上项目标签，所以要按
  # .env 里记录的引用精确删除一次。delete 可能在工程目录的上一级执行，因此
  # 这里不能依赖当前目录的 .env。
  configured_image="$(awk -F= '$1 == "DSH_IMAGE" { sub(/^[^=]*=/, ""); print; exit }' "$TARGET_DIR/.env" 2>/dev/null || true)"
  case "$configured_image" in
    ''|dsh:local) ;;
    *) DOCKER image rm -f "$configured_image" >/dev/null 2>&1 || true ;;
  esac
  image_refs="$(DOCKER image ls --format '{{.Repository}}:{{.Tag}}' --filter 'reference=dsh:*' 2>/dev/null | sort -u || true)"
  while IFS= read -r ref; do
    [ -n "$ref" ] && DOCKER image rm -f "$ref" >/dev/null 2>&1 || true
  done <<< "$image_refs"
  ids="$(DOCKER image ls -q --filter "label=com.docker.compose.project=$project_name" 2>/dev/null | sort -u || true)"
  while IFS= read -r id; do
    [ -n "$id" ] && DOCKER image rm -f "$id" >/dev/null 2>&1 || true
  done <<< "$ids"
  ids="$(DOCKER image ls -q --filter 'label=org.opencontainers.image.title=dsh-docker' 2>/dev/null | sort -u || true)"
  while IFS= read -r id; do
    [ -n "$id" ] && DOCKER image rm -f "$id" >/dev/null 2>&1 || true
  done <<< "$ids"
  ids="$(DOCKER volume ls -q --filter "label=com.docker.compose.project=$project_name" 2>/dev/null || true)"
  while IFS= read -r id; do
    [ -n "$id" ] && DOCKER volume rm -f "$id" >/dev/null 2>&1 || true
  done <<< "$ids"
  network_ids="$(DOCKER network ls -q --filter "label=com.docker.compose.project=$project_name" 2>/dev/null || true)"
  while IFS= read -r id; do
    [ -n "$id" ] && DOCKER network rm "$id" >/dev/null 2>&1 || true
  done <<< "$network_ids"
  network_ids="$(DOCKER network ls -q --filter 'label=dsh.created-by=dsh-docker-installer' 2>/dev/null || true)"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    # 只删安装器自己建的代理网络，且必须没有任何容器还接在上面。
    if [ "$(DOCKER network inspect --format '{{ len .Containers }}' "$id" 2>/dev/null || echo 1)" = 0 ]; then
      DOCKER network rm "$id" >/dev/null 2>&1 || true
    fi
  done <<< "$network_ids"
  network_project="$(DOCKER network inspect --format '{{ index .Labels "com.docker.compose.project" }}' dsh-private 2>/dev/null || true)"
  if [ "$network_project" = "$project_name" ]; then
    DOCKER network rm dsh-private >/dev/null 2>&1 || true
  fi
  DOCKER builder prune -af

  if [ -d "$TARGET_DIR" ]; then
    target_abs="$(cd "$TARGET_DIR" && pwd -P)"
    case "$target_abs" in
      /|"$HOME")
        echo "[错误] 拒绝删除不安全的工程目录：$target_abs" >&2
        exit 1
        ;;
    esac
    if [ -f "$target_abs/docker-compose.yml" ] && [ -f "$target_abs/Dockerfile" ] && [ -f "$target_abs/install.sh" ]; then
      cd "$(dirname "$target_abs")"
      if ! rm -rf -- "$target_abs" 2>/dev/null; then
        if command -v sudo >/dev/null 2>&1; then
          sudo rm -rf -- "$target_abs"
        else
          echo "[错误] 无法删除包含容器 root 文件的工程目录：$target_abs" >&2
          exit 1
        fi
      fi
    else
      echo "==> $target_abs 不是可识别的 dsh-docker 工程，已保留。"
    fi
  fi
  echo "==> DSH 删除完成。"
}

if [ "$ACTION" = delete ]; then
  if [ ! -f "$TARGET_DIR/docker-compose.yml" ] && [ -f docker-compose.yml ] && [ -f Dockerfile ] && [ -f install.sh ]; then
    TARGET_DIR="."
  fi
  if [ "${DSH_DELETE_DETACHED:-}" = 1 ]; then
    trap 'rm -f -- "$0"' EXIT
  else
    confirm_delete
    DSH_DELETE_CONFIRMED=1
    detach_delete
  fi
  delete_project
  exit 0
fi

case "$ACTION" in
  install|configure) fetch_project ;;
  *) require_project ;;
esac

if [ "$ACTION" = install ] || [ "$ACTION" = configure ]; then
  if container_exists; then
    echo "[错误] dsh 容器已经存在；为保护容器内 apt 软件和系统修改，安装器不会隐式重建它。" >&2
    echo "       使用 ./dsh.sh start|restart 管理现有容器；如需全新系统，请明确执行 ./dsh.sh remove 后再安装。" >&2
    exit 1
  fi
fi

cd "$TARGET_DIR"
chmod +x dsh.sh 2>/dev/null || true

set_compose_env() {
  local key="$1" value="$2" file="${3:-.env}" temporary
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

remove_compose_env() {
  local key="$1" file="$2" temporary
  temporary="${file}.tmp.$$"
  [ -f "$file" ] || return 0
  awk -v key="$key" '$0 !~ "^[[:space:]]*" key "[[:space:]]*="' "$file" > "$temporary"
  mv "$temporary" "$file"
}

get_compose_env() {
  local key="$1" fallback="$2" value
  value="$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env 2>/dev/null || true)"
  printf '%s' "${value:-$fallback}"
}

mkdir -p data/auth
COMPOSE_ARGS=(-f docker-compose.yml)

# 列出可以作为反向代理网络的候选，排除 Docker 内置网络和 DSH 自己管理的网络。
list_proxy_network_candidates() {
  local name
  DOCKER network ls --format '{{.Name}}' 2>/dev/null | while IFS= read -r name; do
    case "$name" in
      bridge|host|none|dsh-private|dsh-docker_default) continue ;;
    esac
    printf '%s\n' "$name"
  done
}

# Compose 从不代建 external 网络，它必须先存在。全新机器上反向代理面板往往还没部署，
# 所以交互模式下允许安装器现在就建好，之后再把反代容器接进同一网络。
ensure_external_network() {
  local name="$1"
  # 已存在的网络一律照旧使用，避免改动老部署已经写进 .env 的配置。
  if DOCKER network inspect "$name" >/dev/null 2>&1; then
    return 0
  fi
  if [ "$name" = dsh-private ]; then
    echo "[错误] dsh-private 是 DSH 自己管理的内部网络名，不能当作外部网络。" >&2
    echo "       请填写反向代理容器所在的网络名，或换一个新名字（例如 dsh-proxy）。" >&2
    return 1
  fi
  if [ "$INTERACTIVE" = true ]; then
    echo
    echo "[提示] 外部 Docker 网络 $name 还不存在。"
    prompt_yes_no "现在创建它（之后把反向代理容器接入同一网络）" y
    if [ "$PROMPT_RESULT" = true ]; then
      if DOCKER network create --label dsh.created-by=dsh-docker-installer "$name" >/dev/null; then
        echo "==> 已创建 Docker 网络 $name。"
        echo "    部署反向代理后执行：docker network connect $name <反代容器名>"
        return 0
      fi
      echo "[错误] 创建 Docker 网络 $name 失败。" >&2
      return 1
    fi
  fi
  echo "[错误] 外部 Docker 网络 $name 不存在。" >&2
  echo "       创建：docker network create $name" >&2
  echo "       接入反代：docker network connect $name <反代容器名>" >&2
  return 1
}

configure_dsh() {
  local access_mode bind_host trusted_hosts network network_external
  local route default_route default_network keep_auth confirm_password
  local candidates image_source image_ref

  image_source="${IMAGE_SOURCE_OVERRIDE:-$(get_compose_env DSH_IMAGE_SOURCE prebuilt)}"
  case "$image_source" in prebuilt|build) ;; *) image_source=prebuilt ;; esac
  if [ "$INTERACTIVE" = true ] && [ -z "$IMAGE_SOURCE_OVERRIDE" ]; then
    case "$image_source" in build) default_route=2 ;; *) default_route=1 ;; esac
    echo
    echo "Debian 13 镜像来源："
    echo "1) 拉取公开预构建镜像（推荐：不在本机编译 DSH，安装耗时约等于下载耗时）"
    echo "2) 在本机构建镜像（用当前工程 Dockerfile 现场构建，不编译 DSH 源码，约几分钟）"
    prompt "请选择" "$default_route"
    case "$PROMPT_RESULT" in
      1) image_source=prebuilt ;;
      2) image_source=build ;;
      *) echo "[错误] 无效镜像来源选项。" >&2; exit 2 ;;
    esac
  fi
  if [ -n "$IMAGE_OVERRIDE" ]; then
    image_ref="$IMAGE_OVERRIDE"
  elif [ "$image_source" = build ]; then
    image_ref="$DEFAULT_LOCAL_IMAGE"
  else
    image_ref="$(get_compose_env DSH_IMAGE "$DEFAULT_PREBUILT_IMAGE")"
    # 旧安装的 .env 里记着本机构建的标签；切换到预构建时必须换成发布引用。
    case "$image_ref" in "$DEFAULT_LOCAL_IMAGE") image_ref="$DEFAULT_PREBUILT_IMAGE" ;; esac
  fi

  access_mode="${ACCESS_MODE_OVERRIDE:-$(get_compose_env DSH_ACCESS_MODE local)}"
  if [ "$INTERACTIVE" = true ] && [ -z "$ACCESS_MODE_OVERRIDE" ]; then
    case "$access_mode" in local) default_route=1 ;; trusted-proxy) default_route=2 ;; basic) default_route=3 ;; *) default_route=1 ;; esac
    echo
    echo "访问保护方式："
    echo "1) 仅本机或 SSH 隧道"
    echo "2) 已有 Cloudflare Access / 面板认证 / 私有 VPN"
    echo "3) DSH 内置 Nginx Basic Auth（外层仍须提供 HTTPS）"
    prompt "请选择" "$default_route"
    case "$PROMPT_RESULT" in
      1) access_mode=local ;;
      2) access_mode=trusted-proxy ;;
      3) access_mode=basic ;;
      *) echo "[错误] 无效访问保护选项。" >&2; exit 2 ;;
    esac
  fi

  bind_host="${BIND_HOST_OVERRIDE:-$(get_compose_env DSH_BIND_HOST 127.0.0.1)}"
  trusted_hosts="${TRUSTED_HOSTS_OVERRIDE:-$(get_compose_env DSH_TRUSTED_HOSTS '')}"
  network="${NETWORK_OVERRIDE:-$(get_compose_env DSH_DOCKER_NETWORK dsh-private)}"
  network_external="${NETWORK_EXTERNAL_OVERRIDE:-$(get_compose_env DSH_DOCKER_NETWORK_EXTERNAL false)}"

  # 兼容旧配置：以前的向导会把 DSH 自管的 dsh-private 默认填成"外部网络"。
  # 如果这个网络确实是 Compose 自己建的，就改回内部管理，避免安装器直接报错。
  if [ "$network" = dsh-private ] && [ "$network_external" = true ] && [ -z "$NETWORK_EXTERNAL_OVERRIDE" ]; then
    case "$(DOCKER network inspect --format '{{ index .Labels "com.docker.compose.project" }}' dsh-private 2>/dev/null || true)" in
      ''|'<no value>') ;;
      *)
        echo "==> 旧配置把 dsh-private 记成了外部网络；已改回由 DSH 自己管理（网络名不变）。"
        network_external=false
        ;;
    esac
  fi

  if [ "$access_mode" = local ]; then
    bind_host="${BIND_HOST_OVERRIDE:-127.0.0.1}"
    trusted_hosts="${TRUSTED_HOSTS_OVERRIDE:-}"
    network="${NETWORK_OVERRIDE:-dsh-private}"
    network_external="${NETWORK_EXTERNAL_OVERRIDE:-false}"
  elif [ "$INTERACTIVE" = true ]; then
    default_route=1
    if DOCKER network inspect dpanel-local >/dev/null 2>&1 || [ "$network_external" = true ]; then
      default_route=2
    fi
    echo
    prompt "反向代理在哪里：1) 宿主机  2) Docker 容器/面板" "$default_route"
    route="$PROMPT_RESULT"
    case "$route" in
      1)
        bind_host="${BIND_HOST_OVERRIDE:-127.0.0.1}"
        network="${NETWORK_OVERRIDE:-dsh-private}"
        network_external="${NETWORK_EXTERNAL_OVERRIDE:-false}"
        ;;
      2)
        default_network=""
        case "$network" in dsh-private|'') ;; *) default_network="$network" ;; esac
        if [ -z "$default_network" ] && DOCKER network inspect dpanel-local >/dev/null 2>&1; then
          default_network=dpanel-local
        fi
        echo "    DSH 会加入这个网络，反向代理用 http://dsh:3080 访问它。"
        if [ -z "$default_network" ]; then
          candidates="$(list_proxy_network_candidates)"
          if [ -n "$candidates" ]; then
            echo "    宿主机现有的网络：$(echo $candidates)"
            default_network="$(printf '%s\n' "$candidates" | sed -n 1p)"
          else
            echo "    宿主机还没有可用网络：面板未部署时直接回车用 dsh-proxy，安装器会先征求同意再创建它。"
            default_network=dsh-proxy
          fi
        fi
        prompt "反向代理所在的 Docker 网络" "$default_network"
        network="$PROMPT_RESULT"
        network_external=true
        bind_host="${BIND_HOST_OVERRIDE:-127.0.0.1}"
        ;;
      *) echo "[错误] 无效反向代理位置。" >&2; exit 2 ;;
    esac
    prompt "公网域名或 trusted host（多个用逗号分隔，不带 https://）" "${trusted_hosts:-agent.example.com}"
    trusted_hosts="$PROMPT_RESULT"
    prompt "宿主机端口绑定地址（推荐 127.0.0.1）" "$bind_host"
    bind_host="$PROMPT_RESULT"
  fi

  case "$bind_host" in
    0.0.0.0|::|'[::]'|'*')
      echo "[错误] 为避免绕过认证，不能使用通配绑定地址；请使用 127.0.0.1 或指定的私有接口。" >&2
      exit 2
      ;;
  esac

  if [ "$network_external" = true ] && ! ensure_external_network "$network"; then
    exit 1
  fi

  if [ "$access_mode" = basic ]; then
    if [ -s data/auth/htpasswd ] && [ "$INTERACTIVE" = true ]; then
      prompt_yes_no "保留现有 Basic Auth 用户名和密码" y
      keep_auth="$PROMPT_RESULT"
    elif [ -s data/auth/htpasswd ] && [ -z "$PENDING_BASIC_PASSWORD" ]; then
      keep_auth=true
    else
      keep_auth=false
    fi
    if [ "$keep_auth" != true ]; then
      if [ "$INTERACTIVE" = true ]; then
        prompt "Basic Auth 用户名" "${PENDING_BASIC_USER:-dsh}"
        PENDING_BASIC_USER="$PROMPT_RESULT"
        case "$PENDING_BASIC_USER" in *[!A-Za-z0-9._-]*|'') echo "[错误] 用户名只允许字母、数字、点、下划线和连字符。" >&2; exit 2 ;; esac
        while :; do
          prompt_secret "Basic Auth 密码（至少 12 个字符）"
          PENDING_BASIC_PASSWORD="$PROMPT_RESULT"
          if [ "${#PENDING_BASIC_PASSWORD}" -lt 12 ]; then
            echo "密码至少需要 12 个字符。" > /dev/tty
            continue
          fi
          prompt_secret "再次输入密码"
          confirm_password="$PROMPT_RESULT"
          [ "$PENDING_BASIC_PASSWORD" = "$confirm_password" ] && break
          echo "两次密码不一致，请重试。" > /dev/tty
        done
      elif [ -z "$PENDING_BASIC_USER" ] || [ "${#PENDING_BASIC_PASSWORD}" -lt 12 ]; then
        echo "[错误] 非交互 Basic Auth 首次配置需要 DSH_BASIC_AUTH_USER 和至少 12 位的 DSH_BASIC_AUTH_PASSWORD。" >&2
        exit 2
      fi
    else
      PENDING_BASIC_PASSWORD=""
    fi
  fi

  PENDING_ACCESS_MODE="$access_mode"
  PENDING_BIND_HOST="$bind_host"
  PENDING_TRUSTED_HOSTS="$trusted_hosts"
  PENDING_NETWORK="$network"
  PENDING_NETWORK_EXTERNAL="$network_external"
  PENDING_IMAGE="$image_ref"
  PENDING_IMAGE_SOURCE="$image_source"
}

build_dsh_image() {
  DOCKER_ENV DSH_IMAGE="$PENDING_IMAGE" DOCKER_BUILDKIT=1 \
    docker compose "${COMPOSE_ARGS[@]}" build dsh
}

# 拉取不经过 Compose：引用直接写在命令行上交给守护进程，插值或环境传递出问题时
# 也不会把拉取指向 docker.io/library/dsh:local。启动那步用 .env 里的同一个引用。
pull_dsh_image() {
  DOCKER pull "$PENDING_IMAGE"
}

# 预构建优先，但公网拉取可能因为网络或尚未发布而失败；这时退回本机构建，
# 而不是让整次安装中断。回退发生在写入 .env 之前，所以配置不会记错来源。
obtain_dsh_image() {
  if [ "$PENDING_IMAGE_SOURCE" = prebuilt ]; then
    echo "==> 正在拉取预构建 Debian 13 镜像：$PENDING_IMAGE"
    if pull_dsh_image; then
      return 0
    fi
    echo "[警告] 无法拉取 $PENDING_IMAGE，改为在本机构建镜像。" >&2
    PENDING_IMAGE_SOURCE=build
    PENDING_IMAGE="$DEFAULT_LOCAL_IMAGE"
  fi
  echo "==> 正在构建 DSH 镜像..."
  build_dsh_image
}

write_basic_auth() {
  local temporary
  [ "$PENDING_ACCESS_MODE" = basic ] || return 0
  [ -n "$PENDING_BASIC_PASSWORD" ] || return 0
  mkdir -p data/auth
  temporary="$(mktemp data/auth/htpasswd.tmp.XXXXXX)"
  if ! printf '%s\n' "$PENDING_BASIC_PASSWORD" \
    | DOCKER run --rm -i --entrypoint htpasswd "$PENDING_IMAGE" -niB "$PENDING_BASIC_USER" > "$temporary"; then
    rm -f "$temporary"
    echo "[错误] 无法生成 Basic Auth 密码哈希。" >&2
    exit 1
  fi
  chmod 600 "$temporary"
  mv "$temporary" data/auth/htpasswd
  unset PENDING_BASIC_PASSWORD
  echo "==> Basic Auth 凭据已使用 bcrypt 哈希保存，未写入 .env。"
}

prepare_pending_env() {
  PENDING_ENV_FILE="$(mktemp .env.pending.XXXXXX)"
  if [ -f .env ]; then cp .env "$PENDING_ENV_FILE"; fi
  remove_compose_env DSH_RUN_AS_ROOT "$PENDING_ENV_FILE"
  set_compose_env DSH_ACCESS_MODE "$PENDING_ACCESS_MODE" "$PENDING_ENV_FILE"
  set_compose_env DSH_BIND_HOST "$PENDING_BIND_HOST" "$PENDING_ENV_FILE"
  set_compose_env DSH_DOCKER_NETWORK "$PENDING_NETWORK" "$PENDING_ENV_FILE"
  set_compose_env DSH_DOCKER_NETWORK_EXTERNAL "$PENDING_NETWORK_EXTERNAL" "$PENDING_ENV_FILE"
  set_compose_env DSH_TRUSTED_HOSTS "$PENDING_TRUSTED_HOSTS" "$PENDING_ENV_FILE"
  set_compose_env DSH_IMAGE "$PENDING_IMAGE" "$PENDING_ENV_FILE"
  set_compose_env DSH_IMAGE_SOURCE "$PENDING_IMAGE_SOURCE" "$PENDING_ENV_FILE"
}

compose_up_with_pending_env() {
  (
    unset DSH_ACCESS_MODE DSH_BIND_HOST DSH_TRUSTED_HOSTS
    unset DSH_DOCKER_NETWORK DSH_DOCKER_NETWORK_EXTERNAL DSH_IMAGE DSH_IMAGE_SOURCE
    DOCKER compose --env-file "$PENDING_ENV_FILE" "${COMPOSE_ARGS[@]}" up -d --no-build --force-recreate
  )
}

assert_dsh_root() {
  local uid attempt
  # /run/dsh.pid 由 dsh-supervisor 写入：第一行是 PID，第二行是进程启动时刻，
  # 所以只能取第一行，整读会拼出无效的 /proc 路径。
  for ((attempt = 0; attempt < 120; attempt++)); do
    uid="$(DOCKER exec dsh sh -c 'pid="$(sed -n 1p /run/dsh.pid 2>/dev/null)"; case "$pid" in ""|*[!0-9]*) exit 1 ;; esac; sed -n "s/^Uid:[[:space:]]*\([0-9]*\).*/\1/p" "/proc/$pid/status"' 2>/dev/null || true)"
    if [ -n "$uid" ]; then
      if [ "$uid" != 0 ]; then
        echo "[错误] DSH 进程 UID 核验失败：期望 0，实际为 $uid。" >&2
        return 1
      fi
      echo "==> 已核验 DSH 进程 UID：0"
      return 0
    fi
    sleep 1
  done
  echo "[错误] DSH 容器已创建，但无法在 120 秒内核验主进程 UID。" >&2
  return 1
}

print_config_summary() {
  echo
  echo "==> 配置已保存到 $(pwd)/.env"
  echo "    访问模式: $PENDING_ACCESS_MODE"
  echo "    端口绑定: $PENDING_BIND_HOST:3080"
  echo "    镜像来源: $PENDING_IMAGE_SOURCE（$PENDING_IMAGE）"
  [ -z "$PENDING_TRUSTED_HOSTS" ] || echo "    Trusted hosts: $PENDING_TRUSTED_HOSTS"
}

cleanup_pending_env() {
  [ -z "$PENDING_ENV_FILE" ] || rm -f "$PENDING_ENV_FILE"
}
trap cleanup_pending_env EXIT

case "$ACTION" in
  install|configure)
    configure_dsh
    obtain_dsh_image
    write_basic_auth
    prepare_pending_env
    echo "==> 正在启动 DSH..."
    if ! compose_up_with_pending_env; then
      echo "[错误] DSH 容器启动失败，原配置未被覆盖。" >&2
      exit 1
    fi
    mv "$PENDING_ENV_FILE" .env
    PENDING_ENV_FILE=""
    assert_dsh_root
    print_config_summary
    ;;
  update) ./dsh.sh update ;;
  start) ./dsh.sh start ;;
  stop) ./dsh.sh stop ;;
  restart) ./dsh.sh restart ;;
  logs) exec ./dsh.sh logs ;;
  status) ./dsh.sh status ;;
esac

echo
echo "==================================================="
echo "  操作完成：$ACTION"
echo "  本机入口: http://127.0.0.1:3080"
echo "  再次运行同一条安装命令即可管理或重新配置"
echo "==================================================="
