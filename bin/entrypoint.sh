#!/bin/sh
set -eu

export NODE_PATH="/app/dsh/node_modules:/data/dsh/profiles/node_modules:${NODE_PATH:-}"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data /workspace
  chmod -R u+rwX,g+rwX /data /workspace
  find /data -name "*credentials*" -exec chmod 600 {} + 2>/dev/null || true
  find /data -name ".*credentials*" -exec chmod 600 {} + 2>/dev/null || true
  if [ -d "$HOME/.ssh" ]; then
    chmod 700 "$HOME/.ssh"
    find "$HOME/.ssh" -type f -exec chmod 600 {} + 2>/dev/null || true
    find "$HOME/.ssh" -type f -name "*.pub" -exec chmod 644 {} + 2>/dev/null || true
    find "$HOME/.ssh" -type f -name "known_hosts*" -exec chmod 644 {} + 2>/dev/null || true
  fi
fi

if [ -f "$DSH_HOME/.credentials.yaml" ]; then
  chmod 600 "$DSH_HOME/.credentials.yaml" 2>/dev/null || true
fi

# 自动清理可能破坏模块解析链的子 profile node_modules 局部遮挡
find "$DSH_HOME/profiles" -mindepth 2 -maxdepth 2 -name "node_modules" -exec rm -rf {} + 2>/dev/null || true

# 彻底平铺并打通所有第三方依赖库（如 zod, yaml, dotenv 等）和所有 @deepseek-ai/* 核心包
node -e '
import fs from "node:fs";
import path from "node:path";

// 1. 平铺 .pnpm 下所有第三方依赖到 /app/dsh/node_modules
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

// 2. 注入所有 @deepseek-ai/* 工作区核心包
const roots = ["/app/dsh/packages", "/app/dsh/vendor", "/app/dsh/apps"];
const targetDirs = ["/app/dsh/node_modules/@deepseek-ai", "/data/dsh/profiles/node_modules/@deepseek-ai"];
targetDirs.forEach(t => { try { fs.mkdirSync(t, { recursive: true }); } catch {} });
roots.forEach(r => {
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
            targetDirs.forEach(t => {
              const link = path.join(t, name);
              try { fs.rmSync(link, { recursive: true, force: true }); } catch {}
              try { fs.symlinkSync(d, link); } catch {}
            });
          }
        } catch {}
      }
    });
  });
});
' 2>/dev/null || true

if [ ! -f "$DSH_HOME/cordis.patch.yml" ]; then
  install -o node -g node -m 600 /etc/dsh-home/cordis.patch.yml "$DSH_HOME/cordis.patch.yml"
fi

mkdir -p "$DSH_HOME/skills/container-environment"
cp -f /etc/dsh-home/skills/container-environment/SKILL.md "$DSH_HOME/skills/container-environment/SKILL.md"
chown -R node:node "$DSH_HOME/skills"

if [ ! -f "$HOME/.npmrc" ]; then
  printf "prefix=%s/.npm-global\n" "$HOME" > "$HOME/.npmrc"
  chown node:node "$HOME/.npmrc"
fi

if [ "$(id -u)" = "0" ]; then
  gosu node nginx -c /etc/dsh/nginx.conf -g "daemon off;" &
  sleep 1
  exec gosu node /usr/local/bin/dsh "$@"
else
  nginx -c /etc/dsh/nginx.conf -g "daemon off;" &
  sleep 1
  exec /usr/local/bin/dsh "$@"
fi