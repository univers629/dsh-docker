// dsh-instances 集成冒烟：用假的 docker 可执行文件驱动真实服务，验证实例创建、
// 数据目录属主、启动/停止/删除、闲置回收、水位收紧与唤醒排队、令牌鉴权。
//
// 假 docker 把收到的参数追加到日志文件，并按容器名返回预设的 inspect 状态，
// 因此可以确定性地覆盖「容器已存在 / 已停止 / 不存在」三条分支而不需要真容器。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { UID_BASE, allocateUid } from '../bin/dsh-instances-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-instances-'))
const TOKEN = 'instances-token-'.padEnd(48, 'x')

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// ---------------------------------------------------------------- 假 docker
// 逻辑写成 .mjs，并通过服务的 DSH_DOCKER / DSH_DOCKER_ARGS 前缀机制注入：
// 用 node 作为可执行文件、假实现作为第一个参数。这样在 Windows 上也能工作
// （Node 不允许无 shell 直接执行 .cmd/.bat），服务端代码无需为测试做特殊分支。
const dockerLog = path.join(sandbox, 'docker.log')
const fakeImpl = path.join(sandbox, 'fake-docker.mjs')
fs.writeFileSync(fakeImpl, `import fs from 'node:fs'
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify(args) + '\\n')
const [command] = args
// inspect 有两种形态：'inspect --format {{.State.Status}} <name>' 与
// 'inspect <name> --format {{json .Mounts}}'，取参数里既不是 --format 也不是模板的那个。
const name = args.slice(1).find((a) => a !== '--format' && !a.startsWith('{{')) ?? ''
// 网络生命周期：每实例一张专属网络（审计修复：不再共用一张网桥）。
//   network inspect <name> --format ...  → 不存在则退出 1（编排服务据此决定是否 create）
//   network create --subnet <cidr> <name> → 记录该网络
//   network connect <net> <svc>           → 幂等；已接入则失败（真实 docker 的行为）
//   network rm <name>                     → 删除
if (command === 'network') {
  const sub = args[1]
  const netDir = ${JSON.stringify(sandbox)} + '/networks'
  fs.mkdirSync(netDir, { recursive: true })
  const membersFile = (n) => netDir + '/' + n + '.members'
  if (sub === 'inspect') {
    const target = args.slice(2).find((a) => a !== '--format' && !a.startsWith('{{')) ?? ''
    if (!fs.existsSync(netDir + '/' + target + '.created')) { process.stderr.write('No such network\\n'); process.exit(1) }
    process.stdout.write(target + '\\n')
    process.exit(0)
  }
  if (sub === 'create') {
    const target = args[args.length - 1]
    fs.writeFileSync(netDir + '/' + target + '.created', '1')
    const subnetIndex = args.indexOf('--subnet')
    if (subnetIndex > 0) fs.writeFileSync(netDir + '/' + target + '.subnet', args[subnetIndex + 1])
    process.stdout.write(target + '\\n')
    process.exit(0)
  }
  if (sub === 'connect') {
    const [target, service] = [args[2], args[3]]
    const current = fs.existsSync(membersFile(target)) ? fs.readFileSync(membersFile(target), 'utf8').split('\\n').filter(Boolean) : []
    if (current.includes(service)) { process.stderr.write('already connected\\n'); process.exit(1) }
    fs.writeFileSync(membersFile(target), [...current, service].join('\\n') + '\\n')
    process.exit(0)
  }
  if (sub === 'disconnect') {
    // 真实 docker 拒绝删除仍有活动端点的网络，因此删除前必须先断开入口与代理。
    const target = args.includes('-f') ? args[args.indexOf('-f') + 1] : args[2]
    const service = args[args.length - 1]
    const current = fs.existsSync(membersFile(target)) ? fs.readFileSync(membersFile(target), 'utf8').split('\\n').filter(Boolean) : []
    fs.writeFileSync(membersFile(target), current.filter((entry) => entry !== service).join('\\n') + '\\n')
    process.exit(0)
  }
  if (sub === 'rm') {
    const target = args[2]
    // 模拟真实行为：网络仍有成员时拒绝删除。这条约束正是「不先 disconnect 就会留下
    // 孤儿网络」的原因，假实现必须复现它，否则测试会漏掉那个缺陷。
    const members = fs.existsSync(membersFile(target)) ? fs.readFileSync(membersFile(target), 'utf8').split('\\n').filter(Boolean) : []
    if (members.length > 0) { process.stderr.write('network has active endpoints\\n'); process.exit(1) }
    for (const suffix of ['.created', '.members', '.subnet']) {
      try { fs.rmSync(netDir + '/' + target + suffix) } catch {}
    }
    process.exit(0)
  }
}
if (command === 'inspect') {
  if (args.some((a) => a.includes('NetworkSettings'))) {
    // 网络查询：按文件里的值应答，便于测试控制「实例挂在哪个网络上」。
    const file = ${JSON.stringify(sandbox)} + '/' + name + '.network'
    const network = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : process.env.FAKE_NETWORK
    process.stdout.write((network || '') + '\\n')
    process.exit(0)
  }
  if (args.some((a) => a.includes('Mounts'))) {
    if (process.env.FAKE_NO_MOUNTS === '1') { process.stdout.write('[]\\n'); process.exit(0) }
    // 模拟真实部署的挂载表：编排服务据此把「容器内数据目录」映射回「宿主路径」
    process.stdout.write(JSON.stringify([{
      Type: 'bind',
      Source: process.env.FAKE_MOUNT_SRC,
      Destination: process.env.FAKE_MOUNT_DEST,
    }]) + '\\n')
    process.exit(0)
  }
  const file = ${JSON.stringify(sandbox)} + '/' + name + '.status'
  const status = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : 'absent'
  if (status === 'absent') { process.stderr.write('No such object\\n'); process.exit(1) }
  process.stdout.write(status + '\\n')
  process.exit(0)
}
if (command === 'stats') { process.stdout.write(process.env.FAKE_CPU || '0.10%\\n'); process.exit(0) }
if (command === 'exec') {
  if (process.env.FAKE_EXEC_MODE === 'notready') process.exit(1)
  if (process.env.FAKE_EXEC_MODE === 'idle') { process.stdout.write('idle\\n'); process.exit(0) }
  process.exit(0)
}
if (command === 'run') {
  const nameIndex = args.indexOf('--name')
  if (nameIndex > 0) {
    fs.writeFileSync(${JSON.stringify(sandbox)} + '/' + args[nameIndex + 1] + '.status', 'running')
    // 新容器加入它被创建时的网络（--network 的值）；网络收敛测试靠这个文件判断收敛。
    const networkIndex = args.indexOf('--network')
    fs.writeFileSync(${JSON.stringify(sandbox)} + '/' + args[nameIndex + 1] + '.network', networkIndex > 0 ? args[networkIndex + 1] : '')
  }
  process.stdout.write('container-id\\n')
  process.exit(0)
}
if (command === 'start') { fs.writeFileSync(${JSON.stringify(sandbox)} + '/' + args[args.length - 1] + '.status', 'running'); process.exit(0) }
if (command === 'stop') { fs.writeFileSync(${JSON.stringify(sandbox)} + '/' + args[args.length - 1] + '.status', 'exited'); process.exit(0) }
if (command === 'rm') { fs.writeFileSync(${JSON.stringify(sandbox)} + '/' + args[args.length - 1] + '.status', 'absent'); process.exit(0) }
process.exit(0)
`)

const DOCKER_ENV = { DSH_DOCKER: process.execPath, DSH_DOCKER_ARGS: fakeImpl }
/** 容器内看到的数据目录；它绝不能出现在 -v 的 source 位置上。 */
const CONFIG_USERS_PLACEHOLDER = '/data/users'

const port = await freePort()
const tokenFile = path.join(sandbox, 'instances.token')
fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 })

const child = spawn(process.execPath, [path.join(root, 'bin', 'dsh-instances.mjs')], {
  env: {
    ...process.env,
    DSH_INSTANCES_LISTEN: `127.0.0.1:${port}`,
    DSH_INSTANCES_TOKEN_FILE: tokenFile,
    DSH_INSTANCES_STATE: path.join(sandbox, 'instances.json'),
    // 模型授权与代理配置：默认路径在 /data 下，沙箱里指向我们写的文件
    DSH_BROKER_GRANTS_FILE: path.join(sandbox, 'broker-grants.json'),
    DSH_BROKER_TOKENS_FILE: path.join(sandbox, 'broker-tokens.json'),
    DSH_BROKER_KEYS_FILE: path.join(sandbox, 'broker-keys.json'),
    DSH_USERS_DIR: path.join(sandbox, 'users'),
    FAKE_MOUNT_DEST: path.join(sandbox, 'users'),
    FAKE_MOUNT_SRC: path.join(sandbox, 'host-users'),
    DSH_INSTANCE_IMAGE: 'dsh:test',
    DSH_INSTANCE_NETWORK: 'dsh-private',
  FAKE_NETWORK: 'dsh-private',
    DSH_INSTANCE_MEMORY_MB: '200',
    ...DOCKER_ENV,
    DSH_IDLE_TIMEOUT_SECONDS: '1800',
    DSH_INSTANCES_SWEEP_SECONDS: '3600',
    DSH_INSTANCES_FAKE_AVAILABLE_BYTES: String(8 * 1024 ** 3),
    FAKE_EXEC_MODE: 'ready',
    FAKE_CPU: '0.10%',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

const base = `http://127.0.0.1:${port}`
const call = (path, body, { token = TOKEN, method = 'POST' } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
})

async function waitReady() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`instances service exited: ${child.exitCode} ${stderr}`)
    try {
      const response = await fetch(`${base}/healthz`)
      if (response.status === 204) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error('instances service did not become ready')
}

function dockerCalls() {
  return fs.readFileSync(dockerLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

try {
  await waitReady()

  // ---- 鉴权：无令牌/错令牌一律 401，健康检查除外 ----
  assert.equal((await fetch(`${base}/healthz`)).status, 204, 'healthz is open')
  assert.equal((await fetch(`${base}/instances`)).status, 401, 'missing token rejected')
  assert.equal((await call('/instances', {}, { token: 'wrong-token' })).status, 401, 'wrong token rejected')
  assert.equal((await call('/instances', {}, { token: '' })).status, 401, 'empty token rejected')

  // ---- 首次 ensure：创建实例 + 等就绪 ----
  const uid = allocateUid([])
  // 给这个 uid 开放一个上游：授权表为空时 seeder 会提前返回（那是有意的省事路径），
  // 这里要覆盖「真的去生成模型配置」的那条路。
  fs.writeFileSync(path.join(sandbox, 'broker-grants.json'), JSON.stringify({
    version: 1,
    users: { [String(uid)]: { tokenDigest: 'a'.repeat(64), upstreams: ['main'] } },
  }))
  fs.writeFileSync(path.join(sandbox, 'broker-tokens.json'), JSON.stringify({
    version: 1,
    tokens: { alice: 'test-instance-token-0123456789abcdef' },
  }))
  fs.writeFileSync(path.join(sandbox, 'broker-keys.json'), JSON.stringify({
    version: 1,
    upstreams: [{ name: 'main', baseUrl: 'https://api.example.com', key: 'k', models: ['m1'] }],
  }))
  const created = await call('/instances/ensure', { uid, username: 'alice' })
  assert.equal(created.status, 200, `ensure must create the instance: ${stderr}`)
  const createdBody = await created.json()
  assert.equal(createdBody.status, 'created')
  assert.equal(createdBody.name, 'dsh-u1')
  assert.equal(createdBody.url, 'http://dsh-u1:3080', 'instances are reached through the in-container nginx port')

  // 容器参数必须带齐安全基线
  const runCall = dockerCalls().find((args) => args[0] === 'run')
  assert.ok(runCall, 'docker run was invoked')
  const runJoined = runCall.join(' ')
  // 挂载点必须是宿主路径：容器内路径交给守护进程会在宿主上找不到。
  // 这里断言自动推导出的路径等于「自身挂载表里的 Source + uid」。
  const expectedHostDataDir = path.join(sandbox, 'host-users', String(uid)).replace(/\\/g, '/')
  assert.ok(
    runJoined.includes(`${expectedHostDataDir}/home:/data/dsh:rw`),
    `mount source must be the host path, got: ${runJoined}`,
  )
  assert.ok(!runJoined.includes(`${CONFIG_USERS_PLACEHOLDER}/home:/data/dsh`), 'must not pass the in-container path as the mount source')

  // 就绪探针必须探**容器的入口端口（3080）**，也就是浏览器真正会走的那条路：
  // 入口 → 容器名 → 容器 nginx:3080 → DSH。
  // 只探 DSH 本体（3081）的漏洞是实测出来的：DSH 已在应答、容器 nginx 尚未监听时，
  // 编排报「就绪」而入口侧 connect() 被拒（111），等待页便在「跳过去 → 被打回来」间闪烁。
  // 也不能探 nginx 的 /healthz：那是无条件 204，DSH 没起来也算通。
  const execCalls = dockerCalls().filter((args) => args[0] === 'exec')
  assert.ok(runJoined.includes('--cap-drop ALL'), 'capabilities dropped')
  assert.ok(!runJoined.includes('--user '), 'instances must boot as root: the entrypoint drops privileges itself')
  assert.ok(runJoined.includes('--memory 200m'), 'memory capped at 200MB')
  assert.ok(!runJoined.includes('--read-only'), 'no read-only rootfs: the entrypoint writes /etc/shadow and /run/dsh-*')
  // 每实例一张专属网络：这是租户隔离的关键。共用一张网桥时，任一用户容器都能按名
  // 解析并直连其它实例的 3080（实例内 nginx 在 password 模式下不做认证），审计实测
  // 跨租户读写配置成功。网络名由编排服务按 uid 槽位生成，并显式指定 /29 子网，
  // 避免 Docker 默认地址池被逐张网络耗尽。
  const expectedNetwork = 'dsh-private-u1'
  assert.ok(runJoined.includes(`--network ${expectedNetwork}`), `joined its own per-instance network (${expectedNetwork})`)
  assert.ok(!runJoined.includes('--network dsh-private '), 'must not join the shared instance network')
  const netCreate = dockerCalls().find((args) => args[0] === 'network' && args[1] === 'create')
  assert.ok(netCreate, 'the per-instance network is created')
  assert.ok(netCreate.includes('--subnet'), 'the network gets an explicit subnet so the address pool is not exhausted')
  assert.ok(netCreate[netCreate.length - 1] === expectedNetwork, 'the created network belongs to this instance')
  // 需要访问实例 HTTP 面的服务必须被接进去，否则用户请求进不到实例。
  const netConnects = dockerCalls().filter((args) => args[0] === 'network' && args[1] === 'connect')
  const connectedServices = netConnects.map((args) => args[3])
  assert.ok(connectedServices.includes('dsh-ingress'), 'the ingress is attached so user requests can reach the instance')
  assert.ok(connectedServices.includes('dsh-key-broker'), 'the key broker is attached so the instance can reach models')
  assert.ok(!runJoined.includes('settings.yaml:'), 'no nested file mount inside the DSH home')
  assert.ok(!runJoined.includes('docker.sock'), 'no docker socket inside the instance')

  // 数据目录
  const userDir = path.join(sandbox, 'users', String(uid))
  assert.ok(fs.existsSync(path.join(userDir, 'home')), 'instance home created')
  assert.ok(fs.existsSync(path.join(userDir, 'workspace')), 'instance workspace created')

  // 模型配置：由容器内的 seed 脚本生成（编排服务 exec 进去跑），因此这里断言
  // 「确实调用了它」，而不是宿主上的文件内容。宿主上不再写 settings.yaml——
  // 那样只能覆盖 bind 模式，volume 模式下卷内容在宿主上不可见。
  assert.ok(
    execCalls.some((args) => args.join(' ').includes('seed-dsh-model-settings.mjs')),
    'instance creation seeds the model settings through the DSH-side script',
  )
  const seedCall = execCalls.find((args) => args.join(' ').includes('seed-dsh-model-settings.mjs'))
  assert.ok(seedCall.join(' ').includes('--home /data/dsh'), 'the seeder writes into the instance DSH home')
  // 令牌必须以 dsh 身份写：DSH 读不到 root 属主的文件会直接启动失败
  assert.ok(
    seedCall.join(' ').includes('su dsh'),
    'the seeder runs as the dsh user: root-owned settings make DSH fail to start',
  )

  // ---- 重复 ensure：容器已在运行 → 不重复创建 ----
  const again = await call('/instances/ensure', { uid, username: 'alice' })
  assert.equal((await again.json()).status, 'running', 'a running instance is reused')
  assert.equal(dockerCalls().filter((args) => args[0] === 'run').length, 1, 'no duplicate container created')

  // ---- 停止后再 ensure：应重新启动并等就绪 ----
  assert.equal((await call('/instances/stop', { uid })).status, 200)
  assert.equal(fs.readFileSync(path.join(sandbox, 'dsh-u1.status'), 'utf8').trim(), 'exited', 'stop reached docker')
  const restarted = await call('/instances/ensure', { uid, username: 'alice' })
  assert.equal((await restarted.json()).status, 'started', 'a stopped instance is started again')

  // ---- 网络收敛：挂在旧网络（共用网桥）上的实例被重建到自己的专属网络 ----
  // 审计修复把「所有实例共用一张网桥」改为「每实例一张专属网络」；只对新建容器生效，
  // 存量实例若不迁移就仍能与其它租户互通。做法是 ensure 时探测容器网络，与期望不符就
  // 移除重建（数据在卷或绑定目录里，不受影响）。假 docker 的网络值写在 <name>.network
  // 文件里，改它即可模拟「旧部署的实例」。
  fs.writeFileSync(path.join(sandbox, 'dsh-u1.network'), 'dsh-instances-net')
  const migrated = await call('/instances/ensure', { uid, username: 'alice' })
  assert.equal((await migrated.json()).status, 'recreated', 'an instance on the shared legacy network is rebuilt')
  const callsAtMigration = dockerCalls()
  const removal = callsAtMigration.filter((args) => args[0] === 'rm')
  assert.ok(removal.some((args) => args.includes('dsh-u1')), 'the legacy-network container is removed before rebuilding')
  const rerun = callsAtMigration.filter((args) => args[0] === 'run')
  assert.ok(rerun.length >= 2, 'the instance is rebuilt after removal')
  assert.ok(
    rerun.at(-1).join(' ').includes(`--network ${expectedNetwork}`),
    'the rebuilt container joins its own per-instance network',
  )
  // 重建后再 ensure：网络已一致，不得反复重建。
  const afterMigration = await call('/instances/ensure', { uid, username: 'alice' })
  assert.equal((await afterMigration.json()).status, 'running', 'the rebuilt instance is reused afterwards')
  assert.equal(
    dockerCalls().filter((args) => args[0] === 'run').length,
    rerun.length,
    'no repeated rebuild once the network matches',
  )

  // ---- 就绪探测失败 → 504，不谎报成功 ----
  // 重新起一个进程并把就绪探针设为失败：ensure 必须立即返回（不等就绪），
  // 而 /instances/state 必须如实报告未就绪——绝不谎报可服务。
  const port2 = await freePort()
  const child2 = spawn(process.execPath, [path.join(root, 'bin', 'dsh-instances.mjs')], {
    env: {
      ...process.env,
      DSH_INSTANCES_LISTEN: `127.0.0.1:${port2}`,
      DSH_INSTANCES_TOKEN_FILE: tokenFile,
      DSH_INSTANCES_STATE: path.join(sandbox, 'instances2.json'),
      DSH_USERS_DIR: path.join(sandbox, 'users2'),
      // 显式宿主路径：自动推导不可用时的兜底，这里同时覆盖这条分支
      DSH_HOST_USERS_DIR: path.join(sandbox, 'host-users2'),
      DSH_INSTANCE_IMAGE: 'dsh:test',
      ...DOCKER_ENV,
      DSH_INSTANCES_SWEEP_SECONDS: '3600',
      FAKE_EXEC_MODE: 'notready',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  try {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port2}/healthz`)).status === 204) break
      } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 120))
    }
    const secondBase = `http://127.0.0.1:${port2}`
    const auth = { authorization: `Bearer ${TOKEN}` }
    const bootStart = Date.now()
    const ensured = await fetch(`${secondBase}/instances/ensure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ uid, username: 'bob' }),
    })
    const elapsed = Date.now() - bootStart
    assert.equal(ensured.status, 200, 'ensure returns immediately without waiting for readiness')
    assert.ok(elapsed < 5000, `ensure must not block on container startup (took ${elapsed}ms)`)
    const state = await (await fetch(`${secondBase}/instances/state?uid=${uid}`, { headers: auth })).json()
    assert.equal(state.running, true, 'container reports as running')
    assert.equal(state.ready, false, 'a failing readiness probe is reported as not ready')
    // 就绪探针必须探实例内的 DSH 本体，而不是实例 nginx 那个无条件 204 的 /healthz：
    // 只探 nginx 会在 DSH 尚未监听 3081 时报「就绪」，用户随即撞上实例 nginx 的 502。
    const serviceSource = fs.readFileSync(path.join(root, 'bin', 'dsh-instances.mjs'), 'utf8')
    const probeBody = /async function probeReady\(name\) \{([\s\S]*?)\n\}/.exec(serviceSource)
  assert.ok(probeBody, 'the readiness probe exists')
  assert.ok(probeBody[1].includes('CONFIG.instanceEntryPort'), 'the readiness probe must target the container entry port the ingress uses')
  assert.ok(!probeBody[1].includes('CONFIG.instanceWebPort'), 'probing DSH directly reports ready while the ingress still cannot connect')
    assert.ok(
      !/probeReady[\s\S]{0,600}healthz/.test(serviceSource),
      'the unconditional nginx healthz must not be used as the readiness signal',
    )
  } finally {
    child2.kill()
  }

  // ---- 参数校验：非法 uid 必须拒绝 ----
  assert.equal((await call('/instances/ensure', { uid: 999, username: 'x' })).status, 400, 'uid below the instance range rejected')
  assert.equal((await call('/instances/ensure', { uid: 'abc' })).status, 400, 'non-numeric uid rejected')
  assert.equal((await call('/instances/touch', { uid: 4242 })).status, 404, 'touch on an unknown instance is 404')

  // ---- 宿主目录既推导不出、也没显式配置时，必须明确报错而不是静默用错路径 ----
  const port3 = await freePort()
  const child3 = spawn(process.execPath, [path.join(root, 'bin', 'dsh-instances.mjs')], {
    env: {
      ...process.env,
      DSH_INSTANCES_LISTEN: `127.0.0.1:${port3}`,
      DSH_INSTANCES_TOKEN_FILE: tokenFile,
      DSH_INSTANCES_STATE: path.join(sandbox, 'instances3.json'),
      DSH_USERS_DIR: path.join(sandbox, 'users3'),
      DSH_INSTANCE_IMAGE: 'dsh:test',
      ...DOCKER_ENV,
      DSH_INSTANCES_SWEEP_SECONDS: '3600',
      FAKE_NO_MOUNTS: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let child3Stderr = ''
  child3.stderr.on('data', (chunk) => { child3Stderr += chunk.toString() })
  try {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port3}/healthz`)).status === 204) break
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 120))
    }
    const unresolved = await fetch(`http://127.0.0.1:${port3}/instances/ensure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ uid, username: 'carol' }),
    })
    assert.equal(unresolved.status, 500, 'an unresolvable host data dir must fail loudly')
    assert.match(child3Stderr, /cannot resolve the host path/, 'the failure explains what to configure')
  } finally {
    child3.kill()
  }

  // ---- 状态只读接口 ----
  const status = await (await fetch(`${base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.equal(status.ok, true)
  assert.equal(status.watermark, 'normal', 'low pressure is normal')
  assert.equal(status.memoryMbPerInstance, 200)
  assert.ok(status.instances.length >= 1, 'instance listed')
  assert.ok(status.instances[0].quota, 'disk quota reported')
  // 运行时设置与默认值随状态一起回：面板据此显示当前值与是否偏离默认。
  assert.equal(status.settings.memoryMb, 200, 'runtime settings echo the effective memory')
  assert.equal(status.defaults.memoryMb, 200, 'factory defaults are reported alongside')

  // ---- 运行时设置：改闲置阈值与每实例内存 ----
  const badIdle = await call('/settings', { idleTimeoutSeconds: 5 })
  assert.equal(badIdle.status, 400, 'a timeout below 60s is refused (it would bounce users between the waiting page and the workspace)')
  const badMemory = await call('/settings', { memoryMb: 32 })
  assert.equal(badMemory.status, 400, 'memory below the 64MB boot floor is refused')
  const saved = await call('/settings', { idleTimeoutSeconds: 900, memoryMb: 320 })
  assert.equal(saved.status, 200)
  const savedBody = await saved.json()
  assert.equal(savedBody.settings.idleTimeoutSeconds, 900)
  assert.equal(savedBody.settings.memoryMb, 320)
  const afterSave = await (await fetch(`${base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.equal(afterSave.idleTimeoutMs, 900_000, 'the new idle timeout takes effect immediately')
  assert.equal(afterSave.memoryMbPerInstance, 320, 'the new memory cap is reported')
  // 新建实例用新内存上限：这是设置唯一能改变运行中容器之外的落点。
  await call('/instances/delete', { uid, purge: false })
  const recreated = await call('/instances/ensure', { uid, username: 'alice' })
  assert.equal((await recreated.json()).status, 'created')
  const runArgsAfter = dockerCalls().filter((args) => args[0] === 'run').at(-1).join(' ')
  assert.ok(runArgsAfter.includes('--memory 320m'), `a new instance uses the updated cap, got: ${runArgsAfter.slice(0, 200)}`)
  // 复原，免得影响后面的断言
  await call('/settings', { idleTimeoutSeconds: 1800, memoryMb: 200 })

  // ---- 固化：标记为永久保留后，拨老 lastSeenAt 也不会被回收 ----
  const pinned = await call('/instances/pin', { uid, pinned: true })
  assert.equal(pinned.status, 200)
  assert.equal((await pinned.json()).pinned, true)
  const pinnedStatus = await (await fetch(`${base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.equal(pinnedStatus.instances.find((i) => i.uid === uid).pinned, true, 'the pin flag reaches the panel')
  const unpinned = await call('/instances/pin', { uid, pinned: false })
  assert.equal((await unpinned.json()).pinned, false)
  const missingPin = await call('/instances/pin', { uid: 999999, pinned: true })
  assert.equal(missingPin.status, 404, 'pinning an unknown instance is a 404')

  // ---- 空闲回收：把 lastSeenAt 拨到很久以前后触发清扫逻辑（经 /status 观测 + 周期清扫）----
  const stateFile = path.join(sandbox, 'instances.json')
  const registry = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  registry.instances[uid].lastSeenAt = Date.now() - 3 * 3600_000
  fs.writeFileSync(stateFile, JSON.stringify(registry))
  // 用 /status 只读观测应仍是 running（只读接口不回收）
  const observed = await (await fetch(`${base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.equal(observed.instances.find((i) => i.uid === uid).running, true, 'status is read-only and does not reclaim')

  // ---- 删除：purge 会移除数据目录 ----
  const removed = await call('/instances/delete', { uid, purge: true })
  assert.equal(removed.status, 200)
  assert.equal((await removed.json()).purged, true)
  assert.ok(!fs.existsSync(userDir), 'purge removed the data directory')
  assert.equal((await call('/instances/stop', { uid })).status, 404, 'stopping a removed instance is 404')
  // 实例的专属网络必须随实例一起消失。删除前必须先断开入口与代理——Docker 拒绝删除
  // 仍有活动端点的网络，漏掉 disconnect 就会留下孤儿网络并一直占着它的 /29 子网。
  assert.ok(
    !fs.existsSync(path.join(sandbox, 'networks', `${expectedNetwork}.created`)),
    'the per-instance network is removed with the instance (no orphaned network)',
  )
  const disconnects = dockerCalls().filter((args) => args[0] === 'network' && args[1] === 'disconnect')
  assert.ok(
    disconnects.length >= 2,
    'the ingress and broker are disconnected before removing the network (docker refuses otherwise)',
  )

  console.log('dsh-instances smoke: ok')
} finally {
  child.kill()
  fs.rmSync(sandbox, { recursive: true, force: true })
}
