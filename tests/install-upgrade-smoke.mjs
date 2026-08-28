import assert from 'node:assert/strict'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// upgrade 的全部价值就在"不问、不丢"这两点上，所以断言分三类：
//   1) 一个向导问题都不许打印，配置只能从落盘的 .env 反推；
//   2) data/ 与 workspace/ 里的东西必须一字不改地留在原处；
//   3) 垃圾回收只许动本项目，绝不许出现 system prune 或不带过滤的 image prune。

const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installSh = await readFile(join(repoRoot, 'install.sh'), 'utf8')
const installPs1 = await readFile(join(repoRoot, 'install.ps1'), 'utf8')

// 两侧都要有这个动作，且都必须走 --no-build --force-recreate（镜像已经在上一步拉好/构建好）。
assert.match(installSh, /^  upgrade\) upgrade_dsh ;;$/m)
assert.match(installPs1, /^    'upgrade' \{ Invoke-DshUpgrade \}$/m)
assert.match(installSh, /up -d --no-build --force-recreate --remove-orphans/)
assert.match(installPs1, /'up','-d','--no-build','--force-recreate','--remove-orphans'/)

// 菜单第 2 项是一个二级分支："更新 DSH 本体"和"换镜像重建容器"是两种粒度，
// 合成一个入口再问一次，避免把最常用的那条藏进一串编号里。
assert.match(installSh, /2\) 更新（容器内更新 DSH，或换成新镜像重建容器）/)
assert.match(installSh, /更新哪一层：/)
assert.match(installSh, /^          1\) ACTION=update ;;$/m)
assert.match(installSh, /^          2\) ACTION=upgrade ;;$/m)
assert.match(installSh, /^    echo "8\) 删除"$/m)
assert.match(installPs1, /2\) 更新（容器内更新 DSH，或换成新镜像重建容器）/)
assert.match(installPs1, /更新哪一层：/)
assert.match(installPs1, /'1' \{ \$DshAction = 'update' \}/)
assert.match(installPs1, /'2' \{ \$DshAction = 'upgrade' \}/)
assert.match(installPs1, /'8' \{ \$DshAction = 'delete' \}/)

// 回收的边界：这两条会清掉宿主上别的项目，任何时候都不许出现在 upgrade 路径里。
const shellUpgrade = installSh.slice(installSh.indexOf('load_upgrade_config() {'), installSh.indexOf('print_config_summary() {'))
const powershellUpgrade = installPs1.slice(installPs1.indexOf('function Get-DshComposeFileArgs {'), installPs1.indexOf('switch ($DshAction) {'))
// 注释里点名了这几条禁忌写法（说明为什么不用），所以只看真正会执行的行。
const withoutComments = (source) => source.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
for (const [label, region] of [['install.sh', shellUpgrade], ['install.ps1', powershellUpgrade]]) {
  assert.ok(region.length > 0, label + ' upgrade section must be found')
  const source = withoutComments(region)
  assert.ok(!source.includes('system prune'), label + ' upgrade must never run docker system prune')
  assert.ok(!/image prune(?![^\n]*--filter)/.test(source), label + ' upgrade must never prune images without a filter')
  assert.ok(!source.includes('builder prune -a'), label + ' upgrade must keep the layers the current image still uses')
  assert.ok(source.includes('com.docker.compose.project'), label + ' upgrade must scope cleanup to this compose project')
}

const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`].find(existsSync)
  : 'bash'
assert.ok(bash, 'bash is required for the upgrade smoke test')
const bashPath = (value) => process.platform === 'win32'
  ? value.replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()).replaceAll('\\', '/')
  : value

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-upgrade-smoke-'))
const mockBin = join(sandbox, 'bin')
await mkdir(mockBin)

// MOCK_DOCKER_PULLED 是"镜像换过了"的开关：pull / build 之后 image inspect 换一套 ID 与
// RepoDigest，这样才能验证摘要对比和 DSH_IMAGE_DIGEST 的补写。
const dockerMock = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
state="\${MOCK_DOCKER_PULLED:-/dev/null}"
case "\${1:-}" in
  image)
    if [ "\${2:-}" = inspect ]; then
      case " $* " in
        *RepoDigests*)
          if [ -f "$state" ]; then printf '%s\\n' 'ghcr.io/univers629/dsh-docker@sha256:2222'
          else printf '%s\\n' 'ghcr.io/univers629/dsh-docker@sha256:1111'; fi ;;
        *)
          if [ -f "$state" ]; then printf '%s\\n' 'sha256:2222'; else printf '%s\\n' 'sha256:1111'; fi ;;
      esac
    fi
    exit 0
    ;;
  pull) : > "$state"; exit 0 ;;
  compose)
    case " $* " in *" build "*) : > "$state" ;; esac
    exit 0
    ;;
  inspect) printf '%s\\n' 'dsh-docker'; exit 0 ;;
  network)
    if [ "\${2:-}" = inspect ]; then printf '%s\\n' 0; fi
    exit 0
    ;;
  system) printf '%s\\n' 'TYPE TOTAL RECLAIMABLE'; exit 0 ;;
  exec)
    case " $* " in
      *verify-dsh-hardening*) exit 0 ;;
      */etc/dsh-broker*) ;;
      *dsh-key-broker*) exit 0 ;;
      *) printf '%s\\n' 1000 ;;
    esac
    exit 0
    ;;
esac
exit 0
`
const dockerMockPath = join(mockBin, 'docker')
await writeFile(dockerMockPath, dockerMock)
await chmod(dockerMockPath, 0o755)

const envLines = (imageSource) => [
  'DSH_IMAGE=ghcr.io/univers629/dsh-docker:latest',
  'DSH_IMAGE_SOURCE=' + imageSource,
  'DSH_BIND_HOST=127.0.0.1',
  'DSH_ACCESS_MODE=local',
  'DSH_TRUSTED_HOSTS=',
  'DSH_DOCKER_NETWORK=dsh-private',
  'DSH_DOCKER_NETWORK_EXTERNAL=false',
  'DSH_MODEL_BROKER=on',
  'DSH_MODEL_BROKER_BASE=http://dsh-key-broker:8080',
  'DSH_KEY_ADMIN=off',
  'DSH_EGRESS_MODE=open',
  '',
].join('\n')

// 沿用真实的 compose 文件：-f 组合算错的话 --remove-orphans 会删掉正常运行的旁路容器。
const prepareProject = async (name, imageSource) => {
  const directory = join(sandbox, name)
  await mkdir(join(directory, 'data', 'dsh', 'sessions'), { recursive: true })
  await mkdir(join(directory, 'data', 'broker'), { recursive: true })
  await mkdir(join(directory, 'workspace'), { recursive: true })
  for (const file of ['docker-compose.yml', 'docker-compose.keys.yml', 'docker-compose.keys-admin.yml', 'docker-compose.isolated.yml']) {
    await cp(join(repoRoot, file), join(directory, file))
  }
  await writeFile(join(directory, 'dsh.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(directory, 'dsh.sh'), 0o755)
  await writeFile(join(directory, '.env'), envLines(imageSource))
  await writeFile(join(directory, 'data', 'dsh', 'sessions', 'keep.jsonl'), 'session-must-survive\n')
  await writeFile(join(directory, 'data', 'broker', 'keys.json'), '{"upstreams":{}}\n')
  await writeFile(join(directory, 'workspace', 'keep.txt'), 'workspace-must-survive\n')
  return directory
}

const runUpgrade = (target, logPath) => spawnSync(bash, [
  '-c',
  'PATH="$MOCK_BIN:$PATH"; export PATH; exec "$INSTALL_SCRIPT" "$@"',
  'dsh-upgrade-smoke',
  'upgrade', '--non-interactive', '--dir', target,
], {
  cwd: sandbox,
  encoding: 'utf8',
  env: {
    ...process.env,
    MOCK_DOCKER_LOG: logPath,
    MOCK_DOCKER_PULLED: join(sandbox, target + '.pulled'),
    MOCK_BIN: bashPath(mockBin),
    INSTALL_SCRIPT: bashPath(join(repoRoot, 'install.sh')),
  },
})

try {
  // ---- 预构建来源：拉镜像 + 重建，不许构建、不许清构建缓存 ----
  const prebuiltDir = await prepareProject('prebuilt', 'prebuilt')
  const prebuiltLog = join(sandbox, 'prebuilt.log')
  const prebuilt = runUpgrade('prebuilt', prebuiltLog)
  assert.equal(prebuilt.status, 0, prebuilt.stdout + '\n' + prebuilt.stderr)

  // 1) 一个向导小节都不许出现：配置全部从落盘的 .env 反推。
  for (const heading of ['访问保护方式：', '容器出站网络（', 'Debian 13 镜像来源：', '模型 API 密钥放在哪里：', '现在设置容器 root 密码']) {
    assert.ok(!prebuilt.stdout.includes(heading), 'upgrade must not re-run the wizard, but printed: ' + heading)
  }

  const log = await readFile(prebuiltLog, 'utf8')
  assert.match(log, /^pull ghcr\.io\/univers629\/dsh-docker:latest$/m)
  assert.match(log, /^compose --env-file \.env -f docker-compose\.yml -f docker-compose\.keys\.yml up -d --no-build --force-recreate --remove-orphans$/m)
  assert.ok(!log.includes('build dsh'), 'prebuilt upgrade must not build the image')
  assert.ok(!log.includes('system prune'), 'upgrade must never run docker system prune')
  assert.ok(!log.includes('builder prune'), 'prebuilt upgrade produces no build cache, so it must not prune it')
  for (const line of log.split('\n').filter((entry) => entry.includes('image prune'))) {
    assert.match(line, /--filter /, 'image prune must always be filtered: ' + line)
  }
  assert.match(log, /^image prune -f --filter label=org\.opencontainers\.image\.title=dsh-docker$/m)
  assert.match(log, /container ls -aq --filter label=com\.docker\.compose\.project=dsh-docker/)
  assert.match(log, /^system df$/m)

  // 2) 数据必须原样留着，.env 只允许多出一行摘要。
  assert.equal(await readFile(join(prebuiltDir, 'data', 'dsh', 'sessions', 'keep.jsonl'), 'utf8'), 'session-must-survive\n')
  assert.equal(await readFile(join(prebuiltDir, 'workspace', 'keep.txt'), 'utf8'), 'workspace-must-survive\n')
  assert.equal(await readFile(join(prebuiltDir, 'data', 'broker', 'keys.json'), 'utf8'), '{"upstreams":{}}\n')
  const upgradedEnv = await readFile(join(prebuiltDir, '.env'), 'utf8')
  assert.match(upgradedEnv, /^DSH_IMAGE_DIGEST=ghcr\.io\/univers629\/dsh-docker@sha256:2222$/m)
  const withoutDigest = upgradedEnv.split('\n').filter((line) => !line.startsWith('DSH_IMAGE_DIGEST=')).join('\n')
  assert.equal(withoutDigest, envLines('prebuilt'), 'upgrade must not rewrite any other .env line')

  // ---- 本机构建来源：构建 + 只清一次不带 -a 的构建缓存 ----
  await prepareProject('built', 'build')
  const builtLog = join(sandbox, 'built.log')
  const built = runUpgrade('built', builtLog)
  assert.equal(built.status, 0, built.stdout + '\n' + built.stderr)
  const buildLogText = await readFile(builtLog, 'utf8')
  assert.match(buildLogText, /build dsh/)
  assert.ok(!buildLogText.includes('pull ghcr.io'), 'build source must not pull the published image')
  assert.match(buildLogText, /^builder prune -f$/m)
  assert.ok(!buildLogText.includes('builder prune -af'), 'upgrade must keep reusable build cache')

  // ---- 没装过就升级：必须直接拒绝，而不是悄悄跑一次安装 ----
  const bareDir = join(sandbox, 'bare')
  await mkdir(bareDir, { recursive: true })
  await cp(join(repoRoot, 'docker-compose.yml'), join(bareDir, 'docker-compose.yml'))
  const bare = runUpgrade('bare', join(sandbox, 'bare.log'))
  assert.notEqual(bare.status, 0, 'upgrade without .env must fail')
  assert.match(bare.stderr, /没有 \.env/)
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

console.log('install-upgrade-smoke ok')
