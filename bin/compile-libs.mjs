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
  console.error('[Compile-Libs] Warning: esbuild not found in standard paths');
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
        const srcDir = path.join(d, 'src');
        const libDir = path.join(d, 'lib');
        if (fs.existsSync(srcDir)) {
          const files = fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })
            .filter(f => f.isFile() && (f.name.endsWith('.ts') || f.name.endsWith('.js')))
            .map(f => {
              const base = f.parentPath || f.path || srcDir;
              return path.join(base, f.name);
            });

          for (const file of files) {
            const rel = path.relative(srcDir, file);
            const outFile = path.join(libDir, rel.replace(/\.tsx?$/, '.js'));
            if (!fs.existsSync(outFile)) {
              fs.mkdirSync(path.dirname(outFile), { recursive: true });
              try {
                buildSync({
                  entryPoints: [file],
                  outfile: outFile,
                  format: 'esm',
                  platform: 'node',
                  target: 'es2024',
                  bundle: false,
                });
                compiledCount++;
              } catch (e) {
                // ignore
              }
            }
          }
        }
      }
    }
  }
}

console.log(`[Compile-Libs] Successfully compiled ${compiledCount} missing library files.`);
