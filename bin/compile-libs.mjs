import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

const appDir = '/app/dsh';
const roots = ['packages', 'vendor', 'apps'].map(x => path.join(appDir, x));

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
