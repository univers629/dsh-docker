import fs from 'node:fs';
import path from 'node:path';

const appDir = '/app/dsh';
const pnpmDir = path.join(appDir, 'node_modules/.pnpm');
const rootModules = path.join(appDir, 'node_modules');

// 1. Flatten all .pnpm 3rd-party dependencies into /app/dsh/node_modules
if (fs.existsSync(pnpmDir)) {
  for (const entry of fs.readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const subModules = path.join(pnpmDir, entry.name, 'node_modules');
    if (fs.existsSync(subModules)) {
      for (const pkg of fs.readdirSync(subModules, { withFileTypes: true })) {
        const pkgPath = path.join(subModules, pkg.name);
        if (pkg.name.startsWith('@')) {
          const scopeDir = path.join(rootModules, pkg.name);
          try { fs.mkdirSync(scopeDir, { recursive: true }); } catch {}
          for (const scopedPkg of fs.readdirSync(pkgPath, { withFileTypes: true })) {
            const dest = path.join(scopeDir, scopedPkg.name);
            if (!fs.existsSync(dest)) {
              try { fs.symlinkSync(path.join(pkgPath, scopedPkg.name), dest); } catch {}
            }
          }
        } else {
          const dest = path.join(rootModules, pkg.name);
          if (!fs.existsSync(dest)) {
            try { fs.symlinkSync(pkgPath, dest); } catch {}
          }
        }
      }
    }
  }
}

// 2. Link all @deepseek-ai/* workspace packages directly into /app/dsh/node_modules/@deepseek-ai
const scopeDir = path.join(rootModules, '@deepseek-ai');
try { fs.mkdirSync(scopeDir, { recursive: true }); } catch {}

const roots = ['packages', 'vendor', 'apps'].map(r => path.join(appDir, r));
for (const r of roots) {
  if (!fs.existsSync(r)) continue;
  for (const g of fs.readdirSync(r, { withFileTypes: true })) {
    if (!g.isDirectory()) continue;
    const gp = path.join(r, g.name);
    const dirs = fs.existsSync(path.join(gp, 'package.json'))
      ? [gp]
      : fs.readdirSync(gp, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(gp, d.name));
    for (const d of dirs) {
      const p = path.join(d, 'package.json');
      if (fs.existsSync(p)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (pkg.name && pkg.name.startsWith('@deepseek-ai/')) {
            const name = pkg.name.replace('@deepseek-ai/', '');
            const link = path.join(scopeDir, name);
            try { fs.rmSync(link, { recursive: true, force: true }); } catch {}
            fs.symlinkSync(d, link);
          }
        } catch {}
      }
    }
  }
}
