import fs from 'node:fs'
import path from 'node:path'

const source = process.env.DSH_DOCKER_CONTROL_SOURCE ?? '/opt/dsh-docker-control'
const profile = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web'
const target = path.join(profile, 'node_modules', 'dsh-docker-control')
const manifestPath = path.join(profile, 'package.json')

if (!fs.existsSync(path.join(source, 'package.json')) || !fs.existsSync(manifestPath)) process.exit(0)

fs.mkdirSync(path.dirname(target), { recursive: true })
fs.cpSync(source, target, { recursive: true, force: true })

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) process.exit(0)
  if (!bundles.includes('dsh-docker-control')) {
    manifest.dsh.profile.bundles = [...bundles, 'dsh-docker-control']
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    process.stderr.write('[dsh] enabled built-in Docker control plugin\n')
  }
} catch {
  process.stderr.write('[dsh] Docker control plugin could not update the web profile\n')
}
