# syntax=docker/dockerfile:1.7
ARG DEBIAN_IMAGE=debian:13-slim
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS node-runtime

FROM ${DEBIAN_IMAGE} AS runtime

# 可选：把 Debian 软件源换成本地镜像。部分网络直连 deb.debian.org 会持续失败
# （apt 返回 500/404 而不是超时），此时用
#   --build-arg APT_MIRROR=https://mirrors.aliyun.com/debian
# 留空表示沿用基础镜像自带的官方源。安全源按 Debian 镜像的通行命名推导为
# <APT_MIRROR>-security（aliyun / ustc / tencent / tuna 都遵循该约定）。
#
# 无论传入 http 还是 https，构建期一律降级为 http：这一步发生在基础镜像里，此时还
# 没有 ca-certificates，任何 https 源都会因证书校验失败而一个包都拿不到。apt 的
# InRelease 与每个包都由 Signed-By 指定的密钥签名，完整性不依赖传输层，Debian 官方
# 默认源同样是 http。该替换会留在运行时镜像里，容器内 apt install 也走同一个源。
ARG APT_MIRROR=""

# 可选：把 npm 源换成本地镜像（部分地区直连 registry.npmjs.org 不稳定）。
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
# 留空表示使用官方源。该设置写进镜像的 npm 配置，容器内安装插件时同样生效。
ARG NPM_REGISTRY=""

# image.source 让 GHCR 自动把包关联到本仓库，包页面才会显示 README 并继承
# 仓库的可见性入口。
LABEL org.opencontainers.image.title="dsh-docker" \
      org.opencontainers.image.source="https://github.com/univers629/dsh-docker" \
      org.opencontainers.image.licenses="MIT"

COPY --from=node-runtime /usr/local/ /usr/local/

# 保留 APT 软件包缓存；APT 索引不挂载为临时 BuildKit 缓存，确保运行时可继续 apt install。
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
    && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    set -e; \
    if [ -n "$APT_MIRROR" ]; then \
      mirror_host="$(printf '%s' "$APT_MIRROR" | sed -E 's|^https?://||')"; \
      sources=/etc/apt/sources.list.d/debian.sources; \
      sed -i "s|http://deb.debian.org/debian-security|http://${mirror_host}-security|g; s|http://deb.debian.org/debian|http://${mirror_host}|g" "$sources"; \
      apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update; \
      # 第一阶段只能走明文 HTTP：此时镜像里还没有 CA 证书，任何 https 源都会验签失败。
      # ca-certificates 本身很小，明文通道足够。
      apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y --no-install-recommends ca-certificates; \
      # 第二阶段切到 https：明文通道在部分网络下会被中间设备截断大文件（21MB 的包
      # 反复 500/unexpected EOF，同一文件走 https 几秒就下完）。
      sed -i "s|http://${mirror_host}|https://${mirror_host}|g" "$sources"; \
      echo "APT 源已替换为 https://${mirror_host}"; \
    fi; \
    apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y --no-install-recommends \
       bash \
       procps \
       git \
       ca-certificates \
       curl \
       nginx \
       libnginx-mod-stream \
       apache2-utils \
       util-linux \
       openssl \
       # docker-cli（仅客户端，不含守护进程）：dsh-instances 需要它来创建/启停用户实例。
       # 它挂在 dsh-mgmt 上并通过挂载的 docker.sock 调用守护进程，而不含 socket 的容器
       # （包括 dsh 本体）拿到这个客户端也没有任何作用。
       docker-cli \
       python3 \
       python3-pip \
       python3-venv \
       make \
       gcc \
       g++ \
    && if [ -n "$NPM_REGISTRY" ]; then \
         npm config set registry "$NPM_REGISTRY"; \
         echo "npm 源已替换为 $NPM_REGISTRY"; \
       fi \
    # 网络抖动下 npm 默认重试次数偏少，构建会因单个 tarball 的 TLS 重置而失败。
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 10000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && ln -s /usr/bin/python3 /usr/local/bin/python \
    && npm install -g pnpm@11.7.0 \
    && npm cache clean --force

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# 运行账户：DSH 本体、它派生的 Agent 会话和 Nginx worker 都以这个非特权账户运行。
# 容器里只有 PID 1、Nginx 主进程和特权代理保留 root，UID 1000 与安装器的核验一致。
RUN groupadd --gid 1000 dsh \
    && useradd --uid 1000 --gid 1000 --home-dir /data/home --no-create-home --shell /bin/bash dsh

COPY bin/install-dsh-runtime.sh /usr/local/bin/install-dsh-runtime
COPY bin/update-dsh.sh /usr/local/lib/dsh/update-dsh.sh
COPY bin/dsh-update-shim /usr/local/bin/update-dsh
COPY bin/apply-dsh-artifact-patches.mjs /usr/local/lib/dsh/apply-dsh-artifact-patches.mjs
COPY bin/write-dsh-metadata.mjs /usr/local/lib/dsh/write-dsh-metadata.mjs
COPY bin/write-dsh-update-status.mjs /usr/local/lib/dsh/write-dsh-update-status.mjs
COPY bin/preflight-profile-plugins.mjs /usr/local/lib/dsh/preflight-profile-plugins.mjs
COPY patches/ /etc/dsh-patches/
COPY bin/dsh /usr/local/bin/dsh
COPY bin/dsh-supervisor /usr/local/bin/dsh-supervisor
COPY bin/restart-dsh /usr/local/bin/restart-dsh
COPY bin/manage-dsh-plugin /usr/local/bin/manage-dsh-plugin
COPY bin/cleanup-dsh-plugin-transactions /usr/local/bin/cleanup-dsh-plugin-transactions
COPY bin/validate-dsh-profile.mjs /usr/local/lib/dsh/validate-dsh-profile.mjs
COPY bin/prepare-profile-modules.mjs /usr/local/bin/prepare-profile-modules.mjs
# 插件故障隔离：启动成功时记录可用组合，连续失败时把日志里点名的插件禁掉再重试，
# 免得一个不兼容的插件装进来就让网页一直 502 且只能人工去修。
COPY bin/dsh-plugin-snapshot.mjs /usr/local/bin/dsh-plugin-snapshot.mjs
COPY bin/dsh-plugin-quarantine.mjs /usr/local/bin/dsh-plugin-quarantine.mjs
COPY bin/entrypoint.sh /usr/local/bin/entrypoint.sh
# 降权后唯一的提权入口：以 root 运行的特权代理 + 客户端 + apt/sudo 兼容包装。
COPY bin/dsh-privileged-policy.mjs /usr/local/lib/dsh/dsh-privileged-policy.mjs
COPY bin/dsh-privileged-helper.mjs /usr/local/lib/dsh/dsh-privileged-helper.mjs
COPY bin/dsh-root /usr/local/bin/dsh-root
COPY bin/dsh-apt-shim /usr/local/bin/apt
COPY bin/dsh-sudo-shim /usr/local/bin/sudo
COPY bin/hash-dsh-password /usr/local/bin/hash-dsh-password
COPY bin/verify-dsh-hardening /usr/local/bin/verify-dsh-hardening
COPY bin/configure-nginx-auth /usr/local/bin/configure-nginx-auth
COPY bin/patch-profile-plugins.mjs /usr/local/bin/patch-profile-plugins.mjs
COPY bin/watch-profile-plugins.mjs /usr/local/bin/watch-profile-plugins.mjs
COPY bin/install-docker-control.mjs /usr/local/bin/install-docker-control.mjs
# 旁路服务：真实模型密钥只存在于 dsh-key-broker 容器，出站白名单由 dsh-egress
# 容器执行。两者复用同一个镜像（都只用 Node 内置模块），但以独立容器、非 root、
# 零能力运行，和 DSH 容器之间只有 HTTP，没有共享卷。
COPY bin/dsh-key-broker-policy.mjs /usr/local/lib/dsh/dsh-key-broker-policy.mjs
COPY bin/dsh-key-broker.mjs /usr/local/lib/dsh/dsh-key-broker.mjs
# 每用户模型上游授权：代理按实例令牌识别调用者，只放行被开放的上游。
COPY bin/dsh-broker-grants.mjs /usr/local/lib/dsh/dsh-broker-grants.mjs
COPY bin/dsh-egress-policy.mjs /usr/local/lib/dsh/dsh-egress-policy.mjs
COPY bin/dsh-egress-proxy.mjs /usr/local/lib/dsh/dsh-egress-proxy.mjs
# 认证网关（dsh-auth）与实例编排（dsh-instances）。两者是独立容器，但复用同一个镜像。
# dsh-auth 的 Passkey 校验依赖 @simplewebauthn/server：与 KPanel 用 go-webauthn/webauthn
# 同构——密码学交给成熟库，服务本体只写策略（见 docs/auth-design.md §2.4）。
COPY bin/package.json /usr/local/lib/dsh/package.json
COPY bin/dsh-auth-policy.mjs /usr/local/lib/dsh/dsh-auth-policy.mjs
COPY bin/dsh-auth-store.mjs /usr/local/lib/dsh/dsh-auth-store.mjs
COPY bin/dsh-auth-passkey.mjs /usr/local/lib/dsh/dsh-auth-passkey.mjs
COPY bin/dsh-auth.mjs /usr/local/lib/dsh/dsh-auth.mjs
COPY bin/dsh-instances-policy.mjs /usr/local/lib/dsh/dsh-instances-policy.mjs
# 模型配置生成器：运行期（创建用户实例时）按该账户被开放的上游写 settings.yaml。
# 它依赖 yaml 与 pi-ai 目录（镜像里已有），并用 DSH 自己的 schema 校验结果。
COPY bin/seed-dsh-model-settings.mjs /usr/local/lib/dsh/seed-dsh-model-settings.mjs
COPY bin/dsh-model-settings-policy.mjs /usr/local/lib/dsh/dsh-model-settings-policy.mjs
COPY bin/dsh-instances.mjs /usr/local/lib/dsh/dsh-instances.mjs
COPY bin/dsh-auth-web/ /usr/local/lib/dsh/dsh-auth-web/
COPY dsh-home/ /usr/local/share/dsh-home/
COPY dsh-home/docker-control/ /opt/dsh-docker-control/
COPY nginx/dsh-nginx.conf /usr/local/share/dsh/nginx.conf
COPY nginx/dsh-ingress.conf /usr/local/share/dsh/ingress.conf
COPY nginx/dsh-multiuser.conf /usr/local/share/dsh/nginx-multiuser.conf
COPY nginx/dsh-authgate.conf /usr/local/share/dsh/nginx-authgate.conf
COPY pwa/ /usr/local/share/dsh-pwa/

RUN chmod +x /usr/local/bin/dsh /usr/local/bin/dsh-supervisor /usr/local/bin/restart-dsh \
      /usr/local/bin/manage-dsh-plugin /usr/local/bin/cleanup-dsh-plugin-transactions \
      /usr/local/bin/entrypoint.sh /usr/local/bin/configure-nginx-auth \
      /usr/local/bin/patch-profile-plugins.mjs /usr/local/bin/watch-profile-plugins.mjs \
      /usr/local/bin/install-docker-control.mjs \
      /usr/local/bin/dsh-plugin-snapshot.mjs /usr/local/bin/dsh-plugin-quarantine.mjs \
      /usr/local/bin/install-dsh-runtime /usr/local/bin/update-dsh \
      /usr/local/lib/dsh/update-dsh.sh /usr/local/bin/dsh-root /usr/local/bin/apt \
      /usr/local/bin/sudo /usr/local/bin/hash-dsh-password \
      /usr/local/bin/verify-dsh-hardening \
      /usr/local/lib/dsh/dsh-key-broker.mjs /usr/local/lib/dsh/dsh-egress-proxy.mjs \
      /usr/local/lib/dsh/dsh-auth.mjs /usr/local/lib/dsh/dsh-instances.mjs \
    && ln -sf apt /usr/local/bin/apt-get \
    && ln -sf apt /usr/local/bin/apt-mark \
    && cd /opt/dsh-docker-control \
    && npm install --omit=dev --no-package-lock \
    && npm cache clean --force \
    && cd /usr/local/lib/dsh \
    && npm install --omit=dev --no-package-lock \
    && npm cache clean --force \
    && mkdir -p /opt /data/dsh /data/agents /data/mcp /data/home /workspace \
       /data/home/.npm /data/home/.npm-global/bin /data/home/.local/bin \
       /data/home/.local/share/pnpm /data/home/.cache /data/home/.config \
       /run/dsh-priv /run/dsh-state /root/dsh-secret /etc/dsh-broker \
       /usr/bin /usr/sbin /usr/lib /usr/share /usr/include /usr/libexec \
       /usr/games /usr/src /var/lib /var/cache /var/backups \
    && chown 1000:1000 /data/dsh /data/agents /data/mcp /workspace \
    && chown -R 1000:1000 /data/home \
    && chown 0:1000 /run/dsh-priv /run/dsh-state \
    && chmod 750 /run/dsh-priv \
    && chmod 770 /run/dsh-state \
    && chmod 700 /root/dsh-secret \
    && printf '%s\n' \
       'export PATH="/data/home/.local/bin:/data/home/bin:/data/home/.npm-global/bin:/data/home/.local/share/pnpm:$PATH"' \
       'if [ -z "${HOME:-}" ]; then HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"; export HOME; fi' \
       > /etc/profile.d/dsh-toolchain.sh

# DSH 本体是上游发布在 npm 上的预构建包，装完直接对产物打补丁，不克隆源码也不编译。
# 默认装 latest：上游改动导致补丁锚点失效时这一步会直接失败，而不是静默产出一个
# 没打上补丁的镜像。
ARG DSH_VERSION=latest
ENV DSH_PATCH_DIR=/etc/dsh-patches \
    DSH_NPM_PACKAGE=@deepseek-ai/dsh \
    DSH_APP_DIR=/app/dsh
RUN /usr/local/bin/install-dsh-runtime /app/dsh "${DSH_VERSION}" \
    && npm cache clean --force

ENV DSH_RUN_USER=dsh \
    DSH_RESTART_REQUEST_FILE=/run/dsh-state/restart \
    DSH_PROFILE_PATCH_REPORT=/run/dsh-state/profile-patches.json \
    DSH_ROOT_HASH_FILE=/root/dsh-secret/root.hash
# 这里故意不设全容器的 HOME。镜像里一旦有 ENV HOME=/data/home，宿主上默认以 root
# 身份进来的 docker exec 也会继承它：root 跑一次 npm/npx，/data/home/.npm 里就留下
# root 属主的缓存，之后 dsh 账户自己装工具链只会以 EACCES 失败。改成不设之后 root
# 用 passwd 里的 /root，dsh 的 HOME 由 Supervisor 显式传给 DSH 子进程（DSH_USER_HOME）。
ENV DSH_HOME=/data/dsh \
    DSH_AGENTS_HOME=/data/agents \
    DSH_UPDATE_STATE=/data/dsh/update \
    DSH_NGINX_CONFIG=/usr/local/share/dsh/nginx.conf \
    DSH_USER_HOME=/data/home \
    PNPM_HOME=/data/home/.local/share/pnpm \
    DSH_PERMISSION_MODE=danger-full-access \
    DSH_HOST_ACCESS=mounted-paths-only \
    DSH_WRITABLE_PATHS=/data/dsh,/data/home,/data/mcp,/data/agents,/workspace \
    DSH_SYSTEM_PACKAGES_PERSISTENT=false \
    NODE_PATH=/app/dsh/node_modules:/data/dsh/profiles/node_modules \
    PATH=/data/home/.local/bin:/data/home/bin:/data/home/.npm-global/bin:/data/home/.local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace

EXPOSE 3080

# Nginx 的 /healthz 直接返回 204，只能证明入口活着：DSH 崩溃循环时容器依然是
# healthy。所以这里同时探 Nginx 入口和 DSH 自己的回环监听端口，DSH 起不来就必须
# 变成 unhealthy。
#
# 判据是「没有 5xx」而不是「2xx」：DSH 自己在监听就说明进程活着，而开了认证入口之后
# 首页会回 401，用 response.ok 判定会让容器恒定 unhealthy，真正的故障反而淹没在
# 常态报警里。docker-compose.yml 的覆盖版本用的是同一判据，两处必须一致。
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const dshPort = process.env.DSH_WEB_PORT || '3081';const check = (url) => fetch(url).then((response) => {if (response.status >= 500) throw new Error(url + ' ' + response.status)});Promise.all([check('http://127.0.0.1:3080/healthz'), check('http://127.0.0.1:' + dshPort + '/')]).then(() => process.exit(0)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["web"]
