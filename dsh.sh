#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

# Compose 里 shell 环境变量的优先级高于 .env；清掉它们，保证运行时始终使用
# 安装器写入 .env 的访问模式、绑定地址和网络配置。
unset DSH_ACCESS_MODE DSH_BIND_HOST DSH_TRUSTED_HOSTS DSH_DOCKER_NETWORK DSH_DOCKER_NETWORK_EXTERNAL
unset DSH_IMAGE DSH_IMAGE_SOURCE
# 旁路服务的开关同理。这里的 -f 列表是按 .env 算出来的，如果 Compose 插值又去读宿主
# shell 里残留的值，就会出现「叠加了 keys/isolated 文件，但服务拿到的还是旧模式」
# 这种最难查的半启用状态。
unset DSH_MODEL_BROKER DSH_MODEL_BROKER_BASE DSH_EGRESS_MODE DSH_EGRESS_ALLOWED_HOSTS
unset DSH_KEY_ADMIN DSH_KEY_ADMIN_BIND_HOST DSH_KEY_ADMIN_HOST_PORT

ACTION="${1:-start}"

# 补上 bin/ 下脚本的可执行位。
#
# docker-compose.yml 把 ./bin/dsh-supervisor 绑定挂载进容器的 /usr/local/bin（只读），
# 覆盖镜像里已 chmod +x 的那份。宿主机上这个文件缺可执行位时，容器启动会失败并陷入
# 重启循环，日志只有一句 "Permission denied"，看不出是权限位的问题。git 能保留执行位，
# 但 tar 解包（无 git 时的安装路径）不会，从 Windows 同步过来的工程也可能丢。
# 放在这里：start / restart / up 之前都会执行到。
if [ -d bin ]; then
  chmod +x bin/* 2>/dev/null || true
fi

if ! command -v docker &>/dev/null; then
  echo "[错误] 未检测到 Docker，请先安装 Docker 后重试。"
  exit 1
fi

# sudo 默认 env_reset，导出的变量到不了 docker compose，插值会退回 dsh:local。
# 需要变量的调用一律走 DOCKER_ENV，用 env 在命令行上显式透传。
if docker info >/dev/null 2>&1; then
  DOCKER() { docker "$@"; }
  DOCKER_ENV() { env "$@"; }
else
  DOCKER() { sudo docker "$@"; }
  DOCKER_ENV() { sudo env "$@"; }
fi

# 安装器把镜像引用写进 .env；预构建安装用的是发布引用，不是 dsh:local。
# .env 有可能被 Windows 侧的编辑器存成 CRLF，尾随的 CR 会让 "on" / "allowlist"
# 这类相等比较全部失配，所以在这里就把它剥掉。
env_value() {
  local key="$1" fallback="$2" value=""
  if [ -f .env ]; then
    value="$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env 2>/dev/null | tr -d '\r' || true)"
  fi
  printf '%s' "${value:-$fallback}"
}

# --- Compose 叠加文件与旁路容器 ---
#
# 顺序是契约，与安装器 set_compose_args 一致：
#   base → keys → keys-admin → auth → basic → multiuser → isolated
# isolated 必须最后：它的 !reset / !override 要作用在前面合并出来的结果上。
#
#   DSH_MODEL_BROKER=on       → docker-compose.keys.yml（dsh-key-broker）
#   DSH_KEY_ADMIN=on          → docker-compose.keys-admin.yml（dsh-key-admin）
#   DSH_ACCESS_MODE=password  → docker-compose.auth.yml（dsh-auth）
#   DSH_MULTI_USER=on         → docker-compose.multiuser.yml（dsh-instances + 七层入口）
#   DSH_ACCESS_MODE=basic     → docker-compose.basic-auth.yml（只挂 htpasswd 单文件）
#   DSH_EGRESS_MODE=allowlist|blocklist → docker-compose.isolated.yml（dsh-egress）
#
# 入口容器二选一，靠 profile 区分：单管理员用 dsh-authgate，多用户用 multiuser 叠加层里的
# dsh-ingress。两者发布同一个宿主端口，同时激活会让第二个入口绑定失败——这也是这台 CLI
# 之前与安装器分叉的地方：它只认密钥与出站叠加层，对密码/多用户部署重启会起出一套没有
# 入口的容器。
#
# 叠加文件不存在时只警告并按未启用处理：老部署目录里没有这些文件，而 docker compose
# 遇到缺失的 -f 会直接失败退出——那样连 stop / logs / status 这些只读操作都会一起废掉。
COMPOSE_ARGS=(-f docker-compose.yml)
SIDECAR_SERVICES=()
BROKER_ENABLED=false
KEY_ADMIN_ENABLED=false
AUTH_ENABLED=false
MULTI_USER_ENABLED=false
EGRESS_ENABLED=false

# 旁路容器去重：isolated 与 multiuser 都会带 dsh-ingress，重复的服务名会让 up 的参数
# 列表里出现同一项。
add_sidecars() {
  local service
  for service in "$@"; do
    case " ${SIDECAR_SERVICES[*]-} " in
      *" $service "*) ;;
      *) SIDECAR_SERVICES+=("$service") ;;
    esac
  done
}

if [ "$(env_value DSH_MODEL_BROKER off)" = on ]; then
  if [ -f docker-compose.keys.yml ]; then
    COMPOSE_ARGS+=(-f docker-compose.keys.yml)
    add_sidecars dsh-key-broker
    BROKER_ENABLED=true
  else
    echo "[警告] .env 里 DSH_MODEL_BROKER=on，但目录里没有 docker-compose.keys.yml，已按未启用处理。" >&2
  fi
fi
# 面板依附密钥代理：它写的就是 broker 那份 keys.json。broker 没启用时面板既没有配置可改，
# 也会让人误以为密钥已经搬出容器，所以这里按未启用处理并说明原因。
if [ "$(env_value DSH_KEY_ADMIN off)" = on ]; then
  if [ "$BROKER_ENABLED" != true ]; then
    echo "[警告] .env 里 DSH_KEY_ADMIN=on，但密钥代理没启用，面板已按未启用处理。" >&2
  elif [ -f docker-compose.keys-admin.yml ]; then
    COMPOSE_ARGS+=(-f docker-compose.keys-admin.yml)
    add_sidecars dsh-key-admin
    KEY_ADMIN_ENABLED=true
  else
    echo "[警告] .env 里 DSH_KEY_ADMIN=on，但目录里没有 docker-compose.keys-admin.yml，已按未启用处理。" >&2
  fi
fi

ACCESS_MODE="$(env_value DSH_ACCESS_MODE local)"
MULTI_USER="$(env_value DSH_MULTI_USER off)"

# 认证网关：password 模式与多用户模式都必需。多用户时入口由 multiuser 叠加层提供，
# 因此不激活 authgate profile、也不把 dsh-authgate 当旁路容器。
if [ "$ACCESS_MODE" = password ] || [ "$MULTI_USER" = on ]; then
  if [ -f docker-compose.auth.yml ]; then
    if [ "$MULTI_USER" = on ]; then
      COMPOSE_ARGS+=(-f docker-compose.auth.yml)
      add_sidecars dsh-auth
    else
      COMPOSE_ARGS+=(--profile authgate -f docker-compose.auth.yml)
      add_sidecars dsh-auth dsh-authgate
    fi
    AUTH_ENABLED=true
  else
    echo "[警告] .env 需要认证网关（DSH_ACCESS_MODE=password 或 DSH_MULTI_USER=on），但目录里没有 docker-compose.auth.yml，已按未启用处理——那等于容器内不认证、外面也没有认证。" >&2
  fi
fi

# basic 模式需要把 htpasswd 单独挂进容器（基础 compose 不再整目录挂 data/auth，
# 那会把认证数据库暴露给容器内的 Agent）。只在文件已存在时叠加，否则 Docker 会
# 在宿主上把那个路径造成目录。
if [ "$ACCESS_MODE" = basic ] && [ -f data/auth/htpasswd ] && [ -f docker-compose.basic-auth.yml ]; then
  COMPOSE_ARGS+=(-f docker-compose.basic-auth.yml)
fi

# 多用户改变入口与网络拓扑，必须带上编排服务与七层入口；它建立在认证层之上，
# 因此认证层缺席时明确回报并跳过，而不是起出一套没人能登录的容器。
if [ "$MULTI_USER" = on ]; then
  if [ ! -f docker-compose.multiuser.yml ]; then
    echo "[警告] .env 里 DSH_MULTI_USER=on，但目录里没有 docker-compose.multiuser.yml，已按单用户处理。" >&2
  elif [ "$AUTH_ENABLED" != true ]; then
    echo "[警告] .env 里 DSH_MULTI_USER=on，但认证网关未启用（缺 docker-compose.auth.yml），已按单用户处理——多用户必须由网关解析身份。" >&2
  else
    COMPOSE_ARGS+=(--profile multiuser -f docker-compose.multiuser.yml)
    add_sidecars dsh-instances dsh-ingress
    MULTI_USER_ENABLED=true
  fi
fi

# blocklist 与 allowlist 用同一套隔离形态（都要把 dsh 收进没有网关的网络，出站全部经过
# dsh-egress），两者只差代理里最后那道域名判定，因此除 open 之外都要叠加——与安装器一致。
EGRESS_MODE="$(env_value DSH_EGRESS_MODE open)"
if [ "$EGRESS_MODE" != open ]; then
  if [ -f docker-compose.isolated.yml ]; then
    COMPOSE_ARGS+=(-f docker-compose.isolated.yml)
    add_sidecars dsh-egress
    EGRESS_ENABLED=true
    # 入口容器在两种模式下是不同的服务名：isolated.yml 里叫 dsh-ingress-iso，
    # multiuser.yml 里叫 dsh-ingress。它们共用 container_name=dsh-ingress，
    # 但服务定义是两套（不同 nginx 配置、不同运行用户），用不同服务名避免
    # Compose 合并同名服务时把序列字段（security_opt/command/ports）追加成重复项。
    # 多用户时由 multiuser 分支负责登记它，这里不重复加。
    if [ "$MULTI_USER_ENABLED" = true ]; then
      :
    else
      COMPOSE_ARGS+=(--profile isolate)
      add_sidecars dsh-ingress-iso
    fi
  else
    echo "[警告] .env 里 DSH_EGRESS_MODE=${EGRESS_MODE}，但目录里没有 docker-compose.isolated.yml，已按 open 处理。" >&2
  fi
fi

container_exists() {
  DOCKER container inspect dsh >/dev/null 2>&1
}

container_running() {
  [ "$(DOCKER inspect --format '{{.State.Status}}' dsh 2>/dev/null || true)" = running ]
}

ensure_image() {
  local image_ref image_source
  image_ref="$(env_value DSH_IMAGE dsh:local)"
  image_source="$(env_value DSH_IMAGE_SOURCE '')"
  if DOCKER image inspect "$image_ref" >/dev/null 2>&1; then
    return 0
  fi
  if [ "$image_source" = prebuilt ]; then
    echo "==> 首次创建容器，正在拉取预构建 Debian 13 镜像：$image_ref"
    DOCKER pull "$image_ref"
    return 0
  fi
  echo "==> 首次创建容器，正在构建 Debian 13 镜像..."
  DOCKER_ENV DSH_IMAGE="$image_ref" DOCKER_BUILDKIT=1 \
    docker compose "${COMPOSE_ARGS[@]}" build dsh
}

ensure_container() {
  if container_exists; then return 0; fi
  ensure_image
  DOCKER compose "${COMPOSE_ARGS[@]}" up -d --no-build dsh
}

# 旁路容器单独补：用户可能是在已有部署上才把 .env 的开关打开的，这时 dsh 容器已经
# 存在，ensure_container 会直接返回，旁路容器就永远起不来。缺失的才 up（避免顺带
# 重建 dsh），已存在但停着的直接 start。
ensure_sidecars() {
  local service missing=()
  [ "${#SIDECAR_SERVICES[@]}" -gt 0 ] || return 0
  for service in "${SIDECAR_SERVICES[@]}"; do
    if ! DOCKER container inspect "$service" >/dev/null 2>&1; then
      missing+=("$service")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    DOCKER compose "${COMPOSE_ARGS[@]}" up -d --no-build "${missing[@]}"
  fi
  for service in "${SIDECAR_SERVICES[@]}"; do
    if [ "$(DOCKER inspect --format '{{.State.Status}}' "$service" 2>/dev/null || true)" != running ]; then
      DOCKER start "$service" >/dev/null 2>&1 || true
    fi
  done
}

# 旁路容器的状态探针。broker 和 egress 容器都是 read_only + 非 root，所以只能用
# node -e 打回环上的 /status，绝不能依赖写临时文件。
# 脚本刻意不用箭头函数：同一段源码要原样搬进 dsh.bat，而 cmd 里 `>` 即使在引号内也
# 容易踩坑，避免出现比留着可读性更划算。
status_probe() {
  printf '%s' "const url='http://127.0.0.1:$1/status';fetch(url).then(function(response){return response.text()}).then(function(text){try{console.log(JSON.stringify(JSON.parse(text),null,2))}catch(error){console.log(text)}}).catch(function(error){console.error(url+' : '+error.message);process.exitCode=1})"
}

# 探针前置检查：容器不存在或没运行时给一句能照着做的话，而不是让 docker exec 抛
# 一行英文错误。
require_sidecar() {
  local service="$1"
  if ! DOCKER container inspect "$service" >/dev/null 2>&1; then
    echo "[错误] $service 容器不存在，请先运行 $0 start。" >&2
    return 1
  fi
  if [ "$(DOCKER inspect --format '{{.State.Status}}' "$service" 2>/dev/null || true)" != running ]; then
    echo "[错误] $service 容器当前未运行，请先运行 $0 start。" >&2
    return 1
  fi
}

# status 里顺带把三个旁路容器的存在与健康状态列出来：它们不发布端口也没有 Web 界面，
# compose ps 之外没有别的地方能看到它们是不是活着。
report_sidecar() {
  local name="$1" label="$2" enabled="$3" switch="$4" state health
  state="$(DOCKER inspect --format '{{.State.Status}}' "$name" 2>/dev/null || true)"
  if [ -z "$state" ]; then
    if [ "$enabled" = true ]; then
      printf '  %-15s %s：已启用但容器不存在，运行 %s start 创建\n' "$name" "$label" "$0"
    else
      printf '  %-15s %s：未启用（在 .env 里设置 %s 后重新 start）\n' "$name" "$label" "$switch"
    fi
    return 0
  fi
  health="$(DOCKER inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}无健康检查{{end}}' "$name" 2>/dev/null || true)"
  printf '  %-15s %s：%s（健康：%s）\n' "$name" "$label" "$state" "${health:-未知}"
}

# 多用户运维：向实例编排服务发一次带令牌的请求。
# 令牌由认证网关创建，两个容器共享 data/auth 挂载，因此这里直接读同一个文件。
# 由用户名解析实例槽位号。
#
# 不走文本解析：/instances 的 JSON 里 uid 在 username **之前**，用 awk 顺序扫会错位
# （实测把 alice 解析成了 bob 的 uid）。这里在容器内用 node 做精确匹配，注册表说什么就是什么。
multiuser_uid_for() {
  local username="$1" token uid
  token="$(cat data/auth/instances.token 2>/dev/null || true)"
  if [ -z "$token" ]; then
    echo "[错误] 读不到 data/auth/instances.token（认证网关尚未创建它）。" >&2
    return 1
  fi
  uid="$(DOCKER exec dsh-instances node -e '
    const [username, token] = process.argv.slice(1)
    fetch("http://127.0.0.1:8092/instances", { headers: { authorization: "Bearer " + token } })
      .then((response) => response.json())
      .then((data) => {
        const hit = (data.instances || []).find((instance) => instance.username === username)
        if (!hit) process.exit(3)
        process.stdout.write(String(hit.uid))
      })
      .catch(() => process.exit(1))
  ' "$username" "$token" 2>/dev/null)" || true
  if [ -z "$uid" ]; then
    echo "[错误] 找不到账户 $username 的实例；先用 ./dsh.sh users 看看现有实例。" >&2
    return 1
  fi
  printf '%s\n' "$uid"
}

multiuser_request() {
  local path="$1" body="$2" token
  if ! DOCKER container inspect dsh-instances >/dev/null 2>&1; then
    echo "[错误] 未发现 dsh-instances 容器：该部署不是多用户模式。" >&2
    return 1
  fi
  if [ "$(DOCKER inspect --format '{{.State.Status}}' dsh-instances 2>/dev/null || true)" != running ]; then
    echo "[错误] dsh-instances 当前未运行，请先 ./dsh.sh start。" >&2
    return 1
  fi
  token="$(cat data/auth/instances.token 2>/dev/null || true)"
  if [ -z "$token" ]; then
    echo "[错误] 读不到 data/auth/instances.token（认证网关尚未创建它）。" >&2
    return 1
  fi
  DOCKER exec dsh-instances node -e '
    const [path, body, token] = process.argv.slice(1)
    const init = { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + token } }
    if (body) { init.headers["content-type"] = "application/json"; init.body = body }
    fetch("http://127.0.0.1:8092" + path, init)
      .then(async (r) => { const text = await r.text(); process.stdout.write(text + "\n"); process.exit(r.ok ? 0 : 1) })
      .catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1) })
  ' "$path" "$body" "$token"
}

case "$ACTION" in
  start|up)
    echo "==> 启动 DeepSeek Harness 容器..."
    ensure_container
    if ! container_running; then DOCKER start dsh >/dev/null; fi
    ensure_sidecars
    echo "==> Web UI: http://127.0.0.1:3080"
    ;;
  update)
    if ! container_exists; then
      echo "[错误] 容器尚未创建，请先运行 ./dsh.sh start。" >&2
      exit 1
    fi
    if ! container_running; then
      echo "[错误] 容器当前未运行，请先运行 ./dsh.sh start。" >&2
      exit 1
    fi
    echo "==> 在现有 Debian 13 容器内更新 DSH..."
    DOCKER exec dsh /usr/local/bin/update-dsh
    ;;
  stop)
    echo "==> 停止服务..."
    DOCKER compose "${COMPOSE_ARGS[@]}" stop dsh ${SIDECAR_SERVICES[@]+"${SIDECAR_SERVICES[@]}"}
    ;;
  remove|down)
    echo "==> 即将删除容器可写层；/data 和 /workspace 挂载数据不会删除。"
    DOCKER compose "${COMPOSE_ARGS[@]}" down
    ;;
  restart)
    echo "==> 重启服务..."
    DOCKER compose "${COMPOSE_ARGS[@]}" restart dsh ${SIDECAR_SERVICES[@]+"${SIDECAR_SERVICES[@]}"}
    ;;
  logs)
    # 默认跟随全部服务：隔离模式下 ingress / egress / broker 的日志和 dsh 自己的
    # 一样重要（被拒的出站请求只会出现在 egress 的审计日志里）。`logs <服务>` 只跟一个。
    shift || true
    if [ "$#" -gt 0 ]; then
      DOCKER compose "${COMPOSE_ARGS[@]}" logs -f "$@"
    else
      DOCKER compose "${COMPOSE_ARGS[@]}" logs -f
    fi
    ;;
  keys)
    if [ "$BROKER_ENABLED" != true ]; then
      echo "模型密钥代理未启用（.env 里 DSH_MODEL_BROKER 不是 on）：模型密钥现在直接放在 DSH 容器里，"
      echo "容器内任何进程（包括被提示注入的 Agent）都能读到它。"
      # 补填密钥不需要重建容器：docker-compose.keys.yml 只新增 dsh-key-broker，不改 dsh
      # 服务的定义，所以别让用户去手写 JSON 或重装——安装器有专门的动作干这件事。
      echo "启用方法：在这个目录里运行 ./install.sh model-key，按提示填上游名字、base_url 和密钥。"
      echo "它只写 data/broker/keys.json（0600）、翻 .env 里的开关、再新增 dsh-key-broker 容器，"
      echo "不会重建 dsh，容器里 apt 装过的东西不会丢。它还会把供应商按 DSH 官方格式写进"
      echo "data/dsh/settings.yaml（base_url = http://dsh-key-broker:8080/u/<上游名字>，密钥是占位串），"
      echo "settings.yaml 是热加载的，刷新 WebUI 就能在「设置 → 模型」里选模型。"
      echo "不想在终端里填就运行 ./install.sh key-panel，在浏览器里填（同样不重建 dsh）。"
      exit 0
    fi
    require_sidecar dsh-key-broker
    echo "==> dsh-key-broker /status："
    if ! DOCKER exec dsh-key-broker node -e "$(status_probe 8080)"; then
      echo "[错误] 读不到 dsh-key-broker 的 /status，容器可能刚起来或配置有问题，见 $0 logs dsh-key-broker。" >&2
      exit 1
    fi
    echo
    echo "说明：这里只显示上游名字与用量，密钥只存在于 data/broker/keys.json 与 broker 容器内存中。"
    echo "      它不会出现在这条输出、DSH 容器、compose 文件或 broker 的审计日志里。"
    ;;
  key-panel)
    if [ "$KEY_ADMIN_ENABLED" != true ]; then
      echo "模型密钥管理面板未启用（.env 里 DSH_KEY_ADMIN 不是 on）。"
      echo "启用方法：在这个目录里运行 ./install.sh key-panel，它只新增 dsh-key-admin 容器，不重建 dsh。"
      exit 0
    fi
    require_sidecar dsh-key-admin
    echo "==> 模型密钥管理面板: http://$(env_value DSH_KEY_ADMIN_BIND_HOST 127.0.0.1):$(env_value DSH_KEY_ADMIN_HOST_PORT 3082)/"
    if [ -s data/broker/admin.token ]; then
      echo "    访问令牌: $(tr -d '[:space:]' < data/broker/admin.token)"
    else
      echo "[警告] 找不到 data/broker/admin.token，面板会拒绝所有请求；重新运行 ./install.sh key-panel 生成。" >&2
    fi
    echo "    远程访问请走 SSH 隧道，不要把这个端口暴露到公网。"
    ;;
  egress)
    if [ "$EGRESS_ENABLED" != true ]; then
      echo "出站白名单未启用（.env 里 DSH_EGRESS_MODE 不是 allowlist）：容器当前可以直接访问任意公网地址，"
      echo "被提示注入的 Agent 可以把数据 POST 到任何地方。"
      echo "启用方法：在 .env 里设置 DSH_EGRESS_MODE=allowlist（要额外放行域名就再写 DSH_EGRESS_ALLOWED_HOSTS），"
      echo "然后运行 $0 start。"
      exit 0
    fi
    require_sidecar dsh-egress
    echo "==> dsh-egress /status："
    if ! DOCKER exec dsh-egress node -e "$(status_probe 3128)"; then
      echo "[错误] 读不到 dsh-egress 的 /status，容器可能刚起来或配置有问题，见 $0 logs dsh-egress。" >&2
      exit 1
    fi
    echo
    echo "说明：allowlist 模式下 dsh 容器只挂 internal 网络，出网只有 dsh-egress 这一条路，"
    echo "      白名单外的域名会被直接拒绝。被拒的请求见 $0 logs dsh-egress。"
    ;;
  shell)
    # 默认进入非特权的 dsh 账户：这正是 DSH 与 Agent 实际运行的身份。
    DOCKER exec -it -u dsh dsh bash -l
    ;;
  root-shell)
    echo "==> 以容器 root 打开 shell（仅宿主机管理员通道，容器内无法这样提权）。"
    DOCKER exec -it dsh bash -l
    ;;
  verify)
    DOCKER exec dsh /usr/local/bin/verify-dsh-hardening
    ;;
  users)
    echo "==> 多用户实例（来自实例编排服务）："
    multiuser_request /instances
    ;;
  start-user)
    target="${2:-}"
    if [ -z "$target" ]; then echo "用法: $0 start-user <用户名>" >&2; exit 1; fi
    uid="$(multiuser_uid_for "$target")" || exit 1
    echo "==> 启动 $target（uid $uid）..."
    multiuser_request /instances/ensure "{\"uid\":$uid,\"username\":\"$target\"}"
    ;;
  stop-user)
    target="${2:-}"
    if [ -z "$target" ]; then echo "用法: $0 stop-user <用户名>" >&2; exit 1; fi
    uid="$(multiuser_uid_for "$target")" || exit 1
    echo "==> 停止 $target（uid $uid）..."
    multiuser_request /instances/stop "{\"uid\":$uid}"
    ;;
  status|ps)
    DOCKER compose "${COMPOSE_ARGS[@]}" ps
    echo
    echo "==> 旁路容器："
    report_sidecar dsh-key-broker "模型密钥代理" "$BROKER_ENABLED" DSH_MODEL_BROKER=on
    report_sidecar dsh-key-admin "密钥管理面板" "$KEY_ADMIN_ENABLED" DSH_KEY_ADMIN=on
    report_sidecar dsh-auth "认证网关" "$AUTH_ENABLED" "DSH_ACCESS_MODE=password 或 DSH_MULTI_USER=on"
    report_sidecar dsh-instances "实例编排服务" "$MULTI_USER_ENABLED" DSH_MULTI_USER=on
    report_sidecar dsh-egress "出站白名单代理" "$EGRESS_ENABLED" DSH_EGRESS_MODE=allowlist
    # 入口容器二选一：单管理员是 dsh-authgate，多用户是 dsh-ingress（出站隔离也用它）。
    # 两个都列会让人以为两套入口可以并存，而它们发布的是同一个宿主端口。
    if [ "$MULTI_USER_ENABLED" != true ]; then
      report_sidecar dsh-authgate "宿主入口（单管理员）" "$AUTH_ENABLED" DSH_ACCESS_MODE=password
    fi
    if [ "$MULTI_USER_ENABLED" = true ] || [ "$EGRESS_ENABLED" = true ]; then
      report_sidecar dsh-ingress "宿主入口（七层/出站）" true "DSH_MULTI_USER=on 或 DSH_EGRESS_MODE!=open"
    fi
    ;;
  *)
    echo "用法: $0 [start|update|stop|restart|logs [服务]|status|shell|root-shell|verify|keys|key-panel|egress|users|start-user <用户名>|stop-user <用户名>|remove]"
    echo "  keys      显示模型密钥代理（dsh-key-broker）的上游与用量，不显示密钥"
    echo "  key-panel 显示模型密钥管理面板（dsh-key-admin）的地址与访问令牌"
    echo "  egress    显示出站白名单代理（dsh-egress）的白名单规模与放行/拒绝计数"
    echo "  users     列出多用户模式下的账户实例（在线/停止、忙碌、磁盘用量）"
    echo "  start-user 手动拉起某个账户的实例（正常情况下由登录自动触发）"
    echo "  stop-user 手动停止某个账户的实例（释放内存，数据保留）"
    exit 1
    ;;
esac