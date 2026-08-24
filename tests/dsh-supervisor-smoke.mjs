import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const image = process.env.DSH_TEST_IMAGE
if (!image) {
  console.log('dsh supervisor smoke: skipped (set DSH_TEST_IMAGE to run the container test)')
  process.exit(0)
}

const script = String.raw`
set -eu
export DSH_DISABLE_NGINX=true
export DSH_PREPARE_EXECUTABLE=/bin/true
export DSH_EXECUTABLE=/bin/sleep
export DSH_RESTART_DELAY=1

/usr/local/bin/dsh-supervisor 300 &
supervisor_job=$!

attempt=0
while [ ! -s /run/dsh.pid ] && [ "$attempt" -lt 100 ]; do
  attempt=$((attempt + 1))
  sleep 0.1
done
[ -s /run/dsh.pid ]
first_dsh=$(sed -n '1p' /run/dsh.pid)
supervisor_pid=$(sed -n '1p' /run/dsh-supervisor.pid)
[ "$supervisor_pid" = "$supervisor_job" ]

/usr/local/bin/restart-dsh check
/usr/local/bin/restart-dsh request

attempt=0
second_dsh=$first_dsh
while [ "$second_dsh" = "$first_dsh" ] && [ "$attempt" -lt 100 ]; do
  attempt=$((attempt + 1))
  sleep 0.1
  second_dsh=$(sed -n '1p' /run/dsh.pid 2>/dev/null || printf '%s' "$first_dsh")
done

[ "$second_dsh" != "$first_dsh" ]
kill -0 "$supervisor_pid"
[ "$(sed -n '1p' /run/dsh-supervisor.pid)" = "$supervisor_pid" ]

kill -TERM "$supervisor_pid"
wait "$supervisor_job"
printf '%s\n' "$supervisor_pid:$first_dsh:$second_dsh"
`

const result = spawnSync('docker', [
  'run', '--rm', '--entrypoint', '/bin/sh', image, '-c', script,
], { encoding: 'utf8', timeout: 30000 })

assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
assert.match(result.stdout, /^\d+:\d+:\d+$/m)
console.log('dsh supervisor smoke: ok')
