import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// 内置插件曾经只有一个来源（镜像里的 /opt），于是"运行中的插件"永远等于构建镜像那一刻
// 的代码，任何本地或仓库里的改动都会在下次启动被无声冲掉。改成"镜像只做种子、持久数据
// 目录才是权威"之后，下面这些行为必须成立，否则等于把老坑换了个位置：
//
//   1. 数据目录不存在时从镜像播种；
//   2. 数据目录自己改过、而镜像种子没变时绝不播种（本地改动能活过重启）；
//   3. 镜像种子换了（新镜像）才重播，并且明确告警说覆盖掉了哪一份；
//   4. profile 里那份与源不一致时按源覆盖，并且明确告警；
//   5. 显式指定 DSH_DOCKER_CONTROL_SOURCE 时不碰数据目录；
//   6. DSH_DOCKER_CONTROL_DATA 被误设成别的目录时不许删人家的东西。
const root = mkdtempSync(join(tmpdir(), 'dsh-docker-control-source-'))
const baked = join(root, 'baked')
const data = join(root, 'data', 'dsh-docker-control')
const profile = join(root, 'profiles', 'web')
const report = join(root, 'state', 'docker-control-source.json')
const stamp = join(root, 'data', '.dsh-docker-control-seed.json')
const installer = resolve('bin/install-docker-control.mjs')

function makePlugin(dir, marker, name = 'dsh-docker-control') {
  mkdirSync(join(dir, 'client'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version: '0.1.0' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'client', 'client.js'), `export const marker = '${marker}'\n`, 'utf8')
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n', 'utf8')
  return dir
}

function run(extra = {}) {
  // 先把环境里可能继承到的 DSH_DOCKER_CONTROL_* 清干净，再叠加本用例显式给的值：
  // 否则在真实容器里跑测试会继承到运行中那套路径。
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('DSH_DOCKER_CONTROL_')) delete env[key]
  Object.assign(env, extra, { DSH_PROFILE_ROOT: profile })
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key]
  const result = spawnSync(process.execPath, [installer], { cwd: resolve('.'), env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return {
    stderr: result.stderr,
    report: JSON.parse(readFileSync(report, 'utf8')),
  }
}

const profileCopy = join(profile, 'node_modules', 'dsh-docker-control')
const profileMarker = () => readFileSync(join(profileCopy, 'client', 'client.js'), 'utf8')
const dataMarker = () => readFileSync(join(data, 'client', 'client.js'), 'utf8')
const base = {
  DSH_DOCKER_CONTROL_BAKED: baked,
  DSH_DOCKER_CONTROL_DATA: data,
  DSH_DOCKER_CONTROL_REPORT: report,
  DSH_DOCKER_CONTROL_SEED_STAMP: stamp,
}

try {
  // 1. 首次运行：数据目录不存在，从镜像种子播种。
  makePlugin(baked, 'from-image')
  const first = run(base)
  assert.equal(first.report.seeded, true)
  assert.equal(first.report.sourceKind, 'data-volume')
  assert.equal(first.report.seedReplacedHash, null)
  assert.equal(first.report.profileTampered, false)
  assert.equal(first.report.profileHashAfter, first.report.sourceHash)
  assert.equal(first.report.bakedHash, first.report.sourceHash)
  assert.match(first.stderr, /seeded the built-in Docker control plugin/)
  assert.match(profileMarker(), /from-image/)
  assert.equal(dataMarker(), profileMarker(), 'profile 副本应逐字节等于源')

  // 2. 数据目录自己改过、镜像种子没变：必须原样保留，并同步进 profile。
  writeFileSync(join(data, 'client', 'client.js'), "export const marker = 'local-edit'\n", 'utf8')
  const second = run(base)
  assert.equal(second.report.seeded, false)
  assert.notEqual(second.report.sourceHash, second.report.bakedHash, '本地改过之后两个哈希就该不同了')
  assert.match(dataMarker(), /local-edit/, '本地改动不能被镜像种子冲掉')
  assert.match(profileMarker(), /local-edit/, 'profile 应同步到本地改动')
  assert.equal(second.report.sourceChanged, true, '源变了要如实记录')
  assert.equal(second.report.profileTampered, false, '源正常更新不是篡改 profile')
  assert.match(second.stderr, /source updated/, '正常更新给一条 info')
  assert.doesNotMatch(second.stderr, /\[dsh\]\[warn\]/, '正常同步不该有告警')

  // 3. 换了镜像（种子变了）：重播，并且告警说明覆盖掉了本地那份。
  const editedHash = second.report.sourceHash
  makePlugin(baked, 'new-image')
  const third = run(base)
  assert.equal(third.report.seeded, true)
  assert.equal(third.report.seedReplacedHash, editedHash, '报告应如实记录被覆盖掉的本地哈希')
  assert.match(third.stderr, /\[dsh\]\[warn\]/, '覆盖本地改动必须出声')
  assert.match(dataMarker(), /new-image/)

  // 4. profile 里那份被人动过：按源覆盖，并且告警。
  writeFileSync(join(profileCopy, 'client', 'client.js'), "export const marker = 'hand-edited-profile'\n", 'utf8')
  const fourth = run(base)
  assert.equal(fourth.report.seeded, false)
  assert.equal(fourth.report.profileTampered, true)
  assert.ok(fourth.report.profileHashBefore)
  assert.notEqual(fourth.report.profileHashBefore, fourth.report.sourceHash)
  assert.equal(fourth.report.profileHashAfter, fourth.report.sourceHash)
  assert.match(fourth.stderr, /\[dsh\]\[warn\] the profile copy/)
  assert.match(profileMarker(), /new-image/)

  // 5. 幂等：没有变化时既不告警，也不谎报"覆盖过"。
  const fifth = run(base)
  assert.equal(fifth.report.seeded, false)
  assert.equal(fifth.report.profileTampered, false)
  assert.equal(fifth.report.sourceChanged, false)
  assert.equal(fifth.report.profileHashBefore, fifth.report.sourceHash)
  assert.doesNotMatch(fifth.stderr, /\[dsh\]\[warn\]/)

  // 6. 显式指定源：当权威用，不碰数据目录。
  const explicit = join(root, 'worktree')
  const untouched = join(root, 'untouched')
  makePlugin(explicit, 'from-worktree')
  const sixth = run({ ...base, DSH_DOCKER_CONTROL_SOURCE: explicit, DSH_DOCKER_CONTROL_DATA: untouched })
  assert.equal(sixth.report.sourceKind, 'override')
  assert.equal(sixth.report.source, explicit)
  assert.match(profileMarker(), /from-worktree/)
  assert.equal(existsSync(untouched), false, '显式指定源时不能顺手播种数据目录')

  // 7. 数据目录被误设成别人的插件目录：只跳过播种，绝不删除、也不留种子戳。
  const foreign = join(root, 'foreign')
  const foreignStamp = join(root, 'foreign-stamp.json')
  makePlugin(foreign, 'someone-else', 'someone-else')
  writeFileSync(join(foreign, 'important.txt'), 'do not delete\n', 'utf8')
  const seventh = run({ ...base, DSH_DOCKER_CONTROL_DATA: foreign, DSH_DOCKER_CONTROL_SEED_STAMP: foreignStamp })
  assert.equal(seventh.report.seeded, false)
  assert.equal(readFileSync(join(foreign, 'important.txt'), 'utf8'), 'do not delete\n')
  assert.equal(JSON.parse(readFileSync(join(foreign, 'package.json'), 'utf8')).name, 'someone-else')
  assert.equal(existsSync(foreignStamp), false, '没播种就不该写种子戳')

  process.stdout.write('dsh-docker-control source smoke: ok\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
