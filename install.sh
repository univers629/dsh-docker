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
PENDING_ROOT_PASSWORD="${DSH_ROOT_PASSWORD:-}"
ROOT_PASSWORD_OVERRIDE=""
NO_ROOT_PASSWORD=false
PENDING_ACCESS_MODE=""
PENDING_BIND_HOST=""
PENDING_TRUSTED_HOSTS=""
PENDING_NETWORK=""
PENDING_NETWORK_EXTERNAL=""
PENDING_IMAGE=""
PENDING_IMAGE_SOURCE=""
PENDING_ENV_FILE=""
MODEL_KEY_SPECS=()
MODEL_BASE_URL_SPECS=()
MODEL_API_SPECS=()
MODEL_HEADER_SPECS=()
MODEL_ID_SPECS=()
NO_MODEL_SETTINGS_SEED=false
MODEL_KEYS_FILE="${DSH_MODEL_KEYS_FILE:-}"
NO_MODEL_BROKER=false
EGRESS_MODE_OVERRIDE=""
EGRESS_ALLOW_OVERRIDE=""
USERNS_PREFLIGHT=false
PENDING_MODEL_BROKER=off
PENDING_EGRESS_MODE=open
PENDING_EGRESS_ALLOWED_HOSTS=""
# 密钥管理面板（dsh-key-admin）：装完之后在浏览器里填密钥、拉模型列表、写 DSH 配置。
# 默认只发布在宿主回环上，端口和绑定地址都记在 .env 里，令牌记在 data/broker/admin.token。
KEY_ADMIN_OVERRIDE=""
PENDING_KEY_ADMIN=off
PENDING_KEY_ADMIN_BIND_HOST=""
PENDING_KEY_ADMIN_PORT=""
KEY_ADMIN_TOKEN_STATE=""
DEFAULT_KEY_ADMIN_BIND_HOST="127.0.0.1"
DEFAULT_KEY_ADMIN_PORT="3082"
# 收集到的上游用几个下标对齐的数组存。密钥只在 BROKER_KEYS 里短暂停留，写盘之后
# 立刻清空，和 PENDING_ROOT_PASSWORD 一样的处理。
BROKER_NAMES=()
BROKER_BASE_URLS=()
BROKER_KEYS=()
BROKER_RPM=()
BROKER_DAILY=()
# API 形态（profile）决定注入哪个认证头、放行哪些路径前缀；额外请求头按 name=value 存，
# 多条之间用 US(0x1f) 分隔——值里可能出现空格、逗号和等号，只有控制符是安全的分隔符。
BROKER_PROFILES=()
BROKER_HEADERS=()
BROKER_HEADER_RS=$'\x1f'
# 要写进 DSH settings.yaml 的模型 id（逗号分隔）。只有内置目录里没有的上游才必须填：
# 目录里的上游（deepseek、google、nvidia……）沿用目录里的整份模型清单。
BROKER_MODELS=()

DEFAULT_PREBUILT_IMAGE="${DSH_PREBUILT_IMAGE:-ghcr.io/univers629/dsh-docker:latest}"
DEFAULT_LOCAL_IMAGE="dsh:local"
# 容器内只填占位密钥，真实密钥由 dsh-key-broker 在转发时注入，所以这个地址是契约的
# 一部分：compose 用它渲染 DSH_MODEL_BROKER_BASE，摘要用它拼出给 Agent 的 base_url。
MODEL_BROKER_BASE="http://dsh-key-broker:8080"
MODEL_BROKER_PLACEHOLDER_KEY="dsh-broker-placeholder"

usage() {
  cat <<'EOF'
用法：install.sh [操作] [选项]

操作：install（默认）、configure、update（容器内更新 DSH）、model-key（给已装好的部署补填模型密钥）、
      key-panel（给已装好的部署开/关模型密钥管理面板）、
      start、stop、restart、logs、status、delete（删除）
选项：
  --access local|trusted-proxy|basic
  --bind-host ADDRESS             Docker 发布端口绑定地址
  --trusted-hosts HOSTS           逗号分隔的公网 host[:port]
  --network NAME                  与 Docker 反向代理共享的外部网络
  --network-external / --network-internal
  --image-source prebuilt|build   prebuilt 拉取已发布镜像，build 在本机编译
  --image REF                     自定义镜像引用（默认按来源推导）
  --root-password VALUE           容器 root 密码（至少 12 位，也可用 DSH_ROOT_PASSWORD）
  --no-root-password              不设置容器 root 密码（容器内任意特权命令保持关闭）
  --model-key NAME=KEY            模型上游密钥（可重复；命令行参数会进 ps，仅供自动化）
  --model-base-url NAME=URL       上游 base_url（可重复；常见上游有内置默认值）
  --model-api NAME=PROFILE        上游 API 形态：any（默认）、chat、responses、messages、gemini
  --model-header NAME=H=V         给某个上游固定一个请求头（可重复，例如 originator、user-agent）
  --model-id NAME=ID[,ID]         写进 DSH 的模型 id（可重复；内置目录里的上游可省略）
  --no-model-settings-seed        不替 DSH 写模型配置（供应商与模型要自己在 WebUI 里填）
  --model-keys-file PATH          导入一份完整的 keys.json（也可用 DSH_MODEL_KEYS_FILE）
  --no-model-broker               关闭模型密钥代理，并清空 data/broker/keys.json
  --key-admin / --no-key-admin    模型密钥管理面板（浏览器里填密钥、拉模型列表、写 DSH 配置）
  --key-admin-bind ADDRESS        面板发布地址（默认 127.0.0.1，改成别的等于把面板暴露出去）
  --key-admin-port PORT           面板宿主端口（默认 3082）
  --egress open|allowlist         容器出站模式（allowlist 只放行白名单域名）
  --egress-allow HOSTS            allowlist 下额外放行的域名（可重复，逗号分隔，支持 *.example.com）
  --userns-preflight              只做宿主 userns-remap 预检并退出，不安装
  --non-interactive               不显示问答，使用参数或安全默认值
  --dir PATH                      工程目录（默认 ./dsh-docker）

关于模型密钥：写在命令行上的密钥会出现在 ps 里，所以人工安装请直接跑向导逐个输入
（不回显），自动化请用 --model-keys-file 指向一份 0600 的 keys.json；--model-key 只是
给没法交互的流水线留的后路。真实密钥永远不会写进 .env。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    install|configure|update|model-key|key-panel|start|stop|restart|logs|status|delete)
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
    --root-password)
      [ "$#" -ge 2 ] || { echo "[错误] --root-password 缺少值。" >&2; exit 2; }
      shift
      ROOT_PASSWORD_OVERRIDE="$1"
      ;;
    --root-password=*) ROOT_PASSWORD_OVERRIDE="${1#*=}" ;;
    --no-root-password) NO_ROOT_PASSWORD=true ;;
    --model-key)
      [ "$#" -ge 2 ] || { echo "[错误] --model-key 缺少值。" >&2; exit 2; }
      shift
      MODEL_KEY_SPECS+=("$1")
      ;;
    --model-key=*) MODEL_KEY_SPECS+=("${1#*=}") ;;
    --model-base-url)
      [ "$#" -ge 2 ] || { echo "[错误] --model-base-url 缺少值。" >&2; exit 2; }
      shift
      MODEL_BASE_URL_SPECS+=("$1")
      ;;
    --model-base-url=*) MODEL_BASE_URL_SPECS+=("${1#*=}") ;;
    --model-api)
      [ "$#" -ge 2 ] || { echo "[错误] --model-api 缺少值。" >&2; exit 2; }
      shift
      MODEL_API_SPECS+=("$1")
      ;;
    --model-api=*) MODEL_API_SPECS+=("${1#*=}") ;;
    --model-header)
      [ "$#" -ge 2 ] || { echo "[错误] --model-header 缺少值。" >&2; exit 2; }
      shift
      MODEL_HEADER_SPECS+=("$1")
      ;;
    --model-header=*) MODEL_HEADER_SPECS+=("${1#*=}") ;;
    --model-id)
      [ "$#" -ge 2 ] || { echo "[错误] --model-id 缺少值。" >&2; exit 2; }
      shift
      MODEL_ID_SPECS+=("$1")
      ;;
    --model-id=*) MODEL_ID_SPECS+=("${1#*=}") ;;
    --no-model-settings-seed) NO_MODEL_SETTINGS_SEED=true ;;
    --model-keys-file)
      [ "$#" -ge 2 ] || { echo "[错误] --model-keys-file 缺少值。" >&2; exit 2; }
      shift
      MODEL_KEYS_FILE="$1"
      ;;
    --model-keys-file=*) MODEL_KEYS_FILE="${1#*=}" ;;
    --no-model-broker) NO_MODEL_BROKER=true ;;
    --key-admin) KEY_ADMIN_OVERRIDE=on ;;
    --no-key-admin) KEY_ADMIN_OVERRIDE=off ;;
    --key-admin-bind)
      [ "$#" -ge 2 ] || { echo "[错误] --key-admin-bind 缺少值。" >&2; exit 2; }
      shift
      PENDING_KEY_ADMIN_BIND_HOST="$1"
      ;;
    --key-admin-bind=*) PENDING_KEY_ADMIN_BIND_HOST="${1#*=}" ;;
    --key-admin-port)
      [ "$#" -ge 2 ] || { echo "[错误] --key-admin-port 缺少值。" >&2; exit 2; }
      shift
      PENDING_KEY_ADMIN_PORT="$1"
      ;;
    --key-admin-port=*) PENDING_KEY_ADMIN_PORT="${1#*=}" ;;
    --egress)
      [ "$#" -ge 2 ] || { echo "[错误] --egress 缺少值。" >&2; exit 2; }
      shift
      EGRESS_MODE_OVERRIDE="$1"
      ;;
    --egress=*) EGRESS_MODE_OVERRIDE="${1#*=}" ;;
    # 可重复：多次 --egress-allow 累积成一条逗号分隔的 DSH_EGRESS_ALLOWED_HOSTS。
    --egress-allow)
      [ "$#" -ge 2 ] || { echo "[错误] --egress-allow 缺少值。" >&2; exit 2; }
      shift
      EGRESS_ALLOW_OVERRIDE="${EGRESS_ALLOW_OVERRIDE:+$EGRESS_ALLOW_OVERRIDE,}$1"
      ;;
    --egress-allow=*) EGRESS_ALLOW_OVERRIDE="${EGRESS_ALLOW_OVERRIDE:+$EGRESS_ALLOW_OVERRIDE,}${1#*=}" ;;
    --userns-preflight) USERNS_PREFLIGHT=true ;;
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
  ''|install|configure|update|model-key|key-panel|start|stop|restart|logs|status|delete) ;;
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
case "$EGRESS_MODE_OVERRIDE" in
  ''|open|allowlist) ;;
  *) echo "[错误] --egress 只支持 open 或 allowlist。" >&2; exit 2 ;;
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

# prompt 会一直问到非空，但有些配置项"留空"本身就是有效答案（例如额外放行的域名），
# 所以这一个只问一次，回车即表示清空当前值。
prompt_optional() {
  local message="$1" default="${2:-}" answer
  if [ -n "$default" ]; then
    printf '%s [当前 %s，回车表示清空]: ' "$message" "$default" > /dev/tty
  else
    printf '%s（可留空）: ' "$message" > /dev/tty
  fi
  IFS= read -r answer < /dev/tty || exit 1
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

# --userns-preflight 只做宿主检查，不该被"这次要做什么"的菜单挡住。
if [ -z "$ACTION" ] && [ "$USERNS_PREFLIGHT" != true ]; then
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
    echo "9) 补填模型 API 密钥（只新增密钥代理容器，不重建 dsh）"
    echo "10) 模型密钥管理面板（浏览器里填密钥、拉模型列表，不重建 dsh）"
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
      9) ACTION=model-key ;;
      10) ACTION=key-panel ;;
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

userns_chown() {
  local path="$1" owner="$2"
  if chown -R "$owner" "$path" 2>/dev/null; then
    echo "    已对齐 $path -> $owner"
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo chown -R "$owner" "$path" 2>/dev/null; then
    echo "    已对齐 $path -> $owner（经 sudo）"
    return 0
  fi
  echo "[警告] 无法把 $path 的属主改成 $owner。" >&2
  return 1
}

# 宿主 userns-remap 预检。开了它之后容器里的 UID 0 在宿主上只是 subuid 区间里的一个
# 普通账户，就算内核漏洞逃逸出去也不是宿主 root——这是纵深防御的最后一层。
#
# 但它是 daemon 级设置，一改会影响这台宿主上的所有容器（所有绑定卷的属主都要重新
# 对齐），所以安装器只做三件事：检测、算出 subuid 基址、对齐本工程的绑定挂载属主。
# 绝不代写 /etc/docker/daemon.json，也绝不代重启 Docker。
userns_preflight() {
  local security_options base root_dir project_dir directory mapped_user mapped_root failed=false
  echo "==> user namespace remap 预检"
  security_options="$(DOCKER info --format '{{.SecurityOptions}}' 2>/dev/null || true)"
  case "$security_options" in
    *name=userns*) ;;
    *)
      echo "    当前状态：未启用（docker info 的 SecurityOptions 里没有 name=userns）"
      echo
      echo "    需要人工执行的步骤（只对 Linux 宿主有意义）："
      echo "      1) 编辑 /etc/docker/daemon.json，加入一行： \"userns-remap\": \"default\""
      echo "      2) sudo systemctl restart docker"
      echo "      3) 回来再跑一次 ./install.sh --userns-preflight，让它把绑定挂载的属主对齐"
      echo
      echo "    重启守护进程之后，这台宿主上所有现有容器的卷属主都会失配：容器里的 UID N"
      echo "    在宿主上变成 BASE+N，原来属于宿主 UID N 的文件容器里就读不到了。不只是 DSH，"
      echo "    每个用绑定挂载的项目都要重新对齐一次。"
      echo "    另外 Docker Desktop / WSL2 不支持 userns-remap（docker run --userns 只接受 host），"
      echo "    在这类环境里改 daemon.json 也不会生效，这条只对 Linux VPS 有意义。"
      return 0
      ;;
  esac
  echo "    当前状态：已启用（$security_options）"
  # 容器 UID N 在宿主上的真实身份是 BASE+N，BASE 就是 dockremap 的起始 subuid。
  base="$(awk -F: '$1 == "dockremap" { print $2; exit }' /etc/subuid 2>/dev/null || true)"
  if [ -z "$base" ]; then
    # /etc/subuid 读不到（远端守护进程、只读宿主）时退一步看 DockerRootDir：
    # remap 打开后它会带上 <uid>.<gid> 后缀，那个 uid 就是 BASE。
    root_dir="$(DOCKER info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
    case "$root_dir" in
      */[0-9]*.[0-9]*)
        base="${root_dir##*/}"
        base="${base%%.*}"
        ;;
    esac
  fi
  case "$base" in
    ''|*[!0-9]*)
      echo "[错误] 宿主已启用 userns-remap，但取不到 dockremap 的起始 subuid。" >&2
      echo "       既读不到 /etc/subuid 的 dockremap 行（格式 dockremap:BASE:COUNT），" >&2
      echo "       docker info 的 DockerRootDir 也没有 <uid>.<gid> 后缀。" >&2
      echo "       请手动确认 BASE 后执行（1000 是容器内 dsh 账户的 UID）：" >&2
      echo "         sudo chown -R \$((BASE + 1000)):\$((BASE + 1000)) data/dsh data/home data/agents data/mcp workspace data/broker" >&2
      echo "         sudo chown -R \$((BASE + 0)):\$((BASE + 0)) data/secret data/auth" >&2
      return 1
      ;;
  esac
  mapped_user=$((base + 1000))
  mapped_root=$((base + 0))
  echo "    dockremap 起始 subuid：$base"
  echo "    映射结果：容器 UID 1000（dsh 账户）== 宿主 UID $mapped_user，容器 root == 宿主 UID $mapped_root"
  echo "    为什么必须在宿主侧改：remap 之后容器 root 只是它自己 user namespace 里的 root，"
  echo "    CAP_CHOWN 也只在那个 namespace 内有效，所以容器改不了绑定挂载目录在宿主上的属主。"
  project_dir=""
  if [ -f "$TARGET_DIR/docker-compose.yml" ]; then
    project_dir="$TARGET_DIR"
  elif [ -f docker-compose.yml ] && [ -f Dockerfile ]; then
    project_dir="."
  fi
  if [ -z "$project_dir" ]; then
    echo "    未找到工程目录（$TARGET_DIR），只打印需要在工程目录里执行的命令："
    echo "      sudo chown -R $mapped_user:$mapped_user data/dsh data/home data/agents data/mcp workspace data/broker"
    echo "      sudo chown -R $mapped_root:$mapped_root data/secret data/auth"
    return 0
  fi
  ( cd "$project_dir" && mkdir -p data/dsh data/home data/agents data/mcp data/broker data/secret data/auth workspace )
  # 走 DSH 账户的目录用 BASE+1000；data/secret 与 data/auth 只被容器 root 读，用 BASE+0。
  for directory in data/dsh data/home data/agents data/mcp workspace data/broker; do
    userns_chown "$project_dir/$directory" "$mapped_user:$mapped_user" || failed=true
  done
  for directory in data/secret data/auth; do
    userns_chown "$project_dir/$directory" "$mapped_root:$mapped_root" || failed=true
  done
  if [ "$failed" = true ]; then
    echo "[错误] 有目录的属主没能对齐，容器起来之后会读不到它们。" >&2
    echo "       请用 root 重跑：sudo ./install.sh --userns-preflight --dir $TARGET_DIR" >&2
    return 1
  fi
  echo "==> 绑定挂载的属主已全部对齐，可以继续安装或启动容器。"
}

if [ "$USERNS_PREFLIGHT" = true ]; then
  if userns_preflight; then
    exit 0
  fi
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
  local container_name
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
      # 密钥代理与出站隔离的叠加文件同样要带上，否则 down 看不到 dsh-key-broker /
      # dsh-egress / dsh-ingress 这几个服务，它们会连着 dsh-internal 网络一起留下来。
      # 老部署目录里没有这两个文件，所以必须逐个判断存在性。
      [ -f docker-compose.keys.yml ] && compose_files+=( -f docker-compose.keys.yml )
      [ -f docker-compose.keys-admin.yml ] && compose_files+=( -f docker-compose.keys-admin.yml )
      [ -f docker-compose.isolated.yml ] && compose_files+=( -f docker-compose.isolated.yml )
      DOCKER compose -p "$project_name" "${compose_files[@]}" down --volumes --remove-orphans
    ) || true
  fi

  container_ids="$(DOCKER container ls -aq --filter "label=com.docker.compose.project=$project_name" 2>/dev/null || true)"
  while IFS= read -r id; do
    [ -n "$id" ] && DOCKER container rm -f "$id" >/dev/null 2>&1 || true
  done <<< "$container_ids"
  # 兜底按名字删：叠加文件缺失、或者容器被手工从项目里摘掉时，标签过滤都找不到它们。
  for container_name in dsh dsh-key-broker dsh-key-admin dsh-egress dsh-ingress; do
    DOCKER container rm -f "$container_name" >/dev/null 2>&1 || true
  done
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
  for container_name in dsh-private dsh-internal dsh-admin; do
    network_project="$(DOCKER network inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$container_name" 2>/dev/null || true)"
    if [ "$network_project" = "$project_name" ]; then
      DOCKER network rm "$container_name" >/dev/null 2>&1 || true
    fi
  done
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

# data/auth 存 Basic Auth 的 bcrypt 文件；data/secret 只存容器 root 口令哈希，
# 并且只挂到容器的 /root/dsh-secret（0700 root:root），dsh 账户读不到。
# data/broker 存模型密钥，只被 dsh-key-broker 容器以 UID 1000 只读挂载，
# 完全不出现在 DSH 容器的挂载表里。
mkdir -p data/auth data/secret data/broker
COMPOSE_ARGS=(-f docker-compose.yml)

# 叠加顺序是契约的一部分，不能按别的顺序拼：keys.yml 先把 dsh-key-broker 放进
# dsh-internal，isolated.yml 才能把 dsh 收进那张没有网关的网络而不切断模型请求。
set_compose_args() {
  COMPOSE_ARGS=(-f docker-compose.yml)
  if [ "$PENDING_MODEL_BROKER" = on ]; then
    if [ ! -f docker-compose.keys.yml ]; then
      echo "[错误] 需要 docker-compose.keys.yml 才能启用模型密钥代理，但工程目录里没有它。" >&2
      echo "       请更新工程源码，或用 --no-model-broker 关闭密钥代理。" >&2
      exit 1
    fi
    COMPOSE_ARGS+=(-f docker-compose.keys.yml)
    # 面板依附密钥代理：它改的就是 broker 那份 keys.json，broker 关着的话面板没有意义。
    if [ "$PENDING_KEY_ADMIN" = on ]; then
      if [ ! -f docker-compose.keys-admin.yml ]; then
        echo "[错误] 需要 docker-compose.keys-admin.yml 才能启用密钥管理面板，但工程目录里没有它。" >&2
        echo "       请更新工程源码，或用 --no-key-admin 关闭面板。" >&2
        exit 1
      fi
      COMPOSE_ARGS+=(-f docker-compose.keys-admin.yml)
    fi
  elif [ "$PENDING_KEY_ADMIN" = on ]; then
    echo "[警告] 密钥代理关着，密钥管理面板不会启动（它管理的就是代理那份密钥配置）。" >&2
    PENDING_KEY_ADMIN=off
  fi
  if [ "$PENDING_EGRESS_MODE" = allowlist ]; then
    if [ ! -f docker-compose.isolated.yml ]; then
      echo "[错误] 需要 docker-compose.isolated.yml 才能启用出站白名单模式，但工程目录里没有它。" >&2
      echo "       请更新工程源码，或用 --egress open 保持直连出网。" >&2
      exit 1
    fi
    COMPOSE_ARGS+=(-f docker-compose.isolated.yml)
  fi
}

# ---------------------------------------------------------------------------
# 模型密钥代理（dsh-key-broker）
#
# 这一整段只为一件事服务：真实模型密钥不要出现在 DSH 容器里。那个容器里的 Agent 以
# danger-full-access 运行，放进去的密钥不需要"骗"它说出来，一条 cat 就够了。所以密钥
# 只写 data/broker/keys.json（0600，只被 broker 容器只读挂载），.env 里只留开关和地址。
# ---------------------------------------------------------------------------

# 内置 base_url 只是省掉常见上游的手输。其它上游必须显式给 --model-base-url：
# 猜错 base_url 等于把密钥发到一个我们没验证过的域名，宁可报错退出。
#
# 这些值抄的是 DSH 内置模型目录（pi-ai catalog）里同名 provider 的 base_url，
# 版本段（/v1、/v1beta 等）必须留在这里：DSH 侧填的是 <代理>/u/<上游名>，客户端
# SDK 只会往后接 /chat/completions、/responses、/v1/messages、/models/... 这类相对
# 路径，版本段由代理这一侧的上游 base_url 提供。名字与目录对上还有一个额外好处：
# 安装器写进 settings.yaml 时能直接沿用目录里的整份模型清单。
model_default_base_url() {
  case "$1" in
    deepseek) printf '%s' 'https://api.deepseek.com' ;;
    openai) printf '%s' 'https://api.openai.com/v1' ;;
    anthropic) printf '%s' 'https://api.anthropic.com' ;;
    google) printf '%s' 'https://generativelanguage.googleapis.com/v1beta' ;;
    nvidia) printf '%s' 'https://integrate.api.nvidia.com/v1' ;;
    openrouter) printf '%s' 'https://openrouter.ai/api/v1' ;;
    groq) printf '%s' 'https://api.groq.com/openai/v1' ;;
    xai) printf '%s' 'https://api.x.ai/v1' ;;
    moonshotai) printf '%s' 'https://api.moonshot.ai/v1' ;;
    together) printf '%s' 'https://api.together.ai/v1' ;;
    cerebras) printf '%s' 'https://api.cerebras.ai/v1' ;;
    mistral) printf '%s' 'https://api.mistral.ai' ;;
    zai) printf '%s' 'https://api.z.ai/api/coding/paas/v4' ;;
    *) return 1 ;;
  esac
}

# 转义全程用 bash 自己的字符串替换，不调用任何外部命令：密钥因此不会出现在
# 任何进程的命令行里，也就不会进 ps。
json_escape() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  text="${text//$'\n'/\\n}"
  text="${text//$'\r'/\\r}"
  text="${text//$'\t'/\\t}"
  printf '%s' "$text"
}

json_string() {
  printf '"%s"' "$(json_escape "$1")"
}

# 上游名字同时是 settings.yaml 里的路由键和凭据引用名的词干，所以规则不能比 DSH
# 自己宽：官方「添加自定义提供方」用的是 /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/——首字符必须是
# 小写字母（凭据引用名是 POSIX 标识符，不能以数字开头），分隔符只有单个短横线，末尾
# 不能是短横线。放行 b_ai、4o 之类的名字，只会写出一条用户在官方页面上改不了的路由。
validate_upstream_name() {
  local name="$1"
  case "$name" in
    ''|[!a-z]*|*[!a-z0-9-]*|*-|*--*)
      echo "[错误] 上游名字要以小写字母开头，之后只能是小写字母、数字和单个短横线：$name" >&2
      return 1
      ;;
  esac
  if [ "${#name}" -gt 32 ]; then
    echo "[错误] 上游名字最多 32 个字符：$name" >&2
    return 1
  fi
}

# 这里只挡明显写错的（明文、内嵌凭据、带 query）。严格校验在 broker 的
# parseBrokerConfig 里，配置写错它会直接拒绝启动——所以早报错比晚报错好。
validate_upstream_base_url() {
  local url="$1"
  case "$url" in
    https://?*) ;;
    *) echo "[错误] base_url 必须使用 https（密钥不能走明文）：$url" >&2; return 1 ;;
  esac
  case "$url" in
    *[?#]*) echo "[错误] base_url 不允许带 query 或 fragment：$url" >&2; return 1 ;;
    *@*) echo "[错误] base_url 不允许内嵌凭据：$url" >&2; return 1 ;;
  esac
}

model_base_url_override() {
  local wanted="$1" spec
  for spec in ${MODEL_BASE_URL_SPECS[@]+"${MODEL_BASE_URL_SPECS[@]}"}; do
    if [ "${spec%%=*}" = "$wanted" ]; then
      printf '%s' "${spec#*=}"
      return 0
    fi
  done
  return 1
}

# 优先级：显式传入 > --model-base-url > 内置默认表 > 报错。
resolve_upstream_base_url() {
  local name="$1" explicit="$2" url=""
  if [ -n "$explicit" ]; then
    url="$explicit"
  elif url="$(model_base_url_override "$name")"; then
    :
  elif url="$(model_default_base_url "$name")"; then
    :
  else
    echo "[错误] 上游 $name 没有内置 base_url，请显式指定：--model-base-url $name=https://..." >&2
    return 1
  fi
  validate_upstream_base_url "$url" || return 1
  printf '%s' "$url"
}

# API 形态（profile）→ 认证头与放行的路径前缀。上游千差万别，但认证方式和端点形态其实
# 只有几种，让人在向导里选一次比让他手写 keys.json 的 headerName/allowedPathPrefixes 现实。
# any 表示不写 allowedPathPrefixes，沿用 broker 内置的兼容端点集合。
broker_profile_header_name() {
  case "$1" in
    messages) printf '%s' 'x-api-key' ;;
    gemini) printf '%s' 'x-goog-api-key' ;;
    *) printf '%s' 'authorization' ;;
  esac
}

broker_profile_header_template() {
  case "$1" in
    messages|gemini) printf '%s' '{key}' ;;
    *) printf '%s' 'Bearer {key}' ;;
  esac
}

# 收窄到这个形态真正会用到的端点。代理本来就默认拒绝名单外的路径，选形态只是再紧一层：
# 拿到占位密钥的 Agent 连"换个端点试试"都做不到。
broker_profile_paths() {
  case "$1" in
    chat) printf '%s' '/v1/chat/completions /chat/completions /v1/models /models' ;;
    responses) printf '%s' '/v1/responses /responses /v1/models /models' ;;
    messages) printf '%s' '/v1/messages /messages /v1/models /models' ;;
    gemini) printf '%s' '/models /v1beta/models' ;;
    *) printf '%s' '' ;;
  esac
}

# Anthropic 缺 anthropic-version 会被上游直接 400，所以这个头跟着形态一起给。
broker_profile_headers() {
  case "$1" in
    messages) printf '%s' 'anthropic-version=2023-06-01' ;;
    *) printf '%s' '' ;;
  esac
}

# 没显式选形态时按上游名猜一个。猜错也只是路径前缀宽一点，不会写错认证头。
broker_default_profile() {
  case "$1" in
    anthropic|claude) printf '%s' 'messages' ;;
    gemini|google|googleai) printf '%s' 'gemini' ;;
    *) printf '%s' 'any' ;;
  esac
}

validate_broker_profile() {
  case "$1" in
    any|chat|responses|messages|gemini) ;;
    *) echo "[错误] 未知的 API 形态：$1（可选 any、chat、responses、messages、gemini）" >&2; return 1 ;;
  esac
}

# 认证头由 profile 决定，而客户端自带的认证材料会被 broker 剥掉。额外请求头因此不允许
# 覆盖这些名字：那等于让一份配置悄悄绕过密钥注入。逐跳头也拦掉，转发时它们本来就会被丢。
BROKER_FORBIDDEN_HEADERS="authorization proxy-authorization api-key x-api-key x-goog-api-key x-auth-token cookie set-cookie host forwarded x-forwarded-for x-forwarded-host x-forwarded-proto x-real-ip content-length connection keep-alive transfer-encoding upgrade te trailer"

# 成功时把归一化后的 name=value 打到 stdout，失败时只在 stderr 说原因。
validate_broker_header() {
  local spec="$1" name value forbidden
  case "$spec" in
    ?*=?*) ;;
    *) echo "[错误] 请求头需要 name=value 格式，两边都不能为空：$spec" >&2; return 1 ;;
  esac
  name="$(printf '%s' "${spec%%=*}" | tr '[:upper:]' '[:lower:]')"
  value="${spec#*=}"
  case "$name" in
    ''|[!a-z0-9]*|*[!a-z0-9-]*)
      echo "[错误] 不是合法的 HTTP 头名：$name" >&2
      return 1
      ;;
  esac
  for forbidden in $BROKER_FORBIDDEN_HEADERS; do
    if [ "$name" = "$forbidden" ]; then
      echo "[错误] 请求头 $name 由密钥代理自己管理，不能在这里覆盖。" >&2
      return 1
    fi
  done
  printf '%s=%s' "$name" "$value"
}

add_broker_upstream() {
  local name="$1" base="$2" key="$3" rpm="${4:-0}" daily="${5:-0}" profile="${6:-}" headers="${7:-}" models="${8:-}" resolved index
  name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  validate_upstream_name "$name" || return 1
  [ -n "$profile" ] || profile="$(broker_default_profile "$name")"
  validate_broker_profile "$profile" || return 1
  if [ -z "$key" ]; then
    echo "[错误] 上游 $name 的密钥为空。" >&2
    return 1
  fi
  resolved="$(resolve_upstream_base_url "$name" "$base")" || return 1
  case "$rpm" in ''|*[!0-9]*) echo "[错误] 每分钟请求上限必须是非负整数：$rpm" >&2; return 1 ;; esac
  case "$daily" in ''|*[!0-9]*) echo "[错误] 每日请求配额必须是非负整数：$daily" >&2; return 1 ;; esac
  # 同名上游以最后一次为准，和 keys.json 的合并语义保持一致。
  index=0
  while [ "$index" -lt "${#BROKER_NAMES[@]}" ]; do
    if [ "${BROKER_NAMES[$index]}" = "$name" ]; then
      BROKER_BASE_URLS[$index]="$resolved"
      BROKER_KEYS[$index]="$key"
      BROKER_RPM[$index]="$rpm"
      BROKER_DAILY[$index]="$daily"
      BROKER_PROFILES[$index]="$profile"
      BROKER_HEADERS[$index]="$headers"
      BROKER_MODELS[$index]="$models"
      return 0
    fi
    index=$((index + 1))
  done
  BROKER_NAMES+=("$name")
  BROKER_BASE_URLS+=("$resolved")
  BROKER_KEYS+=("$key")
  BROKER_RPM+=("$rpm")
  BROKER_DAILY+=("$daily")
  BROKER_PROFILES+=("$profile")
  BROKER_HEADERS+=("$headers")
  BROKER_MODELS+=("$models")
}

# 上游的 API 形态：内存里没有这个上游时（例如选了"保留现有配置"，名字是从 keys.json
# 里捞的）退回 any——那只影响端点收窄的宽窄，不影响认证头写对写错。
broker_upstream_profile() {
  local wanted="$1" index=0
  while [ "$index" -lt "${#BROKER_NAMES[@]}" ]; do
    if [ "${BROKER_NAMES[$index]}" = "$wanted" ]; then
      printf '%s' "${BROKER_PROFILES[$index]}"
      return 0
    fi
    index=$((index + 1))
  done
  printf '%s' 'any'
}

# 这个上游在向导里填过的模型 id（逗号分隔）。没填过就是空串。
broker_upstream_models() {
  local wanted="$1" index=0
  while [ "$index" -lt "${#BROKER_NAMES[@]}" ]; do
    if [ "${BROKER_NAMES[$index]}" = "$wanted" ]; then
      printf '%s' "${BROKER_MODELS[$index]}"
      return 0
    fi
    index=$((index + 1))
  done
  printf '%s' ''
}

# 把自动问到的模型清单回填进数组。名字对不上就什么都不做（上游可能已经被跳过了）。
set_broker_models() {
  local wanted="$1" value="$2" index=0
  while [ "$index" -lt "${#BROKER_NAMES[@]}" ]; do
    if [ "${BROKER_NAMES[$index]}" = "$wanted" ]; then
      BROKER_MODELS[$index]="$value"
      return 0
    fi
    index=$((index + 1))
  done
}

# 上游名字不是秘密，可以进摘要和日志；密钥永远不进。
broker_upstream_names() {
  local index=0 names=""
  while [ "$index" -lt "${#BROKER_NAMES[@]}" ]; do
    names="${names:+$names }${BROKER_NAMES[$index]}"
    index=$((index + 1))
  done
  if [ -z "$names" ] && [ -s data/broker/keys.json ]; then
    # 选了"保留现有配置"时内存里没有上游列表，只为摘要从文件里捞一遍名字。
    names="$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([a-z0-9_-]\{1,32\}\)".*/\1/p' data/broker/keys.json | sort -u | tr '\n' ' ')"
  fi
  printf '%s' "$names"
}

# 可选字段能省就省：把 broker 的默认值抄一份进 keys.json，只会在 broker 改默认值之后
# 变成静默的行为分叉，也让人更难看出哪些限制是自己真的设过的。
broker_upstreams_json() {
  local index=0 body="" entry name newline profile header_name header_template paths prefix extras extra pairs
  newline=$'\n'
  while [ "$index" -lt "${#BROKER_NAMES[@]}" ]; do
    name="${BROKER_NAMES[$index]}"
    entry="$(printf '{"name": %s, "baseUrl": %s, "key": %s' \
      "$(json_string "$name")" \
      "$(json_string "${BROKER_BASE_URLS[$index]}")" \
      "$(json_string "${BROKER_KEYS[$index]}")")"
    profile="${BROKER_PROFILES[$index]}"
    header_name="$(broker_profile_header_name "$profile")"
    header_template="$(broker_profile_header_template "$profile")"
    # 只有偏离 broker 默认值时才写出来：把默认值抄进配置只会在 broker 改默认值之后
    # 变成静默的行为分叉。
    if [ "$header_name" != authorization ] || [ "$header_template" != 'Bearer {key}' ]; then
      entry="$entry, \"headerName\": $(json_string "$header_name"), \"headerTemplate\": $(json_string "$header_template")"
    fi
    paths=""
    for prefix in $(broker_profile_paths "$profile"); do
      paths="${paths:+$paths, }$(json_string "$prefix")"
    done
    [ -z "$paths" ] || entry="$entry, \"allowedPathPrefixes\": [$paths]"
    # 形态自带的头（例如 anthropic-version）在前，用户自己填的在后：同名时以用户的为准。
    extras=""
    pairs="$(broker_profile_headers "$profile")"
    [ -z "${BROKER_HEADERS[$index]}" ] || pairs="${pairs:+$pairs$BROKER_HEADER_RS}${BROKER_HEADERS[$index]}"
    while [ -n "$pairs" ]; do
      case "$pairs" in
        *"$BROKER_HEADER_RS"*) extra="${pairs%%"$BROKER_HEADER_RS"*}"; pairs="${pairs#*"$BROKER_HEADER_RS"}" ;;
        *) extra="$pairs"; pairs="" ;;
      esac
      [ -n "$extra" ] || continue
      extras="${extras:+$extras, }$(json_string "${extra%%=*}"): $(json_string "${extra#*=}")"
    done
    [ -z "$extras" ] || entry="$entry, \"extraHeaders\": {$extras}"
    # dsh 这个字段 broker 自己会忽略（它的解析器丢掉未知字段），存的是"DSH 侧要怎么填"：
    # 形态和模型清单。不写的话密钥管理面板打开这条上游时看到的是空清单，用户会以为
    # 安装时填的东西丢了，一保存还会把已经问到的模型清单覆盖掉。
    entry="$entry, \"dsh\": {\"api\": $(json_string "$profile"), \"models\": $(broker_models_json "${BROKER_MODELS[$index]}")}"
    [ "${BROKER_RPM[$index]}" = 0 ] || entry="$entry, \"requestsPerMinute\": ${BROKER_RPM[$index]}"
    [ "${BROKER_DAILY[$index]}" = 0 ] || entry="$entry, \"dailyRequestBudget\": ${BROKER_DAILY[$index]}"
    entry="$entry}"
    body="${body:+$body,$newline    }$entry"
    index=$((index + 1))
  done
  printf '[%s    %s%s  ]' "$newline" "$body" "$newline"
}

# 合并交给 node：现有 keys.json 里可能还有这次没提到的上游，整体覆盖会把它们丢掉，
# 而 shell 没法可靠地拆一份可能含任意字符的 JSON。宿主有 node 就用宿主的，没有就用
# 镜像里的（镜像必然带 node，broker 本身就跑在上面）。密钥全程走 stdin，不进命令行。
BROKER_MERGE_SCRIPT='
const chunks = []
process.stdin.on("data", (chunk) => chunks.push(chunk))
process.stdin.on("end", () => {
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  const incoming = Array.isArray(payload.incoming) ? payload.incoming : []
  const names = new Set(incoming.map((entry) => entry && entry.name))
  let kept = []
  if (payload.existing) {
    const document = JSON.parse(payload.existing)
    if (Array.isArray(document.upstreams)) {
      kept = document.upstreams.filter((entry) => entry && !names.has(entry.name))
    }
  }
  process.stdout.write(JSON.stringify({ version: 1, upstreams: kept.concat(incoming) }, null, 2))
})
'

# 需要"一个带 node 的镜像"时用哪个 tag。model-key 这条路径不走 obtain_dsh_image，
# 所以 PENDING_IMAGE 是空的，直接拿它去 docker run 只会得到 invalid reference format。
# 顺序：本次安装选定的 > .env 里记着的 > 现有 dsh 容器实际在用的 > 预构建镜像。
node_tool_image() {
  local image="$PENDING_IMAGE"
  [ -n "$image" ] || image="$(get_compose_env DSH_IMAGE "")"
  [ -n "$image" ] || image="$(DOCKER container inspect dsh --format '{{.Config.Image}}' 2>/dev/null || true)"
  [ -n "$image" ] || image="$DEFAULT_PREBUILT_IMAGE"
  printf '%s' "$image"
}

merge_broker_config() {
  local incoming="$1" payload image
  payload="$(printf '{"existing": %s, "incoming": %s}' \
    "$(json_string "$(cat data/broker/keys.json)")" "$incoming")"
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$payload" | node -e "$BROKER_MERGE_SCRIPT"
  else
    # 故意不用 docker exec 进 dsh：合并的输入里带着真实密钥，让它流经 Agent 那个容器
    # 就等于白搭一个密钥代理。这里起的是一次性容器，只借它的 node，用完即弃。
    image="$(node_tool_image)"
    printf '%s' "$payload" | DOCKER run --rm -i --entrypoint node "$image" -e "$BROKER_MERGE_SCRIPT"
  fi
}

# 替"DSH 内置目录之外的上游"向上游问一次模型清单。
#
# 这一步不是省一次输入：DSH 对目录外的路由要求至少一个模型 id，缺了就拒绝整条路由，
# 而拒绝的表现是 WebUI 的模型页不多出卡片、也不报任何错。向导以前靠追问用户手写模型
# id 来避免它，但那是把上游文档的活推给了用户，跳过一次就装出一个"填了密钥却选不到
# 模型"的部署。密钥这时就在手上，直接问上游最省事；问不出来才提示手动补。
#
# 密钥全程走 stdin，不进任何进程的命令行。宿主有 node 就用宿主的，没有就借镜像里那个
# （和 merge_broker_config 同一个理由：绝不让密钥流经 dsh 容器）。
discover_broker_models() {
  local image="$1" index=0 name payload upstreams="" result kind value count
  [ "${#BROKER_NAMES[@]}" -gt 0 ] || return 0
  if [ ! -f bin/discover-upstream-models.mjs ]; then
    return 0
  fi
  while [ "$index" -lt "${#BROKER_NAMES[@]}" ]; do
    name="${BROKER_NAMES[$index]}"
    if [ -z "${BROKER_MODELS[$index]}" ] && ! model_default_base_url "$name" >/dev/null 2>&1; then
      upstreams="${upstreams:+$upstreams, }{\"name\": $(json_string "$name"), \"baseUrl\": $(json_string "${BROKER_BASE_URLS[$index]}"), \"key\": $(json_string "${BROKER_KEYS[$index]}"), \"shape\": $(json_string "${BROKER_PROFILES[$index]}")}"
    fi
    index=$((index + 1))
  done
  [ -n "$upstreams" ] || return 0
  echo "==> 这些上游不在 DSH 内置模型目录里，正在向上游问它们的模型清单..."
  payload="$(printf '{"upstreams": [%s]}' "$upstreams")"
  if command -v node >/dev/null 2>&1; then
    result="$(printf '%s' "$payload" | node bin/discover-upstream-models.mjs 2>/dev/null || true)"
  else
    [ -n "$image" ] || image="$(node_tool_image)"
    result="$(printf '%s' "$payload" | DOCKER run --rm -i \
      -v "$(pwd)/bin:/dsh-bin:ro" --entrypoint node "$image" \
      /dsh-bin/discover-upstream-models.mjs 2>/dev/null || true)"
  fi
  payload=""
  while IFS="$(printf '\t')" read -r kind name value; do
    case "$kind" in
      models)
        [ -n "$value" ] || continue
        set_broker_models "$name" "$value"
        count="$(printf '%s' "$value" | tr ',' '\n' | grep -c .)"
        echo "    $name：问到 $count 个模型 id，已写进 DSH 的模型清单。"
        ;;
      failed)
        echo "[警告] 上游 $name 的模型清单问不出来：$value" >&2
        echo "       DSH 要求内置目录之外的上游至少有一个模型 id，所以它暂时不会出现在" >&2
        echo "       「设置 → 模型」里。装完在密钥管理面板的\"模型清单\"里手写一个再保存即可。" >&2
        ;;
    esac
  done <<EOF
$result
EOF
  result=""
}

# --no-model-broker 必须真的把密钥清掉：只翻开关、把文件留在盘上，等于密钥还在。
clear_broker_config() {
  [ -e data/broker/keys.json ] || return 0
  rm -f data/broker/keys.json
  echo "==> 已删除 data/broker/keys.json（模型密钥代理已关闭）。"
}

import_model_keys_file() {
  local source="$1" temporary
  if [ ! -r "$source" ]; then
    echo "[错误] 读不到 --model-keys-file 指定的文件：$source" >&2
    exit 2
  fi
  # 只做最基本的形状检查：完整校验在 broker 的 parseBrokerConfig 里，写错了它会拒绝启动。
  if ! grep -q '"upstreams"' "$source"; then
    echo "[错误] $source 里没有 upstreams 字段，不像是 keys.json。" >&2
    exit 2
  fi
  mkdir -p data/broker
  temporary="$(mktemp data/broker/keys.json.tmp.XXXXXX)"
  chmod 600 "$temporary"
  cat "$source" > "$temporary"
  mv "$temporary" data/broker/keys.json
  broker_config_chown
  echo "==> 已从 $source 导入模型密钥配置（0600）。"
}

# broker 容器以 UID 1000 只读挂载这份文件，属主不对它就读不到。chown 会在 rootless、
# 非 1000 的宿主用户或非 Linux 宿主上失败，那不是安装失败，所以只警告不中断。
broker_config_chown() {
  if chown 1000:1000 data/broker/keys.json 2>/dev/null; then
    return 0
  fi
  echo "[警告] 无法把 data/broker/keys.json 的属主改成 1000:1000。" >&2
  echo "       dsh-key-broker 以 UID 1000 只读挂载它；如果容器报读不到配置，请在宿主上执行：" >&2
  echo "       sudo chown 1000:1000 data/broker/keys.json" >&2
}


# ---------------------------------------------------------------------------
# 模型密钥管理面板（dsh-key-admin）
#
# 它补的是"密钥只能在安装向导里填"这个缺口：换密钥、加供应商、改模型清单都不该
# 只能回终端，但也不能挪到 DSH 自己的 WebUI 里——那个页面跑在 dsh 容器内，填进去的
# 密钥就落在 Agent 能读的地方。所以面板是又一个独立容器，写的仍然是同一份
# data/broker/keys.json，broker 按 mtime 热加载。
#
# 三条边界（缺一条这个面板就成了新的攻击面）：
#   1. 面板只挂 dsh-admin 网络，dsh 容器不在其中，跨网桥流量被 Docker 自己拦掉；
#   2. 宿主端口默认只发布在 127.0.0.1：发布到 0.0.0.0 的话 dsh 容器能经网关回连；
#   3. 所有 /api 都要令牌，令牌写 data/broker/admin.token（0600），不进 .env。
# ---------------------------------------------------------------------------

# 面板令牌。48 个十六进制字符（192 bit），只从 /dev/urandom 取，不经过任何外部命令的
# 命令行。已有令牌就保留：重跑安装不该让人重新去翻一遍新令牌。
write_key_admin_token() {
  local temporary
  [ "$PENDING_KEY_ADMIN" = on ] || return 0
  mkdir -p data/broker
  if [ -s data/broker/admin.token ]; then
    KEY_ADMIN_TOKEN_STATE=kept
  else
    if [ ! -r /dev/urandom ]; then
      echo "[错误] 读不到 /dev/urandom，无法生成面板令牌。" >&2
      exit 1
    fi
    temporary="$(mktemp data/broker/admin.token.tmp.XXXXXX)"
    chmod 600 "$temporary"
    od -An -tx1 -N24 /dev/urandom | tr -d '[:space:]' > "$temporary"
    printf '\n' >> "$temporary"
    mv "$temporary" data/broker/admin.token
    KEY_ADMIN_TOKEN_STATE=new
    echo "==> 已生成密钥管理面板令牌：data/broker/admin.token（0600），未写入 .env。"
  fi
  # 面板容器以 UID 1000 读它，属主不对就读不到，进程会直接退出。
  if ! chown 1000:1000 data/broker/admin.token 2>/dev/null; then
    echo "[警告] 无法把 data/broker/admin.token 的属主改成 1000:1000。" >&2
    echo "       面板容器以 UID 1000 读它；如果容器报读不到令牌，请执行：" >&2
    echo "       sudo chown 1000:1000 data/broker/admin.token" >&2
  fi
}

read_key_admin_token() {
  [ -s data/broker/admin.token ] || return 1
  tr -d '[:space:]' < data/broker/admin.token
}

# 面板的访问方式。令牌只在本次新生成时回显一次：已有令牌的部署重跑安装时把它再打一遍，
# 等于把长期凭据抄进终端记录和滚动缓冲区，没有任何必要。
print_key_admin_access() {
  local token
  [ "$PENDING_KEY_ADMIN" = on ] || return 0
  echo "    模型密钥面板: http://$PENDING_KEY_ADMIN_BIND_HOST:$PENDING_KEY_ADMIN_PORT/"
  if [ "$KEY_ADMIN_TOKEN_STATE" = new ] && token="$(read_key_admin_token)"; then
    echo "      访问令牌: $token"
    echo "      （只回显这一次；随时可以从 $(pwd)/data/broker/admin.token 再取）"
  else
    echo "      访问令牌: 见 $(pwd)/data/broker/admin.token（cat 一下粘到页面上）"
  fi
  case "$PENDING_KEY_ADMIN_BIND_HOST" in
    127.0.0.1|localhost|'[::1]'|::1)
      echo "      远程访问: ssh -N -L $PENDING_KEY_ADMIN_PORT:127.0.0.1:$PENDING_KEY_ADMIN_PORT <用户名@宿主地址>"
      ;;
  esac
}

# 面板要能从零开始：容器先起来，第一把密钥在页面上填。broker 的挂载是一份文件，
# 文件不存在的话 Docker 会把挂载点建成目录，broker 会直接启动失败，所以先落一份空的。
# 空的 upstreams 是合法状态：这时 broker 对每个 /u/ 请求都回 503。
ensure_broker_config_placeholder() {
  [ ! -s data/broker/keys.json ] || return 0
  mkdir -p data/broker
  printf '{\n  "version": 1,\n  "upstreams": []\n}\n' > data/broker/keys.json
  chmod 600 data/broker/keys.json
  broker_config_chown
  echo "==> 已创建空的 data/broker/keys.json（0600）：密钥留到面板里填。"
}

configure_key_admin() {
  PENDING_KEY_ADMIN="$(get_compose_env DSH_KEY_ADMIN off)"
  case "$PENDING_KEY_ADMIN" in on|off) ;; *) PENDING_KEY_ADMIN=off ;; esac
  [ -z "$KEY_ADMIN_OVERRIDE" ] || PENDING_KEY_ADMIN="$KEY_ADMIN_OVERRIDE"
  [ -n "$PENDING_KEY_ADMIN_BIND_HOST" ] || PENDING_KEY_ADMIN_BIND_HOST="$(get_compose_env DSH_KEY_ADMIN_BIND_HOST "$DEFAULT_KEY_ADMIN_BIND_HOST")"
  [ -n "$PENDING_KEY_ADMIN_PORT" ] || PENDING_KEY_ADMIN_PORT="$(get_compose_env DSH_KEY_ADMIN_HOST_PORT "$DEFAULT_KEY_ADMIN_PORT")"
  case "$PENDING_KEY_ADMIN_PORT" in
    ''|*[!0-9]*) echo "[错误] 面板端口必须是数字：$PENDING_KEY_ADMIN_PORT" >&2; exit 2 ;;
  esac
  if [ "$PENDING_KEY_ADMIN_PORT" -lt 1 ] || [ "$PENDING_KEY_ADMIN_PORT" -gt 65535 ]; then
    echo "[错误] 面板端口超出范围：$PENDING_KEY_ADMIN_PORT" >&2
    exit 2
  fi
  if [ "$PENDING_MODEL_BROKER" != on ] || [ ! -f docker-compose.keys-admin.yml ]; then
    PENDING_KEY_ADMIN=off
    return 0
  fi
  if [ "$INTERACTIVE" != true ] || [ -n "$KEY_ADMIN_OVERRIDE" ]; then
    return 0
  fi
  echo
  echo "模型密钥管理面板："
  echo "    浏览器里填密钥、按上游拉一次模型列表、设固定请求头（originator / version /"
  echo "    User-Agent 这些），保存后直接写进 DSH 的模型配置，不用再回终端。"
  echo "    它是独立容器，默认只发布在 $PENDING_KEY_ADMIN_BIND_HOST:$PENDING_KEY_ADMIN_PORT，"
  echo "    dsh 容器连不到它；访问要一个令牌，令牌在 data/broker/admin.token。"
  prompt_yes_no "启用模型密钥管理面板" y
  if [ "$PROMPT_RESULT" = true ]; then
    PENDING_KEY_ADMIN=on
  else
    PENDING_KEY_ADMIN=off
  fi
}

# 面板的核验分两半：它自己活着，以及 dsh 容器确实连不到它。第二条是整个隔离设计的
# 前提——面板持有全部真实密钥，Agent 一旦能打到它，密钥代理就白搭了。
assert_key_admin() {
  local attempt state="" probe
  [ "$PENDING_KEY_ADMIN" = on ] || return 0
  echo "==> 正在核验模型密钥管理面板（dsh-key-admin）..."
  for ((attempt = 0; attempt < 30; attempt++)); do
    if DOCKER exec dsh-key-admin node -e "fetch('http://127.0.0.1:8090/healthz').then((response) => process.exit(response.status === 204 ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
      state=ok
      break
    fi
    sleep 1
  done
  if [ "$state" != ok ]; then
    echo "[错误] dsh-key-admin 未在 30 秒内让 /healthz 返回 204。" >&2
    echo "       查看原因：docker logs dsh-key-admin（读不到令牌时它会直接退出）。" >&2
    return 1
  fi
  echo "==> 已核验 dsh-key-admin /healthz = 204"
  probe="const net = require('node:net'); const socket = net.connect(8090, 'dsh-key-admin'); socket.on('connect', () => { socket.destroy(); process.exit(0) }); socket.on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 4000)"
  if DOCKER exec dsh node -e "$probe" >/dev/null 2>&1; then
    echo "[错误] dsh 容器能连到 dsh-key-admin:8090：面板对 Agent 可达，真实密钥等于没有隔离。" >&2
    echo "       请检查 docker-compose.keys-admin.yml 的 networks 有没有被改过（面板只能在 dsh-admin 上）。" >&2
    return 1
  fi
  echo "==> 已核验 dsh 容器连不到 dsh-key-admin（面板不在 Agent 可达的网络里）"
  case "$PENDING_KEY_ADMIN_BIND_HOST" in
    127.0.0.1|localhost|'[::1]'|::1) ;;
    *)
      echo "[警告] 面板发布在 $PENDING_KEY_ADMIN_BIND_HOST，不是回环地址：宿主网络上的人只要拿到令牌就能改密钥，" >&2
      echo "       dsh 容器也可能经宿主网关回连这个端口。远程使用请改回 127.0.0.1 并走 SSH 隧道。" >&2
      ;;
  esac
}

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

# --model-base-url 只做格式检查：报错时机不该取决于上游出现的顺序。
validate_model_base_url_specs() {
  local spec
  for spec in ${MODEL_BASE_URL_SPECS[@]+"${MODEL_BASE_URL_SPECS[@]}"}; do
    case "$spec" in
      ?*=?*) ;;
      *) echo "[错误] --model-base-url 需要 NAME=URL 格式。" >&2; exit 2 ;;
    esac
  done
  for spec in ${MODEL_API_SPECS[@]+"${MODEL_API_SPECS[@]}"}; do
    case "$spec" in
      ?*=?*) ;;
      *) echo "[错误] --model-api 需要 NAME=PROFILE 格式。" >&2; exit 2 ;;
    esac
    validate_broker_profile "${spec#*=}" || exit 2
  done
  for spec in ${MODEL_HEADER_SPECS[@]+"${MODEL_HEADER_SPECS[@]}"}; do
    case "$spec" in
      ?*=?*=?*) ;;
      *) echo "[错误] --model-header 需要 NAME=HEADER=VALUE 格式。" >&2; exit 2 ;;
    esac
    validate_broker_header "${spec#*=}" > /dev/null || exit 2
  done
  for spec in ${MODEL_ID_SPECS[@]+"${MODEL_ID_SPECS[@]}"}; do
    case "$spec" in
      ?*=?*) ;;
      *) echo "[错误] --model-id 需要 NAME=ID 格式（多个 id 用逗号分隔）。" >&2; exit 2 ;;
    esac
  done
}

# 同一个上游可以给多条 --model-id，也可以在一条里用逗号分隔，最后合成一条逗号分隔串。
model_id_override() {
  local wanted spec out=""
  wanted="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  for spec in ${MODEL_ID_SPECS[@]+"${MODEL_ID_SPECS[@]}"}; do
    [ "$(printf '%s' "${spec%%=*}" | tr '[:upper:]' '[:lower:]')" = "$wanted" ] || continue
    out="${out:+$out,}${spec#*=}"
  done
  printf '%s' "$out"
}

model_api_override() {
  local wanted spec
  wanted="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  for spec in ${MODEL_API_SPECS[@]+"${MODEL_API_SPECS[@]}"}; do
    if [ "$(printf '%s' "${spec%%=*}" | tr '[:upper:]' '[:lower:]')" = "$wanted" ]; then
      printf '%s' "${spec#*=}"
      return 0
    fi
  done
  return 1
}

# 同一个上游可以给多条 --model-header，拼成 RS 分隔串交给 add_broker_upstream。
model_header_overrides() {
  local wanted spec pair out=""
  wanted="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  for spec in ${MODEL_HEADER_SPECS[@]+"${MODEL_HEADER_SPECS[@]}"}; do
    [ "$(printf '%s' "${spec%%=*}" | tr '[:upper:]' '[:lower:]')" = "$wanted" ] || continue
    pair="$(validate_broker_header "${spec#*=}")" || return 1
    out="${out:+$out$BROKER_HEADER_RS}$pair"
  done
  printf '%s' "$out"
}

# 把 --model-key 收集进上游数组。安装向导和 model-key 动作共用，保证两条路径下
# "命令行给了密钥"的行为完全一致。
apply_model_key_specs() {
  local spec name profile headers
  for spec in ${MODEL_KEY_SPECS[@]+"${MODEL_KEY_SPECS[@]}"}; do
    # 报错文案里不能回显 spec：格式写错时它整体可能就是一段密钥。
    case "$spec" in
      ?*=?*) ;;
      *) echo "[错误] --model-key 需要 NAME=KEY 格式，且两边都不能为空。" >&2; exit 2 ;;
    esac
    name="$(printf '%s' "${spec%%=*}" | tr '[:upper:]' '[:lower:]')"
    profile="$(model_api_override "$name" || true)"
    headers="$(model_header_overrides "$name")" || exit 2
    add_broker_upstream "$name" "" "${spec#*=}" 0 0 "$profile" "$headers" "$(model_id_override "$name")" || exit 2
  done
  # --model-api / --model-header 挂在一个没给密钥的上游名上时静默丢掉最难查，所以点出来。
  for spec in ${MODEL_API_SPECS[@]+"${MODEL_API_SPECS[@]}"} ${MODEL_HEADER_SPECS[@]+"${MODEL_HEADER_SPECS[@]}"} ${MODEL_ID_SPECS[@]+"${MODEL_ID_SPECS[@]}"}; do
    name="$(printf '%s' "${spec%%=*}" | tr '[:upper:]' '[:lower:]')"
    case " $(broker_upstream_names) " in
      *" $name "*) ;;
      *) echo "[警告] 没有名为 $name 的上游，对应的 --model-api / --model-header / --model-id 不会生效。" >&2 ;;
    esac
  done
}

# 交互式收集一个或多个上游。安装向导和 model-key 动作共用这一段：两处的问答必须
# 完全一致，否则"装的时候跳过、之后再补"就会变成两套语义。收集结果只落在
# BROKER_NAMES/BROKER_KEYS 等数组里，是否启用由调用方按数组是否为空来决定。
#
# 密钥处直接回车是有效答案，不是输入错误：
#   - 还没填过任何上游 → 什么都不收集，调用方按"不启用"处理；
#   - 已经填过 → 只是不再加下一个，前面填好的保留。
prompt_broker_upstreams() {
  local name base key confirm profile headers models
  while :; do
    while :; do
      prompt "上游名字（小写字母开头，只能用小写字母、数字和短横线）" deepseek
      name="$(printf '%s' "$PROMPT_RESULT" | tr '[:upper:]' '[:lower:]')"
      validate_upstream_name "$name" && break
    done
    # base_url 内置表里有就不问：deepseek、openai、anthropic、google、nvidia 这些
    # 上游的地址不是用户该记的东西。表里没有才问，因为自建网关的地址无从猜测。
    base="$(model_default_base_url "$name" 2>/dev/null || true)"
    if [ -z "$base" ]; then
      echo > /dev/tty
      echo "$name 不在内置默认表里，base_url 照上游文档原样填，注意带上版本段：" > /dev/tty
      echo "    OpenAI 兼容网关一般是 https://<域名>/v1，Anthropic 兼容的一般不带 /v1。" > /dev/tty
      echo "    这里填的是真实上游地址；DSH 容器那边填什么由安装器自己算。" > /dev/tty
      while :; do
        prompt "$name 的 base_url" ""
        base="$PROMPT_RESULT"
        validate_upstream_base_url "$base" && break
      done
    fi
    while :; do
      prompt_secret "$name 的 API 密钥（不回显，留空 = 跳过）"
      key="$PROMPT_RESULT"
      if [ -z "$key" ]; then
        if [ "${#BROKER_NAMES[@]}" -gt 0 ]; then
          echo "已跳过 $name，前面填好的上游保留。" > /dev/tty
        fi
        return 0
      fi
      prompt_secret "再次输入 $name 的 API 密钥"
      confirm="$PROMPT_RESULT"
      [ "$key" = "$confirm" ] && break
      echo "两次输入不一致，请重试。" > /dev/tty
    done
    confirm=""
    # 认证头形态、固定请求头、模型清单、限额都不在这里问：
    #   - 形态按上游名推断（broker_default_profile），认证头因此不会写错；
    #   - 模型清单由 discover_broker_models 向上游问，问不出来才需要人介入；
    #   - 这四样都能在密钥管理面板里改，而且它们都不是秘密，唯一必须在这里给的是密钥。
    # 命令行给过 --model-api / --model-header / --model-id 时沿用，不再重复追问。
    profile="$(model_api_override "$name" || true)"
    headers="$(model_header_overrides "$name")" || headers=""
    models="$(model_id_override "$name")"
    add_broker_upstream "$name" "$base" "$key" 0 0 "$profile" "$headers" "$models" || continue
    key=""
    prompt_yes_no "再添加一个上游" n
    [ "$PROMPT_RESULT" = true ] || break
  done
}

# 跳过密钥代理时必须把代价讲清楚，而不是静默放过：不开代理就只剩"密钥写进容器"这一条
# 路，而容器里的 Agent 能读到它。同时给出补填的办法，否则用户只会以为要重装。
print_broker_skipped_notice() {
  echo "==> 本次不启用密钥代理。"
  echo "    现在填密钥的地方就只有 DSH 的 WebUI，而 WebUI 跑在 DSH 容器里：填进去的密钥"
  echo "    就落在容器内，容器里的 Agent（以及在容器内拿到 root 的人）一条 cat 就能读到。"
  echo "    想改成真实密钥不进容器：cd 到工程目录后执行 ./install.sh model-key 补填，"
  echo "    它只新增 dsh-key-broker 容器，不重建 dsh，容器里 apt 装过的东西不会丢。"
  echo "    不想在终端里填就执行 ./install.sh key-panel，在浏览器里填（同样不重建 dsh）。"
}

configure_model_broker() {
  PENDING_MODEL_BROKER="$(get_compose_env DSH_MODEL_BROKER off)"
  case "$PENDING_MODEL_BROKER" in on|off) ;; *) PENDING_MODEL_BROKER=off ;; esac

  validate_model_base_url_specs

  if [ "$NO_MODEL_BROKER" = true ]; then
    PENDING_MODEL_BROKER=off
    clear_broker_config
    return 0
  fi

  if [ -n "$MODEL_KEYS_FILE" ]; then
    import_model_keys_file "$MODEL_KEYS_FILE"
    PENDING_MODEL_BROKER=on
  fi

  apply_model_key_specs
  if [ "${#BROKER_NAMES[@]}" -gt 0 ]; then
    PENDING_MODEL_BROKER=on
  fi

  if [ "$INTERACTIVE" != true ]; then
    # 非交互的默认行为必须和以前完全一样：既没给密钥、盘上也没有配置，就保持 off，
    # 否则一条不带新参数的老安装命令会突然多起来一个容器。
    if [ "${#BROKER_NAMES[@]}" -eq 0 ] && [ ! -s data/broker/keys.json ]; then
      PENDING_MODEL_BROKER=off
    elif [ -s data/broker/keys.json ]; then
      PENDING_MODEL_BROKER=on
    fi
    return 0
  fi

  # 命令行已经把密钥给全了就不再追问：自动化和交互混用时不该被问答打断。
  if [ "${#BROKER_NAMES[@]}" -gt 0 ] || [ -n "$MODEL_KEYS_FILE" ]; then
    return 0
  fi

  echo
  echo "模型 API 密钥放在哪里："
  echo "    DSH 容器里的 Agent 以 danger-full-access 运行。密钥放在那个容器里的话，提示注入"
  echo "    根本不需要骗它说出来，一条 cat 就够了；容器内被拿到 root 也一样。"
  echo "    开启后真实密钥只留在 data/broker/keys.json 和独立的 dsh-key-broker 容器里，"
  echo "    DSH 容器只拿到占位密钥和 $MODEL_BROKER_BASE 这个地址。"
  echo "    手上没有密钥就先跳过：下面回答 n，或在密钥那一步直接回车。装完之后随时可以用"
  echo "    ./install.sh model-key 补填，那条命令不重建 dsh，容器里 apt 装过的东西不会丢。"
  if [ -s data/broker/keys.json ]; then
    prompt_yes_no "保留现有模型密钥配置" y
    if [ "$PROMPT_RESULT" = true ]; then
      PENDING_MODEL_BROKER=on
      echo "==> 保留 data/broker/keys.json，本次完全不改动其中的密钥。"
      return 0
    fi
  fi
  prompt_yes_no "把模型 API 密钥搬到独立的密钥代理容器" y
  if [ "$PROMPT_RESULT" != true ]; then
    PENDING_MODEL_BROKER=off
    print_broker_skipped_notice
    return 0
  fi
  prompt_broker_upstreams
  # 一个上游都没收集到（密钥处直接回车）就按"本次不启用"处理。以前这里是必填死循环，
  # 想先把环境装起来的人只能 Ctrl-C，反而更容易把安装打断在一半。
  if [ "${#BROKER_NAMES[@]}" -eq 0 ]; then
    # 但"没在终端里填"不等于"不想要密钥代理"：先把代理和面板装上、keys.json 留空，
    # 剩下的在浏览器里做，这样填错一个 base_url 也不必重跑一遍安装向导。
    if [ -f docker-compose.keys-admin.yml ] && [ -z "$KEY_ADMIN_OVERRIDE" ]; then
      echo
      echo "终端里没填密钥。还有一种填法："
      echo "    启用模型密钥管理面板，装完在浏览器里填密钥、按上游拉一次模型列表、设固定请求头，"
      echo "    保存后直接写进 DSH 的模型配置。面板是独立容器，dsh 容器连不到它。"
      prompt_yes_no "现在不填密钥，装完在密钥管理面板里填" y
      if [ "$PROMPT_RESULT" = true ]; then
        PENDING_MODEL_BROKER=on
        # 置成 on 后 configure_key_admin 会跳过重复提问，直接沿用这个决定。
        KEY_ADMIN_OVERRIDE=on
        ensure_broker_config_placeholder
        return 0
      fi
    fi
    PENDING_MODEL_BROKER=off
    print_broker_skipped_notice
    return 0
  fi
  PENDING_MODEL_BROKER=on
}

configure_egress_mode() {
  local default_route
  PENDING_EGRESS_MODE="${EGRESS_MODE_OVERRIDE:-$(get_compose_env DSH_EGRESS_MODE open)}"
  case "$PENDING_EGRESS_MODE" in open|allowlist) ;; *) PENDING_EGRESS_MODE=open ;; esac
  if [ "$INTERACTIVE" = true ] && [ -z "$EGRESS_MODE_OVERRIDE" ]; then
    case "$PENDING_EGRESS_MODE" in allowlist) default_route=2 ;; *) default_route=1 ;; esac
    echo
    echo "容器出站网络："
    echo "1) open（默认）：容器可访问任意外网地址。"
    echo "2) allowlist：容器只能经 dsh-egress 代理出网，白名单外的域名返回 403。"
    echo "    内置白名单：Debian、npm、PyPI、GitHub、ghcr.io、nodejs.org、astral.sh，"
    echo "    足够 apt / pip / npm / git 正常工作；其他域名需要在下一问里补充。"
    echo "    影响范围：Agent 访问白名单外的网页、搜索接口、第三方下载站会被拒绝。"
    echo "    不受影响：模型请求（dsh-key-broker 独立出网）；宿主 3080 改由 dsh-ingress"
    echo "    发布，反向代理仍写 http://dsh:3080。"
    prompt "请选择" "$default_route"
    case "$PROMPT_RESULT" in
      1) PENDING_EGRESS_MODE=open ;;
      2) PENDING_EGRESS_MODE=allowlist ;;
      *) echo "[错误] 无效出站模式选项。" >&2; exit 2 ;;
    esac
  fi
  PENDING_EGRESS_ALLOWED_HOSTS="${EGRESS_ALLOW_OVERRIDE:-$(get_compose_env DSH_EGRESS_ALLOWED_HOSTS '')}"
  if [ "$PENDING_EGRESS_MODE" = allowlist ] && [ "$INTERACTIVE" = true ] && [ -z "$EGRESS_ALLOW_OVERRIDE" ]; then
    echo "    填写的域名会追加在内置白名单之后（内置的软件源始终放行），留空表示只用内置白名单。"
    echo "    Agent 需要访问的网页或 API 域名也填在这里，例如 www.google.com,*.wikipedia.org。"
    prompt_optional "额外放行的域名（逗号分隔，支持 *.example.com）" "$PENDING_EGRESS_ALLOWED_HOSTS"
    PENDING_EGRESS_ALLOWED_HOSTS="$PROMPT_RESULT"
  fi
}

configure_dsh() {
  local access_mode bind_host trusted_hosts network network_external
  local route default_route default_network keep_auth confirm_password
  local keep_root_password confirm_root_password
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

  # 容器 root 密码：降权后的 dsh 账户要执行任意特权命令必须提供它，校验走带失败
  # 锁定的特权代理。不设置就等于关掉这条提权路径，apt 与 DSH 更新仍然可用。
  if [ -n "$ROOT_PASSWORD_OVERRIDE" ]; then
    PENDING_ROOT_PASSWORD="$ROOT_PASSWORD_OVERRIDE"
  fi
  if [ "$NO_ROOT_PASSWORD" = true ]; then
    PENDING_ROOT_PASSWORD=""
    rm -f data/secret/root.hash
  elif [ -n "$PENDING_ROOT_PASSWORD" ]; then
    if [ "${#PENDING_ROOT_PASSWORD}" -lt 12 ]; then
      echo "[错误] 容器 root 密码至少需要 12 个字符。" >&2
      exit 2
    fi
  elif [ "$INTERACTIVE" = true ]; then
    keep_root_password=false
    if [ -s data/secret/root.hash ]; then
      prompt_yes_no "保留现有的容器 root 密码" y
      keep_root_password="$PROMPT_RESULT"
    fi
    if [ "$keep_root_password" != true ]; then
      echo
      echo "容器 root 密码（用于容器内的特权命令：dsh-root run <命令> 或 sudo <命令>）："
      echo "    不设置也能用 apt 安装软件和更新 DSH，只是任意特权命令保持关闭。"
      prompt_yes_no "现在设置容器 root 密码" y
      if [ "$PROMPT_RESULT" = true ]; then
        while :; do
          prompt_secret "容器 root 密码（至少 12 个字符）"
          PENDING_ROOT_PASSWORD="$PROMPT_RESULT"
          if [ "${#PENDING_ROOT_PASSWORD}" -lt 12 ]; then
            echo "密码至少需要 12 个字符。" > /dev/tty
            continue
          fi
          prompt_secret "再次输入容器 root 密码"
          confirm_root_password="$PROMPT_RESULT"
          [ "$PENDING_ROOT_PASSWORD" = "$confirm_root_password" ] && break
          echo "两次密码不一致，请重试。" > /dev/tty
        done
      else
        PENDING_ROOT_PASSWORD=""
        rm -f data/secret/root.hash
      fi
    fi
  fi

  configure_model_broker
  configure_key_admin
  configure_egress_mode

  PENDING_ACCESS_MODE="$access_mode"
  PENDING_BIND_HOST="$bind_host"
  PENDING_TRUSTED_HOSTS="$trusted_hosts"
  PENDING_NETWORK="$network"
  PENDING_NETWORK_EXTERNAL="$network_external"
  PENDING_IMAGE="$image_ref"
  PENDING_IMAGE_SOURCE="$image_source"
  # 叠加文件由上面两段问答决定，所以 COMPOSE_ARGS 必须在这里重算一次；
  # build 与 up 都用它，两边不能出现不同的 -f 组合。
  set_compose_args
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

# 明文密码只经过一次管道交给容器里的 openssl，宿主机上只留下 sha512crypt 哈希，
# 而且这个哈希在容器里只挂到 dsh 账户进不去的 /root/dsh-secret。
write_root_password() {
  local temporary
  [ -n "$PENDING_ROOT_PASSWORD" ] || return 0
  mkdir -p data/secret
  temporary="$(mktemp data/secret/root.hash.tmp.XXXXXX)"
  if ! printf '%s\n' "$PENDING_ROOT_PASSWORD" \
    | DOCKER run --rm -i --entrypoint /usr/local/bin/hash-dsh-password "$PENDING_IMAGE" > "$temporary"; then
    rm -f "$temporary"
    echo "[错误] 无法生成容器 root 密码哈希。" >&2
    exit 1
  fi
  if ! grep -q '^\$6\$' "$temporary"; then
    rm -f "$temporary"
    echo "[错误] 容器 root 密码哈希格式异常，未写入。" >&2
    exit 1
  fi
  chmod 600 "$temporary"
  mv "$temporary" data/secret/root.hash
  PENDING_ROOT_PASSWORD=""
  echo "==> 容器 root 密码已用 sha512crypt 哈希保存到 data/secret/root.hash，未写入 .env。"
}

# 原子写 + 0600 + Linux 上 chown 1000:1000。写完立刻清空内存里的密钥，和上面
# write_root_password 把 PENDING_ROOT_PASSWORD 清空是同一个理由。
write_broker_config() {
  local temporary document upstreams
  [ "${#BROKER_NAMES[@]}" -gt 0 ] || return 0
  mkdir -p data/broker
  upstreams="$(broker_upstreams_json)"
  if [ -s data/broker/keys.json ]; then
    if ! document="$(merge_broker_config "$upstreams")"; then
      echo "[错误] 无法与现有 data/broker/keys.json 合并，原文件未改动。" >&2
      echo "       合并需要 node：宿主上没有就借 $(node_tool_image) 里的那个，" >&2
      echo "       请确认这个镜像在本机可用（docker image inspect 能查到，或者能拉到）。" >&2
      exit 1
    fi
  else
    document="$(printf '{\n  "version": 1,\n  "upstreams": %s\n}' "$upstreams")"
  fi
  temporary="$(mktemp data/broker/keys.json.tmp.XXXXXX)"
  chmod 600 "$temporary"
  printf '%s\n' "$document" > "$temporary"
  mv "$temporary" data/broker/keys.json
  document=""
  upstreams=""
  BROKER_KEYS=()
  broker_config_chown
  echo "==> 模型密钥已写入 $(pwd)/data/broker/keys.json（0600），未写入 .env。"
}

# 逗号分隔的模型 id → JSON 数组。空串给出 []，让 seed 脚本按"沿用目录清单"处理。
broker_models_json() {
  local raw="$1" id out="" IFS=','
  for id in $raw; do
    id="${id# }"
    id="${id% }"
    [ -n "$id" ] || continue
    out="${out:+$out, }$(json_string "$id")"
  done
  printf '[%s]' "$out"
}

# DSH 以 UID 1000 跑，这两份文件是安装器（通常是 root）新建的，不改属主 DSH 就写不回去。
# 失败只警告：rootless、userns-remap 或非 Linux 宿主上 chown 本来就会失败，那不是安装失败。
seed_files_chown() {
  local file failed=false
  for file in data/dsh/settings.yaml data/dsh/.credentials.yaml; do
    [ -e "$file" ] || continue
    chown 1000:1000 "$file" 2>/dev/null || failed=true
  done
  [ "$failed" = true ] || return 0
  echo "[警告] 无法把 data/dsh/settings.yaml 与 .credentials.yaml 的属主改成 1000:1000。" >&2
  echo "       如果 DSH 报存不了模型设置，请在宿主上执行：" >&2
  echo "       sudo chown 1000:1000 data/dsh/settings.yaml data/dsh/.credentials.yaml" >&2
}

# 把"该在 DSH 里怎么填"从摘要变成实际配置。
#
# 安装器手里已经有全部非秘密的事实：上游名、API 形态、模型 id，以及密钥代理的地址。
# DSH 侧需要的就是这些加一个占位密钥，所以没有理由让用户照着摘要手抄一遍——抄错一处
# （尤其是 base_url 的版本段）就是一个 404 或 403，而那时候人已经在 WebUI 里了。
#
# 写入的位置和格式都是 DSH 官方那套：
#   data/dsh/settings.yaml  → llm-pi-ai.providers.<上游名> 与 agent-default-model
#   data/dsh/.credentials.yaml → refs.<上游名>_API_KEY = 占位串
# 两份文件 DSH 都在热加载，所以补填密钥不需要重启容器；引用名与 WebUI 自己派生的一致，
# 用户之后在页面上改密钥会改到同一个引用上。
#
# 真正的合并交给镜像里的 node：那里才有 yaml 库（改 YAML 必须保住用户已有的注释和
# 配置）和 DSH 内置模型目录（目录里的上游可以直接沿用整份模型清单）。
seed_dsh_model_settings() {
  local image="$1" names name upstreams="" payload
  if [ "$NO_MODEL_SETTINGS_SEED" = true ]; then
    echo "==> 已跳过写入 DSH 模型配置（--no-model-settings-seed）：供应商与模型请在 WebUI 里自己加。"
    return 0
  fi
  [ "$PENDING_MODEL_BROKER" = on ] || return 0
  names="$(broker_upstream_names)"
  [ -n "$names" ] || return 0
  if [ -z "$image" ]; then
    echo "[警告] 不知道该用哪个镜像来写 DSH 模型配置，已跳过。" >&2
    return 0
  fi
  # model-key 只 require_project、不同步源码，所以老部署的工程目录里可能还没有这个脚本。
  if [ ! -f bin/seed-dsh-model-settings.mjs ]; then
    echo "[警告] 工程目录里没有 bin/seed-dsh-model-settings.mjs，跳过写 DSH 模型配置。" >&2
    echo "       先更新工程文件（重新跑一次安装或 git pull），再执行 ./install.sh model-key。" >&2
    return 0
  fi
  mkdir -p data/dsh
  for name in $names; do
    upstreams="${upstreams:+$upstreams, }{\"name\": $(json_string "$name"), \"shape\": $(json_string "$(broker_upstream_profile "$name")"), \"models\": $(broker_models_json "$(broker_upstream_models "$name")")}"
  done
  payload="$(printf '{"brokerBase": %s, "placeholder": %s, "upstreams": [%s]}' \
    "$(json_string "$MODEL_BROKER_BASE")" "$(json_string "$MODEL_BROKER_PLACEHOLDER_KEY")" "$upstreams")"
  echo "==> 正在把模型供应商写进 DSH 配置（data/dsh/settings.yaml）："
  if ! printf '%s' "$payload" | DOCKER run --rm -i \
      -v "$(pwd)/bin:/dsh-seed:ro" -v "$(pwd)/data/dsh:/seed-home" \
      --entrypoint node "$image" /dsh-seed/seed-dsh-model-settings.mjs --home /seed-home; then
    echo "[警告] 没能替 DSH 写模型配置。WebUI 的「设置 → 模型」里可以自己加：" >&2
    echo "       base_url = $MODEL_BROKER_BASE/u/<上游名>，API 密钥填占位串 $MODEL_BROKER_PLACEHOLDER_KEY。" >&2
    return 0
  fi
  seed_files_chown
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
  # 这四个键只是开关和地址，真实密钥永远不进 .env。
  set_compose_env DSH_MODEL_BROKER "$PENDING_MODEL_BROKER" "$PENDING_ENV_FILE"
  set_compose_env DSH_MODEL_BROKER_BASE "$MODEL_BROKER_BASE" "$PENDING_ENV_FILE"
  set_compose_env DSH_KEY_ADMIN "$PENDING_KEY_ADMIN" "$PENDING_ENV_FILE"
  set_compose_env DSH_KEY_ADMIN_BIND_HOST "$PENDING_KEY_ADMIN_BIND_HOST" "$PENDING_ENV_FILE"
  set_compose_env DSH_KEY_ADMIN_HOST_PORT "$PENDING_KEY_ADMIN_PORT" "$PENDING_ENV_FILE"
  set_compose_env DSH_EGRESS_MODE "$PENDING_EGRESS_MODE" "$PENDING_ENV_FILE"
  set_compose_env DSH_EGRESS_ALLOWED_HOSTS "$PENDING_EGRESS_ALLOWED_HOSTS" "$PENDING_ENV_FILE"
}

compose_up_with_pending_env() {
  (
    unset DSH_ACCESS_MODE DSH_BIND_HOST DSH_TRUSTED_HOSTS
    unset DSH_DOCKER_NETWORK DSH_DOCKER_NETWORK_EXTERNAL DSH_IMAGE DSH_IMAGE_SOURCE
    unset DSH_MODEL_BROKER DSH_MODEL_BROKER_BASE DSH_EGRESS_MODE DSH_EGRESS_ALLOWED_HOSTS
    unset DSH_KEY_ADMIN DSH_KEY_ADMIN_BIND_HOST DSH_KEY_ADMIN_HOST_PORT
    DOCKER compose --env-file "$PENDING_ENV_FILE" "${COMPOSE_ARGS[@]}" up -d --no-build --force-recreate
  )
}

# DSH 必须以非 root 的 dsh 账户（UID 1000）运行，容器的能力集、no_new_privs、
# Docker socket 与 /proc 挂载状态再由容器内的自检脚本实际验证一遍。
assert_dsh_hardening() {
  local uid attempt
  # /run/dsh.pid 由 dsh-supervisor 写入：第一行是 PID，第二行是进程启动时刻，
  # 所以只能取第一行，整读会拼出无效的 /proc 路径。
  uid=""
  for ((attempt = 0; attempt < 120; attempt++)); do
    uid="$(DOCKER exec dsh sh -c 'pid="$(sed -n 1p /run/dsh.pid 2>/dev/null)"; case "$pid" in ""|*[!0-9]*) exit 1 ;; esac; sed -n "s/^Uid:[[:space:]]*\([0-9]*\).*/\1/p" "/proc/$pid/status"' 2>/dev/null || true)"
    if [ -n "$uid" ]; then
      break
    fi
    sleep 1
  done
  if [ -z "$uid" ]; then
    echo "[错误] DSH 容器已创建，但无法在 120 秒内核验主进程 UID。" >&2
    return 1
  fi
  if [ "$uid" != 1000 ]; then
    echo "[错误] DSH 进程 UID 核验失败：期望 1000（非特权 dsh 账户），实际为 $uid。" >&2
    return 1
  fi
  echo "==> 已核验 DSH 进程 UID：1000（dsh 账户）"
  echo "==> 正在核验容器加固状态..."
  if ! DOCKER exec dsh /usr/local/bin/verify-dsh-hardening; then
    echo "[错误] 容器加固自检未通过，请按上面的失败项排查后重试。" >&2
    return 1
  fi
}

# 密钥代理的核验分两半，缺一半都不算通过：
#   1) broker 自己活着（/healthz 必须是 204）；
#   2) DSH 容器里的 /etc/dsh-broker 是空的——这是整个设计的前提，一旦那份配置被挂进了
#      Agent 能读的容器，密钥就等于没搬走，这时宁可让安装失败。
assert_model_broker() {
  local attempt state="" broker_entries=""
  [ "$PENDING_MODEL_BROKER" = on ] || return 0
  echo "==> 正在核验模型密钥代理（dsh-key-broker）..."
  for ((attempt = 0; attempt < 30; attempt++)); do
    if DOCKER exec dsh-key-broker node -e "fetch('http://127.0.0.1:8080/healthz').then((response) => process.exit(response.status === 204 ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
      state=ok
      break
    fi
    sleep 1
  done
  if [ "$state" != ok ]; then
    echo "[错误] dsh-key-broker 未在 30 秒内让 /healthz 返回 204。" >&2
    echo "       查看原因：docker logs dsh-key-broker（配置写错时 broker 会拒绝启动）。" >&2
    return 1
  fi
  echo "==> 已核验 dsh-key-broker /healthz = 204"
  # /etc/dsh-broker 这个目录在镜像里就存在（broker 容器的根文件系统是 read_only，
  # 只读挂载点必须预先建好），所以"目录存在"永远成立，不能当成失败信号——按存在性判断
  # 会让一次完全成功的安装以致命错误收尾，连配置摘要都打不出来。真正要拦的是目录里
  # 出现了内容：那才说明密钥配置被挂进了 Agent 可读的容器。判定口径与
  # bin/verify-dsh-hardening 的 check_broker_mount() 一致。
  broker_entries="$(DOCKER exec dsh sh -c 'ls -A /etc/dsh-broker 2>/dev/null' 2>/dev/null || true)"
  if [ -n "$broker_entries" ]; then
    echo "[错误] DSH 容器里的 /etc/dsh-broker 不是空的：密钥配置被挂进了 Agent 可读的容器。" >&2
    echo "       这会让密钥代理完全失去意义，请检查 docker-compose.keys.yml 有没有被改过。" >&2
    return 1
  fi
  echo "==> 已核验 DSH 容器内 /etc/dsh-broker 为空（真实密钥不在 Agent 可达范围内）"
}

assert_egress_isolation() {
  local attempt payload="" state="" ingress_host
  [ "$PENDING_EGRESS_MODE" = allowlist ] || return 0
  echo "==> 正在核验出站白名单代理（dsh-egress）..."
  for ((attempt = 0; attempt < 30; attempt++)); do
    payload="$(DOCKER exec dsh-egress node -e "fetch('http://127.0.0.1:3128/status').then(async (response) => { if (response.status !== 200) { process.exit(1) } process.stdout.write(await response.text()) }).catch(() => process.exit(1))" 2>/dev/null || true)"
    case "$payload" in
      *'"status":"ok"'*) state=ok; break ;;
    esac
    payload=""
    sleep 1
  done
  if [ "$state" != ok ]; then
    echo "[错误] dsh-egress 未在 30 秒内从 /status 返回可用的 JSON。" >&2
    echo "       查看原因：docker logs dsh-egress。" >&2
    return 1
  fi
  echo "==> 已核验 dsh-egress /status：$payload"
  # 隔离之后 dsh 自己不再发布端口，宿主的 3080 全靠 dsh-ingress 顶着，所以这一条
  # 必须单独探一次，否则"装完了但打不开"要到用户点链接时才发现。
  state=""
  for ((attempt = 0; attempt < 30; attempt++)); do
    if DOCKER exec dsh-ingress node -e "const net = require('node:net'); const socket = net.connect(3080, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); process.exit(0) }); socket.on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 4000)" >/dev/null 2>&1; then
      state=ok
      break
    fi
    sleep 1
  done
  if [ "$state" != ok ]; then
    echo "[错误] dsh-ingress 的 3080 监听未在 30 秒内就绪，隔离模式下宿主入口会不通。" >&2
    echo "       查看原因：docker logs dsh-ingress。" >&2
    return 1
  fi
  echo "==> 已核验 dsh-ingress 容器内 3080 已监听"
  # 宿主侧只警告不失败：端口发布是否可达还取决于宿主防火墙和 Docker 的端口转发时序，
  # 那些都不是安装器能修的，容器内的监听才是它的责任范围。
  ingress_host="$PENDING_BIND_HOST"
  case "$ingress_host" in '['*']') ingress_host="${ingress_host#[}"; ingress_host="${ingress_host%]}" ;; esac
  state=""
  for ((attempt = 0; attempt < 15; attempt++)); do
    if (exec 3<>"/dev/tcp/$ingress_host/3080") >/dev/null 2>&1; then
      state=ok
      break
    fi
    sleep 1
  done
  if [ "$state" = ok ]; then
    echo "==> 已核验宿主 $ingress_host:3080 可连接（由 dsh-ingress 发布）"
  else
    echo "[警告] 宿主 $ingress_host:3080 暂时连不上；请确认防火墙放行，并用 docker ps 确认 dsh-ingress 在运行。" >&2
  fi
}

print_config_summary() {
  local upstream_name
  echo
  echo "==> 配置已保存到 $(pwd)/.env"
  echo "    访问模式: $PENDING_ACCESS_MODE"
  echo "    端口绑定: $PENDING_BIND_HOST:3080"
  echo "    镜像来源: $PENDING_IMAGE_SOURCE（$PENDING_IMAGE）"
  [ -z "$PENDING_TRUSTED_HOSTS" ] || echo "    Trusted hosts: $PENDING_TRUSTED_HOSTS"
  echo "    运行账户: dsh (UID 1000)，容器已 cap_drop ALL + no-new-privileges"
  if [ -s data/secret/root.hash ]; then
    echo "    容器 root 密码: 已设置（容器内 dsh-root run / sudo <命令> 可用，连续错误会锁定）"
  else
    echo "    容器 root 密码: 未设置（容器内任意特权命令关闭；apt 与 DSH 更新不受影响）"
  fi
  if [ "$PENDING_MODEL_BROKER" = on ]; then
    echo "    模型密钥代理: 开（dsh-key-broker；真实密钥只在 data/broker/keys.json 与该容器内）"
    for upstream_name in $(broker_upstream_names); do
      echo "      - $upstream_name: DSH 侧 base_url = $MODEL_BROKER_BASE/u/$upstream_name，密钥是占位串 $MODEL_BROKER_PLACEHOLDER_KEY"
    done
    if [ -z "$(broker_upstream_names)" ]; then
      echo "      还没有任何上游：现在向 DSH 发模型请求会得到 503，请先在下面的面板里填一把密钥。"
    elif [ "$NO_MODEL_SETTINGS_SEED" = true ]; then
      echo "    模型设置: 未写入（--no-model-settings-seed），请在 WebUI 的「设置 → 模型」里自己加供应商"
    else
      echo "    模型设置: 已写进 data/dsh/settings.yaml，WebUI 的「设置 → 模型」里可直接选模型"
    fi
    echo "    作用范围: 只保证密钥字面值不进入 dsh 容器，不限制额度消耗，也不阻止数据外发。"
    echo "      容器里的 Agent 用占位密钥仍可发起请求，因此建议为每个上游设置"
    echo "      requestsPerMinute / dailyRequestBudget，并按需启用 allowlist 出站模式。"
  else
    echo "    模型密钥代理: 关（密钥若写进容器内的配置或环境，容器里的 Agent 一条 cat 就能读到）"
  fi
  print_key_admin_access
  if [ "$PENDING_EGRESS_MODE" = allowlist ]; then
    echo "    出站模式: allowlist（dsh 不直连外网，出站只经过 dsh-egress；宿主 3080 由 dsh-ingress 发布）"
    if [ -n "$PENDING_EGRESS_ALLOWED_HOSTS" ]; then
      echo "    白名单: 内置白名单 + 自定义 $(printf '%s' "$PENDING_EGRESS_ALLOWED_HOSTS" | awk -F, '{ print NF }') 条（DSH_EGRESS_ALLOWED_HOSTS）"
    else
      echo "    白名单: 仅内置白名单（Debian / npm / PyPI / GitHub / ghcr.io / nodejs.org / astral.sh）"
    fi
  else
    echo "    出站模式: open（容器可访问任意外网地址，出站流量不做域名限制）"
  fi
}

# 给已经装好的部署补填模型密钥。单独做一个动作的理由：install/configure 见到 dsh 容器
# 存在就会直接拒绝执行（那是为了保护容器可写层里 apt 装的东西），而 docker-compose.keys.yml
# 只新增 dsh-key-broker，完全不改 dsh 服务的定义，所以补填密钥根本不需要重建 dsh。
add_model_key() {
  if [ "$NO_MODEL_BROKER" = true ]; then
    echo "[错误] model-key 是补填密钥的动作，不能和 --no-model-broker 一起用。" >&2
    exit 2
  fi
  if [ ! -f docker-compose.keys.yml ]; then
    echo "[错误] 工程目录里没有 docker-compose.keys.yml，请先更新工程文件后重试。" >&2
    exit 1
  fi
  if ! container_exists; then
    echo "[错误] 还没有 dsh 容器，请先执行安装。" >&2
    exit 1
  fi
  validate_model_base_url_specs
  if [ -n "$MODEL_KEYS_FILE" ]; then
    import_model_keys_file "$MODEL_KEYS_FILE"
  fi
  apply_model_key_specs
  # 命令行两种给法都没用到时才问答。
  if [ "${#BROKER_NAMES[@]}" -eq 0 ] && [ -z "$MODEL_KEYS_FILE" ]; then
    if [ "$INTERACTIVE" != true ]; then
      echo "[错误] 非交互模式下 model-key 需要 --model-key NAME=KEY 或 --model-keys-file PATH。" >&2
      exit 2
    fi
    echo
    echo "补填模型 API 密钥："
    echo "    真实密钥只会写进 $(pwd)/data/broker/keys.json（0600）与 dsh-key-broker 容器，"
    echo "    DSH 容器只拿到占位密钥和 $MODEL_BROKER_BASE 这个地址。同名上游会被覆盖。"
    prompt_broker_upstreams
    if [ "${#BROKER_NAMES[@]}" -eq 0 ]; then
      echo "==> 没有填任何密钥，配置未改动。"
      return 0
    fi
  fi
  discover_broker_models "$(node_tool_image)"
  write_broker_config
  if [ ! -s data/broker/keys.json ]; then
    echo "[错误] data/broker/keys.json 仍然是空的，.env 未改动。" >&2
    exit 1
  fi
  PENDING_MODEL_BROKER=on
  set_compose_env DSH_MODEL_BROKER on
  set_compose_env DSH_MODEL_BROKER_BASE "$MODEL_BROKER_BASE"
  # 面板归 ./install.sh key-panel 管，这里不追问；只沿用 .env 里已有的决定，让这次 start
  # 顺带把已经开着的面板带起来，并在后面把隔离再核验一遍。
  if [ -z "$KEY_ADMIN_OVERRIDE" ]; then
    case "$(get_compose_env DSH_KEY_ADMIN off)" in on) KEY_ADMIN_OVERRIDE=on ;; *) KEY_ADMIN_OVERRIDE=off ;; esac
  fi
  configure_key_admin
  write_key_admin_token
  set_compose_env DSH_KEY_ADMIN "$PENDING_KEY_ADMIN"
  if [ "$PENDING_KEY_ADMIN" = on ]; then
    set_compose_env DSH_KEY_ADMIN_BIND_HOST "$PENDING_KEY_ADMIN_BIND_HOST"
    set_compose_env DSH_KEY_ADMIN_HOST_PORT "$PENDING_KEY_ADMIN_PORT"
  fi
  # 只叫 dsh.sh start：它按 .env 算出叠加文件，只把缺失的旁路容器 up 起来，不动 dsh。
  echo "==> 正在启动 dsh-key-broker（不重建 dsh 容器）..."
  if ! ./dsh.sh start; then
    echo "[错误] 启动失败。密钥已写入 data/broker/keys.json，修好后可以重试。" >&2
    exit 1
  fi
  assert_model_broker
  assert_key_admin
  echo
  seed_dsh_model_settings "$(node_tool_image)"
  echo "==> 密钥代理已就绪。DSH 的 settings.yaml 与 .credentials.yaml 都是热加载的，"
  echo "    刷新一下 WebUI 就能在「设置 → 模型」里看到这些供应商，密钥框里是占位串。"
  echo "    容器内那份 skill 文档上的 DSH_MODEL_BROKER 仍显示安装时的值，要等下次重建容器"
  echo "    才会刷新——那只是说明文字，不影响代理生效。"
  print_key_admin_access
}

# 给已经装好的部署开或关模型密钥管理面板。和 model-key 同一个理由：docker-compose.keys-admin.yml
# 只新增 dsh-key-admin 服务，完全不碰 dsh 服务的定义，所以不需要重建 dsh 容器，
# 容器可写层里 apt 装过的东西不会丢。
manage_key_admin() {
  if [ ! -f docker-compose.keys-admin.yml ]; then
    echo "[错误] 工程目录里没有 docker-compose.keys-admin.yml，请先更新工程文件后重试。" >&2
    echo "       更新办法：在工程目录里 git pull，或重新跑一次安装命令选\"重新配置\"。" >&2
    exit 1
  fi
  if ! container_exists; then
    echo "[错误] 还没有 dsh 容器，请先执行安装。" >&2
    exit 1
  fi
  if [ "$KEY_ADMIN_OVERRIDE" = off ]; then
    set_compose_env DSH_KEY_ADMIN off
    echo "==> 已在 .env 里关闭面板（DSH_KEY_ADMIN=off），正在移除 dsh-key-admin 容器..."
    DOCKER rm -f dsh-key-admin >/dev/null 2>&1 || true
    echo "==> 面板已关闭。data/broker/keys.json 与 admin.token 都保持原样，密钥不受影响。"
    return 0
  fi
  if [ "$NO_MODEL_BROKER" = true ]; then
    echo "[错误] 面板管理的就是密钥代理里的密钥，不能和 --no-model-broker 一起用。" >&2
    exit 2
  fi
  # 面板离不开 broker：它写的那份 keys.json 就是 broker 的配置。broker 还没开就一起开，
  # keys.json 允许是空的（这时 broker 对每个 /u/ 请求回 503），第一把密钥在页面上填。
  PENDING_MODEL_BROKER=on
  ensure_broker_config_placeholder
  KEY_ADMIN_OVERRIDE=on
  configure_key_admin
  if [ "$PENDING_KEY_ADMIN" != on ]; then
    echo "[错误] 无法启用面板，请检查上面的提示。" >&2
    exit 1
  fi
  write_key_admin_token
  set_compose_env DSH_MODEL_BROKER on
  set_compose_env DSH_MODEL_BROKER_BASE "$MODEL_BROKER_BASE"
  set_compose_env DSH_KEY_ADMIN on
  set_compose_env DSH_KEY_ADMIN_BIND_HOST "$PENDING_KEY_ADMIN_BIND_HOST"
  set_compose_env DSH_KEY_ADMIN_HOST_PORT "$PENDING_KEY_ADMIN_PORT"
  echo "==> 正在启动 dsh-key-admin（不重建 dsh 容器）..."
  if ! ./dsh.sh start; then
    echo "[错误] 启动失败。.env 已更新，修好后可以重新执行 ./install.sh key-panel。" >&2
    exit 1
  fi
  assert_model_broker
  assert_key_admin
  echo
  echo "==> 面板已就绪。在页面上保存上游后它会直接写 data/dsh/settings.yaml 与"
  echo "    .credentials.yaml，DSH 热加载这两份文件，刷新 WebUI 就能在「设置 → 模型」里选到。"
  print_key_admin_access
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
    write_root_password
    discover_broker_models "$PENDING_IMAGE"
    write_broker_config
    write_key_admin_token
    seed_dsh_model_settings "$PENDING_IMAGE"
    prepare_pending_env
    echo "==> 正在启动 DSH..."
    if ! compose_up_with_pending_env; then
      echo "[错误] DSH 容器启动失败，原配置未被覆盖。" >&2
      exit 1
    fi
    mv "$PENDING_ENV_FILE" .env
    PENDING_ENV_FILE=""
    assert_dsh_hardening
    assert_model_broker
    assert_key_admin
    assert_egress_isolation
    print_config_summary
    ;;
  model-key) add_model_key ;;
  key-panel) manage_key_admin ;;
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
