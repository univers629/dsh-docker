import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// DSH itself owns $DSH_HOME/profiles/node_modules: healProfilesModuleFallback
// creates one symlink per package there and throws when an entry is not a
// symlink. An earlier image symlinked the whole directory to the app modules,
// which made DSH crash on boot as soon as the app used a real npm layout, so
// the prepared state must always be a real directory.
const script = fileURLToPath(new URL('../bin/prepare-profile-modules.mjs', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-modules-'))
const appDir = path.join(root, 'app')
const appModules = path.join(appDir, 'node_modules')
const profiles = path.join(root, 'profiles')
const profileModules = path.join(profiles, 'node_modules')
const linkType = process.platform === 'win32' ? 'junction' : 'dir'

fs.mkdirSync(path.join(appModules, 'commander'), { recursive: true })
fs.mkdirSync(profiles, { recursive: true })
fs.symlinkSync(appModules, profileModules, linkType)

const run = () => execFileSync(process.execPath, [script], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_APP_DIR: appDir, DSH_PROFILES_DIR: profiles },
})

const first = run()
assert.match(first, /已移除旧版整目录软链/)
assert.equal(fs.lstatSync(profileModules).isSymbolicLink(), false)
assert.equal(fs.lstatSync(profileModules).isDirectory(), true)
assert.equal(fs.readdirSync(profileModules).length, 0)

// A package symlink placed by DSH must survive the next preparation.
fs.symlinkSync(path.join(appModules, 'commander'), path.join(profileModules, 'commander'), linkType)
const second = run()
assert.doesNotMatch(second, /已移除旧版整目录软链/)
assert.equal(fs.lstatSync(path.join(profileModules, 'commander')).isSymbolicLink(), true)

// A missing runtime installation must fail loudly instead of silently booting.
fs.rmSync(appModules, { recursive: true, force: true })
assert.throws(run, /运行时模块目录不存在/)

fs.rmSync(root, { recursive: true, force: true })
console.log('profile modules smoke: ok')
