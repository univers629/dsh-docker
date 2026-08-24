# syntax=docker/dockerfile:1.7
ARG DEBIAN_IMAGE=debian:13-slim
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS node-runtime

FROM ${DEBIAN_IMAGE} AS builder

COPY --from=node-runtime /usr/local/ /usr/local/

ARG UPSTREAM_REPO=https://github.com/deepseek-ai/deepseek-harness.git
ARG UPSTREAM_REF=master

ENV CI=true
WORKDIR /app/dsh

# 开启 APT 持久化缓存：不删除 .deb 安装包，挂载本地持久缓存
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
    && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
    && npm install -g pnpm@11.7.0 esbuild

RUN git clone --depth 1 -b ${UPSTREAM_REF} ${UPSTREAM_REPO} .

# 挂载 pnpm 本地持久化 store 缓存
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY patches/ /tmp/dsh-patches/
COPY bin/apply-dsh-patches.sh /tmp/apply-dsh-patches
COPY bin/write-dsh-metadata.mjs /tmp/write-dsh-metadata.mjs
RUN chmod +x /tmp/apply-dsh-patches \
    && /tmp/apply-dsh-patches /app/dsh /tmp/dsh-patches

ENV NODE_OPTIONS="--max-old-space-size=2048"
RUN --mount=type=cache,target=/app/dsh/node_modules/.cache \
    pnpm run build:official

COPY bin/build-fix.mjs /tmp/build-fix.mjs
RUN DSH_BUILD_APP_DIR=/app/dsh NODE_PATH=/usr/local/lib/node_modules node /tmp/build-fix.mjs \
    && node /tmp/write-dsh-metadata.mjs /app/dsh /tmp/dsh-patches /app/dsh/DSH-BUILD-METADATA.json \
    && rm -rf /tmp/build-fix.mjs /tmp/write-dsh-metadata.mjs /tmp/apply-dsh-patches \
      /tmp/dsh-patches .git docs .agents examples test* **/*.tsbuildinfo node_modules/.cache

FROM ${DEBIAN_IMAGE} AS runtime

LABEL org.opencontainers.image.title="dsh-docker" \
      org.opencontainers.image.licenses="MIT"

ARG UPSTREAM_REPO=https://github.com/deepseek-ai/deepseek-harness.git
ARG UPSTREAM_REF=master

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
       apache2-utils \
       gosu \
       passwd \
       util-linux \
       python3 \
       python3-pip \
       python3-venv \
       make \
       gcc \
       g++ \
    && groupadd --gid 1000 node \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash node \
    && ln -s /usr/bin/python3 /usr/local/bin/python \
    && npm install -g pnpm@11.7.0 esbuild \
    && npm cache clean --force

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
COPY --chown=node:node --from=builder /app/dsh /app/dsh
COPY bin/apply-dsh-patches.sh /usr/local/bin/apply-dsh-patches
COPY bin/update-dsh.sh /usr/local/bin/update-dsh
COPY bin/write-dsh-metadata.mjs /usr/local/lib/dsh/write-dsh-metadata.mjs
COPY bin/write-dsh-update-status.mjs /usr/local/lib/dsh/write-dsh-update-status.mjs
COPY bin/build-fix.mjs /usr/local/lib/dsh/build-fix.mjs
COPY patches/ /etc/dsh-patches/
COPY bin/dsh /usr/local/bin/dsh
COPY bin/manage-dsh-plugin /usr/local/bin/manage-dsh-plugin
COPY bin/link-modules.mjs /usr/local/bin/link-modules.mjs
COPY bin/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY bin/configure-nginx-auth /usr/local/bin/configure-nginx-auth
COPY bin/patch-profile-plugins.mjs /usr/local/bin/patch-profile-plugins.mjs
COPY bin/install-docker-control.mjs /usr/local/bin/install-docker-control.mjs
COPY dsh-home/ /usr/local/share/dsh-home/
COPY dsh-home/docker-control/ /opt/dsh-docker-control/
COPY nginx/dsh-nginx.conf /usr/local/share/dsh/nginx.conf

RUN cd /opt/dsh-docker-control \
    && npm install --omit=dev --ignore-scripts --no-package-lock \
    && npm cache clean --force \
    && mkdir -p /opt /data/dsh /data/agents /data/mcp /data/home /workspace \
       /usr/bin /usr/sbin /usr/lib /usr/share /usr/include /usr/libexec \
       /usr/games /usr/src /var/lib /var/cache /var/backups \
    && chown -R node:node /opt /data /workspace \
    && chmod +x /usr/local/bin/dsh /usr/local/bin/manage-dsh-plugin /usr/local/bin/entrypoint.sh /usr/local/bin/configure-nginx-auth /usr/local/bin/patch-profile-plugins.mjs /usr/local/bin/install-docker-control.mjs /usr/local/bin/apply-dsh-patches /usr/local/bin/update-dsh \
    && printf '%s\n' 'export PATH="/data/home/.local/bin:/data/home/bin:/data/home/.npm-global/bin:$PATH"' > /etc/profile.d/dsh-toolchain.sh

ENV DSH_HOME=/data/dsh \
    DSH_AGENTS_HOME=/data/agents \
    DSH_UPSTREAM_REPO=${UPSTREAM_REPO} \
    DSH_UPSTREAM_REF=${UPSTREAM_REF} \
    DSH_PATCH_DIR=/etc/dsh-patches \
    DSH_APP_DIR=/app/dsh \
    DSH_UPDATE_STATE=/data/dsh/update \
    DSH_NGINX_CONFIG=/usr/local/share/dsh/nginx.conf \
    HOME=/data/home \
    DSH_PERMISSION_MODE=danger-full-access \
    DSH_HOST_ACCESS=mounted-paths-only \
    DSH_WRITABLE_PATHS=/data/dsh,/data/home,/data/mcp,/data/agents,/workspace \
    DSH_SYSTEM_PACKAGES_PERSISTENT=true \
    NODE_PATH=/app/dsh/node_modules:/data/dsh/profiles/node_modules \
    PATH=/data/home/.local/bin:/data/home/bin:/data/home/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["web"]
