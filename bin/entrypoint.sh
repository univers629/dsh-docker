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

# 自动清理可能破坏模块解析链的嵌套 node_modules
find "$DSH_HOME/profiles" -mindepth 2 -maxdepth 2 -name "node_modules" -exec rm -rf {} + 2>/dev/null || true
find /app/dsh/packages /app/dsh/vendor -mindepth 3 -maxdepth 4 -type d -name "node_modules" -exec rm -rf {} + 2>/dev/null || true

# 彻底平铺并修复所有 @deepseek-ai/* 模块全局链接，消除任何软链接断链
node -e '
import fs from "node:fs";
import path from "node:path";
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