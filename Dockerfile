# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS builder

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
RUN git apply --unidiff-zero --check /tmp/dsh-patches/*.patch \
    && git apply --unidiff-zero /tmp/dsh-patches/*.patch \
    && rm -rf /tmp/dsh-patches \
    && sed -i 's/if (!(WIDER_MODES\[effectiveMode\]/if (effectiveMode === mode) return mode as SandboxMode; if (!(WIDER_MODES[effectiveMode]/' \
        packages/sandbox/sandbox/src/escalation.ts \
    && sed -i 's/if (justification !== undefined && justification.trim().length === 0)/if (justification !== undefined \&\& justification.trim().length === 0 \&\& sandboxPermissions !== "danger-full-access")/' \
        packages/sandbox/sandbox/src/escalation.ts \
    && sed -i "s/return \[...new Set(\[policy\.workspaceRoot, '\/tmp', tmpdir()\]/return [...new Set([policy.workspaceRoot, '\/data', '\/tmp', tmpdir()]/" \
        packages/sandbox/sandbox/src/roots.ts \
    && sed -i "s/readWrite\.push('\/tmp', policy\.workspaceRoot)/readWrite.push('\/tmp', '\/data', policy.workspaceRoot)/" \
        packages/sandbox/sandbox-local/src/profiles.ts \
    && sed -i "s/args\.push('--tmpfs', '\/tmp')/args.push('--tmpfs', '\/tmp'); args.push('--bind', '\/data', '\/data')/" \
        packages/sandbox/sandbox-local/src/profiles.ts \
    && sed -i "s/readlinkSync, symlinkSync/readlinkSync, realpathSync, symlinkSync/" \
        packages/boot/app-boot/src/profile.ts \
    && sed -i "s/return candidate/return realpathSync(candidate)/" \
        packages/boot/app-boot/src/profile.ts

ENV NODE_OPTIONS="--max-old-space-size=2048"
RUN --mount=type=cache,target=/app/dsh/node_modules/.cache \
    pnpm run build:official

COPY bin/build-fix.mjs /tmp/build-fix.mjs
RUN NODE_PATH=/usr/local/lib/node_modules node /tmp/build-fix.mjs \
    && rm -rf /tmp/build-fix.mjs .git docs .agents examples test* **/*.tsbuildinfo node_modules/.cache

FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="dsh-docker" \
      org.opencontainers.image.licenses="MIT"

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
       python3 \
       python3-pip \
       python3-venv \
    && ln -s /usr/bin/python3 /usr/local/bin/python \
    && npm install -g pnpm@11.7.0 \
    && npm cache clean --force

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
COPY --chown=node:node --from=builder /app/dsh /app/dsh
COPY bin/dsh /usr/local/bin/dsh
COPY bin/manage-dsh-plugin /usr/local/bin/manage-dsh-plugin
COPY bin/link-modules.mjs /usr/local/bin/link-modules.mjs
COPY bin/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY bin/configure-nginx-auth /usr/local/bin/configure-nginx-auth
COPY bin/patch-profile-plugins.mjs /usr/local/bin/patch-profile-plugins.mjs
COPY bin/install-docker-control.mjs /usr/local/bin/install-docker-control.mjs
COPY dsh-home/ /etc/dsh-home/
COPY dsh-home/docker-control/ /opt/dsh-docker-control/
COPY nginx/dsh-nginx.conf /etc/dsh/nginx.conf

RUN cd /opt/dsh-docker-control \
    && npm install --omit=dev --ignore-scripts --no-package-lock \
    && npm cache clean --force \
    && mkdir -p /opt /data/dsh /data/agents /data/mcp /data/home /workspace \
    && chown -R node:node /opt /data /workspace \
    && chmod +x /usr/local/bin/dsh /usr/local/bin/manage-dsh-plugin /usr/local/bin/entrypoint.sh /usr/local/bin/configure-nginx-auth /usr/local/bin/patch-profile-plugins.mjs /usr/local/bin/install-docker-control.mjs \
    && printf '%s\n' 'export PATH="/data/home/.local/bin:/data/home/bin:/data/home/.npm-global/bin:$PATH"' > /etc/profile.d/dsh-toolchain.sh

ENV DSH_HOME=/data/dsh \
    DSH_AGENTS_HOME=/data/agents \
    HOME=/data/home \
    NODE_PATH=/app/dsh/node_modules:/data/dsh/profiles/node_modules \
    PATH=/data/home/.local/bin:/data/home/bin:/data/home/.npm-global/bin:${PATH}

WORKDIR /workspace

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["web"]
