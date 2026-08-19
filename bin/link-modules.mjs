import fs from 'node:fs';
import path from 'node:path';

const appDir = '/app/dsh';
const appModules = path.join(appDir, 'node_modules');
const dataProfiles = '/data/dsh/profiles';
const dataModules = path.join(dataProfiles, 'node_modules');

// 0. 动态修补 app-boot 的模块软链解析，确保返回物理真实路径而非嵌套相对软链
const appBootLib = path.join(appDir, 'packages/boot/app-boot/lib/index.js');
if (fs.existsSync(appBootLib)) {
  try {
    let code = fs.readFileSync(appBootLib, 'utf8');
    if (code.includes('return candidate') && !code.includes('realpathSync(candidate)')) {
      code = code.replace(/return candidate/g, 'return realpathSync(candidate)');
      fs.writeFileSync(appBootLib, code);
      console.log('[link-modules] Patched app-boot realpath resolution.');
    }
  } catch {}
}

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

// 2. 为每个工作区包生成根 index.js 兜底（以防 Node 旧版 Legacy Resolver 查找根 index.js）
for (const pkg of allPkgs) {
  const libIndex = path.join(pkg.dir, 'lib/index.js');
  const rootIndex = path.join(pkg.dir, 'index.js');
  if (fs.existsSync(libIndex) && !fs.existsSync(rootIndex)) {
    try {
      fs.writeFileSync(rootIndex, "export * from './lib/index.js';\nexport { default } from './lib/index.js';\n");
    } catch {}
  }
}

// 3. 平铺所有 .pnpm 第三方依赖到 /app/dsh/node_modules 和 /data/dsh/profiles/node_modules
function flattenPnpm(targetDir) {
  const pnpmDir = path.join(appModules, '.pnpm');
  if (!fs.existsSync(pnpmDir)) return;
  try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
  for (const entry of fs.readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(pnpmDir, entry.name, 'node_modules');
    if (!fs.existsSync(sub)) continue;
    for (const pkg of fs.readdirSync(sub, { withFileTypes: true })) {
      const pkgPath = path.join(sub, pkg.name);
      if (pkg.name.startsWith('@')) {
        const scopeDest = path.join(targetDir, pkg.name);
        try { fs.mkdirSync(scopeDest, { recursive: true }); } catch {}
        for (const scopedPkg of fs.readdirSync(pkgPath, { withFileTypes: true })) {
          const dest = path.join(scopeDest, scopedPkg.name);
          const src = path.join(pkgPath, scopedPkg.name);
          try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
          try { fs.symlinkSync(src, dest); } catch {}
        }
      } else {
        const dest = path.join(targetDir, pkg.name);
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
        try { fs.symlinkSync(pkgPath, dest); } catch {}
      }
    }
  }
}

flattenPnpm(appModules);
flattenPnpm(dataModules);

// 4. 链接所有普通第三方模块到 profiles
if (fs.existsSync(appModules)) {
  for (const entry of fs.readdirSync(appModules, { withFileTypes: true })) {
    if (entry.name === '@deepseek-ai') continue;
    const src = path.join(appModules, entry.name);
    const dest = path.join(dataModules, entry.name);
    if (!fs.existsSync(dest)) {
      try { fs.symlinkSync(src, dest); } catch {}
    }
  }
}

// 5. 在 /app/dsh/node_modules/@deepseek-ai 和 /data/dsh/profiles/node_modules/@deepseek-ai 建立绝对路径软链
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

console.log(`[link-modules] Successfully mapped ${allPkgs.length} workspace packages and all flattened pnpm dependencies.`);
