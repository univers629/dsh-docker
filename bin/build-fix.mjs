import fs from 'node:fs';
import path from 'node:path';

const appDir = '/app/dsh';
const rootModules = path.join(appDir, 'node_modules');

// 1. 定位 esbuild
let buildSync = null;
const possibleEsbuildPaths = [
  path.join(rootModules, 'esbuild/lib/main.js'),
  path.join(rootModules, 'tsdown/node_modules/esbuild/lib/main.js'),
  path.join(rootModules, 'tsx/node_modules/esbuild/lib/main.js'),
];
for (const p of possibleEsbuildPaths) {
  if (fs.existsSync(p)) {
    try {
      const m = await import(p);
      buildSync = m.buildSync;
      break;
    } catch {}
  }
}
if (!buildSync) {
  const pnpmDir = path.join(rootModules, '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    const entry = fs.readdirSync(pnpmDir).find(d => d.startsWith('esbuild@'));
    if (entry) {
      const p = path.join(pnpmDir, entry, 'node_modules/esbuild/lib/main.js');
      if (fs.existsSync(p)) {
        try {
          const m = await import(p);
          buildSync = m.buildSync;
        } catch {}
      }
    }
  }
}

if (!buildSync) {
  console.error('[build-fix] Fatal: esbuild not found');
  process.exit(1);
}

// 2. 编译所有源码包的 lib/index.js 与 lib/invariant.js
const roots = ['packages', 'vendor', 'apps'].map(x => path.join(appDir, x));
let compiled = 0;

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
        const srcIndex = path.join(d, 'src/index.ts');
        const libIndex = path.join(d, 'lib/index.js');
        const srcInv = path.join(d, 'src/invariant.ts');
        const libInv = path.join(d, 'lib/invariant.js');

        if (fs.existsSync(srcIndex)) {
          fs.mkdirSync(path.join(d, 'lib'), { recursive: true });
          try {
            buildSync({
              entryPoints: [srcIndex],
              outfile: libIndex,
              format: 'esm',
              platform: 'node',
              target: 'es2024',
              bundle: true,
              packages: 'external',
            });
            compiled++;
          } catch (e) {
            console.error(`Failed compiling ${d}:`, e);
          }
        }
        if (fs.existsSync(srcInv)) {
          fs.mkdirSync(path.join(d, 'lib'), { recursive: true });
          try {
            buildSync({
              entryPoints: [srcInv],
              outfile: libInv,
              format: 'esm',
              platform: 'node',
              target: 'es2024',
              bundle: true,
              packages: 'external',
            });
          } catch {}
        }
      }
    }
  }
}
console.log(`[build-fix] Compiled ${compiled} workspace library entrypoints.`);

// 3. 平铺所有 .pnpm 第三方依赖到 /app/dsh/node_modules
const pnpmDir = path.join(rootModules, '.pnpm');
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

// 4. 链接所有 @deepseek-ai/* 工作区包到 /app/dsh/node_modules/@deepseek-ai
const scopeDir = path.join(rootModules, '@deepseek-ai');
try { fs.mkdirSync(scopeDir, { recursive: true }); } catch {}

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
console.log('[build-fix] Dependency flattening and workspace linking complete.');
