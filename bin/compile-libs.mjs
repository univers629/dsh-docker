import fs from 'node:fs';
import path from 'node:path';

const appDir = '/app/dsh';
const roots = ['packages', 'vendor', 'apps'].map(x => path.join(appDir, x));

// 动态定位 esbuild
let buildSync = null;
try {
  const es = await import('esbuild');
  buildSync = es.buildSync;
} catch {
  const possiblePaths = [
    '/app/dsh/node_modules/esbuild/lib/main.js',
    '/app/dsh/node_modules/tsdown/node_modules/esbuild/lib/main.js',
    '/app/dsh/node_modules/tsx/node_modules/esbuild/lib/main.js',
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        const es = await import(p);
        buildSync = es.buildSync;
        break;
      } catch {}
    }
  }
  if (!buildSync) {
    const pnpmDir = '/app/dsh/node_modules/.pnpm';
    if (fs.existsSync(pnpmDir)) {
      const entry = fs.readdirSync(pnpmDir).find(d => d.startsWith('esbuild@'));
      if (entry) {
        const p = path.join(pnpmDir, entry, 'node_modules/esbuild/lib/main.js');
        if (fs.existsSync(p)) {
          const es = await import(p);
          buildSync = es.buildSync;
        }
      }
    }
  }
}

if (!buildSync) {
  console.error('[Compile-Libs] Fatal: esbuild not found');
  process.exit(1);
}

let compiledCount = 0;

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
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        const srcIndex = path.join(d, 'src/index.ts');
        const libIndex = path.join(d, 'lib/index.js');
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
            compiledCount++;
          } catch (e) {
            console.error(`[Compile-Libs] Failed to compile ${pkg.name}:`, e);
          }
        }
      }
    }
  }
}

console.log(`[Compile-Libs] Successfully compiled ${compiledCount} missing library packages.`);
