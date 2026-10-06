// 回归：凡是被 bind mount 覆盖进容器的脚本，在 Git 里必须有可执行位。
//
// 为什么必须这样测：docker-compose.yml 把 ./bin/dsh-supervisor 挂到容器的
// /usr/local/bin/dsh-supervisor（只读），宿主机的权限位会覆盖镜像里 chmod +x 的结果。
// 该文件在 Git 里是 100644 时，容器启动会卡在
//   exec: /usr/local/bin/dsh-supervisor: Permission denied
// 并陷入重启循环——报错只有一句 permission denied，完全看不出与 Git 权限位有关。
//
// 更隐蔽的一点：Windows 上检出或 tar 解包都不会保留执行位，所以本地测试全绿、
// 一到 Linux 生产就炸。这条断言把"镜像里有没有 chmod"和"宿主机挂载了什么"解耦，
// 直接盯住 Git 索引里的权限位。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))

/** 读取 Git 索引里的模式位，返回 "100644" / "100755" 等。 */
function gitMode(relPath) {
  const out = execFileSync('git', ['ls-files', '-s', '--', relPath], { cwd: root, encoding: 'utf8' })
  const line = out.trim().split('\n')[0] ?? ''
  return line.split(/\s+/)[0] ?? ''
}

// 1) 所有被 bind mount 进容器的宿主机文件都必须可执行。
//    这些路径直接从 compose 文件里扫出来，新增挂载时测试自动覆盖。
const composeFiles = [
  'docker-compose.yml',
  'docker-compose.keys.yml',
  'docker-compose.keys-admin.yml',
  'docker-compose.isolated.yml',
  'docker-compose.auth.yml',
  'docker-compose.multiuser.yml',
]
const mounted = new Set()
const notReadOnly = []
for (const file of composeFiles) {
  let text
  try { text = readFileSync(join(root, file), 'utf8') } catch { continue }
  // 形如 `- ./bin/dsh-supervisor:/usr/local/bin/dsh-supervisor:ro`
  for (const m of text.matchAll(/^\s*-\s+\.\/([^:\s]+):([^:\s]+)(:([^\s#]+))?/gm)) {
    if (!m[1].startsWith('bin/')) continue
    mounted.add(m[1])
    // 必须带 :ro。挂载源在宿主机上，属主与权限位跟着 clone 的人走——非 root 用户
    // clone 时是 1000:1000 0775，容器里 uid 1000 恰好是 dsh，等于把启动链交给运行账户。
    // 只读挂载是这里唯一挡住写入（含 unlink）的机制，掉了就只剩权限位，而权限位不可控。
    if (m[4] !== 'ro') notReadOnly.push(`${file}: ${m[1]} -> ${m[2]}`)
  }
}
assert.ok(mounted.size > 0, 'expected to find at least one ./bin/... bind mount in the compose files')

assert.deepEqual(
  notReadOnly,
  [],
  'bin/ 下的挂载必须带 :ro：挂载源的属主随 clone 者变化，容器里的运行账户可能正是它，' +
    '只读挂载才是拦住写入的那一层。缺 :ro 的挂载：\n' + notReadOnly.join('\n'),
)

for (const rel of mounted) {
  assert.equal(
    gitMode(rel),
    '100755',
    `${rel} is bind-mounted into the container but is not executable in Git; ` +
      'the host mode overrides the image chmod and the container fails with "Permission denied"',
  )
}

// 2) bin/ 下所有带 shebang 的脚本都应可执行（含未被挂载的：容器内还可能有别的
//    调用路径，且权限位错误会在别处复现）。
const lsFiles = execFileSync('git', ['ls-files', '-s', '--', 'bin/'], { cwd: root, encoding: 'utf8' })
const offenders = []
for (const line of lsFiles.trim().split('\n')) {
  const m = line.match(/^(\d+)\s+\S+\s+\d+\t(.+)$/)
  if (!m) continue
  const [, mode, rel] = m
  if (rel.includes('node_modules')) continue
  let first = ''
  try { first = readFileSync(join(root, rel), 'utf8').split('\n')[0] } catch { continue }
  if (first.startsWith('#!') && mode !== '100755') offenders.push(`${rel} (${mode})`)
}
assert.deepEqual(
  offenders,
  [],
  `scripts with a shebang must be 100755 in Git: ${offenders.join(', ')}`,
)

// 3) 非脚本文件不应被误设为可执行（反之会让 Git 记录无意义的模式变化）。
for (const rel of ['bin/package.json', 'bin/dsh-auth-web/admin.html', 'bin/dsh-auth-web/app.css']) {
  assert.equal(gitMode(rel), '100644', `${rel} is not a script and must stay 100644 in Git`)
}

// 4) 启动路径要有兜底：即使某个部署的权限位错了，也能自愈。
//    git 只会修正新检出，已装好的机器不会自动更新工作区权限。
const dshSh = readFileSync(join(root, 'dsh.sh'), 'utf8')
assert.match(dshSh, /chmod \+x bin\/\*/, 'dsh.sh must repair bin/ exec bits before starting services')
const installSh = readFileSync(join(root, 'install.sh'), 'utf8')
assert.match(installSh, /fix_exec_bits\(\) \{/, 'install.sh must define fix_exec_bits')
assert.match(installSh, /fix_exec_bits "\$TARGET_DIR"/, 'install.sh must call fix_exec_bits on the project directory')

console.log(`exec-bit smoke: ok (${mounted.size} bind-mounted scripts verified)`)
