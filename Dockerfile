# syntax=docker/dockerfile:1.7
ARG DEBIAN_IMAGE=debian:13-slim
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS node-runtime

FROM ${DEBIAN_IMAGE} AS runtime

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
    apt-get update \
    && apt-get install -y --no-install-recommends \
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
       python3 \
       python3-pip \
       python3-venv \
       make \
       gcc \
       g++ \
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
COPY patches/ /etc/dsh-patches/
COPY bin/dsh /usr/local/bin/dsh
COPY bin/dsh-supervisor /usr/local/bin/dsh-supervisor
COPY bin/restart-dsh /usr/local/bin/restart-dsh
COPY bin/manage-dsh-plugin /usr/local/bin/manage-dsh-plugin
COPY bin/cleanup-dsh-plugin-transactions /usr/local/bin/cleanup-dsh-plugin-transactions
COPY bin/validate-dsh-profile.mjs /usr/local/lib/dsh/validate-dsh-profile.mjs
COPY bin/prepare-profile-modules.mjs /usr/local/bin/prepare-profile-modules.mjs
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
COPY bin/install-docker-control.mjs /usr/local/bin/install-docker-control.mjs
# 旁路服务：真实模型密钥只存在于 dsh-key-broker 容器，出站白名单由 dsh-egress
# 容器执行。两者复用同一个镜像（都只用 Node 内置模块），但以独立容器、非 root、
# 零能力运行，和 DSH 容器之间只有 HTTP，没有共享卷。
COPY bin/dsh-key-broker-policy.mjs /usr/local/lib/dsh/dsh-key-broker-policy.mjs
COPY bin/dsh-key-broker.mjs /usr/local/lib/dsh/dsh-key-broker.mjs
COPY bin/dsh-egress-policy.mjs /usr/local/lib/dsh/dsh-egress-policy.mjs
COPY bin/dsh-egress-proxy.mjs /usr/local/lib/dsh/dsh-egress-proxy.mjs
COPY dsh-home/ /usr/local/share/dsh-home/
COPY dsh-home/docker-control/ /opt/dsh-docker-control/
COPY nginx/dsh-nginx.conf /usr/local/share/dsh/nginx.conf
COPY nginx/dsh-ingress.conf /usr/local/share/dsh/ingress.conf

RUN chmod +x /usr/local/bin/dsh /usr/local/bin/dsh-supervisor /usr/local/bin/restart-dsh \
      /usr/local/bin/manage-dsh-plugin /usr/local/bin/cleanup-dsh-plugin-transactions \
      /usr/local/bin/entrypoint.sh /usr/local/bin/configure-nginx-auth \
      /usr/local/bin/patch-profile-plugins.mjs /usr/local/bin/install-docker-control.mjs \
      /usr/local/bin/install-dsh-runtime /usr/local/bin/update-dsh \
      /usr/local/lib/dsh/update-dsh.sh /usr/local/bin/dsh-root /usr/local/bin/apt \
      /usr/local/bin/sudo /usr/local/bin/hash-dsh-password \
      /usr/local/bin/verify-dsh-hardening \
      /usr/local/lib/dsh/dsh-key-broker.mjs /usr/local/lib/dsh/dsh-egress-proxy.mjs \
    && ln -sf apt /usr/local/bin/apt-get \
    && ln -sf apt /usr/local/bin/apt-mark \
    && cd /opt/dsh-docker-control \
    && npm install --omit=dev --no-package-lock \
    && npm cache clean --force \
    && mkdir -p /opt /data/dsh /data/agents /data/mcp /data/home /workspace \
       /run/dsh-priv /run/dsh-state /root/dsh-secret /etc/dsh-broker \
       /usr/bin /usr/sbin /usr/lib /usr/share /usr/include /usr/libexec \
       /usr/games /usr/src /var/lib /var/cache /var/backups \
    && chown 1000:1000 /data/dsh /data/agents /data/mcp /data/home /workspace \
    && chown 0:1000 /run/dsh-priv /run/dsh-state \
    && chmod 750 /run/dsh-priv \
    && chmod 770 /run/dsh-state \
    && chmod 700 /root/dsh-secret \
    && printf '%s\n' 'export PATH="/data/home/.local/bin:/data/home/bin:/data/home/.npm-global/bin:$PATH"' > /etc/profile.d/dsh-toolchain.sh

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
    DSH_ROOT_HASH_FILE=/root/dsh-secret/root.hash
ENV DSH_HOME=/data/dsh \
    DSH_AGENTS_HOME=/data/agents \
    DSH_UPDATE_STATE=/data/dsh/update \
    DSH_NGINX_CONFIG=/usr/local/share/dsh/nginx.conf \
    HOME=/data/home \
    DSH_PERMISSION_MODE=danger-full-access \
    DSH_HOST_ACCESS=mounted-paths-only \
    DSH_WRITABLE_PATHS=/data/dsh,/data/home,/data/mcp,/data/agents,/workspace \
    DSH_SYSTEM_PACKAGES_PERSISTENT=false \
    NODE_PATH=/app/dsh/node_modules:/data/dsh/profiles/node_modules \
    PATH=/data/home/.local/bin:/data/home/bin:/data/home/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace

EXPOSE 3080

# Nginx 的 /healthz 直接返回 204，只能证明入口活着：DSH 崩溃循环时容器依然是
# healthy。所以这里同时探 Nginx 入口和 DSH 自己的回环监听端口，DSH 起不来就必须
# 变成 unhealthy。
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const dshPort = process.env.DSH_WEB_PORT || '3081';const check = (url) => fetch(url).then((response) => {if (!response.ok) throw new Error(url + ' ' + response.status)});Promise.all([check('http://127.0.0.1:3080/healthz'), check('http://127.0.0.1:' + dshPort + '/')]).then(() => process.exit(0)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["web"]
