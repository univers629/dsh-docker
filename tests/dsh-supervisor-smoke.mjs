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
export DSH_RESTART_DELAY=5

# 假的 DSH：先把自己拿到的环境记下来，再变成一个长睡进程。exec 保证 PID 不变，
# Supervisor 记录的就是它自己。
cat > /tmp/fake-dsh <<'FAKE'
#!/bin/sh
printf '%s\n' "HOME=$HOME" "DSH_SUPERVISED=$DSH_SUPERVISED" "INVOCATION_ID=$INVOCATION_ID" > /tmp/dsh-child-env
exec sleep 300
FAKE
chmod +x /tmp/fake-dsh
export DSH_EXECUTABLE=/tmp/fake-dsh

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

# 子进程的环境：HOME 必须显式给到运行账户的家目录（镜像不再给全容器设 HOME），
# 并且要带上"本 host 由外部 Supervisor 托管"的标记，否则会自重启的插件会去抢端口。
grep -qx 'HOME=/data/home' /tmp/dsh-child-env
grep -qx 'DSH_SUPERVISED=1' /tmp/dsh-child-env
grep -qE '^INVOCATION_ID=[0-9a-f]{32}$' /tmp/dsh-child-env

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

# 子进程意外死掉之后的 backoff 窗口（这里是 5 秒）：check 要用退出码 3 把
# "Supervisor 在、子进程暂时不在" 和 "Supervisor 没了" 区分开，而 request 不该报错，
# 因为 Supervisor 已经在准备重新拉起——面板的重启按钮就是靠这条不再误报失败。
kill -KILL "$second_dsh"
attempt=0
while [ -s /run/dsh.pid ] && [ "$attempt" -lt 50 ]; do
  attempt=$((attempt + 1))
  sleep 0.1
done
[ ! -s /run/dsh.pid ]
check_status=0
/usr/local/bin/restart-dsh check || check_status=$?
[ "$check_status" = 3 ]
/usr/local/bin/restart-dsh request

attempt=0
third_dsh=''
while [ -z "$third_dsh" ] && [ "$attempt" -lt 150 ]; do
  attempt=$((attempt + 1))
  sleep 0.1
  third_dsh=$(sed -n '1p' /run/dsh.pid 2>/dev/null || printf '')
done
[ -n "$third_dsh" ]
[ "$third_dsh" != "$second_dsh" ]

kill -TERM "$supervisor_pid"
wait "$supervisor_job"
printf '%s\n' "$supervisor_pid:$first_dsh:$second_dsh"
`

const result = spawnSync('docker', [
  'run', '--rm', '--entrypoint', '/bin/sh', image, '-c', script,
], { encoding: 'utf8', timeout: 60000 })

assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
assert.match(result.stdout, /^\d+:\d+:\d+$/m)
console.log('dsh supervisor smoke: ok')
