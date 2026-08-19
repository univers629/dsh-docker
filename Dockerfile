# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS builder

ARG UPSTREAM_REPO=https://github.com/deepseek-ai/deepseek-harness.git
ARG UPSTREAM_REF=master

ENV CI=true
WORKDIR /app/dsh

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11.7.0

RUN git clone --depth 1 -b ${UPSTREAM_REF} ${UPSTREAM_REPO} .

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

RUN sed -i 's/if (!(WIDER_MODES\[effectiveMode\]/if (effectiveMode === mode) return mode as SandboxMode; if (!(WIDER_MODES[effectiveMode]/' \
        packages/sandbox/sandbox/src/escalation.ts \
    && sed -i 's/if (justification !== undefined && justification.trim().length === 0)/if (justification !== undefined \&\& justification.trim().length === 0 \&\& sandboxPermissions !== "danger-full-access")/' \
        packages/sandbox/sandbox/src/escalation.ts \
    && sed -i "s/return \[...new Set(\[policy\.workspaceRoot, '\/tmp', tmpdir()\]/return [...new Set([policy.workspaceRoot, '\/data', '\/tmp', tmpdir()]/" \
        packages/sandbox/sandbox/src/roots.ts \
    && sed -i "s/readWrite\.push('\/tmp', policy\.workspaceRoot)/readWrite.push('\/tmp', '\/data', policy.workspaceRoot)/" \
        packages/sandbox/sandbox-local/src/profiles.ts \
    && sed -i "s/args\.push('--tmpfs', '\/tmp')/args.push('--tmpfs', '\/tmp'); args.push('--bind', '\/data', '\/data')/" \
        packages/sandbox/sandbox-local/src/profiles.ts

ENV NODE_OPTIONS="--max-old-space-size=2048"
RUN --mount=type=cache,target=/app/dsh/node_modules/.cache \
    pnpm run build

RUN grep -q 'connection\.isLoopback ? "host" : "memory"' packages/client/ui-settings/lib/client.js \
    && sed -i 's/connection\.isLoopback ? "host" : "memory"/"host"/' packages/client/ui-settings/lib/client.js \
    && node --check packages/client/ui-settings/lib/client.js

# 平铺所有 .pnpm 第三方依赖，链接所有工作区核心包，并清除所有嵌套干扰 node_modules
RUN node -e '
import fs from "node:fs";
import path from "node:path";

const pnpmDir = "/app/dsh/node_modules/.pnpm";
if (fs.existsSync(pnpmDir)) {
  fs.readdirSync(pnpmDir, { withFileTypes: true }).forEach(entry => {
    if (!entry.isDirectory()) return;
    const subModules = path.join(pnpmDir, entry.name, "node_modules");
    if (fs.existsSync(subModules)) {
      fs.readdirSync(subModules, { withFileTypes: true }).forEach(pkg => {
        const pkgPath = path.join(subModules, pkg.name);
        if (pkg.name.startsWith("@")) {
          const scopeDir = path.join("/app/dsh/node_modules", pkg.name);
          try { fs.mkdirSync(scopeDir, { recursive: true }); } catch {}
          fs.readdirSync(pkgPath, { withFileTypes: true }).forEach(scopedPkg => {
            const dest = path.join(scopeDir, scopedPkg.name);
            if (!fs.existsSync(dest)) {
              try { fs.symlinkSync(path.join(pkgPath, scopedPkg.name), dest); } catch {}
            }
          });
        } else {
          const dest = path.join("/app/dsh/node_modules", pkg.name);
          if (!fs.existsSync(dest)) {
            try { fs.symlinkSync(pkgPath, dest); } catch {}
          }
        }
      });
    }
  });
}

const scopeDir = "/app/dsh/node_modules/@deepseek-ai";
try { fs.mkdirSync(scopeDir, { recursive: true }); } catch {}

["packages", "vendor", "apps"].forEach(r => {
  if (!fs.existsSync(r)) return;
  fs.readdirSync(r, { withFileTypes: true }).forEach(g => {
    if (!g.isDirectory()) return;
    const gp = path.join(r, g.name);
    const dirs = fs.existsSync(path.join(gp, "package.json")) ? [gp] : fs.readdirSync(gp, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(gp, d.name));
    dirs.forEach(d => {
      const p = path.join(d, "package.json");
      if (fs.existsSync(p)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
          if (pkg.name && pkg.name.startsWith("@deepseek-ai/")) {
            const name = pkg.name.replace("@deepseek-ai/", "");
            const link = path.join(scopeDir, name);
            try { fs.rmSync(link, { recursive: true, force: true }); } catch {}
            fs.symlinkSync(path.resolve(d), link);
          }
        } catch {}
      }
    });
  });
});
' \
    && find packages vendor apps -mindepth 3 -maxdepth 5 -type d -name "node_modules" -prune -exec rm -rf {} + \
    && rm -rf .git docs .agents examples test* **/*.tsbuildinfo node_modules/.cache

FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="DeepSeek Harness Docker" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash \
       procps \
       git \
       ca-certificates \
       curl \
       nginx \
       gosu \
       python3 \
       python3-pip \
       python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/python3 /usr/local/bin/python \
    && npm install -g pnpm@11.7.0 \
    && npm cache clean --force

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
COPY --from=builder /app/dsh /app/dsh
COPY bin/dsh /usr/local/bin/dsh
COPY bin/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY dsh-home/ /etc/dsh-home/
COPY nginx/dsh-nginx.conf /etc/dsh/nginx.conf

RUN mkdir -p /opt /data/dsh /data/agents /data/mcp /data/home /workspace \
    && chown -R node:node /opt /app/dsh /data /workspace \
    && chmod +x /usr/local/bin/dsh /usr/local/bin/entrypoint.sh

ENV DSH_HOME=/data/dsh \
    DSH_AGENTS_HOME=/data/agents \
    HOME=/data/home \
    NODE_PATH=/app/dsh/node_modules:/data/dsh/profiles/node_modules \
    PATH=/data/home/.local/bin:/data/home/bin:/data/home/.npm-global/bin:${PATH}

WORKDIR /workspace

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3080/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["web"]