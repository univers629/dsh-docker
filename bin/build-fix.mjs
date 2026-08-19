import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const appDir = '/app/dsh';
const rootModules = path.join(appDir, 'node_modules');
const require = createRequire(path.join(appDir, 'package.json'));

// 1. 获取 esbuild 的 buildSync
let buildSync = null;
try {
  const esbuild = require('esbuild');
  buildSync = esbuild.buildSync;
} catch {
  try {
    const esbuild = await import('esbuild');
    buildSync = esbuild.buildSync || esbuild.default?.buildSync;
  } catch {}
}

if (!buildSync) {
  console.error('[build-fix] Fatal: esbuild not found');
  process.exit(1);
}

// 2. 递归查找工作区中所有 package.json
function findPackages(dir) {
  let results = [];
  try {
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of list) {
      if (item.name === 'node_modules' || item.name === '.git' || item.name === 'docs' || item.name === 'website') continue;
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        const pkgJson = path.join(fullPath, 'package.json');
        if (fs.existsSync(pkgJson)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
            if (pkg.name) {
              results.push({ name: pkg.name, dir: fullPath, pkg });
            }
          } catch {}
        }
        results = results.concat(findPackages(fullPath));
      }
    }
  } catch {}
  return results;
}

const allPackages = findPackages(appDir);
console.log(`[build-fix] Discovered ${allPackages.length} workspace packages.`);

// 3. 为所有缺失入口的包编译 lib/index.js 和 lib/invariant.js
let compiled = 0;
for (const item of allPackages) {
  const d = item.dir;
  const srcIndex = path.join(d, 'src/index.ts');
  const libIndex = path.join(d, 'lib/index.js');
  const srcInv = path.join(d, 'src/invariant.ts');
  const libInv = path.join(d, 'lib/invariant.js');

  if (fs.existsSync(srcIndex) && !fs.existsSync(libIndex)) {
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
      console.error(`[build-fix] Error compiling ${item.name}:`, e.message);
    }
  }

  if (fs.existsSync(srcInv) && !fs.existsSync(libInv)) {
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
console.log(`[build-fix] Compiled ${compiled} missing workspace library entrypoints.`);

// 4. 平铺所有 .pnpm 第三方依赖到 /app/dsh/node_modules
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

// 5. 链接所有 @deepseek-ai/* 工作区包到 /app/dsh/node_modules/@deepseek-ai
const scopeDir = path.join(rootModules, '@deepseek-ai');
try { fs.mkdirSync(scopeDir, { recursive: true }); } catch {}

for (const item of allPackages) {
  if (item.name.startsWith('@deepseek-ai/')) {
    const shortName = item.name.replace('@deepseek-ai/', '');
    const link = path.join(scopeDir, shortName);
    try { fs.rmSync(link, { recursive: true, force: true }); } catch {}
    try { fs.symlinkSync(item.dir, link); } catch {}
  }
}
console.log('[build-fix] Dependency flattening and workspace linking complete.');
