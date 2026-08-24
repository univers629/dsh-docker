import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const [sourceDir, patchDir, outputPath] = process.argv.slice(2)
if (!sourceDir || !patchDir || !outputPath) {
  console.error('usage: write-dsh-metadata.mjs <source-dir> <patch-dir> <output>')
  process.exit(2)
}

function packageVersion() {
  const candidates = [
    join(sourceDir, 'package.json'),
    join(sourceDir, 'apps', 'cli', 'package.json'),
    join(sourceDir, 'packages', 'cli', 'package.json'),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const packageJson = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof packageJson.version === 'string' && packageJson.version.length > 0) {
        return packageJson.version
      }
    } catch {}
  }
  return 'unknown'
}

function patchHash() {
  const hash = createHash('sha256')
  const files = readdirSync(patchDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.patch'))
    .map(entry => entry.name)
    .sort()
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(join(patchDir, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

let commit = 'unknown'
try {
  commit = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {}

const metadata = {
  version: packageVersion(),
  upstreamCommit: commit,
  patchsetHash: patchHash(),
  builtAt: new Date().toISOString(),
}
writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 })
