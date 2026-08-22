import fs from 'node:fs'
import path from 'node:path'

const source = process.env.DSH_DOCKER_CONTROL_SOURCE ?? '/opt/dsh-docker-control'
const profile = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web'
const target = path.join(profile, 'node_modules', 'dsh-docker-control')
const manifestPath = path.join(profile, 'package.json')
const patchPath = path.join(profile, 'cordis.patch.yml')
const workspacePath = path.join(profile, 'pnpm-workspace.yaml')

if (!fs.existsSync(path.join(source, 'package.json'))) process.exit(0)

function ensureWebProfile() {
  fs.mkdirSync(profile, { recursive: true })
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      name: `dsh-profile-${path.basename(profile)}`,
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        },
      },
    }, null, 2)}\n`, 'utf8')
  }
  if (!fs.existsSync(patchPath)) fs.writeFileSync(patchPath, '[]\n', 'utf8')
  if (!fs.existsSync(workspacePath)) {
    fs.writeFileSync(workspacePath, 'nodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
  }
}

// The upstream web profile is normally initialized lazily by dsh itself. The
// built-in plugin is installed before dsh starts, so initialize the same
// profile files here when the persistent profile directory is empty.
ensureWebProfile()

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
