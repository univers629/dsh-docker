import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const appDir = process.env.DSH_BUILD_APP_DIR || '/app/dsh';
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

// Keep workspace packages external when producing the compatibility bundles.
// The harness relies on identity-bearing singletons (notably dsh-scope's
// private scope tag and Cordis' Context symbols). Bundling each package entry
// independently would create one copy per bundle, so an agent scope minted by
// dsh-agent-loop would be invisible to dsh-agent-presets. Runtime linking below
// provides the one canonical module instance for every workspace package.
const workspaceExternals = allPackages.map(({ name }) => name);

// 3. 无条件为所有包编译自包含的 lib/index.js 和 lib/invariant.js，并生成根 index.js 兜底
let compiled = 0;
for (const item of allPackages) {
  const d = item.dir;
  const srcIndex = path.join(d, 'src/index.ts');
  const libIndex = path.join(d, 'lib/index.js');
  const srcInv = path.join(d, 'src/invariant.ts');
  const libInv = path.join(d, 'lib/invariant.js');
  const rootIndex = path.join(d, 'index.js');

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
        external: workspaceExternals,
      });
      compiled++;
    } catch (e) {
      console.error(`[build-fix] Error compiling ${item.name}:`, e.message);
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

  // 生成根 index.js 兜底（以防任何 resolver 执行 legacy 查找）
  if (fs.existsSync(libIndex)) {
    try {
      fs.writeFileSync(rootIndex, "export * from './lib/index.js';\nexport { default } from './lib/index.js';\n");
    } catch {}
  }
}
console.log(`[build-fix] Compiled ${compiled} workspace library entrypoints.`);

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
