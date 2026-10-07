#!/usr/bin/env bash
set -euo pipefail

ACTION=""
ACCESS_MODE_OVERRIDE=""
# 多用户模式：账户注册 + 每用户独立实例。仅自定义向导或显式旗标可开启，
# 一键安装恒为单管理员模式。
MULTI_USER_OVERRIDE=""
REGISTER_GATE_OVERRIDE=""
IDLE_TIMEOUT_OVERRIDE=""
DISK_QUOTA_OVERRIDE=""
TRUSTED_PROXY_ACK=""
BIND_HOST_OVERRIDE=""
TRUSTED_HOSTS_OVERRIDE=""
NETWORK_OVERRIDE=""
NETWORK_EXTERNAL_OVERRIDE=""
IMAGE_SOURCE_OVERRIDE=""
IMAGE_OVERRIDE=""
INTERACTIVE=auto
# 向导（dsh-installer）是否已完成全部提问。置 true 后，本脚本的交互原语一律不再
# 向用户提问，直接返回默认值——否则向导问过的东西会被再问一遍。
# 必须在这里初始化：脚本开头 set -u，未定义就引用会直接报错。
DSH_WIZARD_DONE=false
# 一键安装：--quick 显式开启；无 TTY 的 curl|bash 直灌也默认走一键（随机安全凭据、零提问）。
# 显式 --non-interactive 保留旧的自动化语义（全显式参数、不随机、不打印横幅）。
QUICK_INSTALL=auto
NON_INTERACTIVE_FLAG=false
# 显式要看主菜单：无 TTY 的 curl|bash 直灌默认走一键，那时菜单不会出现。
# 已有部署要更新或卸载时正需要它，因此 --menu 强制进入交互，不依赖 stdin 是否 TTY。
MENU_REQUESTED=false
# 一键模式下本次生成的明文凭据，只在结尾回显一次；只存哈希，绝不写进 .env。
GENERATED_BASIC_USER=""
GENERATED_BASIC_PASSWORD=""
GENERATED_ROOT_PASSWORD=""
TARGET_DIR="${DSH_INSTALL_DIR:-dsh-docker}"
PROMPT_RESULT=""
PENDING_BASIC_USER="${DSH_BASIC_AUTH_USER:-}"
PENDING_BASIC_PASSWORD="${DSH_BASIC_AUTH_PASSWORD:-}"
PENDING_ROOT_PASSWORD="${DSH_ROOT_PASSWORD:-}"
ROOT_PASSWORD_OVERRIDE=""
NO_ROOT_PASSWORD=false
PENDING_ACCESS_MODE=""
PENDING_MULTI_USER=""
PENDING_REGISTER_GATE=""
PENDING_IDLE_TIMEOUT=""
PENDING_USER_DISK_QUOTA=""
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

操作：install（默认）、configure、upgrade（换成新镜像并重建容器，沿用现有 .env，不重问配置）、
      update（容器内更新 DSH）、model-key（给已装好的部署补填模型密钥）、
      key-panel（给已装好的部署开/关模型密钥管理面板）、
      start、stop、restart、logs、status、delete（删除）
选项：
  --access local|trusted-proxy|basic|password
                                  password 由内置认证网关承担认证（多用户模式使用，
                                  容器内 Nginx 不再做 Basic Auth）
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
  --egress open|blocklist|allowlist
                                  容器出站模式（blocklist 挡内置隧道清单，allowlist 只放行白名单）
  --egress-allow HOSTS            allowlist 下额外放行的域名（可重复，逗号分隔，支持 *.example.com）
  --userns-preflight              只做宿主 userns-remap 预检并退出，不安装
  --non-interactive               不显示问答，使用参数或安全默认值
  --menu                          显示主菜单（更新/卸载等都在其中），即使没有 TTY
  --quick                         一键安装：basic 认证 + 随机账密 + 关闭密钥代理，零提问
  --multi-user                    多用户：开放注册 + 每用户独立实例（与 --access=password 搭配）
  --no-multi-user                 单管理员模式（默认）
  --register-gate=open|invite     多用户模式的注册门槛：开放注册，或需要邀请码
  --idle-timeout=SECONDS          多用户模式：实例闲置多久后停用（默认 1800）
  --user-disk-quota=GB            多用户模式：每用户磁盘配额 GB（0 表示不限制，默认 5）
                                  （不显式给动作且无 TTY 的 curl|bash 直灌也默认走一键）
  --dir PATH                      工程目录（默认 ./dsh-docker）

关于删除：先问数据范围——全部删除，或者只保留会话（data/dsh/sessions）、工作目录
（workspace）和插件（data/dsh/profiles）——最后才让人输入 DELETE 确认。脚本里可以
用 DSH_DELETE_KEEP=1 预先选中"保留"这一支，删除本身仍要求交互确认。

关于模型密钥：写在命令行上的密钥会出现在 ps 里，所以人工安装请直接跑向导逐个输入
（不回显），自动化请用 --model-keys-file 指向一份 0600 的 keys.json；--model-key 只是
给没法交互的流水线留的后路。真实密钥永远不会写进 .env。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    install|configure|upgrade|update|model-key|key-panel|start|stop|restart|logs|status|delete)
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
    --ack-trusted-proxy) TRUSTED_PROXY_ACK=true ;;
    --userns-preflight) USERNS_PREFLIGHT=true ;;
    --network-external) NETWORK_EXTERNAL_OVERRIDE=true ;;
    --network-internal) NETWORK_EXTERNAL_OVERRIDE=false ;;
    --non-interactive|-y|--yes) INTERACTIVE=false; NON_INTERACTIVE_FLAG=true ;;
    --menu) MENU_REQUESTED=true ;;
    --quick) QUICK_INSTALL=true ;;
  --multi-user) MULTI_USER_OVERRIDE=on ;;
  --no-multi-user) MULTI_USER_OVERRIDE=off ;;
  --register-gate=*) REGISTER_GATE_OVERRIDE="${1#*=}" ;;
  --idle-timeout=*) IDLE_TIMEOUT_OVERRIDE="${1#*=}" ;;
  --user-disk-quota=*) DISK_QUOTA_OVERRIDE="${1#*=}" ;;
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
  ''|install|configure|upgrade|update|model-key|key-panel|start|stop|restart|logs|status|delete) ;;
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
  ''|open|blocklist|allowlist) ;;
  *) echo "[错误] --egress 只支持 open、blocklist 或 allowlist。" >&2; exit 2 ;;
esac

if [ "$INTERACTIVE" = auto ]; then
  # 交互 = 控制终端可用。判据必须是 /dev/tty，不能是 stdin：
  # curl|bash 直灌时 stdin 是 curl 的管道（`-t 0` 恒为假），但终端本身还在，
  # 用户就坐在它前面。按 stdin 判定会让这条最常见的安装方式直接跳过整个向导。
  # 注意 -r/-w 在某些 pty 环境里会返回真但打开仍失败，所以要实际试着打开一次。
  if (: < /dev/tty) 2>/dev/null; then
    INTERACTIVE=true
  else
    INTERACTIVE=false
  fi
fi
# --menu 是显式要求打开向导（与不带参数时的行为一致，保留它只为兼容既有脚本）。
if [ "$MENU_REQUESTED" = true ]; then
  INTERACTIVE=true
fi
# 一键安装只由 --quick 显式开启，不再是"没有 TTY"的隐式默认。
# 默认动作是显示向导，一键安装是向导第一页里的一个选项。
if [ "$QUICK_INSTALL" = auto ]; then
  QUICK_INSTALL=false
fi
# 一键 = 零提问：强制走非交互，但没有显式动作时默认 install。
# 这一步必须排在下面的"无终端"守卫之前：--quick 本身就是不需要终端的路径，
# 若先判守卫，`install.sh --quick` 在 CI 里会被误判成"没有终端所以无法安装"。
if [ "$QUICK_INSTALL" = true ]; then
  INTERACTIVE=false
  [ -z "$ACTION" ] && ACTION=install
fi
# 无终端、无显式动作、也不是一键：不能静默替用户选一条安装路径（默认值会写进 .env
# 并创建容器）。这里报错并给出两条明确出路，而不是偷偷跑一键安装。
if [ "$INTERACTIVE" != true ] && [ "$NON_INTERACTIVE_FLAG" != true ] \
   && [ "$QUICK_INSTALL" != true ] && [ -z "$ACTION" ]; then
  echo "[错误] 当前环境没有可用的控制终端，无法显示安装向导。" >&2
  echo >&2
  echo "       要无人值守安装，请显式指定动作与参数：" >&2
  echo "         install.sh install --non-interactive --access local --image-source prebuilt" >&2
  echo "       要一键安装（basic 认证 + 随机账密 + 关闭密钥代理）：" >&2
  echo "         install.sh install --quick" >&2
  echo >&2
  echo "       在终端里运行时不应出现这条提示；若出现，请检查 /dev/tty 是否可用。" >&2
  exit 2
fi

# 向导页计数器：每进入一页自增，用于页头显示「(N)」。文本输入与单选共用。
# 进入新页同时要求整页重绘：新页内容与上一页无关，逐行比对没有意义。
UI_PAGE_NO=0
ui_next_page() {
  UI_PAGE_NO=$((UI_PAGE_NO + 1))
  UI_STEP=$UI_PAGE_NO
  UI_FULL_REDRAW=true
}

prompt() {
  local message="$1" default="${2:-}" answer
  # 向导（dsh-installer）已经问过全部问题。走到这里说明某个调用点没带上自己的
  # 答案判断；与其指望每处都记得检查，不如在原语这一层截断：直接返回默认值。
  # 这样「向导问完又问一遍」在结构上不可能发生。
  if [ "${DSH_WIZARD_DONE:-}" = true ]; then
    PROMPT_RESULT="$default"
    return 0
  fi
  # 向导模式下，文本提问也渲染成独立一页（与单选页同一版式）。
  # 这是把 prompt 原语本身做成页面，而不是在 30 多处调用点各写一遍绘制代码——
  # 否则任何新增提问都会退回成终端日志输出。
  if [ "$UI_TUI" = true ]; then
    ui_raw_on || true
    ui_next_page
    ui_lines_begin
    ui_draw_header "$message" 5
    ui_line ""
    if [ -n "$default" ]; then
      ui_line "$(printf '  \033[2m%s\033[0m \033[2m[%s]\033[0m' "$message" "$default")"
    else
      ui_line "$(printf '  \033[2m%s\033[0m' "$message")"
    fi
    ui_line ""
    ui_flush
    printf '  \033[1;36m▸\033[0m ' > /dev/tty
    stty icanon echo < /dev/tty 2>/dev/null || true
    IFS= read -r answer < /dev/tty || { ui_raw_off; exit 1; }
    stty -icanon -echo < /dev/tty 2>/dev/null || true
    answer="${answer:-$default}"
    if [ -n "$answer" ]; then
      PROMPT_RESULT="$answer"
      return 0
    fi
  fi
  # 默认从 /dev/tty 读：即使 stdin 被 curl 的管道占着，也能读到终端上的输入。
  # 但 --menu 会在没有真实 tty 设备的环境里被显式调用（例如被包在 pty 里的会话），
  # 这时退回 stdin，否则菜单刚画出来就因打不开 /dev/tty 而退出。
  local input=/dev/tty
  # -r/-w 在某些 pty 环境里会返回真，但真正打开时仍失败（Git-Bash 的 /dev/tty 如此）。
  # 所以直接试着打开一次；打不开就退回脚本自己的 stdin/stdout（不重定向）。
  # 这样 --menu 在没有真实 tty 设备的环境里也能用，而不是菜单画出来之后才崩。
  local use_redirect=true
  if ! (: < "$input") 2>/dev/null; then
    use_redirect=false
  fi
  while :; do
    if [ -n "$default" ]; then
      if [ "$use_redirect" = true ]; then
        printf '%s [%s]: ' "$message" "$default" > "$input"
      else
        printf '%s [%s]: ' "$message" "$default"
      fi
    else
      if [ "$use_redirect" = true ]; then
        printf '%s: ' "$message" > "$input"
      else
        printf '%s: ' "$message"
      fi
    fi
    if [ "$use_redirect" = true ]; then
      IFS= read -r answer < "$input" || exit 1
    else
      IFS= read -r answer || exit 1
    fi
    answer="${answer:-$default}"
    if [ -n "$answer" ]; then
      PROMPT_RESULT="$answer"
      return
    fi
  done
}

prompt_secret() {
  local message="$1" answer
  # 同 prompt：向导问过的秘密不该再问一遍。返回空串，调用方按「未提供」处理。
  if [ "${DSH_WIZARD_DONE:-}" = true ]; then
    PROMPT_RESULT=""
    return 0
  fi
  printf '%s: ' "$message" > /dev/tty
  IFS= read -r -s answer < /dev/tty || exit 1
  printf '\n' > /dev/tty
  PROMPT_RESULT="$answer"
}

# ---------------------------------------------------------------- 翻页向导
#
# 向导由 dsh-installer（Go + Bubble Tea，与 dpanel 安装器同一 TUI 框架）承担：
# 它负责全部交互页面，收集完答案写成 KEY=VALUE 文件，本脚本读入后执行安装。
#
# 拿不到二进制时直接报错退出，不提供第二套 bash 界面：两套界面意味着两套体验，
# 而且 bash 版必须在页面之外处理分支，很难与 Go 版保持一致。宁可让用户看到
# 「下载失败」并知道怎么修，也不要给出一个看起来能用、实则流程割裂的界面。
DSH_INSTALLER_VERSION="0.1.0"
DSH_INSTALLER_BASE="${DSH_INSTALLER_BASE:-https://github.com/univers629/dsh-docker/releases/download}"

# 把 dsh-installer 放到缓存目录并打印它的路径。
#
# 查找顺序：显式路径 → 工程内构建产物 → 缓存 → 下载。
#
# 缓存按「内容摘要」寻址而不是按版本号：文件名里带上发布清单里的 SHA256 前缀。
# 这一段是踩过坑的——早先缓存名只由版本号与架构决定，同一版本号下重发二进制后，
# 旧缓存会永远命中，用户拿到的是上一版向导却以为是新的。按内容寻址后，
# 只要发布物变了，缓存名就变，旧文件自然失效。
# 拿不到向导二进制时的修复指引。
#
# 单独成函数是因为有两条入口需要它：交互路径（向导是唯一入口，给不出就没法继续）
# 与命令行安装路径（退回普通输出也能装，但用户会想看图形界面）。同一份文案两处
# 各写一遍必然会漂移。
dsh_installer_missing_help() {
  cat >&2 <<'FAIL'
[错误] 无法获取安装向导（dsh-installer）。

它负责向导的全部交互页面，安装器不再内置第二套界面。请按以下任一方式处理：

  1. 确认能访问 GitHub Releases，然后重试：
       https://github.com/univers629/dsh-docker/releases

  2. 若使用镜像源，指定它的地址前缀后重试：
       DSH_INSTALLER_BASE=https://<你的镜像>/releases/download bash install.sh

  3. 离线或受限网络下，先在有网机器下载对应架构的二进制放到缓存目录：
       ~/.cache/dsh-docker/dsh-installer-0.1.0-<amd64|arm64>
     再用 DSH_INSTALLER_BIN 指向任意路径：
       DSH_INSTALLER_BIN=/path/to/dsh-installer bash install.sh

  4. 不需要交互时用无人值守参数，它不依赖向导：
       bash install.sh install --non-interactive --access local --image-source prebuilt
       bash install.sh install --quick
FAIL
}

dsh_installer_path() {
  local arch cache manifest want dest url got
  if [ -n "${DSH_INSTALLER_BIN:-}" ] && [ -x "$DSH_INSTALLER_BIN" ]; then
    printf '%s' "$DSH_INSTALLER_BIN"
    return 0
  fi
  # 工程内构建产物：开发者本机验证用，优先于下载。
  if [ -x "./cmd/dsh-installer/dsh-installer" ]; then
    printf '%s' "./cmd/dsh-installer/dsh-installer"
    return 0
  fi
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) arch="" ;;
  esac
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/dsh-docker"
  mkdir -p "$cache" 2>/dev/null || true

  # 先取发布清单，拿到这份二进制应有的 SHA256。
  # 拿不到清单（离线、镜像源没放）时退回「版本号+架构」命名，并允许离线使用。
  manifest=""
  want=""
  if command -v curl >/dev/null 2>&1; then
    manifest="$(curl -fsSL --max-time 30 "$DSH_INSTALLER_BASE/v$DSH_INSTALLER_VERSION/SHA256SUMS" 2>/dev/null || true)"
    if [ -n "$manifest" ]; then
      # SHA256SUMS 的格式是 "<hash>  <文件名>"（两空格），所以文件名是第 2 列。
      # tr -d '\r' 去掉行尾 CR：某些环境（Windows 上的 Git Bash、被中间设备改写的
      # 响应）会在行尾带 \r，它会被并进哈希值，导致校验必然失败。
      want="$(printf '%s\n' "$manifest" | tr -d '\r' | awk -v f="dsh-installer-linux-$arch" '$2 == f { print $1 }')"
    fi
  fi

  if [ -n "$want" ]; then
    # 内容寻址：文件名里带摘要前缀（12 位足以区分），发布物一变缓存名就变。
    dest="$cache/dsh-installer-$DSH_INSTALLER_VERSION-$arch-$(printf '%s' "$want" | cut -c1-12)"
    if cache_candidate_ok "$dest"; then
      printf '%s' "$dest"
      return 0
    fi
    url="$DSH_INSTALLER_BASE/v$DSH_INSTALLER_VERSION/dsh-installer-linux-$arch"
    if ! curl -fsSL --max-time 120 "$url" -o "$dest.tmp" 2>/dev/null; then
      rm -f "$dest.tmp"
      return 1
    fi
    # 校验：下载到的东西必须与清单一致，否则说明发布物被替换或传输损坏。
    # 用重定向而不是传路径：GNU sha256sum 在文件名含反斜杠时会给整行加 `\` 转义
    # 前缀，那样 awk 取到的「哈希」会多一个字符而使校验永远失败。从 stdin 读时
    # 文件名恒为 `-`，不触发转义。
    got="$(sha256sum < "$dest.tmp" 2>/dev/null | awk '{print $1}')"
    if [ -z "$got" ] || [ "$got" != "$want" ]; then
      rm -f "$dest.tmp"
      echo "[错误] 向导二进制校验失败：期望 $want，实际 ${got:-（无法计算）}。" >&2
      echo "       可能是下载被中间设备改写，或镜像源上的文件与 SHA256SUMS 不同步。" >&2
      return 1
    fi
    chmod +x "$dest.tmp" 2>/dev/null || { rm -f "$dest.tmp"; return 1; }
    mv -f "$dest.tmp" "$dest"
    printf '%s' "$dest"
    return 0
  fi

  # 拿不到清单（离线、镜像源没放 SHA256SUMS）。
  # 优先级：先尝试下载一份新的，失败再用缓存。
  # 反过来（先用缓存）会让陈旧缓存永远胜出——用户的网络明明是通的，却因为磁盘上
  # 那份旧文件而一直看到上一版界面，而且无从发现。新的下载即使没校验，
  # 也比「确定过时的缓存」更接近用户要的东西。
  command -v curl >/dev/null 2>&1 || {
    # 连 curl 都没有，只能看缓存。
    use_unverified_cache "$cache" "$DSH_INSTALLER_VERSION" "$arch"
    return $?
  }
  dest="$cache/dsh-installer-$DSH_INSTALLER_VERSION-$arch"
  url="$DSH_INSTALLER_BASE/v$DSH_INSTALLER_VERSION/dsh-installer-linux-$arch"
  if curl -fsSL --max-time 120 "$url" -o "$dest.tmp" 2>/dev/null; then
    chmod +x "$dest.tmp" 2>/dev/null || { rm -f "$dest.tmp"; return 1; }
    mv -f "$dest.tmp" "$dest"
    echo "[注意] 已下载向导但无法校验（拿不到 SHA256SUMS）。" >&2
    printf '%s' "$dest"
    return 0
  fi
  rm -f "$dest.tmp"
  use_unverified_cache "$cache" "$DSH_INSTALLER_VERSION" "$arch"
}

# 判断缓存里的候选是否可用。
#
# 不只看 -x：Windows 上（Git Bash、WSL 挂载的 NTFS 卷）文件的可执行位由扩展名
# 决定，无扩展名的文件永远不是 -x，会让缓存判定恒假。这里用「是普通文件且非空」
# 作为判据——真正的可执行性在调用前由 chmod 保证（下载后立刻 chmod +x）。
cache_candidate_ok() {
  local f="$1"
  [ -f "$f" ] || return 1
  [ -s "$f" ] || return 1
  case "$f" in
    *.tmp) return 1 ;;
  esac
  return 0
}

# 在拿不到 SHA256SUMS 时退回本地缓存，并明确告知未经校验。
# 单独成函数：这条降级路径要在「下载失败」和「没有 curl」两处使用。
use_unverified_cache() {
  local cache="$1" version="$2" arch="$3" candidate=""
  # 内容寻址的缓存（带摘要后缀）优先于旧命名：前者的内容至少被校验过一次。
  for candidate in "$cache/dsh-installer-$version-$arch"-*; do
    cache_candidate_ok "$candidate" || continue
    echo "[注意] 使用缓存的向导 $candidate（未校验：拿不到 SHA256SUMS）。" >&2
    printf '%s' "$candidate"
    return 0
  done
  candidate="$cache/dsh-installer-$version-$arch"
  if cache_candidate_ok "$candidate"; then
    echo "[注意] 使用缓存的向导 $candidate（未校验：拿不到 SHA256SUMS）。" >&2
    printf '%s' "$candidate"
    return 0
  fi
  return 1
}
# 把向导回传的答案读进当前 shell 的 _OVERRIDE 变量。
#
# 单独成函数而不是内联在向导调用处：向导与执行视图现在是**同一个** Go 程序，
# bash 不再有机会「等程序退出之后再读文件」——答案文件在向导确认那一刻就写好了，
# 但读取它的时机取决于是否真的会进执行阶段（见 run_install_execution）。
dsh_installer_read_answers() {
  local answers="$1" key value line
  [ -f "$answers" ] || return 1
  # 逐行读入 KEY=VALUE。值里可能有空格，所以只按第一个 = 切分。
  while IFS= read -r line; do
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      action) ACTION="$value" ;;
      mode) DSH_ANSWER_MODE="$value" ;;
      access) ACCESS_MODE_OVERRIDE="$value" ;;
      image_source) IMAGE_SOURCE_OVERRIDE="$value" ;;
      bind_host) BIND_HOST_OVERRIDE="$value" ;;
      egress) EGRESS_MODE_OVERRIDE="$value" ;;
      multi_user) MULTI_USER_OVERRIDE="$value" ;;
      register_gate) REGISTER_GATE_OVERRIDE="$value" ;;
      idle_timeout) IDLE_TIMEOUT_OVERRIDE="$value" ;;
      disk_quota) DISK_QUOTA_OVERRIDE="$value" ;;
      key_admin) KEY_ADMIN_OVERRIDE="$value" ;;
      root_password) ROOT_PASSWORD_OVERRIDE="$value" ;;
      no_root_password) [ "$value" = yes ] && NO_ROOT_PASSWORD_ANSWER=true ;;
      delete_keep) DSH_DELETE_KEEP="$value" ;;
      delete_confirmed) DSH_DELETE_CONFIRMED=1 ;;
      model_broker) PENDING_MODEL_BROKER="$value" ;;
      egress_allow) EGRESS_ALLOW_OVERRIDE="$value" ;;
      basic_user) PENDING_BASIC_USER="$value" ;;
      basic_password) PENDING_BASIC_PASSWORD="$value" ;;
      proxy) DSH_ANSWER_PROXY="$value" ;;
      proxy_network) DSH_ANSWER_PROXY_NETWORK="$value" ;;
      trusted_proxy_ack) [ "$value" = yes ] && TRUSTED_PROXY_ACK=true ;;
    esac
  done < "$answers"
  # 向导已完成：后续的交互原语一律不再提问（见各处 DSH_WIZARD_DONE 判断）。
  # 这一步是「向导是唯一入口」的关键——否则 bash 会把问过的问题再问一遍。
  DSH_WIZARD_DONE=true
  export DSH_WIZARD_DONE
  # 一键安装：向导已经问完，交回引擎的零提问路径。
  if [ "${DSH_ANSWER_MODE:-}" = quick ]; then
    QUICK_INSTALL=true
    INTERACTIVE=false
    PENDING_MODEL_BROKER=off
  fi
  return 0
}

# ---------------------------------------------------------------- 翻页向导（bash 兜底）
#
# 向导占用终端的**备用屏幕缓冲**（alternate screen buffer），与 dpanel 的安装器同一种
# 形态：进入后整个终端切到一张独立画布，向导画面不会滚进 scrollback；退出时终端恢复到
# 进入前的样子，就像从没打印过东西。用主屏幕缓冲 + 清屏是做不到这一点的——那会把每一页
# 都留在日志里，看起来就是"不断往终端刷界面"。
#
# 备用缓冲由 terminal 自身维护（CSI ?1049h/l），不需要 curses。退出路径有三条，
# 都要还原：正常结束、Ctrl+C、以及任何 EXIT（含 set -e 触发的提前退出）。

UI_TUI=false
UI_STTY_STATE=""
UI_STEP=0
UI_TOTAL=0
UI_TRAP_SAVED=false
UI_PREV_EXIT_TRAP=""
UI_ALT_SCREEN=false

# 判定能否进入翻页模式：必须有可读写的 tty，且 stty 能切换模式。
ui_detect_tui() {
  [ "$INTERACTIVE" = true ] || return 1
  case "${TERM:-}" in ''|dumb) return 1 ;; esac
  (: < /dev/tty) 2>/dev/null || return 1
  stty -g < /dev/tty >/dev/null 2>&1 || return 1
  UI_TUI=true
  return 0
}

# 进入备用屏幕：切到独立画布并清屏、隐藏光标。
ui_alt_enter() {
  [ "$UI_ALT_SCREEN" = true ] && return 0
  printf '\033[?1049h\033[2J\033[H\033[?25l' > /dev/tty
  UI_ALT_SCREEN=true
}

# 退出备用屏幕：恢复光标与终端原有画面。
ui_alt_leave() {
  [ "$UI_ALT_SCREEN" = true ] || return 0
  printf '\033[?25h\033[?1049l' > /dev/tty
  UI_ALT_SCREEN=false
}

ui_raw_on() {
  UI_STTY_STATE="$(stty -g < /dev/tty 2>/dev/null)" || return 1
  stty -icanon -echo min 1 time 0 < /dev/tty 2>/dev/null || return 1
  # 备用屏幕在整个向导期间保持：每页都进出一次会闪屏。ui_alt_enter 自身幂等。
  ui_alt_enter
  # 退出时一定要还原终端，否则用户的 shell 会留在无回显、无光标的备用屏幕里。
  # 但**不能直接覆盖**已有的 EXIT trap：安装路径挂了 cleanup_pending_env、
  # delete 的 detached 路径挂了自删脚本，覆盖掉它们会漏掉清理。所以把原有 trap
  # 记下来，退出时先还原终端再执行原逻辑。
  # 只在第一次记录：每页都会调 ui_raw_on，重复记录会把本函数安装的 trap 当成原有 trap。
  if [ "$UI_TRAP_SAVED" != true ]; then
    UI_PREV_EXIT_TRAP="$(trap -p EXIT 2>/dev/null || true)"
    UI_TRAP_SAVED=true
  fi
  trap 'ui_term_restore; ui_run_prev_trap' EXIT
  trap 'ui_term_restore; exit 130' INT
  trap 'ui_term_restore; exit 143' TERM
}

# 执行 ui_raw_on 之前记录的 EXIT trap（若有）。trap -p 的输出形如
# `trap -- '命令' EXIT`，这里把引号里的命令取出来执行。
ui_run_prev_trap() {
  local spec="$UI_PREV_EXIT_TRAP"
  UI_PREV_EXIT_TRAP=""
  [ -n "$spec" ] || return 0
  local body="${spec#trap -- \'}"
  body="${body%\' EXIT}"
  [ "$body" != "$spec" ] && [ -n "$body" ] && eval "$body" || true
}

# 退出按键原始模式（页与页之间调用）。刻意**不**离开备用屏幕：
# 那会让每翻一页都闪一次屏，向导应当始终待在同一张画布上。
ui_raw_off() {
  if [ -n "$UI_STTY_STATE" ]; then
    stty "$UI_STTY_STATE" < /dev/tty 2>/dev/null || true
    UI_STTY_STATE=""
  fi
}

# 彻底还原终端：离开备用屏幕并恢复行模式。向导结束（或任何退出路径）时调用，
# 之后终端回到用户原本的画面，向导内容不会留在 scrollback 里。
ui_term_restore() {
  ui_alt_leave
  ui_raw_off
}

# 读一个按键，归一化成 up/down/enter/esc/其他。方向键是 ESC [ A/B 三字节序列，
# 裸 ESC（回退）与它共用首字节，所以用极短超时区分：没有后续字节就是裸 ESC。
ui_read_key() {
  local key rest
  IFS= read -rsn1 key < /dev/tty || { echo esc; return; }
  case "$key" in
    $'\x1b')
      IFS= read -rsn1 -t 0.05 rest < /dev/tty 2>/dev/null || { echo esc; return; }
      if [ "$rest" = '[' ]; then
        IFS= read -rsn1 -t 0.05 rest < /dev/tty 2>/dev/null || { echo esc; return; }
        case "$rest" in
          A) echo up ;;
          B) echo down ;;
          *) echo other ;;
        esac
      else
        echo esc
      fi
      ;;
    '') echo enter ;;
    $'\x03') echo interrupt ;;
    k) echo up ;;
    j) echo down ;;
    *) echo "other:$key" ;;
  esac
}

# ---------------------------------------------------------------- 页面渲染
#
# 渲染分两种：进入一页时整页重绘一次，页内每次按键只重画变化的那几行。
#
# 这是 dpanel 安装器的实际做法（抓取其原始字节确认）：按一次方向键只输出 121 字节，
# 其中不含 CSI 2J（全屏清空），而是「CSI H 回到左上 → 用换行走到目标行 → 画该行
# → CSI K 擦掉行尾」，只覆盖变化的行。整页清屏重画会让画面整片闪动，观感上像是
# 每按一次键就把界面重印一遍。
UI_LINES=()          # 本帧要显示的行
UI_DRAWN=()          # 上一帧已绘制的行
UI_FULL_REDRAW=true  # 下一页是否整页重绘

ui_lines_begin() { UI_LINES=(); }
ui_line() { UI_LINES+=("$1"); }

# 终端可用行数。留一行余量：写满最后一列/最后一行会触发滚动，一旦滚动，
# 「CSI H 回左上 + 换行定位」的行号就全部错位，旧行擦不掉、新行叠上去。
ui_term_rows() {
  local size rows
  size="$(stty size < /dev/tty 2>/dev/null)"
  rows="${size%% *}"
  case "$rows" in ''|*[!0-9]*) rows=0 ;; esac
  if [ "$rows" -gt 1 ]; then
    printf '%s' "$((rows - 1))"
  else
    printf '0'
  fi
}

# 输出一帧。UI_FULL_REDRAW 为真时先清屏再逐行画；否则只重画内容有变化的行。
#
# 两个必须遵守的约束（都是实测出来的）：
#   1. 帧高不得超过终端行数。超出就会滚动，而滚动之后所有按行号定位的操作全部错位，
#      表现是「移动选择时旧行残留成两行、还遮挡下面的选项」。
#   2. 末行之后不能再输出换行。等高于终端时那一行换行会立刻把整屏顶上去一格。
ui_flush() {
  local total=${#UI_LINES[@]} i limit
  limit="$(ui_term_rows)"
  if [ "$limit" -gt 0 ] && [ "$total" -gt "$limit" ]; then
    # 溢出时保底截断：宁可少显示尾部，也不能滚动（滚动会让整页错位）。
    total="$limit"
  fi
  if [ "$UI_FULL_REDRAW" = true ]; then
    printf '\033[2J\033[H' > /dev/tty
    for ((i = 0; i < total; i++)); do
      if [ "$i" -eq $((total - 1)) ]; then
        printf '%s\033[K' "${UI_LINES[$i]}" > /dev/tty
      else
        printf '%s\033[K\r\n' "${UI_LINES[$i]}" > /dev/tty
      fi
    done
    UI_DRAWN=("${UI_LINES[@]:0:$total}")
    UI_FULL_REDRAW=false
    return 0
  fi
  printf '\033[H' > /dev/tty
  for ((i = 0; i < total; i++)); do
    if [ "${UI_LINES[$i]}" = "${UI_DRAWN[$i]:-}" ]; then
      # 未变化：只下移一行，不重画。这正是「选中的那一行才闪」的关键。
      printf '\r\n' > /dev/tty
    else
      printf '%s\033[K\r\n' "${UI_LINES[$i]}" > /dev/tty
      UI_DRAWN[$i]="${UI_LINES[$i]}"
    fi
  done
  # 本帧行数少于上一帧时，清掉尾部的旧行，避免残留。
  for ((i = total; i < ${#UI_DRAWN[@]}; i++)); do
    printf '\033[K\r\n' > /dev/tty
  done
  if [ "${#UI_DRAWN[@]}" -gt "$total" ]; then
    UI_DRAWN=("${UI_LINES[@]:0:$total}")
  fi
}

# 每页重绘的页头：鲸鱼 + DSH 大字 + 「向导名 - 当前页标题 (步骤)」。
# 版式对齐 dpanel 的安装器：标题与步骤计数同一行（`🚀 DPanel - 安装方式 (3/9)`），
# 每页都重画一遍 logo，读起来是"同一个程序在翻页"而不是一串散问。
#
# $2 是页头之后还要输出多少行（正文 + 页脚）。图案按剩余空间选择，而不是按终端
# 高度写死：只要正文还放得下就画图案，放不下就不画。硬编码高度会让长菜单撑破屏幕，
# 一旦内容超出终端高度就会滚动，滚动之后按行号定位的重绘全部错位。
# 图案高度：鲸鱼与 DSH 并排 11 行，仅 DSH 大字 8 行；外加图案后的一行空行。
ui_draw_header() {
  local page_title="${1:-}" body_lines="${2:-0}"
  local term_rows=0 term_cols=0 size room
  size="$(stty size < /dev/tty 2>/dev/null)"
  term_rows="${size%% *}"
  term_cols="${size##* }"
  case "$term_rows" in ''|*[!0-9]*) term_rows=0 ;; esac
  case "$term_cols" in ''|*[!0-9]*) term_cols=0 ;; esac

  # 终端未知（拿不到尺寸）时按最小可用高度处理，只画标题。
  if [ "$term_rows" -eq 0 ]; then
    room=0
  else
    room=$((term_rows - 1 - body_lines - 1))   # 留白 1 行 + 标题 1 行
  fi

  if [ "$term_cols" -eq 0 ] || [ "$term_cols" -ge 71 ]; then
    if [ "$room" -ge 12 ]; then
      ui_paint_banner
      ui_line ""
    fi
  else
    if [ "$room" -ge 9 ]; then
      ui_paint_wordmark
      ui_line ""
    fi
  fi
  local head
  head="$(printf '\033[1m  DeepSeek Harness\033[0m')"
  [ -n "$page_title" ] && head="$head$(printf ' \033[2m-\033[0m \033[1m%s\033[0m' "$page_title")"
  # 总页数依赖分支（选「启动」一页，选「安装」两页），写死一个分母就是假的，
  # 所以只在确实知道总数时显示 N/M，否则只报页码。
  if [ "$UI_TOTAL" -gt 0 ]; then
    head="$head$(printf ' \033[2m(%s/%s)\033[0m' "$UI_STEP" "$UI_TOTAL")"
  elif [ "$UI_STEP" -gt 0 ]; then
    head="$head$(printf ' \033[2m(%s)\033[0m' "$UI_STEP")"
  fi
  ui_line "$head"
  return 0
}

# 把图案追加为「行」，供增量重绘使用（每行都带品牌蓝，末行后复位颜色）。
ui_paint_banner() {
  local blue last i
  blue="$(banner_blue)"
  last=$(( ${#BANNER_ART[@]} - 1 ))
  for ((i = 0; i <= last; i++)); do
    if [ "$i" -eq "$last" ]; then
      ui_line "${blue}${BANNER_ART[$i]}$ANSI_CLEAR"
    else
      ui_line "${blue}${BANNER_ART[$i]}"
    fi
  done
}

ui_paint_wordmark() {
  local blue last i
  blue="$(banner_blue)"
  last=$(( ${#WORDMARK_ART[@]} - 1 ))
  for ((i = 0; i <= last; i++)); do
    if [ "$i" -eq "$last" ]; then
      ui_line "${blue}${WORDMARK_ART[$i]}$ANSI_CLEAR"
    else
      ui_line "${blue}${WORDMARK_ART[$i]}"
    fi
  done
}

# 一页单选。items 每项为 "值\t标题\t说明"。
# 结果：UI_VALUE=选中的值；UI_BACK=true 表示用户按了 Esc 要回上一页。
ui_page_select() {
  local title="$1" default_index="$2"; shift 2
  local -a items=("$@")
  local index=0 i value label desc key
  # 向导已经跑过，任何 bash 页面都不该再出现。走到这里说明有个调用点漏了守卫——
  # 那会让用户在向导里答过的问题被再问一遍（曾经真实发生：多用户配置在向导之后
  # 又弹出「注册门槛」整页）。这里不静默放过，而是取默认值并留下可被测试捕获的痕迹。
  if [ "${DSH_WIZARD_DONE:-}" = true ]; then
    echo "[警告] 向导已结束，跳过 bash 页面「$title」（调用点缺少 DSH_WIZARD_DONE 守卫）。" >&2
    # default_index 既可能是下标也可能是选项值（调用点两种都有），两种都要认。
    UI_VALUE="${items[0]%%$'\t'*}"
    if [ "$default_index" -ge 0 ] 2>/dev/null && [ "$default_index" -lt "${#items[@]}" ]; then
      UI_VALUE="${items[$default_index]%%$'\t'*}"
    else
      for ((i = 0; i < ${#items[@]}; i++)); do
        if [ "${items[$i]%%$'\t'*}" = "$default_index" ]; then UI_VALUE="$default_index"; break; fi
      done
    fi
    UI_BACK=false
    return 0
  fi
  # 默认项定位
  for ((i = 0; i < ${#items[@]}; i++)); do
    if [ "${items[$i]%%$'\t'*}" = "$default_index" ]; then index=$i; fi
  done
  [ "$default_index" -ge 0 ] 2>/dev/null && [ "$default_index" -lt "${#items[@]}" ] && index="$default_index"

  UI_BACK=false
  if [ "$UI_TUI" != true ]; then
    # 非 TUI 回退：编号选择。输出走与 prompt 相同的可降级通道——没有 /dev/tty 的
    # 环境（pty 包装、CI）里必须仍然能跑，否则菜单画出来就崩。
    printf '\n%s\n' "$title"
    for ((i = 0; i < ${#items[@]}; i++)); do
      value="${items[$i]%%$'\t'*}"
      desc="${items[$i]#*$'\t'}"
      printf '  %s) %s\n' "$((i + 1))" "${desc%%$'\t'*}"
    done
    prompt "请选择" "$((index + 1))"
    case "$PROMPT_RESULT" in
      [0-9]*) if [ "$PROMPT_RESULT" -ge 1 ] && [ "$PROMPT_RESULT" -le "${#items[@]}" ]; then
                UI_VALUE="${items[$((PROMPT_RESULT - 1))]%%$'\t'*}"
              else
                UI_VALUE="${items[$index]%%$'\t'*}"
              fi ;;
      *) UI_VALUE="${items[$index]%%$'\t'*}" ;;
    esac
    return 0
  fi

  ui_raw_on || { UI_TUI=false; ui_page_select "$title" "$default_index" "${items[@]}"; return 0; }
  while :; do
    # 组装本帧：页头 + 空行 + 选项 + 操作键提示。
    # 只组装不打印；ui_flush 决定重画哪些行。
    ui_lines_begin
    # 先算出正文行数，页头据此决定要不要画图案：选项全部可见优先于图案。
    local body_lines=3   # 前导空行 + 尾随空行 + 操作键提示
    for ((i = 0; i < ${#items[@]}; i++)); do
      rest="${items[$i]#*$'\t'}"
      label="${rest%%$'\t'*}"
      body_lines=$((body_lines + 1))
      [ "$rest" != "$label" ] && body_lines=$((body_lines + 1))
    done
    # 标题并入页头（dpanel 的版式：`DPanel - 安装方式 (3/9)`），正文直接列选项
    ui_draw_header "$title" "$body_lines"
    ui_line ""
    for ((i = 0; i < ${#items[@]}; i++)); do
      value="${items[$i]%%$'\t'*}"
      rest="${items[$i]#*$'\t'}"
      label="${rest%%$'\t'*}"
      desc=""
      [ "$rest" != "$label" ] && desc="${rest#*$'\t'}"
      if [ "$i" = "$index" ]; then
        # 选中项只改这一行：dpanel 用高亮行首标记，其余行原样不动。
        ui_line "$(printf '  \033[1;36m▸ %s\033[0m' "$label")"
      else
        ui_line "$(printf '    %s' "$label")"
      fi
      [ -n "$desc" ] && ui_line "$(printf '    \033[2m%s\033[0m' "$desc")"
    done
    ui_line ""
    ui_line "$(printf '  \033[2m↑/↓ 选择 | Enter 确认 | Esc 返回 | Ctrl+C 退出\033[0m')"
    ui_flush

    key="$(ui_read_key)"
    case "$key" in
      up) index=$((index > 0 ? index - 1 : ${#items[@]} - 1)) ;;
      down) index=$((index < ${#items[@]} - 1 ? index + 1 : 0)) ;;
      enter)
        UI_VALUE="${items[$index]%%$'\t'*}"
        ui_raw_off
        return 0
        ;;
      esc)
        ui_raw_off
        UI_BACK=true
        return 0
        ;;
      interrupt)
        ui_raw_off
        printf '\n已取消。\n' > /dev/tty
        exit 130
        ;;
    esac
  done
}

# 一页文本输入。Esc 回上一页。UI_VALUE=输入值；UI_BACK=true 表示回退。
ui_page_input() {
  local title="$1" label="$2" default="$3" secret="${4:-false}"
  UI_BACK=false
  if [ "$UI_TUI" != true ]; then
    if [ "$secret" = true ]; then prompt_secret "$label"; else prompt "$label" "$default"; fi
    UI_VALUE="$PROMPT_RESULT"
    return 0
  fi
  ui_raw_on || { UI_TUI=false; ui_page_input "$title" "$label" "$default" "$secret"; return 0; }
  ui_lines_begin
  ui_draw_header "$title" 4
  ui_line ""
  if [ -n "$default" ]; then
    ui_line "$(printf '  %s \033[2m[%s]\033[0m' "$label" "$default")"
  else
    ui_line "$(printf '  %s' "$label")"
  fi
  ui_line ""
  ui_flush
  printf '  \033[1;36m▸\033[0m ' > /dev/tty
  local answer
  if [ "$secret" = true ]; then
    IFS= read -rs answer < /dev/tty || { ui_raw_off; UI_BACK=true; return 0; }
  else
    stty icanon echo < /dev/tty 2>/dev/null || true
    IFS= read -r answer < /dev/tty || { ui_raw_off; UI_BACK=true; return 0; }
    stty -icanon -echo < /dev/tty 2>/dev/null || true
  fi
  printf '\n' > /dev/tty
  ui_raw_off
  UI_VALUE="${answer:-$default}"
  return 0
}

prompt_secret_orig() { prompt_secret "$@"; }

# 执行前的确认摘要（对齐 dpanel 安装器第 7 页「确认是否执行」）。
# 把它放在 configure_dsh 之后、任何写盘之前：答「否」时这一轮什么都没改动。
# 表格按两列排（键: 值），选项多时自动分栏，避免一屏塞不下。
confirm_install_plan() {
  local -a rows=()
  local broker_label egress_label key_admin_label multi_label

  # 向导已经做过确认页（含同样的摘要）。再确认一次等于问两遍，直接放行。
  if [ "${DSH_WIZARD_DONE:-}" = true ]; then
    return 0
  fi

  case "${PENDING_MODEL_BROKER:-off}" in
    on) broker_label="开（密钥只存宿主机与独立容器）" ;;
    *) broker_label="关（密钥直接写进 DSH 配置）" ;;
  esac
  case "${PENDING_EGRESS_MODE:-open}" in
    blocklist) egress_label="blocklist（挡隧道清单）" ;;
    allowlist) egress_label="allowlist（只放行白名单）" ;;
    *) egress_label="open（容器直连外网）" ;;
  esac
  case "${PENDING_KEY_ADMIN:-off}" in
    on) key_admin_label="开（${PENDING_KEY_ADMIN_BIND_HOST:-127.0.0.1}:${PENDING_KEY_ADMIN_PORT:-3082}）" ;;
    *) key_admin_label="关" ;;
  esac
  case "${PENDING_MULTI_USER:-off}" in
    on) multi_label="多用户（注册门槛=${PENDING_REGISTER_GATE:-open}，闲置=${PENDING_IDLE_TIMEOUT:-1800}s）" ;;
    *) multi_label="单管理员" ;;
  esac

  rows+=("访问保护: ${PENDING_ACCESS_MODE:-local}")
  rows+=("用户模式: $multi_label")
  rows+=("镜像来源: ${PENDING_IMAGE_SOURCE:-prebuilt}")
  rows+=("镜像引用: ${PENDING_IMAGE:-（按来源推导）}")
  rows+=("绑定地址: ${PENDING_BIND_HOST:-127.0.0.1}")
  rows+=("模型密钥代理: $broker_label")
  rows+=("出站模式: $egress_label")
  rows+=("密钥管理面板: $key_admin_label")
  rows+=("工程目录: $TARGET_DIR")

  # 非交互（一键 / CI）没有确认页：那条路本来就是零提问，多问一次会破坏脚本化调用。
  if [ "$INTERACTIVE" != true ]; then
    return 0
  fi

  # 摘要表先以整页绘制一次，随后紧跟的是「是 / 否」选择页（共用同一帧）。
  if [ "$UI_TUI" = true ]; then
    ui_raw_on || true
    ui_lines_begin
    # 摘要表本身占 ${#rows[@]} 行，外加前导/尾随空行。
    ui_draw_header "确认是否执行" "$(( ${#rows[@]} + 2 ))"
    ui_line ""
    local i
    for ((i = 0; i < ${#rows[@]}; i++)); do
      ui_line "$(printf '  \033[2m%s\033[0m' "${rows[$i]}")"
    done
    ui_line ""
    ui_flush
  else
    echo
    echo "确认是否执行："
    local i
    for ((i = 0; i < ${#rows[@]}; i++)); do
      echo "  ${rows[$i]}"
    done
    echo
  fi

  UI_TOTAL=0
  ui_next_page
  ui_page_select "确认是否执行" 0 \
    "yes	是	执行当前操作" \
    "no	否	不执行，返回上一步"
  # 确认页是向导的最后一页：无论选是还是否都要离开备用屏幕，
  # 否则后续的安装输出（或取消提示）会落在用户看不见的画布上。
  ui_term_restore
  if [ "$UI_VALUE" != yes ]; then
    echo "已取消，未做任何改动。" >&2
    exit 0
  fi
}

# prompt 会一直问到非空，但有些配置项"留空"本身就是有效答案（例如额外放行的域名），
# 所以这一个只问一次，回车即表示清空当前值。
prompt_optional() {
  local message="$1" default="${2:-}" answer
  # 同 prompt：向导问过就不再问，返回默认值。
  if [ "${DSH_WIZARD_DONE:-}" = true ]; then
    PROMPT_RESULT="$default"
    return 0
  fi
  # 向导模式下同样渲染成独立一页，版式与 prompt 一致。
  if [ "$UI_TUI" = true ]; then
    ui_raw_on || true
    ui_next_page
    ui_lines_begin
    ui_draw_header "$message" 5
    ui_line ""
    if [ -n "$default" ]; then
      ui_line "$(printf '  \033[2m当前值: %s（回车表示清空）\033[0m' "$default")"
    else
      ui_line "$(printf '  \033[2m可留空\033[0m')"
    fi
    ui_line ""
    ui_flush
    printf '  \033[1;36m▸\033[0m ' > /dev/tty
    stty icanon echo < /dev/tty 2>/dev/null || true
    IFS= read -r answer < /dev/tty || { ui_raw_off; exit 1; }
    stty -icanon -echo < /dev/tty 2>/dev/null || true
    PROMPT_RESULT="$answer"
    return 0
  fi
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
  # 同 prompt：向导问过就不再问。按传入的默认值作答（调用点给的默认值就是
  # 「导航空着这一项时该怎么办」的答案）。
  if [ "${DSH_WIZARD_DONE:-}" = true ]; then
    case "$default" in
      y|Y|yes|YES|true|是) PROMPT_RESULT=true ;;
      *) PROMPT_RESULT=false ;;
    esac
    return 0
  fi
  # 向导模式下渲染成真正的「是/否」选择页（↑/↓ + Enter），而不是让人手打 y/n——
  # 手打字母既不是面板形态，也容易输错。非向导模式保留原来的 y/n 循环。
  if [ "$UI_TUI" = true ]; then
    local default_index=0
    case "$default" in n|N|no|NO|否) default_index=1 ;; esac
    ui_next_page
    ui_page_select "$message" "$default_index" \
      "yes	是	确认" \
      "no	否	拒绝"
    case "$UI_VALUE" in
      yes) PROMPT_RESULT=true ;;
      *) PROMPT_RESULT=false ;;
    esac
    return 0
  fi
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

# 生成一个强随机密码：至少 16 位，含大小写、数字，并从一组 URL 安全符号里选一个。
# 只在 /dev/urandom 可用时叫用；退回空白时调用方必须报错而不是降级成弱口令。
generate_password() {
  local i pick length="${1:-16}" out="" pool
  if [ ! -r /dev/urandom ]; then
    echo ""
    return 1
  fi
  pool='abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  while :; do
    out=""
    for i in $(seq 1 "$length"); do
      pick="$(od -An -N1 -tu1 /dev/urandom | tr -d '[:space:]')"
      out="$out$(printf '%s' "$pool" | cut -c$((pick % ${#pool} + 1)))"
    done
    case "$out" in
      *[a-z]*) case "$out" in *[A-Z]*) case "$out" in *[0-9]*) printf '%s' "$out"; return 0 ;; esac ;; esac ;;
    esac
  done
}

# Static properties for the two-ink art below. Cached so the reset/color codes aren't
# re-decoded per line; the plain check keeps the banner a no-op when the terminal can't show it.
ANSI_CLEAR=""
if [ -t 1 ] || [ -t 2 ]; then
  # 品牌蓝 #4D6BFE 作为前景；鲸鱼符号用半块字符，占用每个格子的上半/下半。
  ANSI_CLEAR="$(printf '\033[0m')"
fi

# 官方 DeepSeek 鲸鱼徽标（来源 @lobehub/icons 的 deepseek 图标，品牌蓝 #4D6BFE）。
# 用 Unicode 半块字符（▀/▄/█）光栅化成纯文本，不依赖任何外部字体或图片。
#
# 光栅化必须按图标声明的 fill-rule="evenodd" 做点内测试，并且要支持路径里的圆弧
# 命令（a/A）：镂空（腹部大块留白与眼睛）正是靠奇偶规则从实心形状里挖出来的，
# 而眼睛那条边界是圆弧。少任何一项，图案就只剩外部轮廓。
#
# 图案只在这里存一份：启动横幅与翻页向导的每页页头都读它，避免两处各写一份而漂移。
# install.ps1 的 Show-Banner 存同一份，有测试比对两边是否一致。
BANNER_ART=(
  '       ▄▄▄▄▄▄▄▄     █▄'
  '   ▄███████████▄    ███▄ ▄▄▄▄█   ██████████    █████████  █████   █████'
  ' ▄███████████████▄  ▀████████▀  ░░███░░░░███  ███░░░░░███░░███   ░░███'
  '▄██████████████████▄  ████▀▀     ░███   ░░███░███    ░░░  ░███    ░███'
  '██     ▀▀███████▀▀███████        ░███    ░███░░█████████  ░███████████'
  '██        ▀██████  ▀█████        ░███    ░███ ░░░░░░░░███ ░███░░░░░███'
  '███         ▀█████▄▄████         ░███    ███  ███    ░███ ░███    ░███'
  ' ███          █████████          ██████████  ░░█████████  █████   █████'
  '  ▀██▄    █▄▄  ▀█████▀          ░░░░░░░░░░    ░░░░░░░░░  ░░░░░   ░░░░░'
  '   ▀▀███▄▄████▄▄▄██████▄'
  '      ▀▀███████▀▀▀'
)
# DSH 大字（FIGlet 的 DOS Rebel 字体，8 行）。窄终端放不下鲸鱼时只画它。
# 与 BANNER_ART 一样由字体文件生成、不手抄；install.ps1 存同一份，有测试比对两边。
WORDMARK_ART=(
  ' ██████████    █████████  █████   █████'
  '░░███░░░░███  ███░░░░░███░░███   ░░███'
  ' ░███   ░░███░███    ░░░  ░███    ░███'
  ' ░███    ░███░░█████████  ░███████████'
  ' ░███    ░███ ░░░░░░░░███ ░███░░░░░███'
  ' ░███    ███  ███    ░███ ░███    ░███'
  ' ██████████  ░░█████████  █████   █████'
  '░░░░░░░░░░    ░░░░░░░░░  ░░░░░   ░░░░░'
)


banner_blue() {
  if [ -n "$ANSI_CLEAR" ]; then
    printf '\033[38;2;77;107;254m'
  fi
}

print_banner() {
  local blue last
  blue="$(banner_blue)"
  last=$(( ${#BANNER_ART[@]} - 1 ))
  local i
  for ((i = 0; i <= last; i++)); do
    if [ "$i" -eq "$last" ]; then
      printf '%s\n' "$blue${BANNER_ART[$i]}$ANSI_CLEAR"
    else
      printf '%s\n' "$blue${BANNER_ART[$i]}"
    fi
  done
}

# 只画 DSH 大字：窄终端（放不下鲸鱼 + 大字并排）时的页头图案。
print_wordmark() {
  local blue last
  blue="$(banner_blue)"
  last=$(( ${#WORDMARK_ART[@]} - 1 ))
  local i
  for ((i = 0; i <= last; i++)); do
    if [ "$i" -eq "$last" ]; then
      printf '%s\n' "$blue${WORDMARK_ART[$i]}$ANSI_CLEAR"
    else
      printf '%s\n' "$blue${WORDMARK_ART[$i]}"
    fi
  done
}

# 横幅只在无法进入向导时直接打印。判定要用 UI_TUI 而不是 INTERACTIVE：
# 终端不可翻页（TERM=dumb、stty 不可用）时向导会退回编号输入，那时仍需横幅，
# 而它必须落在主屏幕上。向导路径由第一页页头在备用屏幕内绘制——在主屏幕打印会
# 留在 scrollback 里，退出向导后仍能看到。
ui_detect_tui || true
if [ "$UI_TUI" != true ]; then
  print_banner
  echo
  echo "DeepSeek Harness (DSH) 安装与管理向导"
  echo
fi

# --userns-preflight 只做宿主检查，不该被"这次要做什么"的菜单挡住。
# 菜单要标出"安装"当前是否可用。container_exists() 依赖 DOCKER()，而 DOCKER()
# 在菜单之后才定义，所以这里直接探一次 docker：容器存在则安装走不通。
# 探不到 docker 时按"可用"处理——随后统一的 Docker 检测会给出真正的报错。
INSTALL_AVAILABLE=true
if command -v docker >/dev/null 2>&1 && docker container inspect dsh >/dev/null 2>&1; then
  INSTALL_AVAILABLE=false
elif command -v sudo >/dev/null 2>&1 && sudo docker container inspect dsh >/dev/null 2>&1; then
  INSTALL_AVAILABLE=false
fi

# 交互路径的向导**不在这里**启动。原因：向导与执行视图现在是同一个 Go 程序，
# 而它启动的后台执行子 shell 需要用到本文件后半段定义的那些函数
#（install_prepare_body / install_execute_body 等）。bash 是边读边执行的，
# 在这一点上 fork 出的子 shell 还看不到后面才定义的函数，所以整段挪到脚本末尾
#（见 run_guided_session）。这里只留下判定：走到这里且 ACTION 仍为空，说明是
# 交互路径——前面的「无终端」守卫已经排除了无 TTY 的情况。
if [ -z "$ACTION" ] && [ "$USERNS_PREFLIGHT" != true ]; then
  DSH_ANSWER_CONFIRMED=true
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
      echo "         sudo chown -R \$((BASE + 1000)):\$((BASE + 1000)) data/dsh data/home data/agents data/mcp workspace data/broker data/egress" >&2
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
    echo "      sudo chown -R $mapped_user:$mapped_user data/dsh data/home data/agents data/mcp workspace data/broker data/egress"
    echo "      sudo chown -R $mapped_root:$mapped_root data/secret data/auth"
    return 0
  fi
  ( cd "$project_dir" && mkdir -p data/dsh data/home data/agents data/mcp data/broker data/egress data/secret data/auth workspace )
  # 走 DSH 账户的目录用 BASE+1000；data/secret 与 data/auth 只被容器 root 读，用 BASE+0。
  for directory in data/dsh data/home data/agents data/mcp workspace data/broker data/egress; do
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

# 补上工程内脚本的可执行位。
#
# 为什么需要：docker-compose.yml 把 ./bin/dsh-supervisor 绑定挂载到容器的
# /usr/local/bin/dsh-supervisor（只读），它会覆盖镜像里已 chmod +x 的那份。宿主机上
# 这个文件一旦没有可执行位，容器启动时 exec 就会失败并陷入重启循环，而报错只是
# 「permission denied」，看不出是权限位的问题。
#
# 触发条件不止 git：tar 解包不保留权限位（install.sh 在无 git 时就走这条路），
# Windows 上检出的仓库也可能丢掉执行位。所以这里无条件对齐一次，代价可以忽略。
fix_exec_bits() {
  local dir="${1:-$TARGET_DIR}" f
  [ -d "$dir/bin" ] || return 0
  # bin/ 下的文件全部是可执行脚本（无扩展名的入口，以及 .mjs/.sh 辅助脚本），
  # 所以整目录对齐，不做扩展名筛选——漏掉一个无扩展名的入口就会复现同样的故障。
  for f in "$dir"/bin/*; do
    [ -f "$f" ] || continue
    chmod +x "$f" 2>/dev/null || true
  done
}

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
    fix_exec_bits "$TARGET_DIR"
  elif [ -f "$TARGET_DIR/docker-compose.yml" ]; then
    echo "==> 使用现有工程文件；不会自动同步或更新项目源码。"
    # 已有工程同样要核对：老部署可能是 tar 解包或从 Windows 同步过来的。
    fix_exec_bits "$TARGET_DIR"
  elif [ -f "$TARGET_DIR/$DELETE_KEEP_MARKER" ]; then
    # 上一次删除选择了"保留会话 / 工作目录 / 插件"：目录里只剩那几样，源码是被删掉的。
    # 这里必须把源码取回同一个目录（而不是报错让人手工搬），否则"删除→重装→接着用"
    # 这条路走不通。
    echo "==> $TARGET_DIR 里只剩上次删除时保留的数据，正在取回项目源码..."
    fetch_into_existing_dir
    fix_exec_bits "$TARGET_DIR"
  else
    echo "[错误] $TARGET_DIR 已存在但不是 Git 工程，请移动该目录后重试。" >&2
    exit 1
  fi
}

# 往一个非空目录里放项目源码：先取到临时目录，再整目录搬进去。
# 用 tar 管道而不是 cp/mv 加通配，是因为源码里有 .git、.github、.gitignore 这些点
# 开头的条目，通配是否包含它们取决于 shell 选项。
fetch_into_existing_dir() {
  local tmp src
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/dsh-src-XXXXXX")" || { echo "[错误] 无法创建临时目录。" >&2; exit 1; }
  src="$tmp/src"
  if command -v git >/dev/null 2>&1; then
    git clone https://github.com/univers629/dsh-docker.git "$src"
  else
    mkdir -p "$src"
    curl -fsSL https://github.com/univers629/dsh-docker/archive/refs/heads/main.tar.gz \
      | tar -xz -C "$src" --strip-components=1
  fi
  if [ ! -f "$src/docker-compose.yml" ]; then
    rm -rf -- "$tmp"
    echo "[错误] 取回的源码不完整，已放弃（保留的数据没有被改动）。" >&2
    exit 1
  fi
  # 属主只对新搬进来的源码对齐：保留下来的 data/ 与 workspace/ 属于容器里的 1000:1000，
  # 把它们 chown 给宿主用户只会让容器再修一遍。
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    chown -R "$SUDO_USER:$SUDO_USER" "$src" 2>/dev/null || true
  fi
  ( cd "$src" && tar cf - . ) | ( cd "$TARGET_DIR" && tar xf - )
  rm -rf -- "$tmp"
  rm -f -- "$TARGET_DIR/$DELETE_KEEP_MARKER"
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
  # 删除是破坏性操作，确认由向导的一页选择承担（光标默认停在「取消」，回车不会误删）。
  # 向导确认后会把 delete_confirmed=yes 写进答案文件，这里据此放行。
  if [ "${DSH_DELETE_CONFIRMED:-}" = 1 ]; then
    return 0
  fi
  if [ "$INTERACTIVE" != true ]; then
    echo "[错误] delete 是破坏性操作，需要交互确认；请不要使用 --non-interactive。" >&2
    exit 2
  fi
  # 走到这里说明是以命令行方式（--action delete）直接调用，没有经过向导。
  # 不再提供手输 DELETE 的第二套确认：改用与向导一致的是/否选择页。
  UI_TOTAL=0
  ui_next_page
  ui_page_select "删除的数据范围" 0 \
    "0	全部删除	容器、镜像、.env、模型密钥、root 密码哈希，以及 data/ 和 workspace/ 里的一切" \
    "1	保留会话、工作目录和插件	只留 workspace/、data/dsh/sessions/、data/dsh/profiles/；密钥、密码哈希、.env、data/home 里的工具链都不留"
  case "$UI_VALUE" in
    0) DSH_DELETE_KEEP=0 ;;
    1) DSH_DELETE_KEEP=1 ;;
    *) echo "[错误] 无效选项。" >&2; exit 2 ;;
  esac
  export DSH_DELETE_KEEP

  local scope
  if [ "$DSH_DELETE_KEEP" = 1 ]; then
    scope="保留会话、工作目录和插件"
  else
    scope="全部删除"
  fi
  ui_next_page
  ui_page_select "确认删除（不可恢复）" 1 \
    "yes	确认删除	将永久清除：dsh 容器、DSH 镜像、Compose 挂载与网络、Docker 构建缓存" \
    "no	取消	不执行删除"
  if [ "$UI_VALUE" != yes ]; then
    ui_term_restore
    echo "已取消。"
    exit 0
  fi
  echo "==> 删除范围：$scope"
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
  DSH_DELETE_DETACHED=1 DSH_DELETE_CONFIRMED=1 DSH_DELETE_KEEP="${DSH_DELETE_KEEP:-0}" \
    bash "$tmp_copy" delete --dir "$target_abs" || status=$?
  rm -f -- "$tmp_copy"
  exit "$status"
}

# 清理多用户的每用户实例资源。
#
# 这些资源由 dsh-instances 在运行时创建，不带 Docker 标签，只能按命名规则识别。
# 规则与 bin/dsh-instances.mjs / dsh-instances-policy.mjs 保持一致：
#   容器  dsh-u<N>                 （N 从 1 起，instanceName）
#   卷    dsh-user-<uid>-home / -workspace   （uid 从 100000 起，volumePrefix）
#   网络  dsh-instances-net-u<N>   （instanceNetworkName）
#
# 严格用「锚定的数字后缀」匹配，避免误伤宿主上名字相近的别的资源：
# 例如 `dsh-u1-test` 或别的项目的 `dsh-userdata` 都不该被选中。
# 前缀可用环境变量覆盖（与 dsh-instances 一致），这里同样尊重它们。
cleanup_user_instances() {
  local network_prefix volume_prefix ids id name num rest uid

  network_prefix="${DSH_INSTANCE_NETWORK:-dsh-instances-net}"
  volume_prefix="${DSH_INSTANCE_VOLUME_PREFIX:-dsh-user}"

  # 1) 实例容器：dsh-u 后跟纯数字。先停再删，避免运行中的实例继续写数据。
  #    用 --format 列出「ID 名字」：-q 与 --format 同用会互相覆盖，只留一个。
  ids="$(DOCKER container ls -a --format '{{.ID}} {{.Names}}' 2>/dev/null || true)"
  while IFS=' ' read -r id name; do
    [ -n "$id" ] || continue
    num="${name#dsh-u}"
    # 必须以 dsh-u 开头、且剩余部分是纯数字（排除 dsh-u 自身与 dsh-u1-xxx 这类）
    case "$name" in
      dsh-u*) case "$num" in ''|*[!0-9]*) continue ;; esac ;;
      *) continue ;;
    esac
    DOCKER container rm -f "$id" >/dev/null 2>&1 || true
  done <<< "$ids"

  # 2) 实例数据卷：<prefix>-<uid>-home / -workspace，uid 是纯数字。
  ids="$(DOCKER volume ls --format '{{.Name}}' 2>/dev/null || true)"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case "$name" in
      "${volume_prefix}"-*) ;;
      *) continue ;;
    esac
    rest="${name#"${volume_prefix}"-}"
    uid="${rest%%-*}"
    case "$uid" in ''|*[!0-9]*) continue ;; esac
    # 后缀必须是 home 或 workspace，其余（例如别人的 dsh-user-data）不动。
    case "$rest" in
      *-home|*-workspace) ;;
      *) continue ;;
    esac
    DOCKER volume rm -f "$name" >/dev/null 2>&1 || true
  done <<< "$ids"

  # 3) 每实例网络：<prefix>-u<N>。必须没有容器还接着，否则删不掉（那是正确行为：
  #    有东西在用就不该强拆）。清完实例容器后通常已经空出来。
  ids="$(DOCKER network ls --format '{{.ID}} {{.Name}}' 2>/dev/null || true)"
  while IFS=' ' read -r id name; do
    [ -n "$id" ] || continue
    num="${name#"${network_prefix}"-u}"
    case "$name" in
      "${network_prefix}"-u*) case "$num" in ''|*[!0-9]*) continue ;; esac ;;
      *) continue ;;
    esac
    DOCKER network rm "$id" >/dev/null 2>&1 || true
  done <<< "$ids"
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

  # 多用户的每用户实例：容器 dsh-u<N>、卷 dsh-user-<uid>-{home,workspace}、
  # 网络 dsh-instances-net-u<N>。
  #
  # 这些资源是 dsh-instances 在运行时动态创建的，**不带任何 Docker 标签**，
  # 所以上面所有按 compose 项目标签做的过滤都抓不到它们。不显式清理的话，
  # 「卸载」会留下一堆孤儿容器和卷，用户的文件仍在磁盘上占空间。
  #
  # 只按我们自己的命名规则匹配（dsh-u<数字>、dsh-user-<数字>-*、dsh-instances-net-u<数字>），
  # 不做通配删除：宿主上别的项目不该被碰到。
  cleanup_user_instances

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
      if [ "${DSH_DELETE_KEEP:-0}" = 1 ]; then
        prune_project_keep "$target_abs" || exit 1
      elif ! rm -rf -- "$target_abs" 2>/dev/null; then
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

# 删除时"保留一部分数据"这个二级分支要保留的相对路径。
# 只有这三样：会话、工作目录、插件装在的 profile。密钥、root 密码哈希、.env、
# 工具链（data/home）和 DSH 自己的配置都不在其中——它们由下一次安装重新生成。
DELETE_KEEP_PATHS='workspace data/dsh/sessions data/dsh/profiles'
# 目录里留下的标记文件：下一次安装靠它认出"这里只剩上次保留下来的数据"，从而把
# 项目源码取回来，而不是报"已存在但不是 Git 工程"。
DELETE_KEEP_MARKER=.dsh-preserved

# 容器以 root 身份写下的文件宿主用户删不掉，所以每一次删除都要有 sudo 兜底。
remove_path() {
  local target="$1"
  [ -e "$target" ] || [ -L "$target" ] || return 0
  rm -rf -- "$target" 2>/dev/null && return 0
  if command -v sudo >/dev/null 2>&1 && sudo rm -rf -- "$target"; then
    return 0
  fi
  echo "[错误] 删不掉 $target（容器 root 写下的文件），请用 root 重跑删除。" >&2
  return 1
}

# 删掉 $1 目录里除白名单之外的所有直接子项（含点开头的条目）。
prune_dir_except() {
  local dir="$1" child base keep matched status=0
  shift
  [ -d "$dir" ] || return 0
  # 用 NUL 分隔读 find 的输出：文件名里可以合法地含换行，按行读会把一个条目拆成
  # 两条待删路径，而 delete_project 已经把工作目录切到项目父目录，拆出的相对名会
  # 在项目之外解析（审计复现：含换行的目录名让保留路径被连带删掉、项目外的同名
  # sibling 被 rm -rf）。-print0 配合 read -d '' 才能让文本行与路径一一对应。
  while IFS= read -r -d '' child; do
    [ -n "$child" ] || continue
    base="${child##*/}"
    matched=false
    for keep in "$@"; do
      if [ "$base" = "$keep" ]; then
        matched=true
        break
      fi
    done
    [ "$matched" = true ] && continue
    remove_path "$child" || status=1
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
  return "$status"
}

# 保留会话 / 工作目录 / 插件，其余全部删掉。
#
# 做法是逐层按白名单删，而不是"先备份、删完再搬回来"：中途失败时要保留的数据一直
# 待在原地，不会出现"已经 rm -rf 了、备份却没搬回来"的窗口。项目源码（含 .git）
# 也一并删掉，这样下一次安装会重新取一份新的，而不是继续用旧版脚本。
prune_project_keep() {
  local dir="$1" keep status=0
  prune_dir_except "$dir" workspace data || status=1
  prune_dir_except "$dir/data" dsh || status=1
  prune_dir_except "$dir/data/dsh" sessions profiles || status=1
  # 标记文件同时也是给人看的：目录里只剩这些东西时，光看文件名很难说清它们是什么。
  {
    echo "# 这个目录是 dsh-docker 删除时选择「保留会话 / 工作目录 / 插件」后的残留。"
    echo "# 保留下来的路径："
    for keep in $DELETE_KEEP_PATHS; do
      [ -e "$dir/$keep" ] && echo "#   $keep"
    done
    echo "# 重新安装：curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker/main/install.sh | bash"
    echo "# 安装器看到这个文件就会把项目源码取回到同一个目录，上面这些路径原地接着用。"
  } > "$dir/$DELETE_KEEP_MARKER" 2>/dev/null || true
  local kept=""
  for keep in $DELETE_KEEP_PATHS; do
    if [ -e "$dir/$keep" ]; then
      kept="$kept $keep"
    fi
  done
  if [ -n "$kept" ]; then
    echo "==> 已保留：$kept"
  else
    echo "==> 会话 / 工作目录 / 插件这三个路径都不存在，没有东西需要保留。"
  fi
  echo "==> 其余内容（项目源码、.env、模型密钥、root 密码哈希、data/home 里的工具链）已删除。"
  echo "==> 重新安装到 $dir 即可接着用；安装器会自己把项目源码取回来。"
  return "$status"
}

# 卸载：清掉本工程产生的容器、卷、网络与源码目录，但保留用户数据。
#
# 包成函数是因为它有两条调用路径：命令行直接指定（ACTION=delete）在向导之前就能
# 判断，而向导里选「卸载」要等向导跑完才知道。两条路径的清理动作必须完全一致，
# 所以只能有一份实现。
handle_delete_action() {
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
}

if [ "$ACTION" = delete ]; then
  handle_delete_action
fi

# 进入工程目录：维护类动作（启动、停止、密钥面板…）要对 dsh.sh 与 .env 操作，
# 必须在工程目录里跑。
#
# 幂等，因为两条路径都要用它：命令行直接在参数里给出动作，能在脚本中段就进；
# 交互路径要等向导给出答案才知道是什么动作，只能在脚本末尾补一次。
# install/configure 不在这里进：它们的取源码与 cd 属于安装过程，要收进执行视图的
# 滚动日志（见 install_prepare_body）。delete 也不进：它有自己的目录判定。
DSH_PROJECT_ENTERED=false
enter_project() {
  [ "$DSH_PROJECT_ENTERED" = true ] && return 0
  require_project
  cd "$TARGET_DIR" || return 1
  chmod +x dsh.sh 2>/dev/null || true
  DSH_PROJECT_ENTERED=true
}

case "$ACTION" in
  install|configure) ;;
  '') ;;
  delete) ;;
  *) enter_project || exit $? ;;
esac

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

# data/auth 存认证网关的状态与 TOTP 密钥；data/secret 只存容器 root 口令哈希，
# 并且只挂到容器的 /root/dsh-secret（0700 root:root），dsh 账户读不到。
# data/broker 存模型密钥，只被 dsh-key-broker 容器以 UID 1000 只读挂载，
# 完全不出现在 DSH 容器的挂载表里。
# data/egress 存出站策略（模式 + 白名单 + 黑名单）：管理面板可写，dsh-egress 只读挂载。
#
# 这三个目录的属主必须对齐到 1000，而且**目录本身**也要对齐 —— 不只是里面的文件。
#
# 它们不挂进 dsh 容器，所以 entrypoint 的 align_data_ownership 管不到；以 root 全新
# 安装时目录属主就是 root，而 dsh-auth / dsh-key-broker / dsh-key-admin 都以 UID 1000
# 运行。这三个进程都要在目录里新建临时文件再 rename（state.json / totp.key /
# keys.json.tmp.<pid>），目录不可写就直接 EACCES：把文件的属主改对了也没用，
# 卡住的是目录的写权限。
#
# 必须在 cd 进工程目录**之后**调用：这些是相对路径，脚本顶层的 cwd 是调用者的
# 当前目录（curl | bash 时就是 $HOME），在那儿执行会把目录建到工程外面去，
# 工程里的那份反而保持 root 属主。
align_writable_data_dirs() {
  local failed=0
  mkdir -p data/auth data/secret data/broker data/egress
  # data/secret 由容器 root 使用，属主留 root。
  for directory in data/auth data/broker data/egress; do
    chown 1000:1000 "$directory" 2>/dev/null || failed=1
  done
  if [ "$failed" = 1 ]; then
    # 失败只警告：rootless、userns-remap 或非 Linux 宿主上 chown 本来就会失败，
    # 那不是安装失败。下面给出宿主上该执行的命令。
    echo "[警告] 无法把 data/auth、data/broker、data/egress 的属主改成 1000:1000。" >&2
    echo "       dsh-auth 与密钥管理面板以 UID 1000 运行，要在这些目录里新建临时文件。" >&2
    echo "       如果容器反复重启（EACCES）或面板保存时报错，请在宿主上执行：" >&2
    echo "       sudo chown 1000:1000 data/auth data/broker data/egress" >&2
  fi
  return 0
}

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
  # 认证层（网关 + 入口）在 password 模式与多用户模式下都需要：password 模式的含义是
  # 「容器内不做认证」，认证全在网关侧；多用户还要靠网关把请求按身份路由到实例。
  # 只设模式不部署这一层，等于容器内不认证、外面也没有认证。
  #
  # 入口容器二选一，靠 profile 区分：单管理员用 authgate，多用户用 multiuser 叠加层里的
  # dsh-ingress。两者发布同一个宿主端口，同时激活会让第二个入口绑定失败。
  if [ "$PENDING_ACCESS_MODE" = password ] || [ "$PENDING_MULTI_USER" = on ]; then
    if [ ! -f docker-compose.auth.yml ]; then
      echo "[错误] 需要 docker-compose.auth.yml 才能使用 password 访问模式或多用户模式，但工程目录里没有它。" >&2
      echo "       请更新工程源码，或改用 basic / trusted-proxy 模式。" >&2
      exit 1
    fi
    if [ "$PENDING_MULTI_USER" = on ]; then
      # 入口交给 multiuser 叠加层的 dsh-ingress，因此不激活 authgate profile。
      COMPOSE_ARGS+=(-f docker-compose.auth.yml)
    else
      COMPOSE_ARGS+=(--profile authgate -f docker-compose.auth.yml)
    fi
  fi
  # basic 模式只把 htpasswd 这一个文件挂进容器（整目录挂载会把认证数据库暴露给
  # 容器内的 Agent，见 docker-compose.basic-auth.yml 的注释）。
  if [ "$PENDING_ACCESS_MODE" = basic ]; then
    if [ ! -f docker-compose.basic-auth.yml ]; then
      echo "[错误] 需要 docker-compose.basic-auth.yml 才能使用 basic 访问模式，但工程目录里没有它。" >&2
      echo "       请更新工程源码，或改用 local / trusted-proxy / password 模式。" >&2
      exit 1
    fi
    COMPOSE_ARGS+=(-f docker-compose.basic-auth.yml)
  fi
  # 多用户模式在认证层之上再叠加实例编排；它同时改变入口与网络拓扑，
  # 因此必须与其它叠加层一起传给 build 与 up（两者用的是同一个 COMPOSE_ARGS）。
  if [ "$PENDING_MULTI_USER" = on ]; then
    if [ ! -f docker-compose.multiuser.yml ]; then
      echo "[错误] 需要 docker-compose.multiuser.yml 才能启用多用户模式，但工程目录里没有它。" >&2
      echo "       请更新工程源码，或用 --no-multi-user 保持单管理员模式。" >&2
      exit 1
    fi
    COMPOSE_ARGS+=(--profile multiuser)
    # 多用户建立在认证层之上：上面的分支已经把它加进来了，这里只做兜底声明。
    case " ${COMPOSE_ARGS[*]} " in
      *" docker-compose.auth.yml "*) ;;
      *) COMPOSE_ARGS+=(-f docker-compose.auth.yml) ;;
    esac
    COMPOSE_ARGS+=(-f docker-compose.multiuser.yml)
  fi
  # blocklist 与 allowlist 用同一套隔离形态：都要把 dsh 收进没有网关的网络，出站全部
  # 经过 dsh-egress。两者只差代理里那最后一道域名判定，而那是策略文件的事。
  if [ "$PENDING_EGRESS_MODE" != open ]; then
    if [ ! -f docker-compose.isolated.yml ]; then
      echo "[错误] 需要 docker-compose.isolated.yml 才能启用出站黑/白名单模式，但工程目录里没有它。" >&2
      echo "       请更新工程源码，或用 --egress open 保持直连出网。" >&2
      exit 1
    fi
    COMPOSE_ARGS+=(-f docker-compose.isolated.yml)
    # 两个叠加文件都定义了 dsh-ingress，但那是两套不同实现（不同 nginx 配置、
    # 不同运行用户、不同 entrypoint）。Compose 合并同名服务时序列字段是追加，
    # 同时激活会让 security_opt / command / ports 出现重复项，严格版本的 compose
    # 直接拒绝校验。所以按模式只激活其中一个入口：
    #   多用户 → multiuser.yml 的 dsh-ingress（profiles: multiuser）
    #   单管理员 → isolated.yml 的 dsh-ingress（profiles: isolate）
    if [ "$PENDING_MULTI_USER" != on ]; then
      COMPOSE_ARGS+=(--profile isolate)
    fi
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
# 猜错 base_url 等于把密钥发到一个未经验证的域名，宁可报错退出。
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

# 把自动问出来的 base_url 回填。少写一个 /v1 的后果是整条上游一个请求都发不出去，
# 所以这一项比模型清单更要紧：面板里"拉取模型列表"会同时试 /models 和 /v1/models，
# 因此它照样成功，而 DSH 走代理发的请求全落在上游根路径上，换回来 403 或 404。
set_broker_base_url() {
  local wanted="$1" value="$2" index=0
  while [ "$index" -lt "${#BROKER_NAMES[@]}" ]; do
    if [ "${BROKER_NAMES[$index]}" = "$wanted" ]; then
      BROKER_BASE_URLS[$index]="$value"
      return 0
    fi
    index=$((index + 1))
  done
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
  const previous = new Map()
  if (payload.existing) {
    const document = JSON.parse(payload.existing)
    if (Array.isArray(document.upstreams)) {
      kept = document.upstreams.filter((entry) => entry && !names.has(entry.name))
      for (const entry of document.upstreams) if (entry && entry.name) previous.set(entry.name, entry)
    }
  }
  // 向导不问模型的调用能力、推理档位和模型清单里的花名（那些是密钥管理面板里的事），
  // 但同名上游被重新配置时不能把它们丢掉：档位没了 DSH 的模型页就不显示推理强度菜单，
  // 图像能力没了视觉模型会变成纯文本。所以按 id 把上一次那份声明搬过来——只搬这次
  // 清单里还在的 id，面板里删掉的模型不该被一次重跑带回来。
  for (const entry of incoming) {
    if (!entry || !entry.dsh) continue
    const before = previous.get(entry.name)
    const beforeDsh = before && before.dsh ? before.dsh : {}
    const declared = new Map()
    if (Array.isArray(beforeDsh.models)) {
      for (const model of beforeDsh.models) {
        if (model && typeof model === "object" && model.id) declared.set(String(model.id), model)
      }
    }
    if (Array.isArray(entry.dsh.models)) {
      entry.dsh.models = entry.dsh.models.map((model) => {
        const id = model && typeof model === "object" ? String(model.id || "") : String(model || "")
        const kept = declared.get(id)
        if (!kept) return model
        const merged = { id: id }
        if (Array.isArray(kept.input) && kept.input.length > 0) merged.input = kept.input
        if (Array.isArray(kept.reasoningEfforts) && kept.reasoningEfforts.length > 0) {
          merged.reasoningEfforts = kept.reasoningEfforts
        }
        return merged
      })
    }
    // 老形状：档位挂在整个上游上（dsh.reasoningEfforts）。留着它，面板下一次打开还能照原样回显。
    if (entry.dsh.reasoningEfforts === undefined
      && Array.isArray(beforeDsh.reasoningEfforts) && beforeDsh.reasoningEfforts.length > 0) {
      entry.dsh.reasoningEfforts = beforeDsh.reasoningEfforts
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
      baseurl)
        [ -n "$value" ] || continue
        set_broker_base_url "$name" "$value"
        echo "    $name：base_url 少了版本段，已改成 $value（否则 DSH 发出的请求全会被上游拒掉）。"
        ;;
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

# 向导已经问过密钥代理的两个开关，这里按答案落配置，不再向用户提问。
#
# 密钥本体不在终端里收集：向导开启面板后，上游名、base_url、密钥、模型清单全部在
# 浏览器里的密钥管理面板填。空 keys.json 是合法状态（此时 broker 对 /u/ 请求回 503），
# 所以这里可以先只建占位文件。
configure_model_broker_from_answers() {
  if [ "$PENDING_MODEL_BROKER" != on ]; then
    PENDING_MODEL_BROKER=off
    print_broker_skipped_notice
    return 0
  fi
  if [ -s data/broker/keys.json ]; then
    echo "==> 保留现有 data/broker/keys.json，本次不改动其中的密钥。"
    return 0
  fi
  ensure_broker_config_placeholder
}

configure_model_broker() {
  # 向导已经问过「是否启用密钥代理」与「是否启用管理面板」，答案在
  # PENDING_MODEL_BROKER 里。这里必须**先**处理它再读 .env，否则下面那行
  # 会把向导的答案整段覆盖掉——用户明明选了开启，装完却看到「本次不启用密钥代理」。
  if [ "${DSH_WIZARD_DONE:-}" = true ]; then
    configure_model_broker_from_answers
    return 0
  fi

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
  case "$PENDING_EGRESS_MODE" in open|blocklist|allowlist) ;; *) PENDING_EGRESS_MODE=open ;; esac
  # 黑白名单之间的切换可以在面板里做，那时 .env 不会跟着变。所以隔离部署的当前模式要以
  # 策略文件为准，否则重跑安装器会把面板里的选择悄悄改回来。
  if [ -z "$EGRESS_MODE_OVERRIDE" ] && [ "$PENDING_EGRESS_MODE" != open ]; then
    case "$(egress_policy_mode)" in
      blocklist) PENDING_EGRESS_MODE=blocklist ;;
      allowlist) PENDING_EGRESS_MODE=allowlist ;;
    esac
  fi
  if [ "$INTERACTIVE" = true ] && [ -z "$EGRESS_MODE_OVERRIDE" ]; then
    case "$PENDING_EGRESS_MODE" in
      blocklist) default_route=1 ;;
      allowlist) default_route=2 ;;
      *) default_route=0 ;;
    esac
    ui_next_page
    ui_page_select "容器出站网络" "$default_route" \
      "open	open	容器直接访问任意外网地址" \
      "blocklist	blocklist	出站经 dsh-egress 代理，默认放行，只挡黑名单里的域名（内置清单挡 cloudflared 快速隧道、ngrok、cpolar 这类一键公网隧道服务）" \
      "allowlist	allowlist	出站经 dsh-egress 代理，只放行白名单里的域名，其余返回 403（内置白名单覆盖 Debian、npm、PyPI、GitHub、ghcr.io 等）"
    PENDING_EGRESS_MODE="$UI_VALUE"
  fi
  PENDING_EGRESS_ALLOWED_HOSTS="${EGRESS_ALLOW_OVERRIDE:-$(get_compose_env DSH_EGRESS_ALLOWED_HOSTS '')}"
  if [ "$PENDING_EGRESS_MODE" = allowlist ] && [ "$INTERACTIVE" = true ] && [ -z "$EGRESS_ALLOW_OVERRIDE" ]; then
    prompt_optional "额外放行的域名（逗号分隔，支持 *.example.com；留空表示只用内置白名单）" "$PENDING_EGRESS_ALLOWED_HOSTS"
    PENDING_EGRESS_ALLOWED_HOSTS="$PROMPT_RESULT"
  fi
}

# 出站策略文件 data/egress/policy.json：模式 + 白名单 + 黑名单。dsh-egress 只读它，密钥
# 管理面板可写它，两边都按 mtime 热加载，所以装完之后改清单、在黑白名单之间切换都不用
# 再回终端（只有 open 和隔离形态之间的切换要重跑这个安装器，那要改 compose 叠加）。
#
# 这里只写 mode 一个字段：两份清单缺字段时由代理和面板自己补默认值（白名单回落到内置
# 软件源，黑名单回落到内置隧道清单），省得把同一份域名表在 shell 里再抄一遍。
egress_policy_mode() {
  [ -f data/egress/policy.json ] || return 0
  sed -n 's/^[[:space:]]*"mode"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' data/egress/policy.json 2>/dev/null | sed -n 1p
}

write_egress_policy() {
  local temporary
  [ "$PENDING_EGRESS_MODE" != open ] || return 0
  mkdir -p data/egress
  # 面板以 UID 1000 写这个目录里的临时文件，属主对不上就只能读不能改。
  chown 1000:1000 data/egress 2>/dev/null || true
  if [ -s data/egress/policy.json ]; then
    [ "$(egress_policy_mode)" = "$PENDING_EGRESS_MODE" ] && return 0
    temporary="$(mktemp data/egress/policy.json.tmp.XXXXXX)"
    # 只替换 mode 那一行，两份清单原样保留：它们是用户在面板里改过的。
    if sed 's/^\([[:space:]]*"mode"[[:space:]]*:[[:space:]]*"\)[a-z]*\("\)/\1'"$PENDING_EGRESS_MODE"'\2/' \
        data/egress/policy.json > "$temporary" \
        && grep -q "\"mode\"[[:space:]]*:[[:space:]]*\"$PENDING_EGRESS_MODE\"" "$temporary"; then
      chmod 644 "$temporary"
      mv "$temporary" data/egress/policy.json
      chown 1000:1000 data/egress/policy.json 2>/dev/null || true
      echo "==> 出站策略的模式已改成 $PENDING_EGRESS_MODE（data/egress/policy.json，两份清单保留）。"
      return 0
    fi
    rm -f "$temporary"
    echo "[警告] data/egress/policy.json 里没找到可替换的 mode 字段，没有改动它。" >&2
    echo "       现在生效的是文件里那个模式，可以在密钥管理面板里直接改。" >&2
    return 0
  fi
  temporary="$(mktemp data/egress/policy.json.tmp.XXXXXX)"
  printf '{\n  "version": 1,\n  "mode": "%s"\n}\n' "$PENDING_EGRESS_MODE" > "$temporary"
  chmod 644 "$temporary"
  mv "$temporary" data/egress/policy.json
  chown 1000:1000 data/egress/policy.json 2>/dev/null || true
  echo "==> 出站策略已写入 data/egress/policy.json（模式 $PENDING_EGRESS_MODE），清单之后在密钥管理面板里改。"
}

configure_dsh() {
  local access_mode bind_host trusted_hosts network network_external
  local route default_route default_network keep_auth confirm_password
  local keep_root_password confirm_root_password
  local multi_user register_gate idle_timeout user_disk_quota
  local candidates image_source image_ref

  image_source="${IMAGE_SOURCE_OVERRIDE:-$(get_compose_env DSH_IMAGE_SOURCE prebuilt)}"
  case "$image_source" in prebuilt|build) ;; *) image_source=prebuilt ;; esac
  if [ "$INTERACTIVE" = true ] && [ "${DSH_WIZARD_DONE:-}" != true ] && [ -z "$IMAGE_SOURCE_OVERRIDE" ]; then
    case "$image_source" in build) default_route=1 ;; *) default_route=0 ;; esac
    ui_next_page
    ui_page_select "Debian 13 镜像来源" "$default_route" \
      "prebuilt	拉取公开预构建镜像	推荐：不在本机编译 DSH，安装耗时约等于下载耗时" \
      "build	在本机构建镜像	用当前工程 Dockerfile 现场构建，不编译 DSH 源码，约几分钟"
    image_source="$UI_VALUE"
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

  # 一键：默认做认证。已写进 .env 的访问模式（例如老部署的 local）仍然尊重，只把
  # 「没写过」的默认值从 local 换成 basic——一键就是冲着「开箱即有锁」去的。
  if [ "$QUICK_INSTALL" = true ] && [ -z "$ACCESS_MODE_OVERRIDE" ]; then
    access_mode="$(get_compose_env DSH_ACCESS_MODE basic)"
    case "$access_mode" in local|trusted-proxy|basic) ;; *) access_mode=basic ;; esac
  else
    access_mode="${ACCESS_MODE_OVERRIDE:-$(get_compose_env DSH_ACCESS_MODE local)}"
  fi
  if [ "$INTERACTIVE" = true ] && [ "${DSH_WIZARD_DONE:-}" != true ] && [ -z "$ACCESS_MODE_OVERRIDE" ]; then
    case "$access_mode" in local) default_route=0 ;; trusted-proxy) default_route=1 ;; basic) default_route=2 ;; password) default_route=3 ;; *) default_route=0 ;; esac
    ui_next_page
    ui_page_select "访问保护方式" "$default_route" \
      "local	仅本机或 SSH 隧道	容器内不做认证，只绑定回环地址" \
      "trusted-proxy	已有 Cloudflare Access / 面板认证 / 私有 VPN	容器内不做认证，完全依赖外层入口" \
      "basic	DSH 内置 Nginx Basic Auth	容器内用 bcrypt 密码文件认证；外层仍须提供 HTTPS" \
      "password	多用户（开放注册 + 每实例独立容器）	认证由内置网关承担，可注册账户、TOTP、通行密钥"
    case "$UI_VALUE" in
      local) access_mode=local ;;
      trusted-proxy) access_mode=trusted-proxy ;;
      basic) access_mode=basic ;;
      password) access_mode=password; MULTI_USER_OVERRIDE=on ;;
    esac
  fi

  # trusted-proxy 把认证全部交给外层，容器内不持有任何应用层凭据：任何能连到
  # 源站 443 并让请求被转发进来的来源都不经过外层认证。这里必须把这件事讲清楚，
  # 否则用户容易把「外层有 Access」误当成「容器有锁」。
  if [ "$access_mode" = trusted-proxy ] && [ -z "$TRUSTED_PROXY_ACK" ]; then
    echo
    echo "[注意] trusted-proxy 模式下容器内不做认证，认证完全依赖外层入口："
    echo "  - 直连源站 IP 不经过 Cloudflare Access，等于没有锁；"
    echo "  - 源站 IP 通常会被 Shodan / Censys 按证书信息索引，应按「已公开」设计防护；"
    echo "  - DSH_TRUSTED_HOSTS 只是 cookie 绑定键，不是访问白名单。"
    echo "建议叠加一层不依赖 IP 与 Host 判断的凭据：改用 basic 模式，或走 Cloudflare Tunnel。"
    echo "自检：curl -k -i -H \"Host: <你的域名>\" https://<源站IP>/  返回 200 即为可绕过。"
    echo "详见 docs/security.md 的「trusted-proxy 模式的边界与自检」。"
    if [ "$INTERACTIVE" = true ]; then
      prompt_yes_no "我已了解：外层认证之外，还配置了不依赖 IP/Host 的防护（或未确认，继续安装风险自负）" y
      if [ "$PROMPT_RESULT" != true ]; then
        echo "[警告] 未确认网络层防护。该模式下直连源站即可绕过认证，请务必先加固。" >&2
      fi
    fi
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
  elif [ "${DSH_WIZARD_DONE:-}" = true ]; then
    # 向导已经问过反向代理位置、网络名、公网域名与绑定地址，这里按答案装配：
    # 不再进入下面的分页提问，否则用户在向导里答过的东西会被再问一遍。
    case "${DSH_ANSWER_PROXY:-host}" in
      docker)
        network="${DSH_ANSWER_PROXY_NETWORK:-dsh-proxy}"
        network_external=true
        bind_host="${BIND_HOST_OVERRIDE:-127.0.0.1}"
        echo "==> DSH 加入网络 $network，反向代理用 http://dsh:3080 访问它。"
        ;;
      *)
        bind_host="${BIND_HOST_OVERRIDE:-127.0.0.1}"
        network="${NETWORK_OVERRIDE:-dsh-private}"
        network_external="${NETWORK_EXTERNAL_OVERRIDE:-false}"
        ;;
    esac
  elif [ "$INTERACTIVE" = true ] && [ "${DSH_WIZARD_DONE:-}" != true ]; then
    default_route=0
    if DOCKER network inspect dpanel-local >/dev/null 2>&1 || [ "$network_external" = true ]; then
      default_route=1
    fi
    ui_next_page
    ui_page_select "反向代理在哪里" "$default_route" \
      "host	宿主机	用宿主机的 Nginx 或 SSH 隧道反代，上游写 http://127.0.0.1:3080" \
      "docker	Docker 容器 / 面板	DSH 加入一个外部网络，反向代理用 http://dsh:3080 访问它"
    case "$UI_VALUE" in
      host) route=1 ;;
      docker) route=2 ;;
      *) route=1 ;;
    esac
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
    prompt "公网域名（多个用逗号分隔，不带 https://；仅用于绑定会话 cookie，不是访问白名单）" "${trusted_hosts:-agent.example.com}"
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
    # 向导已经问过「新建还是保留」与账密：DSH_WIZARD_DONE 时不进任何提问分支，
    # 直接用 PENDING_BASIC_USER / PENDING_BASIC_PASSWORD 落盘。
    if [ "${DSH_WIZARD_DONE:-}" != true ] && [ -s data/auth/htpasswd ] && [ "$INTERACTIVE" = true ]; then
      prompt_yes_no "保留现有 Basic Auth 用户名和密码" y
      keep_auth="$PROMPT_RESULT"
    elif [ -s data/auth/htpasswd ] && [ -z "$PENDING_BASIC_PASSWORD" ]; then
      keep_auth=true
    else
      keep_auth=false
    fi
    # 一键：随机生成账密，但尊重环境变量显式给过的值（DSH_BASIC_AUTH_*）与命令行参数。
    # 老部署盘上有 htpasswd 时沿用，不反复改密码把它弄丢。
    if [ "$QUICK_INSTALL" = true ] && [ "$keep_auth" != true ] && [ -z "$PENDING_BASIC_USER" ] && [ -z "$PENDING_BASIC_PASSWORD" ]; then
      GENERATED_BASIC_USER="${DSH_BASIC_AUTH_USER:-dsh}"
      GENERATED_BASIC_PASSWORD="$(generate_password 16)" || {
        echo "[错误] 读不到 /dev/urandom，一键安装无法生成 Basic Auth 密码。" >&2
        exit 1
      }
      PENDING_BASIC_USER="$GENERATED_BASIC_USER"
      PENDING_BASIC_PASSWORD="$GENERATED_BASIC_PASSWORD"
      case "$PENDING_BASIC_USER" in *[!A-Za-z0-9._-]*|'') echo "[错误] 用户名只允许字母、数字、点、下划线和连字符。" >&2; exit 2 ;; esac
    fi
    if [ "$keep_auth" != true ]; then
      if [ "${DSH_WIZARD_DONE:-}" = true ]; then
        # 账密来自向导，只校验、不提问。
        case "$PENDING_BASIC_USER" in *[!A-Za-z0-9._-]*|'') echo "[错误] Basic Auth 用户名只允许字母、数字、点、下划线和连字符。" >&2; exit 2 ;; esac
        if [ "${#PENDING_BASIC_PASSWORD}" -lt 12 ]; then
          echo "[错误] Basic Auth 密码至少需要 12 个字符。" >&2
          exit 2
        fi
      elif [ "$INTERACTIVE" = true ]; then
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
  elif [ "${DSH_WIZARD_DONE:-}" = true ]; then
    # 向导已经问过：给了密码就设置（ROOT_PASSWORD_OVERRIDE 已在上面赋给
    # PENDING_ROOT_PASSWORD），选了「不设置」则清空哈希。这里不再提问。
    if [ "${NO_ROOT_PASSWORD_ANSWER:-}" = true ] || [ -z "$PENDING_ROOT_PASSWORD" ]; then
      PENDING_ROOT_PASSWORD=""
      rm -f data/secret/root.hash
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
  elif [ "$QUICK_INSTALL" = true ] && [ ! -s data/secret/root.hash ]; then
    # 一键：随机生成容器 root 密码。有了它摘要里才能把完整凭据一次给齐，省得用户
    # 装完还要回来再配一道。老部署若有 root.hash 则保持不动。
    GENERATED_ROOT_PASSWORD="$(generate_password 16)" || {
      echo "[错误] 读不到 /dev/urandom，一键安装无法生成容器 root 密码。" >&2
      exit 1
    }
    PENDING_ROOT_PASSWORD="$GENERATED_ROOT_PASSWORD"
  fi

  configure_user_mode "$access_mode"

  configure_model_broker
  configure_key_admin
  configure_egress_mode

  PENDING_ACCESS_MODE="$access_mode"
  PENDING_MULTI_USER="$multi_user"
  PENDING_REGISTER_GATE="$register_gate"
  PENDING_IDLE_TIMEOUT="$idle_timeout"
  PENDING_USER_DISK_QUOTA="$user_disk_quota"
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

# 用户模式问答。
#
# 默认单管理员：行为与既有部署完全一致。多用户会额外部署认证网关与实例编排服务，
# 并按账户隔离会话与文件；它把访问保护方式固定为 password（认证在网关侧完成）。
#
# 一键安装（QUICK_INSTALL=true）短路整个问答：保持单管理员，不出现任何新提问。
configure_user_mode() {
  local access_mode="$1"
  local existing

  multi_user="${MULTI_USER_OVERRIDE:-}"
  register_gate="${REGISTER_GATE_OVERRIDE:-}"
  idle_timeout="${IDLE_TIMEOUT_OVERRIDE:-}"
  user_disk_quota="${DISK_QUOTA_OVERRIDE:-}"

  if [ -z "$multi_user" ]; then
    existing="$(get_compose_env DSH_MULTI_USER off)"
    if [ "$QUICK_INSTALL" = true ]; then
      multi_user="$existing"
    elif [ "${DSH_WIZARD_DONE:-}" = true ]; then
      # 向导已经问过用户模式。它没给答案有两种可能：选了「单管理员」，
      # 或根本没进这个分支（访问保护不是 password）。两种情况都该按单管理员处理，
      # 而不是回落到 bash 里再问一遍——那正是「向导走完又被弹一页」的来源。
      multi_user="$existing"
    elif [ "$access_mode" = password ]; then
      ui_next_page
      ui_page_select "用户模式" 0 \
        "off	单管理员	一套管理员凭据，不开放注册" \
        "on	多用户	开放注册；每个账户拥有独立会话与文件（独立 DSH 实例，默认 200MB 上限 + 闲置自动停用）"
      multi_user="$UI_VALUE"
    else
      multi_user="$existing"
    fi
  fi

  if [ "$multi_user" != on ]; then
    multi_user=off
    # 单管理员模式用不到这些参数；仍然写进 .env（取现值或默认），便于将来切换。
    register_gate="${register_gate:-$(get_compose_env DSH_REGISTER_GATE open)}"
    idle_timeout="${idle_timeout:-$(get_compose_env DSH_IDLE_TIMEOUT_SECONDS 1800)}"
    user_disk_quota="${user_disk_quota:-$(get_compose_env DSH_USER_DISK_QUOTA_BYTES 5)}"
    return 0
  fi

  # 多用户把访问保护方式固定为 password：认证只能有一个来源。
  if [ "$access_mode" != password ]; then
    echo "==> 多用户模式需要内置认证网关承担认证，访问保护方式已改为 password。"
  fi

  # 向导已经问过这三项，按答案落配置；不再画 bash 页面。
  # 答案缺失（向导没进这个分支）时用安全默认值，而不是回落到提问。
  if [ "${DSH_WIZARD_DONE:-}" = true ]; then
    register_gate="${register_gate:-open}"
    idle_timeout="${idle_timeout:-1800}"
    user_disk_quota="${user_disk_quota:-5}"
    echo "==> 多用户模式：注册门槛=${register_gate}，闲置停用=${idle_timeout}s，每用户配额=${user_disk_quota}GB。"
    return 0
  fi

  if [ "$QUICK_INSTALL" = true ]; then
    register_gate="${register_gate:-open}"
    idle_timeout="${idle_timeout:-1800}"
    user_disk_quota="${user_disk_quota:-5}"
    echo "==> 多用户模式：注册门槛=${register_gate}，闲置停用=${idle_timeout}s，每用户配额=${user_disk_quota}GB。"
    return 0
  fi

  ui_next_page
  ui_page_select "注册门槛" 0 \
    "open	开放注册	任何能访问入口的人都可以注册" \
    "invite	需要邀请码	安装结束时会生成一个初始码并显示一次，之后可在管理面板轮换"
  register_gate="$UI_VALUE"

  ui_next_page
  ui_page_select "闲置停用阈值" 0 \
    "1800	30 分钟	默认；实例无活动超过该时长即停用，内存归零、数据保留" \
    "900	15 分钟	更省内存，用户回来的等待更频繁" \
    "3600	60 分钟	更少唤醒，闲置内存占用更久" \
    "0	从不	实例常驻不回收，内存占用最高"
  idle_timeout="$UI_VALUE"

  ui_next_page
  ui_page_select "每用户磁盘配额" 0 \
    "5	5GB	默认" \
    "2	2GB	更省磁盘" \
    "10	10GB	更宽松" \
    "0	不限制	不设上限"
  user_disk_quota="$UI_VALUE"
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
  payload="$(printf '{"brokerBase": %s, "placeholder": %s, "upstreams": [%s], "extraHeaders": {"x-dsh-instance-token": %s}}' \
    "$(json_string "$MODEL_BROKER_BASE")" "$(json_string "$MODEL_BROKER_PLACEHOLDER_KEY")" "$upstreams" \
    "$(json_string "${DSH_ADMIN_BROKER_TOKEN:-}")")"
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
  # 多用户模式的三组开关；单管理员模式下这些键仍然写入，便于重跑向导时回填默认值。
  set_compose_env DSH_MULTI_USER "$PENDING_MULTI_USER" "$PENDING_ENV_FILE"
  set_compose_env DSH_REGISTER_GATE "$PENDING_REGISTER_GATE" "$PENDING_ENV_FILE"
  set_compose_env DSH_IDLE_TIMEOUT_SECONDS "$PENDING_IDLE_TIMEOUT" "$PENDING_ENV_FILE"
  set_compose_env DSH_USER_DISK_QUOTA_BYTES "$PENDING_USER_DISK_QUOTA" "$PENDING_ENV_FILE"
  # 多用户模式必须生成入口↔网关共享密钥：留空时网关的进程内对端校验是 fail-open 的，
  # 任何能连到 dsh-auth 的 dsh-private/dsh-internal 容器都能用被窃取的会话 cookie 换取
  # 身份头（nginx 的 internal 只约束「经由入口」的请求）。已有值则沿用，不覆盖。
  if [ "$PENDING_MULTI_USER" = on ]; then
    ensure_ingress_token "$PENDING_ENV_FILE"
  fi
  # 两种模式都要：管理员的模型请求都经代理，代理一律要求调用者身份。
  # 值已由 resolve_admin_broker_token 解析并导出，这里只负责落盘。
  if [ -n "${DSH_ADMIN_BROKER_TOKEN:-}" ]; then
    set_compose_env DSH_ADMIN_BROKER_TOKEN "$DSH_ADMIN_BROKER_TOKEN" "$PENDING_ENV_FILE"
  fi
}

# 确保 .env 里有 DSH_AUTH_INGRESS_TOKEN。已有非空值就不动（重跑向导不该轮换密钥）。
ensure_ingress_token() {
  local file="${1:-.env}" current
  current="$(awk -F= '$1 == "DSH_AUTH_INGRESS_TOKEN" { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null)"
  if [ -n "$current" ]; then
    return 0
  fi
  if [ ! -r /dev/urandom ]; then
    echo "[警告] 读不到 /dev/urandom，无法生成入口共享密钥。" >&2
    echo "       请手动设置 DSH_AUTH_INGRESS_TOKEN，否则网关的进程内对端校验不生效。" >&2
    return 0
  fi
  set_compose_env DSH_AUTH_INGRESS_TOKEN "$(od -An -tx1 -N24 /dev/urandom | tr -d '[:space:]')" "$file"
  echo "==> 已生成入口↔网关共享密钥（DSH_AUTH_INGRESS_TOKEN 写入 .env）。"
}

# 解析出管理员的模型代理令牌并导出为 DSH_ADMIN_BROKER_TOKEN。
#
# 管理员的模型请求同样经过密钥代理，而代理按调用者身份放行上游，所以管理工作台也
# 需要一枚令牌。网关、安装器与密钥面板三处必须同值：网关用它标识 root，另外两处把
# 它写进 settings.yaml 的请求头。缺了它代理认不出调用者，管理员在自己工作台里发
# 模型请求会被 401 拒掉。
#
# 只解析并导出、不落盘：写模型配置那一步在 .env 提交之前就要用它拼请求头，而落盘
# 统一走 PENDING_ENV_FILE（见 prepare_pending_env），安装失败时 .env 保持原样。
# 已有非空值就沿用（重跑向导不该轮换令牌）。
resolve_admin_broker_token() {
  local file="${1:-.env}" current
  current="${DSH_ADMIN_BROKER_TOKEN:-}"
  if [ -z "$current" ] && [ -f "$file" ]; then
    current="$(awk -F= '$1 == "DSH_ADMIN_BROKER_TOKEN" { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null)"
  fi
  if [ -z "$current" ]; then
    if [ ! -r /dev/urandom ]; then
      echo "[警告] 读不到 /dev/urandom，无法生成管理员模型代理令牌。" >&2
      echo "       请手动设置 DSH_ADMIN_BROKER_TOKEN，否则管理员的模型请求会被代理拒绝。" >&2
      return 0
    fi
    current="$(od -An -tx1 -N32 /dev/urandom | tr -d '[:space:]')"
    echo "==> 已生成管理员模型代理令牌（DSH_ADMIN_BROKER_TOKEN）。"
  fi
  export DSH_ADMIN_BROKER_TOKEN="$current"
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
  local uid attempt exec_err
  # /run/dsh.pid 由 dsh-supervisor 写入：第一行是 PID，第二行是进程启动时刻，
  # 所以只能取第一行，整读会拼出无效的 /proc 路径。
  #
  # 只接受纯数字：runc 在 exec 启动失败时会把错误文本写进 stdout（不只是 stderr），
  # 若不加校验就会把那段错误当成 UID 接收，最终报出「实际为 OCI runtime exec failed...」
  # 这种读不通的话，反而盖住了真正的故障原因。
  uid=""
  exec_err=""
  # 打印一行进度再开始等：容器刚起来时 /run/dsh.pid 可能还没写，这里最长会轮询 2 分钟。
  # 不提示的话，用户看到的是「正在启动 DSH...」之后长时间没有任何输出，像是脚本已经
  # 结束或卡死了——这正是「跑完没日志」的观感来源之一。
  echo "==> 正在等待容器内的 DSH 进程就绪（最多 2 分钟）..."
  for ((attempt = 0; attempt < 120; attempt++)); do
    uid="$(DOCKER exec dsh sh -c 'pid="$(sed -n 1p /run/dsh.pid 2>/dev/null)"; case "$pid" in ""|*[!0-9]*) exit 1 ;; esac; sed -n "s/^Uid:[[:space:]]*\([0-9]*\).*/\1/p" "/proc/$pid/status"' 2>/dev/null || true)"
    case "$uid" in
      '') ;;
      *[!0-9]*) exec_err="$uid"; uid="" ;;   # 运行时报错文本，不是 UID
      *) break ;;
    esac
    # 每 15 秒给一次心跳，让人知道还在等而不是已经结束。
    if [ $((attempt % 15)) -eq 14 ]; then
      echo "    仍在等待容器就绪...（已 $((attempt + 1)) 秒）"
    fi
    sleep 1
  done
  if [ -z "$uid" ]; then
    if [ -n "$exec_err" ]; then
      # 容器已启动但 exec 进不去：这是容器运行时的故障，不是配置问题。
      echo "[错误] 无法在 dsh 容器内执行命令，容器运行时报告：" >&2
      printf '%s\n' "$exec_err" | sed 's/^/       /' >&2
      echo "       容器本身可能是运行中的；请先在宿主上确认：" >&2
      echo "         docker exec dsh true" >&2
      echo "       若同样失败，问题在容器运行时（runc）或宿主内核，与本项目配置无关：" >&2
      echo "       常见原因是宿主为容器化 VPS、宿主内存/进程数耗尽，或 runc 与内核不匹配。" >&2
    else
      echo "[错误] DSH 容器已创建，但无法在 120 秒内核验主进程 UID。" >&2
      echo "       容器可能仍在启动，或 dsh-supervisor 未能写入 /run/dsh.pid；" >&2
      echo "       用 docker logs dsh 查看容器内日志。" >&2
    fi
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
  # blocklist 和 allowlist 是同一套隔离形态：容器不直连外网、出站全经 dsh-egress、宿主
  # 3080 由 dsh-ingress 发布。两者都要核验这条链路。
  [ "$PENDING_EGRESS_MODE" != open ] || return 0
  echo "==> 正在核验出站代理（dsh-egress，模式 $PENDING_EGRESS_MODE）..."
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

# ---------------------------------------------------------------------------
# upgrade：只换镜像，不重问配置
#
# 为什么单独做一个动作：install/configure 见到 dsh 容器就会直接拒绝（那是为了保护
# 容器可写层里 apt 装的东西），而它本身还要把整个向导走一遍；dsh.sh 的 ensure_image
# 只在本地没有那个 tag 时才拉，:latest 拉过一次之后就再也不会更新。于是"发布了新
# 镜像"这件最常做的事以前只能靠删掉重装，代价是会话、插件、项目文件、密钥全丢。
#
# 这条路沿用现有 .env，一个问题都不问，data/ 与 workspace/ 全程不动。
# ---------------------------------------------------------------------------

# 从 .env 反推出本次要用的配置。upgrade 不走问答，所以 PENDING_* 只能从落盘的配置
# 读回来——set_compose_args 和后面那几个核验函数读的都是这些变量。
load_upgrade_config() {
  PENDING_ACCESS_MODE="$(get_compose_env DSH_ACCESS_MODE local)"
  PENDING_BIND_HOST="$(get_compose_env DSH_BIND_HOST 127.0.0.1)"
  PENDING_TRUSTED_HOSTS="$(get_compose_env DSH_TRUSTED_HOSTS '')"
  PENDING_NETWORK="$(get_compose_env DSH_DOCKER_NETWORK dsh-private)"
  PENDING_NETWORK_EXTERNAL="$(get_compose_env DSH_DOCKER_NETWORK_EXTERNAL false)"
  PENDING_IMAGE_SOURCE="${IMAGE_SOURCE_OVERRIDE:-$(get_compose_env DSH_IMAGE_SOURCE prebuilt)}"
  case "$PENDING_IMAGE_SOURCE" in prebuilt|build) ;; *) PENDING_IMAGE_SOURCE=prebuilt ;; esac
  if [ -n "$IMAGE_OVERRIDE" ]; then
    PENDING_IMAGE="$IMAGE_OVERRIDE"
  elif [ "$PENDING_IMAGE_SOURCE" = build ]; then
    PENDING_IMAGE="$(get_compose_env DSH_IMAGE "$DEFAULT_LOCAL_IMAGE")"
  else
    PENDING_IMAGE="$(get_compose_env DSH_IMAGE "$DEFAULT_PREBUILT_IMAGE")"
  fi
  PENDING_MODEL_BROKER="$(get_compose_env DSH_MODEL_BROKER off)"
  case "$PENDING_MODEL_BROKER" in on|off) ;; *) PENDING_MODEL_BROKER=off ;; esac
  PENDING_KEY_ADMIN="$(get_compose_env DSH_KEY_ADMIN off)"
  case "$PENDING_KEY_ADMIN" in on|off) ;; *) PENDING_KEY_ADMIN=off ;; esac
  PENDING_KEY_ADMIN_BIND_HOST="$(get_compose_env DSH_KEY_ADMIN_BIND_HOST "$DEFAULT_KEY_ADMIN_BIND_HOST")"
  PENDING_KEY_ADMIN_PORT="$(get_compose_env DSH_KEY_ADMIN_HOST_PORT "$DEFAULT_KEY_ADMIN_PORT")"
  PENDING_EGRESS_MODE="$(get_compose_env DSH_EGRESS_MODE open)"
  case "$PENDING_EGRESS_MODE" in open|blocklist|allowlist) ;; *) PENDING_EGRESS_MODE=open ;; esac
  # 黑白名单之间的切换是在密钥管理面板里做的，那时 .env 不跟着变。以策略文件为准，
  # 否则一次升级就会把面板里的选择悄悄改回 .env 里那个旧值。
  if [ "$PENDING_EGRESS_MODE" != open ]; then
    case "$(egress_policy_mode)" in
      blocklist) PENDING_EGRESS_MODE=blocklist ;;
      allowlist) PENDING_EGRESS_MODE=allowlist ;;
    esac
  fi
  PENDING_EGRESS_ALLOWED_HOSTS="$(get_compose_env DSH_EGRESS_ALLOWED_HOSTS '')"
}

# 镜像身份：ID 用来判断"这次到底有没有换"，RepoDigest 是发布侧的唯一标识。
# 本机构建的镜像没有 RepoDigest，那时第二个函数返回空串，调用方按空处理。
dsh_image_id() {
  DOCKER image inspect --format '{{.Id}}' "$1" 2>/dev/null | sed -n 1p || true
}

dsh_image_digest() {
  DOCKER image inspect --format '{{ if .RepoDigests }}{{ index .RepoDigests 0 }}{{ end }}' "$1" 2>/dev/null | sed -n 1p || true
}

upgrade_compose_up() {
  (
    unset DSH_ACCESS_MODE DSH_BIND_HOST DSH_TRUSTED_HOSTS
    unset DSH_DOCKER_NETWORK DSH_DOCKER_NETWORK_EXTERNAL DSH_IMAGE DSH_IMAGE_SOURCE
    unset DSH_MODEL_BROKER DSH_MODEL_BROKER_BASE DSH_EGRESS_MODE DSH_EGRESS_ALLOWED_HOSTS
    unset DSH_KEY_ADMIN DSH_KEY_ADMIN_BIND_HOST DSH_KEY_ADMIN_HOST_PORT
    # --remove-orphans：关掉密钥面板、或者从隔离模式退回 open 之后，上一份配置起的
    # 旁路容器会变成孤儿一直挂着。-f 组合是按当前 .env 算出来的，所以不会误删。
    DOCKER compose --env-file .env "${COMPOSE_ARGS[@]}" up -d --no-build --force-recreate --remove-orphans
  )
}

# 升级会留下的 Docker 垃圾，按类精确回收。
#
# 刻意不用 docker system prune、也不用不带过滤的 image prune：那两条会把宿主上别的
# 项目一起清掉。下面每一条都用 Compose 项目标签或镜像自己的 OCI 标签收窄到本项目。
prune_project_leftovers() {
  local project_name ids id
  project_name="$(DOCKER inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' dsh 2>/dev/null || true)"
  case "$project_name" in ''|'<no value>') project_name=dsh-docker ;; esac
  echo "==> 正在回收升级留下的 Docker 垃圾（只动本项目的东西）..."

  # 1) 悬空镜像。拉到新的 :latest 之后旧的那一份会丢掉标签变成 <none>，而它仍然带着
  #    镜像自己的 OCI 标签，所以能精确回收而不碰宿主上别人的悬空镜像。旧容器已经被
  #    上一步的 --force-recreate 删掉了，这时才真的删得动。
  DOCKER image prune -f --filter 'label=org.opencontainers.image.title=dsh-docker' >/dev/null 2>&1 || true
  # 更老的镜像可能没有那个 LABEL（早期 Dockerfile 还没加），按项目标签再扫一遍。
  ids="$(DOCKER image ls -q --filter dangling=true --filter "label=com.docker.compose.project=$project_name" 2>/dev/null | sort -u || true)"
  while IFS= read -r id; do
    [ -n "$id" ] && DOCKER image rm "$id" >/dev/null 2>&1 || true
  done <<< "$ids"

  # 2) 构建缓存。只有本机构建这条路才会产生它；不加 -a，当前镜像还在用的层要留着，
  #    否则下一次构建等于从零开始。
  if [ "$PENDING_IMAGE_SOURCE" = build ]; then
    DOCKER builder prune -f >/dev/null 2>&1 || true
  fi

  # 3) 本项目已经退出的容器。--force-recreate 会顺手删掉被替换的那几个，但更早的失败
  #    尝试可能留下 created / exited / dead 状态的残骸。
  ids="$(DOCKER container ls -aq --filter "label=com.docker.compose.project=$project_name" \
    --filter status=created --filter status=exited --filter status=dead 2>/dev/null | sort -u || true)"
  while IFS= read -r id; do
    [ -n "$id" ] && DOCKER container rm -f "$id" >/dev/null 2>&1 || true
  done <<< "$ids"

  # 4) 本项目的悬空卷。当前部署全是 bind mount，所以这里只会捞到历史遗留。
  ids="$(DOCKER volume ls -q --filter dangling=true --filter "label=com.docker.compose.project=$project_name" 2>/dev/null || true)"
  while IFS= read -r id; do
    [ -n "$id" ] && DOCKER volume rm "$id" >/dev/null 2>&1 || true
  done <<< "$ids"

  # 5) 没有容器再接着的本项目网络。从隔离模式切回 open 之后 dsh-internal 就是这样。
  #    外部网络（比如面板那张 dpanel-local）不带本项目标签，不会被选中。
  ids="$(DOCKER network ls -q --filter "label=com.docker.compose.project=$project_name" 2>/dev/null || true)"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if [ "$(DOCKER network inspect --format '{{ len .Containers }}' "$id" 2>/dev/null || echo 1)" = 0 ]; then
      DOCKER network rm "$id" >/dev/null 2>&1 || true
    fi
  done <<< "$ids"

  # 6) 崩掉的历史运行留在工程目录里的临时 .env。只删一天以前的，避免碰到另一个正在
  #    跑的安装器自己那一份。
  find . -maxdepth 1 -name '.env.pending.*' -type f -mtime +0 -delete 2>/dev/null || true
}

print_upgrade_summary() {
  local before_digest="$1" after_digest="$2"
  echo
  echo "==> 升级完成，配置和数据都没有被改动："
  echo "    .env：沿用（本次只补写 DSH_IMAGE_DIGEST）"
  echo "    会话 data/dsh/sessions、插件 data/dsh/profiles、项目 workspace/：原样保留"
  echo "    模型密钥 data/broker/keys.json、root 密码哈希 data/secret/root.hash：原样保留"
  echo "    工具链 data/home（npm / pnpm / pip / uv 装的东西）：原样保留"
  if [ -n "$after_digest" ]; then
    if [ -n "$before_digest" ] && [ "$before_digest" != "$after_digest" ]; then
      echo "    镜像：$before_digest"
      echo "      -> $after_digest"
    else
      echo "    镜像：$after_digest"
    fi
  else
    echo "    镜像：$PENDING_IMAGE（本机构建，没有发布摘要）"
  fi
  echo
  echo "    apt 装的系统包在容器可写层，重建容器会丢，需要的话重新 apt install 一次。"
  echo "    工程文件（docker-compose*.yml、install.sh、dsh.sh）这次没有动：升级只换镜像。"
  echo "    发布说明提到 Compose 有变化时，先在工程目录里 git pull --ff-only 再升级一次。"
  DOCKER system df 2>/dev/null || true
}

upgrade_dsh() {
  local before_id after_id before_digest after_digest
  if [ ! -f .env ]; then
    echo "[错误] $(pwd) 里没有 .env，说明这里还没有装过 DSH；请先在向导里选择安装。" >&2
    exit 1
  fi
  load_upgrade_config
  set_compose_args
  before_id="$(dsh_image_id "$PENDING_IMAGE")"
  before_digest="$(dsh_image_digest "$PENDING_IMAGE")"
  echo "==> 沿用 .env 里的现有配置，不会重问："
  echo "    镜像：$PENDING_IMAGE（来源 $PENDING_IMAGE_SOURCE）"
  echo "    访问模式：$PENDING_ACCESS_MODE，宿主端口绑定 $PENDING_BIND_HOST:3080"
  echo "    密钥代理：$PENDING_MODEL_BROKER，管理面板：$PENDING_KEY_ADMIN，出站模式：$PENDING_EGRESS_MODE"

  if [ "$PENDING_IMAGE_SOURCE" = prebuilt ]; then
    echo "==> 正在拉取镜像：$PENDING_IMAGE"
    if ! pull_dsh_image; then
      echo "[错误] 拉取失败。容器没有被改动，现有部署照旧运行。" >&2
      exit 1
    fi
  else
    echo "==> 正在用当前工程的 Dockerfile 重新构建镜像：$PENDING_IMAGE"
    if ! build_dsh_image; then
      echo "[错误] 构建失败。容器没有被改动，现有部署照旧运行。" >&2
      exit 1
    fi
  fi

  after_id="$(dsh_image_id "$PENDING_IMAGE")"
  after_digest="$(dsh_image_digest "$PENDING_IMAGE")"
  if [ -n "$before_id" ] && [ "$before_id" = "$after_id" ]; then
    echo "==> 镜像已经是最新的（没有变化），仍然重建容器以套用当前 .env。"
  fi

  echo "==> 正在重建容器（挂载数据、会话、插件、密钥全部保留）..."
  if ! upgrade_compose_up; then
    echo "[错误] 容器重建失败。.env 未被改动，用 ./dsh.sh logs 查看原因。" >&2
    exit 1
  fi
  # 记下这次真正跑起来的镜像摘要，下一次升级就能直接对比出换没换。
  [ -z "$after_digest" ] || set_compose_env DSH_IMAGE_DIGEST "$after_digest"
  assert_dsh_hardening
  assert_model_broker
  assert_key_admin
  assert_egress_isolation
  prune_project_leftovers
  print_upgrade_summary "$before_digest" "$after_digest"
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
    echo "      容器里的 Agent 用占位密钥仍可发起请求，因此建议在密钥管理面板里给每个上游"
    echo "      设置请求限额（每分钟上限 / 每日配额），并按需启用出站黑名单或白名单。"
  else
    echo "    模型密钥代理: 关（密钥若写进容器内的配置或环境，容器里的 Agent 一条 cat 就能读到）"
  fi
  print_key_admin_access
  print_multiuser_summary
  case "$PENDING_EGRESS_MODE" in
    allowlist)
      echo "    出站模式: allowlist（dsh 不直连外网，出站只经过 dsh-egress；宿主 3080 由 dsh-ingress 发布）"
      if [ -n "$PENDING_EGRESS_ALLOWED_HOSTS" ]; then
        echo "    白名单: 内置白名单 + 自定义 $(printf '%s' "$PENDING_EGRESS_ALLOWED_HOSTS" | awk -F, '{ print NF }') 条（DSH_EGRESS_ALLOWED_HOSTS）"
      else
        echo "    白名单: 仅内置白名单（Debian / npm / PyPI / GitHub / ghcr.io / nodejs.org / astral.sh）"
      fi
      echo "    清单可在密钥管理面板的「容器出站策略」里改，改完 5 秒生效"
      ;;
    blocklist)
      echo "    出站模式: blocklist（dsh 不直连外网，出站只经过 dsh-egress；宿主 3080 由 dsh-ingress 发布）"
      echo "    黑名单: 内置的一键公网隧道域名清单，其余域名默认放行"
      echo "    清单和模式可在密钥管理面板的「容器出站策略」里改，改完 5 秒生效"
      ;;
    *)
      echo "    出站模式: open（容器可访问任意外网地址，出站流量不做域名限制）"
      ;;
  esac
}

# 多用户模式的收尾说明。把「谁来管理、入口在哪、邀请码是什么、怎么运维」一次讲清，
# 否则装完只剩一个登录页，管理员不知道下一步该做什么。
print_multiuser_summary() {
  local invite_code_file="data/auth/invite-code" entry_port="${DSH_HTTP_PORT:-3080}"
  local initial_password_file="data/auth/initial-password"

  # password 模式：认证由网关承担，先把「从哪进、拿什么登录」讲清楚。
  if [ "$PENDING_ACCESS_MODE" = password ]; then
    echo "    访问认证: password 模式（dsh-auth 认证网关 + 七层入口，容器内不做认证）"
    echo "      入口: http://$PENDING_BIND_HOST:$entry_port（经网关判定后转发到工作台）"
    if [ -s "$initial_password_file" ]; then
      echo "      root 初始口令: $(cat "$initial_password_file")"
      echo "        （只显示这一次；登录后请到 $PENDING_BIND_HOST:$entry_port/account 修改密码）"
    else
      echo "      root 口令: 沿用已有配置（未重新生成）"
    fi
    echo "      账户安全页: http://$PENDING_BIND_HOST:$entry_port/account"
    echo "        可改密码、开启两步验证（TOTP，含恢复码）、添加通行密钥、查看并吊销登录会话。"
    if [ "$PENDING_MULTI_USER" != on ]; then
      echo "      单管理员模式: 不开放注册、不含用户管理面板；登录后直接进入工作台。"
    fi
    [ -z "${DSH_PUBLIC_ORIGIN:-}" ] && \
      echo "      提示: 未设置 DSH_PUBLIC_ORIGIN，通行密钥（Passkey）已自动禁用（需要固定 HTTPS 域名）。"
  fi

  [ "$PENDING_MULTI_USER" = on ] || return 0

  echo "    多用户模式: 开（开放注册 + 每用户独立 DSH 实例，会话与文件按账户隔离）"
  echo "      组件: dsh-auth（认证网关）、dsh-instances（持有 docker.sock 的实例编排）、"
  echo "            dsh-ingress（七层入口，按会话身份把请求转发到对应用户实例）"
  echo "      注册门槛: $PENDING_REGISTER_GATE"
  if [ "$PENDING_REGISTER_GATE" = invite ] && [ -s "$invite_code_file" ]; then
    echo "      初始邀请码: $(cat "$invite_code_file")（单次有效，用掉后可在管理面板里换一个）"
  fi
  echo "      闲置停用: ${PENDING_IDLE_TIMEOUT}s（0 表示不回收）；每用户磁盘配额: ${PENDING_USER_DISK_QUOTA}GB（0 表示不限制）"
  echo "      每实例内存上限: ${DSH_INSTANCE_MEMORY_MB:-200}MB"
  echo "      管理面板: http://$PENDING_BIND_HOST:$entry_port/admin（仅初始管理员可访问）"
  echo "      账户数据: data/users/<uid>/（属主为该实例 uid；删除账户可在管理面板里连带清理）"
  echo "      注意: 实例被闲置停用后，用户再次访问会看到等待页并自动拉起，通常需要 10–30 秒。"
  return 0
}

# 一键安装结束时单独打印的一块：访问入口 + 本次随机生成的凭据（只回显这一次）。
# 显式传入的密码（命令行 / 环境变量）不回显——那是用户自己管着的值。
print_quick_summary() {
  [ "$QUICK_INSTALL" = true ] || return 0
  echo
  print_banner
  echo "  已按一键默认值完成：$PENDING_ACCESS_MODE 认证 + 无密钥代理 + 出站 open"
  echo
  echo "  ┌─────────────────────────────────────────────"
  echo "  │ 访问入口   http://$PENDING_BIND_HOST:3080"
  if [ "$PENDING_ACCESS_MODE" = basic ]; then
    echo "  │ 登录用户名 ${GENERATED_BASIC_USER:-$PENDING_BASIC_USER}"
    if [ -n "$GENERATED_BASIC_PASSWORD" ]; then
      echo "  │ 登录密码   $GENERATED_BASIC_PASSWORD（只显示这一次）"
    else
      echo "  │ 登录密码   沿用已有的 Basic Auth 凭据（未改动）"
    fi
  fi
  if [ -n "$GENERATED_ROOT_PASSWORD" ]; then
    echo "  │ 容器 root  $GENERATED_ROOT_PASSWORD（只显示这一次）"
  fi
  echo "  └─────────────────────────────────────────────"
  echo "  找回入口：重新运行 install.sh（有 TTY 时选「自定义配置」）即可查看或重设。"
  echo "  提示：本机 Basic Auth 走 HTTP，公网请务必前置 HTTPS（CDN / 反代）后再暴露。"
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
  # 面板地址与令牌必须在 assert 之前打印：assert 失败会 return/exit，把它们之后的
  # 输出全部跳过。上面刚调过 write_key_admin_token，令牌可能是这一轮新生成的——
  # 只回显这一次，被跳过就只能自己去 data/broker/admin.token 里翻。
  print_key_admin_access
  assert_model_broker
  assert_key_admin
  echo
  # 与 install 路径同理：请求头里的令牌要先就位，配置才写得对。
  resolve_admin_broker_token
  seed_dsh_model_settings "$(node_tool_image)"
  echo "==> 密钥代理已就绪。DSH 的 settings.yaml 与 .credentials.yaml 都是热加载的，"
  echo "    刷新一下 WebUI 就能在「设置 → 模型」里看到这些供应商，密钥框里是占位串。"
  echo "    容器内那份 skill 文档上的 DSH_MODEL_BROKER 仍显示安装时的值，要等下次重建容器"
  echo "    才会刷新——那只是说明文字，不影响代理生效。"
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
  # 面板地址与令牌必须在 assert 之前打印：assert 失败会 exit，把它们之后的输出
  # 全部跳过。上面刚调过 write_key_admin_token，令牌可能是这一轮新生成的——
  # 只回显这一次，被跳过就只能自己去 data/broker/admin.token 里翻。
  print_key_admin_access
  assert_model_broker
  assert_key_admin
  echo
  echo "==> 面板已就绪。在页面上保存上游后它会直接写 data/dsh/settings.yaml 与"
  echo "    .credentials.yaml，DSH 热加载这两份文件，刷新 WebUI 就能在「设置 → 模型」里选到。"
}

cleanup_pending_env() {
  [ -z "$PENDING_ENV_FILE" ] || rm -f "$PENDING_ENV_FILE"
}
# 这个 trap 在向导之后才安装，会覆盖 ui_raw_on 装的还原 trap。所以它自己也要负责
# 还原终端：否则安装中途出错（set -e）会把用户留在无回显、无光标的备用屏幕里。
trap 'ui_term_restore; cleanup_pending_env' EXIT

# 维护类动作（启动/停止/日志/状态/更新/卸载等）没有后续向导页，它们的输出必须落在
# 普通终端上。install/configure 不在这里还原：configure_dsh 与 confirm_install_plan
# 还有十余页向导，提前还原会让第二页起退回成日志输出。
case "$ACTION" in
  install|configure) ;;
  *) ui_term_restore ;;
esac

# 准备阶段：取源码、进入工程目录、装配配置。
#
# 单独成函数是因为两条路径对它的位置要求不同：
#   向导路径：向导已经问完并确认过，这三步与执行阶段连续放进同一个滚动日志；
#   命令行路径：确认页要展示配置结果，所以必须先做完这几步再确认。
# 留在主流程里会让向导路径的同一次安装被切成两段体验——先是一段裸输出的克隆进度，
# 再进滚动日志视图。
install_prepare_body() {
  # 容器已存在时不做隐式重建：容器里可能装着 apt 装过的工具链与手工修改，重建会
  # 全部丢掉。这条判断放在最前，避免克隆完才发现装不了。
  if container_exists; then
    echo "[错误] dsh 容器已经存在；为保护容器内 apt 软件和系统修改，安装器不会隐式重建它。"
    echo "       使用 ./dsh.sh start|restart 管理现有容器；如需全新系统，请明确执行 ./dsh.sh remove 后再安装。"
    echo "       要更新、卸载或做其它维护，重新运行安装命令，在主菜单里选「更新」或「卸载」。"
    return 1
  fi

  fetch_project
  cd "$TARGET_DIR" || { echo "[错误] 无法进入工程目录：$TARGET_DIR"; return 1; }
  chmod +x dsh.sh 2>/dev/null || true
  # 数据目录的属主对齐必须在 cd 之后：它们是相对路径，在脚本顶层执行会落到
  # 调用者的当前目录（curl | bash 时是 $HOME），工程里那份反而保持 root 属主，
  # 于是 dsh-auth 以 UID 1000 启动后写不了 /data/auth，容器陷入重启循环。
  align_writable_data_dirs
  # 装配 PENDING_* 与 COMPOSE_ARGS。向导已经把答案交过来了，这一步不再提问。
  configure_dsh
}

# 执行阶段：拉镜像、写配置、起容器、自检、打印摘要。
install_execute_body() {
  obtain_dsh_image
  write_basic_auth
  write_root_password
  discover_broker_models "$PENDING_IMAGE"
  write_broker_config
  write_key_admin_token
  write_egress_policy
  # 管理员令牌要在写模型配置之前就位：那份 settings.yaml 的请求头里带着它，
  # 而配置只写一次，之后再生成就对不上授权表里的摘要了。
  resolve_admin_broker_token
  seed_dsh_model_settings "$PENDING_IMAGE"
  prepare_pending_env
  echo "==> 正在启动 DSH..."
  if ! compose_up_with_pending_env; then
    echo "[错误] DSH 容器启动失败，原配置未被覆盖。" >&2
    return 1
  fi
  mv "$PENDING_ENV_FILE" .env
  PENDING_ENV_FILE=""
  # 面板地址与访问令牌必须在这里打印：它是浏览器里填密钥的唯一入口，
  # 装完不告诉用户地址和令牌，密钥面板就等于不存在（密钥本体不在终端里收集，
  # 全部在面板里填）。此前只在 model-key / key-panel 路径打印，install 漏了。
  #
  # 位置必须在下面那组 assert **之前**：那些 assert 失败会 return 1，把它们之后
  # 的输出全部跳过。容器此刻已经起来、.env 也已提交，访问信息已经是既成事实，
  # 不该因为一项校验没过就不告诉用户——令牌只回显这一次，错过就得自己去
  # data/broker/admin.token 里翻。
  print_key_admin_access
  assert_dsh_hardening
  assert_model_broker
  assert_key_admin
  assert_egress_isolation
  # ./dsh.sh remove 之后重装是常见路径，那会留下失去标签的旧镜像和退出的旁路容器。
  prune_project_leftovers
  print_config_summary
  print_quick_summary
}

# 生成执行视图完成后固定显示的内容（写入 summary 文件）。
#
# 由 EXIT trap 调用，所以成功与失败都会写：失败路径上函数会直接 exit，
# 放在正文末尾的写法会被跳过，用户就看不到「装到哪一步失败的」。
#
# 内容包含三部分：从日志里摘出的关键信息（面板地址、令牌等只有跑完才知道）、
# 访问入口、以及日志文件路径。输出到页面之外的信息越少越好——TUI 退出后画面就没了，
# 打在页外的东西用户往往已经滚过。
write_exec_summary() {
  local rc="$1"
  [ -n "$summaryfile" ] || return 0
  {
    grep -E '模型密钥面板|访问令牌|密钥代理:|访问保护:|多用户模式|出站模式' "$logfile" 2>/dev/null || true
    if [ "$rc" = 0 ]; then
      printf '本机入口: http://%s:%s\n' "${PENDING_BIND_HOST:-127.0.0.1}" "${DSH_HOST_PORT:-3080}"
    else
      printf '安装未完成（退出码 %s）\n' "$rc"
    fi
    printf '完整日志: %s\n' "$logfile"
  } > "$summaryfile" 2>/dev/null || true
}

# 执行阶段的外壳：把执行本体放到后台跑，再由 Go 界面承载向导与日志。
#
# 为什么要后台跑：向导与执行视图现在是**同一个** Go 程序（见 cmd/dsh-installer/root.go），
# 它启动时向导还没有答案，无从启动执行；而执行又必须在用户确认之后才开始。所以
# 执行体先进后台阻塞着，等 Go 在向导确认后打开 FIFO 放行——那是「答案已落盘」与
# 「开始执行」之间的同步点，用 FIFO 而不是信号或轮询，是为了让顺序由内核保证。
#
# 参数：
#   --prepared        调用方已经跑过准备阶段（命令行路径要在确认页之前完成它）
#   --guided          本次带向导：Go 需要 --run-gate，答案文件由 Go 写
#   --answers PATH    向导写答案的文件（--guided 时必给）
#   --already-released 门闸已经放行过（调用方自己写的），Go 直接进执行视图
# 后台执行体：等门闸 → 读答案 → 准备 → 执行 → 写结束标记与摘要。
#
# 为什么由它自己读答案：答案文件在**界面**里写（向导确认那一刻），而本函数所在的
# 子 shell 是界面启动之前就 fork 好的——父 shell 那时还没有答案可读。门闸放行后
# 文件必然已就位，此时读最合适；顺带把 DSH_WIZARD_DONE 也设在子 shell 里，
# configure_dsh 等函数据此跳过提问（否则向导问过的问题会被再问一遍）。
#
# 结束标记与摘要都必须在 EXIT trap 里写：函数内部有 exit（例如取源码失败）、
# 脚本开头是 set -e，都会跳过正文末尾的语句。界面靠标记判断收尾、不靠 EOF，
# 漏写会让它一直等下去。
dsh_exec_body() {
  local answers="$1" gate="$2" already_prepared="$3"
  trap 'rc=$?; printf "%s:%s\n" "$sentinel" "$rc"; write_exec_summary "$rc"' EXIT
  # 等界面放行。读不到（写端提前消失）时不阻塞，直接往下走。
  if [ -n "$gate" ]; then
    read -r _ < "$gate" || true
  fi
  # 只有向导路径才有答案文件。命令行路径的答案来自 argv，父 shell 已经把它解析成
  # 各种 _OVERRIDE 变量了，本子 shell 直接继承；这里若去读一个空文件，反而会把
  # DSH_WIZARD_DONE 置成 true，让 install_execute_body 里的提问全部静默跳过。
  if [ -n "$answers" ]; then
    dsh_installer_read_answers "$answers" || true
  fi
  # 只有安装与重配有「执行」这件事。其余动作（启动、停止、卸载、密钥面板…）
  # 由主 shell 在界面退出后处理，这里立刻收工。
  case "${ACTION:-}" in
    install|configure) ;;
    *) return 0 ;;
  esac
  if [ "$already_prepared" != true ]; then
    install_prepare_body || exit $?
  fi
  install_execute_body
}

# 放行门闸：往 FIFO 写一行，让阻塞在 read 上的执行体继续。
#
# 用 `exec 9<>` 而不是 `printf > "$gate"`：后者的写端 open() 在没有读端时会**永久
# 阻塞**，而补放行恰恰发生在这种状态——执行体可能已经读完并退出（例如它判定本轮
# 不需要执行、直接 return，用户选「卸载」就是这种情况），此时 FIFO 已无读端，
# 整个安装脚本就卡死在这一行上。以读写方式打开则不阻塞：进程自身就是读端。
gate_release() {
  local gate="${1:-}"
  [ -n "$gate" ] && [ -p "$gate" ] || return 0
  exec 9<>"$gate" 2>/dev/null || return 0
  printf '\n' >&9 2>/dev/null || true
  exec 9>&- 2>/dev/null || true
}

# 执行阶段的外壳：执行本体在后台等门闸，界面由 Go 承载（可能含向导）。
#
# 参数：
#   --prepared   调用方已跑过准备阶段（命令行路径要在确认页之前完成它）
#   --guided     本次带向导，门闸交由界面在确认后放行
#   --answers=P  答案文件（--guided 时界面写它，子 shell 读它）
run_install_execution() {
  local bin logfile summaryfile sentinel status answers gate=""
  local already_prepared=false guided=false
  for arg in "$@"; do
    case "$arg" in
      --prepared) already_prepared=true ;;
      --guided) guided=true ;;
      --answers=*) answers="${arg#--answers=}" ;;
    esac
  done

  # 先判断要不要 TUI，再决定去不去找二进制。
  # 顺序很重要：dsh_installer_path 在缓存缺失时会联网下载，而 --non-interactive
  # 根本用不到 TUI——为它去下载一个几 MB 的二进制既浪费又可能卡住（CI、受限网络下
  # 表现为安装器挂起）。无终端时同样直接走普通输出。
  if [ "${DSH_NO_EXEC_VIEW:-}" = 1 ] || [ "$UI_TUI" != true ] || [ "$INTERACTIVE" != true ]; then
    if [ "$guided" = true ]; then
      # 向导仍然要跑（Go 界面自己会进备用屏幕，TERM=dumb 时它会退化成最简渲染），
      # 只是执行阶段不留视图：这样「不显示执行视图」的开关只影响显示，不影响交互。
      # 没有 --watch-log，界面收完答案就退出，随后由 bash 正常执行安装。
      bin="$(dsh_installer_path 2>/dev/null || true)"
      if [ -n "$bin" ]; then
        "$bin" --answers-file "$answers" --dir "$TARGET_DIR" < /dev/tty || {
          status=$?
          [ "$status" = 3 ] && exit 0
          return "$status"
        }
        dsh_installer_read_answers "$answers" || true
      fi
      if [ "$already_prepared" != true ]; then
        install_prepare_body || return $?
      fi
      install_execute_body
      return $?
    fi
    if [ "$already_prepared" != true ]; then
      install_prepare_body || return $?
    fi
    install_execute_body
    return $?
  fi

  # 只有真要显示 TUI 时才找二进制。
  #
  # 向导路径下找不到就**失败**，不像执行视图那样退回普通输出：向导是唯一入口，
  # 没有它就没有答案，退回普通输出也无从继续（无终端守卫已排除无人值守场景）。
  bin="$(dsh_installer_path 2>/dev/null || true)"
  if [ -z "$bin" ]; then
    if [ "$guided" = true ]; then
      # 向导是唯一入口：没有它就收集不到答案，退回普通输出也无从继续。
      dsh_installer_missing_help
      return 1
    fi
    if [ "$already_prepared" != true ]; then
      install_prepare_body || return $?
    fi
    install_execute_body
    return $?
  fi

  logfile="$(mktemp "${TMPDIR:-/tmp}/dsh-exec-XXXXXX.log")" || {
    if [ "$already_prepared" != true ]; then
      install_prepare_body || return $?
    fi
    install_execute_body
    return $?
  }
  summaryfile="$(mktemp "${TMPDIR:-/tmp}/dsh-summary-XXXXXX.txt")" || summaryfile=""
  sentinel="__DSH_EXEC_DONE__"
  # dsh_exec_body 在子 shell 里要用到这两个名字，导出给它是显式声明依赖。
  export sentinel summaryfile logfile

  # 门闸是「答案已落盘」与「开始执行」之间的同步点，用 FIFO 而不是信号或轮询，
  # 是为了让顺序由内核保证：写端打开会一直阻塞到有读端，所以执行体必然在答案
  # 写好之后才开始读它。
  #
  # 用 mktemp -u 再 mkfifo，而不是 mktemp：mktemp 建的是普通文件，写进去不阻塞，
  # 也就起不到同步作用。
  gate="$(mktemp -u "${TMPDIR:-/tmp}/dsh-exec-gate-XXXXXX")"
  if ! mkfifo "$gate" 2>/dev/null; then
    echo "[错误] 无法创建执行门闸（$gate）。" >&2
    rm -f "$logfile" "$summaryfile"
    return 1
  fi

  # 执行本体在后台跑，输出重定向进日志文件；界面只读这个文件。
  # 用文件而不是管道：管道会占住 stdout，且执行结束后内容就没了；文件还能回看。
  ( dsh_exec_body "${answers:-}" "$gate" "$already_prepared" ) >>"$logfile" 2>&1 &
  local body_pid=$!

  # 命令行路径没有向导，门闸没人会开，所以由 bash 自己放行。放在后台启动**之后**：
  # 先开写端会在没有读端时阻塞在这里，而执行体还没起来。
  if [ "$guided" != true ]; then
    gate_release "$gate"
  fi

  # 向导与执行视图在同一个程序里，全程只进出一次备用屏幕。
  #
  # --run-gate 只在带向导时传：界面靠它判断「这里有向导要翻」。命令行路径没有向导，
  # 门闸由上面那行 bash 自己放行，界面一进来就该是执行视图——多传一个门闸会让它
  # 以为要先翻页，于是停在一个空的向导首页上等输入。
  local -a ui_args=(--dir "$TARGET_DIR")
  if [ "$guided" = true ]; then
    ui_args+=(--answers-file "$answers" --run-gate "$gate")
  fi
  ui_args+=(--watch-log "$logfile" \
    --watch-summary-file "${summaryfile:-/dev/null}" \
    --watch-sentinel "$sentinel" --watch-title "安装 DSH")

  "$bin" "${ui_args[@]}" < /dev/tty
  status=$?

  # 退出码 2 是参数错误。最常见的原因是版本错配：install.sh 取自 main 分支，而
  # 二进制来自 Release——Release 若还是旧提交构建的，就不认识本次新传的参数
  #（例如 --run-gate），只会回一句「未知参数」。
  #
  # 清缓存解决不了：缓存名里的摘要取自 Release 自己的 SHA256SUMS，描述的正是那个
  # 旧二进制，清掉也只会重新下载到同一份。要换二进制只能重新发布（Actions 的
  # build-installer），或直接用 DSH_INSTALLER_BIN 指一份匹配的。
  if [ "$status" = 2 ]; then
    echo "[错误] 向导程序不认识本次传入的参数，通常是二进制与脚本版本不一致。" >&2
    echo "       这份二进制来自 Release，若它落后于脚本，请重新发布安装器，" >&2
    echo "       或指定一份匹配的二进制：DSH_INSTALLER_BIN=/path/to/dsh-installer bash install.sh" >&2
  fi

  # 界面半路失败时不会去放行（例如向导还没确认就 Ctrl+C 了），这里补一次，
  # 否则 wait 会永远挂住——执行体现在正阻塞在门闸上。
  #
  # 必须用 gate_release 而不是 `printf > "$gate"`：执行体可能**已经**读完并退出了
  #（例如它判定本轮不需要执行、直接 return），此时 FIFO 没有读端，
  # 普通写端 open() 会永久阻塞，整个安装就卡死在这里。
  gate_release "$gate"
  wait "$body_pid" 2>/dev/null || true
  rm -f "$gate"

  # 失败时不再往终端打整段日志：那些内容已经在执行视图的滚动区里给用户看过，
  # 而备用屏幕退出时会整屏还原，现在再打一遍既重复又是「跑到终端行里」的输出。

  # 摘要临时文件用完即删（日志文件保留，供用户回看或上报）。
  [ -n "$summaryfile" ] && rm -f "$summaryfile"
  return "$status"
}

# 交互路径的完整会话：先把界面需要的答案/日志/门闸备齐，再起一次 Go 程序，
# 由它承载「翻页向导 → 原地切到执行视图」的全过程。
#
# 为什么整段放在脚本末尾：后台执行子 shell 要用到 install_prepare_body 等函数，
# 而 bash 是边读边执行的，脚本中途 fork 出的子 shell 看不到后面才定义的函数。
run_guided_session() {
  local answers status
  # 向导的 stdin 显式指向控制终端。
  #
  # Bubble Tea 自身会处理 stdin 非终端的情况（检测到就把输入切到 /dev/tty），所以
  # 这里不是修 bug，而是两点明确的意图：
  #   1. 不依赖框架的隐式回退——管道留给 bash，终端留给向导，归属写清楚；
  #   2. 没有控制终端时立刻失败并给出无人值守的出路，而不是让向导在无 TTY 时报一句
  #      难以理解的框架错误。
  if [ ! -c /dev/tty ] || ! { : < /dev/tty; } 2>/dev/null; then
    echo "[错误] 向导需要控制终端，但 /dev/tty 不可用。" >&2
    echo "       在终端里运行不应出现这条提示；若通过 CI/管道调用，请改用无人值守参数：" >&2
    echo "         bash install.sh install --non-interactive --access local --image-source prebuilt" >&2
    exit 2
  fi

  answers="$(mktemp "${TMPDIR:-/tmp}/dsh-answers.XXXXXX")" || { echo "[错误] 无法创建临时文件。" >&2; exit 1; }

  run_install_execution --guided --answers="$answers"
  status=$?

  if [ "$status" != 0 ]; then
    rm -f "$answers"
    # 用户主动取消（3）：不是错误，干净退出，不打印额外信息。
    [ "$status" = 3 ] && exit 0
    echo "[错误] 安装向导异常退出（退出码 $status）。" >&2
    exit 1
  fi

  # 答案读回当前 shell：界面里选的是维护类动作（卸载、启动、密钥面板…）时，
  # 它们由紧随其后的主分派处理。
  dsh_installer_read_answers "$answers" || true
  rm -f "$answers"
}

# 交互路径的入口。位置在这里（而不是脚本中段）是因为它拉起的后台执行体依赖
# 上面那些函数的定义，见 run_guided_session 的注释。
if [ "${DSH_ANSWER_CONFIRMED:-}" = true ]; then
  run_guided_session
fi

case "$ACTION" in
  install|configure)
    if [ "${DSH_WIZARD_DONE:-}" = true ]; then
      # 向导路径：界面里已经跑完执行视图（准备与执行都在它的滚动日志里）。
      # 这里什么都不做——再跑一遍等于装两次。
      :
    else
      # 命令行路径：没有向导，需要自己先装配配置才能把摘要展示给人看，
      # 所以准备阶段要在确认页之前跑，之后再执行。
      install_prepare_body || exit $?
      confirm_install_plan
      run_install_execution --prepared
    fi
    ;;
  '') ;;
  delete) handle_delete_action ;;
  *)
    # 维护类动作。走到这里才进工程目录：命令行路径在脚本中段已经进过（幂等，
    # 这里直接返回），而向导路径此刻才第一次知道要做什么动作。
    enter_project || exit $?
    # 补填密钥（model-key）与开关面板（key-panel）都会让 UID 1000 的容器在
    # data/broker 里新建临时文件。老部署可能是以 root 建的目录，这里顺手对齐一次；
    # 目录属主不对时面板能读不能写，报的是 EACCES，看不出是属主问题。
    align_writable_data_dirs
    case "$ACTION" in
      upgrade) upgrade_dsh ;;
      model-key) add_model_key ;;
      key-panel) manage_key_admin ;;
      update) ./dsh.sh update ;;
      start) ./dsh.sh start ;;
      stop) ./dsh.sh stop ;;
      restart) ./dsh.sh restart ;;
      logs) exec ./dsh.sh logs ;;
      status) ./dsh.sh status ;;
    esac
    ;;
esac

# 收尾横幅。
#
# install/configure 在向导路径下不打印：那次的结局（入口地址、日志路径、失败原因）
# 已经由执行视图固定显示在操作区上方，TUI 退出后再打一遍只会重复，而且画面已经
# 滚过去了。其它动作（升级、启动、卸载、密钥面板…）没有视图，仍在这里给出总结。
case "$ACTION" in
  install|configure)
    [ "${DSH_WIZARD_DONE:-}" = true ] || {
      echo
      echo "==================================================="
      echo "  操作完成：$ACTION"
      echo "  本机入口: http://127.0.0.1:3080"
      echo "  再次运行同一条安装命令即可管理或重新配置"
      echo "==================================================="
    }
    ;;
  *)
    echo
    echo "==================================================="
    echo "  操作完成：$ACTION"
    echo "  再次运行同一条安装命令即可管理或重新配置"
    echo "==================================================="
    ;;
esac
