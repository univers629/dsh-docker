// 回归：宿主运维 CLI（dsh.sh）与安装器（install.sh）必须对同一份 .env 算出同一套
// compose 叠加层与 profile。
//
// 这里钉住两个缺口：
//   1. dsh.sh 过去只认密钥与出站叠加层，对密码/多用户部署执行 restart 会起出一套
//      **没有入口**的容器（认证网关与七层入口都不在参数里）；
//   2. 多用户把访问方式固定为 password，于是安装器同时开了 authgate 与 multiuser
//      两个 profile——两个入口容器发布同一个宿主端口，第二个绑定必然失败。
//
// 做法：把 dsh.sh 复制进沙箱、用假 docker 跑 `status` 读出它真正传给 compose 的参数；
// 另一边从 install.sh 里逐字取出 set_compose_args 并跑同一组 PENDING_*，两侧比对。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`].find(existsSync)
  : 'bash'
assert.ok(bash, 'bash is required for the overlay parity smoke test')

const bashPath = (value) => (process.platform === 'win32'
  ? value.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
  : value)

const dshSh = await readFile(join(root, 'dsh.sh'), 'utf8')
const install = await readFile(join(root, 'install.sh'), 'utf8')
const functionStart = install.indexOf('set_compose_args() {')
const functionEnd = install.indexOf('\n}', functionStart)
assert.ok(functionStart >= 0 && functionEnd > functionStart, 'cannot locate set_compose_args in install.sh')
const setComposeArgs = install.slice(functionStart, functionEnd + 2)

const OVERLAYS = [
  'docker-compose.yml',
  'docker-compose.keys.yml',
  'docker-compose.keys-admin.yml',
  'docker-compose.auth.yml',
  'docker-compose.multiuser.yml',
  'docker-compose.basic-auth.yml',
  'docker-compose.isolated.yml',
]

// 每个场景：.env 里的开关 + 需要缺席的叠加文件 + 该产物里必须出现/不得出现的标记。
const scenarios = [
  {
    name: 'local（最小部署）',
    env: { DSH_ACCESS_MODE: 'local' },
    expect: { files: ['docker-compose.yml'], profiles: [] },
  },
  {
    name: 'basic',
    env: { DSH_ACCESS_MODE: 'basic' },
    expect: { files: ['docker-compose.yml', 'docker-compose.basic-auth.yml'], profiles: [] },
  },
  {
    name: 'password（单管理员入口）',
    env: { DSH_ACCESS_MODE: 'password' },
    expect: {
      files: ['docker-compose.yml', 'docker-compose.auth.yml'],
      profiles: ['authgate'],
    },
  },
  {
    name: '多用户（入口只能有一个）',
    env: { DSH_ACCESS_MODE: 'password', DSH_MULTI_USER: 'on' },
    expect: {
      files: ['docker-compose.yml', 'docker-compose.auth.yml', 'docker-compose.multiuser.yml'],
      profiles: ['multiuser'],
      forbiddenProfiles: ['authgate'],
    },
  },
  {
    name: '多用户 + 密钥 + 面板 + 出站黑名单（全叠加）',
    env: {
      DSH_ACCESS_MODE: 'password',
      DSH_MULTI_USER: 'on',
      DSH_MODEL_BROKER: 'on',
      DSH_KEY_ADMIN: 'on',
      DSH_EGRESS_MODE: 'blocklist',
    },
    expect: {
      files: [
        'docker-compose.yml',
        'docker-compose.keys.yml',
        'docker-compose.keys-admin.yml',
        'docker-compose.auth.yml',
        'docker-compose.multiuser.yml',
        'docker-compose.isolated.yml',
      ],
      profiles: ['multiuser'],
      forbiddenProfiles: ['authgate'],
    },
  },
]

const dockerMock = `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
case "$1" in
  info) exit 0 ;;
  *) exit 0 ;;
esac
`

/** 从 dsh.sh 里读出它传给 compose 的叠加层与 profile（按出现顺序）。 */
function overlaysFromArgs(args) {
  const files = []
  const profiles = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-f') files.push(args[index + 1])
    if (args[index] === '--profile') profiles.push(args[index + 1])
  }
  return { files, profiles }
}

for (const scenario of scenarios) {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-overlay-args-'))
  const missing = new Set(scenario.missing ?? [])
  try {
    for (const file of OVERLAYS) {
      if (missing.has(file)) continue
      await writeFile(join(sandbox, file), 'services: {}\n')
    }
    await mkdir(join(sandbox, 'data', 'auth'), { recursive: true })
    await writeFile(join(sandbox, 'data', 'auth', 'htpasswd'), 'dsh:$2y$stub\n')
    await writeFile(join(sandbox, '.env'), `${Object.entries(scenario.env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
    await writeFile(join(sandbox, 'dsh.sh'), dshSh)

    const mockBin = join(sandbox, 'mock-bin')
    await mkdir(mockBin)
    await writeFile(join(mockBin, 'docker'), dockerMock)
    await chmod(join(mockBin, 'docker'), 0o755)
    const dockerLog = join(sandbox, 'docker.log')
    await writeFile(dockerLog, '')

    // --- CLI 侧：跑 status，读它真正传出去的参数 ---
    const cli = spawnSync(bash, [bashPath(join(sandbox, 'dsh.sh')), 'status'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bashPath(mockBin)}:${process.env.PATH}`,
        MOCK_DOCKER_LOG: bashPath(dockerLog),
      },
    })
    assert.equal(cli.status, 0, `dsh.sh status 应成功：${cli.stdout}\n${cli.stderr}`)
    const composeLine = (await readFile(dockerLog, 'utf8'))
      .split('\n')
      .find((line) => line.startsWith('compose '))
    assert.ok(composeLine, `dsh.sh 应调用过 docker compose：${await readFile(dockerLog, 'utf8')}`)
    const cliArgs = composeLine.replace(/^compose\s+/, '').replace(/\s+ps$/, '').split(/\s+/)

    // --- 安装器侧：逐字跑 set_compose_args ---
    const harness = `set -euo pipefail
PENDING_MODEL_BROKER="$1"
PENDING_KEY_ADMIN="$2"
PENDING_ACCESS_MODE="$3"
PENDING_MULTI_USER="$4"
PENDING_EGRESS_MODE="$5"
COMPOSE_ARGS=()
${setComposeArgs}
set_compose_args
printf '%s' "\${COMPOSE_ARGS[*]-}"
`
    const installer = spawnSync(bash, [
      '-c', harness, 'overlay-parity',
      scenario.env.DSH_MODEL_BROKER ?? 'off',
      scenario.env.DSH_KEY_ADMIN ?? 'off',
      scenario.env.DSH_ACCESS_MODE ?? 'local',
      scenario.env.DSH_MULTI_USER ?? 'off',
      scenario.env.DSH_EGRESS_MODE ?? 'open',
    ], { cwd: sandbox, encoding: 'utf8' })
    assert.equal(installer.status, 0, `set_compose_args 应成功：${installer.stdout}\n${installer.stderr}`)
    const installerArgs = installer.stdout.trim().split(/\s+/).filter(Boolean)

    const cliParsed = overlaysFromArgs(cliArgs)
    const installerParsed = overlaysFromArgs(installerArgs)

    // 1) 两侧必须一致：这正是"运维命令起出一套和安装时不同的容器"的根因。
    assert.deepEqual(
      cliParsed.files,
      installerParsed.files,
      `${scenario.name}：dsh.sh 与 install.sh 的叠加层必须一致`,
    )
    assert.deepEqual(
      [...cliParsed.profiles].sort(),
      [...installerParsed.profiles].sort(),
      `${scenario.name}：dsh.sh 与 install.sh 的 profile 必须一致`,
    )

    // 2) 产物本身必须符合预期（顺序也是契约：isolated 必须最后）。
    assert.deepEqual(cliParsed.files, scenario.expect.files, `${scenario.name}：叠加层清单与顺序`)
    assert.deepEqual([...cliParsed.profiles].sort(), [...scenario.expect.profiles].sort(), `${scenario.name}：profile`)

    // 3) 两个入口容器不得同时被激活：它们发布同一个宿主端口。
    const bothEntries = cliParsed.profiles.includes('authgate') && cliParsed.profiles.includes('multiuser')
    assert.equal(bothEntries, false, `${scenario.name}：authgate 与 multiuser 不能同时激活`)
    for (const forbidden of scenario.expect.forbiddenProfiles ?? []) {
      assert.equal(cliParsed.profiles.includes(forbidden), false, `${scenario.name}：不应激活 ${forbidden}`)
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
}

// 认证层缺席时两侧的行为**故意不同**：安装器拒绝继续（装上就是一套没人能登录的部署），
// CLI 只警告并降级（stop/logs/status 这类操作不能因为缺一个文件就废掉）。
{
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-overlay-args-'))
  try {
    for (const file of OVERLAYS) {
      if (file === 'docker-compose.auth.yml') continue
      await writeFile(join(sandbox, file), 'services: {}\n')
    }
    await writeFile(join(sandbox, '.env'), 'DSH_ACCESS_MODE=password\n')
    await writeFile(join(sandbox, 'dsh.sh'), dshSh)
    const mockBin = join(sandbox, 'mock-bin')
    await mkdir(mockBin)
    await writeFile(join(mockBin, 'docker'), dockerMock)
    await chmod(join(mockBin, 'docker'), 0o755)
    const dockerLog = join(sandbox, 'docker.log')
    await writeFile(dockerLog, '')

    const cli = spawnSync(bash, [bashPath(join(sandbox, 'dsh.sh')), 'status'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bashPath(mockBin)}:${process.env.PATH}`, MOCK_DOCKER_LOG: bashPath(dockerLog) },
    })
    assert.equal(cli.status, 0, 'CLI 在缺认证叠加层时必须仍然可用（降级而不是拒绝）')
    assert.match(cli.stderr, /没有 docker-compose\.auth\.yml/, 'CLI 必须明确说明降级原因')
    const composeLine = (await readFile(dockerLog, 'utf8')).split('\n').find((line) => line.startsWith('compose '))
    assert.equal(
      composeLine.replace(/^compose\s+/, '').replace(/\s+ps$/, ''),
      '-f docker-compose.yml',
      '降级后只应保留基础叠加层',
    )

    const installer = spawnSync(bash, ['-c', `set -euo pipefail
PENDING_MODEL_BROKER="off"; PENDING_KEY_ADMIN="off"; PENDING_ACCESS_MODE="password"
PENDING_MULTI_USER="off"; PENDING_EGRESS_MODE="open"
COMPOSE_ARGS=()
${setComposeArgs}
set_compose_args
`], { cwd: sandbox, encoding: 'utf8' })
    assert.notEqual(installer.status, 0, '安装器缺认证叠加层时必须拒绝继续')
    assert.match(installer.stderr, /docker-compose\.auth\.yml/, '安装器必须指出缺少哪个文件')
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
}

console.log('overlay args parity smoke: ok')
