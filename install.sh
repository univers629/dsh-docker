#!/usr/bin/env bash
set -euo pipefail

ACTION=""
ACCESS_MODE_OVERRIDE=""
BIND_HOST_OVERRIDE=""
TRUSTED_HOSTS_OVERRIDE=""
NETWORK_OVERRIDE=""
NETWORK_EXTERNAL_OVERRIDE=""
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
PENDING_ENV_FILE=""

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

if docker info >/dev/null 2>&1; then
  DOCKER() { docker "$@"; }
elif command -v sudo >/dev/null 2>&1; then
  DOCKER() { sudo docker "$@"; }
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
  echo "[警告] 将删除 dsh 容器、dsh:* 镜像、本项目 Compose 挂载和网络、全局 Docker 构建缓存，以及 $TARGET_DIR。"
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

configure_dsh() {
  local access_mode bind_host trusted_hosts network network_external
  local route default_route default_network keep_auth confirm_password

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
        default_network="$network"
        if DOCKER network inspect dpanel-local >/dev/null 2>&1; then default_network=dpanel-local; fi
        prompt "反向代理使用的 Docker 网络" "$default_network"
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

  if [ "$network_external" = true ] && ! DOCKER network inspect "$network" >/dev/null 2>&1; then
    echo "[错误] 外部 Docker 网络 $network 不存在。请先在反向代理面板中创建它。" >&2
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
}

write_basic_auth() {
  local temporary
  [ "$PENDING_ACCESS_MODE" = basic ] || return 0
  [ -n "$PENDING_BASIC_PASSWORD" ] || return 0
  mkdir -p data/auth
  temporary="$(mktemp data/auth/htpasswd.tmp.XXXXXX)"
  if ! printf '%s\n' "$PENDING_BASIC_PASSWORD" \
    | DOCKER run --rm -i --entrypoint htpasswd dsh:local -niB "$PENDING_BASIC_USER" > "$temporary"; then
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
}

compose_up_with_pending_env() {
  (
    unset DSH_ACCESS_MODE DSH_BIND_HOST DSH_TRUSTED_HOSTS
    unset DSH_DOCKER_NETWORK DSH_DOCKER_NETWORK_EXTERNAL
    DOCKER compose --env-file "$PENDING_ENV_FILE" "${COMPOSE_ARGS[@]}" up -d --force-recreate
  )
}

assert_dsh_root() {
  local uid attempt
  for ((attempt = 0; attempt < 120; attempt++)); do
    uid="$(DOCKER exec dsh sh -c 'pid="$(cat /run/dsh.pid 2>/dev/null)" || exit 1; sed -n "s/^Uid:[[:space:]]*\([0-9]*\).*/\1/p" "/proc/$pid/status"' 2>/dev/null || true)"
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
  [ -z "$PENDING_TRUSTED_HOSTS" ] || echo "    Trusted hosts: $PENDING_TRUSTED_HOSTS"
}

cleanup_pending_env() {
  [ -z "$PENDING_ENV_FILE" ] || rm -f "$PENDING_ENV_FILE"
}
trap cleanup_pending_env EXIT

case "$ACTION" in
  install|configure)
    configure_dsh
    echo "==> 正在构建 DSH 镜像..."
    DOCKER compose "${COMPOSE_ARGS[@]}" build dsh
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
