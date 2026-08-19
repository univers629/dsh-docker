import fs from 'node:fs';
import path from 'node:path';

const appDir = '/app/dsh';
const appModules = path.join(appDir, 'node_modules');
const dataProfiles = '/data/dsh/profiles';
const dataModules = path.join(dataProfiles, 'node_modules');

// 1. 递归扫描 /app/dsh 发现所有工作区包
function findPackages(dir) {
  let results = [];
  try {
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of list) {
      if (item.name === 'node_modules' || item.name === '.git' || item.name === 'docs') continue;
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        const pkgJson = path.join(fullPath, 'package.json');
        if (fs.existsSync(pkgJson)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
            if (pkg.name) {
              results.push({ name: pkg.name, dir: fullPath });
            }
          } catch {}
        }
        results = results.concat(findPackages(fullPath));
      }
    }
  } catch {}
  return results;
}

const allPkgs = findPackages(appDir);

// 2. 确保在 /data/dsh/profiles/node_modules 中建立全量模块通道
try { fs.mkdirSync(dataModules, { recursive: true }); } catch {}

// 链接所有第三方依赖从 /app/dsh/node_modules 到 /data/dsh/profiles/node_modules
if (fs.existsSync(appModules)) {
  for (const entry of fs.readdirSync(appModules, { withFileTypes: true })) {
    if (entry.name === '@deepseek-ai') continue;
    const src = path.join(appModules, entry.name);
    const dest = path.join(dataModules, entry.name);
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    try { fs.symlinkSync(src, dest); } catch {}
  }
}

// 3. 在 /app/dsh/node_modules/@deepseek-ai 和 /data/dsh/profiles/node_modules/@deepseek-ai 建立绝对路径软链
const appScope = path.join(appModules, '@deepseek-ai');
const dataScope = path.join(dataModules, '@deepseek-ai');
try { fs.mkdirSync(appScope, { recursive: true }); } catch {}
try { fs.mkdirSync(dataScope, { recursive: true }); } catch {}

for (const pkg of allPkgs) {
  if (pkg.name.startsWith('@deepseek-ai/')) {
    const shortName = pkg.name.replace('@deepseek-ai/', '');
    for (const scopeDir of [appScope, dataScope]) {
      const link = path.join(scopeDir, shortName);
      try { fs.rmSync(link, { recursive: true, force: true }); } catch {}
      try { fs.symlinkSync(pkg.dir, link); } catch {}
    }
  }
}

console.log(`[link-modules] Successfully mapped ${allPkgs.length} packages with absolute paths.`);
