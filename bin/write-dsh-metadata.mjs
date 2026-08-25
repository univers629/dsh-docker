import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [appDir, patchDir, outputPath] = process.argv.slice(2)
if (!appDir || !patchDir || !outputPath) {
  console.error('usage: write-dsh-metadata.mjs <app-dir> <patch-dir> <output>')
  process.exit(2)
}

const packageName = process.env.DSH_NPM_PACKAGE ?? '@deepseek-ai/dsh'
const packageRoot = join(appDir, 'lib', 'node_modules', packageName)

function installedVersion() {
  const manifest = join(packageRoot, 'package.json')
  if (!existsSync(manifest)) return 'unknown'
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

// 补丁集指纹只取定义文件本身：产物补丁的全部内容都在这一个文件里，
// 所以它的哈希就是“这套运行时被改成了什么样”的完整答案。
function patchsetHash() {
  const definitions = join(patchDir, 'artifact-patches.mjs')
  if (!existsSync(definitions)) return 'unknown'
  return createHash('sha256').update(readFileSync(definitions)).digest('hex')
}

const metadata = {
  package: packageName,
  version: installedVersion(),
  source: 'npm',
  entry: join('lib', 'node_modules', packageName, 'lib', 'bin.js'),
  patchsetHash: patchsetHash(),
  installedAt: new Date().toISOString(),
}
writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 })
