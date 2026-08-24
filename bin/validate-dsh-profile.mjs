import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const profile = path.resolve(process.argv[2] ?? '')
if (!profile) throw new Error('profile path is required')

const manifestPath = path.join(profile, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles
if (!Array.isArray(bundles)) throw new Error('profile package.json does not declare dsh.profile.bundles')

const require = createRequire(manifestPath)
for (const bundle of bundles) {
  if (typeof bundle !== 'string' || bundle.length === 0) throw new Error('profile contains an invalid bundle name')
  let entry
  try {
    entry = require.resolve(bundle)
  } catch (error) {
    throw new Error(`bundle ${bundle} has no resolvable runtime entry: ${error.message}`)
  }
  try {
    await import(`${pathToFileURL(entry).href}?dsh-profile-validation=${Date.now()}`)
  } catch (error) {
    throw new Error(`bundle ${bundle} failed to import ${entry}: ${error.message}`)
  }
}

process.stdout.write(`[dsh-plugin] validated ${bundles.length} runtime bundle entries\n`)
