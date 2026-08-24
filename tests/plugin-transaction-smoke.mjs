import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [manager, cleanup] = await Promise.all([
  readFile(new URL('../bin/manage-dsh-plugin', import.meta.url), 'utf8'),
  readFile(new URL('../bin/cleanup-dsh-plugin-transactions', import.meta.url), 'utf8'),
])

assert.doesNotMatch(manager, /--ignore-scripts/)
assert.match(manager, /dangerouslyAllowAllBuilds: true/)
assert.match(manager, /mktemp -d "\$profiles_root\/\.plugin-transaction\.XXXXXX"/)
assert.match(manager, /validate-dsh-profile\.mjs/)
assert.match(manager, /mv "\$profile" "\$backup"/)
assert.match(manager, /mv "\$stage_profile" "\$profile"/)
assert.match(manager, /restart-dsh/)
assert.match(manager, /实时 profile 尚未修改/)
assert.match(manager, /pnpm-tmp\.before/)
assert.match(manager, /comm -13/)
assert.doesNotMatch(manager, /kill -TERM "\$target_pid"|docker restart|compose restart/)
assert.match(cleanup, /\.plugin-transaction\.\*/)
assert.match(cleanup, /\.web\.previous\.\*/)

const image = process.env.DSH_TEST_IMAGE
if (!image) {
  console.log('plugin transaction smoke: static ok; cleanup runtime skipped (set DSH_TEST_IMAGE)')
  process.exit(0)
}

const script = String.raw`
set -eu
root=/tmp/dsh-plugin-cleanup-test
profiles=$root/profiles
profile=$profiles/web
lock=$root/plugin-transaction.lock
mkdir -p "$profile" "$profiles/.plugin-transaction.failed" "$profiles/.web.previous.old"
printf live > "$profile/marker"

DSH_PROFILE_ROOT="$profile" DSH_PLUGIN_LOCK_DIR="$lock" /usr/local/bin/cleanup-dsh-plugin-transactions
[ "$(cat "$profile/marker")" = live ]
[ ! -d "$profiles/.plugin-transaction.failed" ]
[ ! -d "$profiles/.web.previous.old" ]

pnpm_store=/data/home/plugin-test-store
mkdir -p "$profiles/.plugin-transaction.pnpm" "$pnpm_store/tmp/_tmp_created_by_transaction"
printf '%s\n' "$pnpm_store" > "$profiles/.plugin-transaction.pnpm/pnpm-store.path"
: > "$profiles/.plugin-transaction.pnpm/pnpm-tmp.before"
DSH_PROFILE_ROOT="$profile" DSH_PLUGIN_LOCK_DIR="$lock" /usr/local/bin/cleanup-dsh-plugin-transactions
[ ! -d "$pnpm_store/tmp/_tmp_created_by_transaction" ]

rm -rf "$profile"
mkdir -p "$profiles/.web.previous.recover" "$profiles/.plugin-transaction.interrupted"
printf restored > "$profiles/.web.previous.recover/marker"
DSH_PROFILE_ROOT="$profile" DSH_PLUGIN_LOCK_DIR="$lock" /usr/local/bin/cleanup-dsh-plugin-transactions
[ "$(cat "$profile/marker")" = restored ]
[ ! -d "$profiles/.plugin-transaction.interrupted" ]

mkdir -p "$lock" "$profiles/.plugin-transaction.active"
printf '%s\n%s\n' "$$" "$(awk '{ print $22 }' /proc/$$/stat)" > "$lock/pid"
DSH_PROFILE_ROOT="$profile" DSH_PLUGIN_LOCK_DIR="$lock" /usr/local/bin/cleanup-dsh-plugin-transactions
[ -d "$profiles/.plugin-transaction.active" ]
rm -rf "$lock"
DSH_PROFILE_ROOT="$profile" DSH_PLUGIN_LOCK_DIR="$lock" /usr/local/bin/cleanup-dsh-plugin-transactions
[ ! -d "$profiles/.plugin-transaction.active" ]
`

const result = spawnSync('docker', [
  'run', '--rm', '--entrypoint', '/bin/sh', image, '-c', script,
], { encoding: 'utf8', timeout: 30000 })

assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
console.log('plugin transaction smoke: ok')

if (process.env.DSH_REAL_PLUGIN_TEST === 'true') {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-real-plugin-'))
  const realScript = String.raw`
set -eu
mkdir -p /data/dsh/profiles /data/home
node /usr/local/bin/install-docker-control.mjs

DSH_DISABLE_NGINX=true DSH_PREPARE_EXECUTABLE=/bin/true \
  DSH_EXECUTABLE=/bin/sleep DSH_RESTART_DELAY=1 \
  /usr/local/bin/dsh-supervisor 300 &
supervisor_pid=$!
attempt=0
while ! /usr/local/bin/restart-dsh check 2>/dev/null && [ "$attempt" -lt 100 ]; do
  attempt=$((attempt + 1))
  sleep 0.1
done
/usr/local/bin/restart-dsh check

/usr/local/bin/manage-dsh-plugin install github:dsh-market/dsh-market
test -f /data/dsh/profiles/web/node_modules/dshmarket/lib/index.js
! grep -q dangerouslyAllowAllBuilds /data/dsh/profiles/web/pnpm-workspace.yaml
test -z "$(find /data/dsh/profiles -maxdepth 1 -type d -name '.plugin-transaction.*' -print)"
test -z "$(find /data/dsh/profiles -maxdepth 1 -type d -name '.web.previous.*' -print)"
store=$(cd /data/dsh/profiles/web && pnpm store path)
test -z "$(find "$store/tmp" -mindepth 1 -maxdepth 1 -type d -name '_tmp_*' -print 2>/dev/null)"

kill -TERM "$supervisor_pid"
wait "$supervisor_pid"
`
  try {
    const real = spawnSync('docker', [
      'run', '--rm', '--entrypoint', '/bin/sh', '-v', `${dataRoot}:/data`, image, '-c', realScript,
    ], { encoding: 'utf8', timeout: 180000 })
    assert.equal(real.status, 0, `${real.stdout}\n${real.stderr}`)
    assert.match(real.stdout, /prepare/)
    assert.match(real.stdout, /validated 4 runtime bundle entries/)
    console.log('plugin transaction real Git build: ok')
  } finally {
    await rm(dataRoot, { recursive: true, force: true })
  }
}
