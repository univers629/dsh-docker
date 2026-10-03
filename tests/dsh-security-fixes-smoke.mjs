// 安全修复的回归测试（对应 run-2 审计的四条已确认漏洞）。
//
// 这些断言把「修好之后必须一直成立」的性质钉住，而不是只证明当前不报错：
//   1. 内存下限必须与容器堆不变式一致，否则接口会接受一个让实例创建失败的值
//   2. 注册表并发写必须串行化，不得丢失管理员的设置
//   3. 可信代理解析不出地址时必须退化为「不设 IP 维度」，而不是全体共用一个桶
//   4. 每实例网络的子网分配必须唯一且不重叠，否则 Docker 会拒绝创建
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const {
  buildContainerSpec, DEFAULT_NODE_HEAP_MB, minInstanceMemoryMb, UID_BASE,
} = await import(new URL('../bin/dsh-instances-policy.mjs', import.meta.url).href)
const {
  clientIp, ipBucketKey, isAddressLiteral, loginKeys,
} = await import(new URL('../bin/dsh-auth-policy.mjs', import.meta.url).href)

const auth = fs.readFileSync(path.join(root, 'bin', 'dsh-auth.mjs'), 'utf8')
const instances = fs.readFileSync(path.join(root, 'bin', 'dsh-instances.mjs'), 'utf8')

// ---- 1) 内存下限与容器堆不变式一致 ----
{
  const floor = minInstanceMemoryMb(DEFAULT_NODE_HEAP_MB)
  assert.ok(floor > DEFAULT_NODE_HEAP_MB, `下限必须大于堆上限（得到 ${floor} vs 堆 ${DEFAULT_NODE_HEAP_MB}）`)
  // 下限本身必须能被容器层接受——这正是原缺陷：接口接受 64，容器层却抛错。
  const spec = buildContainerSpec({
    name: 't', uid: UID_BASE, image: 'i', network: 'n', dataDir: '/d', memoryMb: floor,
  })
  assert.ok(spec.includes(`${floor}m`), '下限值必须能构造出合法容器规格')
  // 逐点验证：接口允许的最小值不再触发容器层的错误。
  for (const memoryMb of [floor, floor + 1, 200]) {
    assert.doesNotThrow(
      () => buildContainerSpec({ name: 't', uid: UID_BASE, image: 'i', network: 'n', dataDir: '/d', memoryMb }),
      `memoryMb=${memoryMb} 必须能通过容器层校验`,
    )
  }
  // 而旧下限（64/128/160）确实会抛错——这解释了下限为什么必须抬高。
  for (const memoryMb of [64, 128, DEFAULT_NODE_HEAP_MB]) {
    assert.throws(
      () => buildContainerSpec({ name: 't', uid: UID_BASE, image: 'i', network: 'n', dataDir: '/d', memoryMb }),
      `memoryMb=${memoryMb} 应当被容器层拒绝（证明旧下限是错的）`,
    )
  }
  // 设置接口必须用同一个下限，而不是硬编码 64。
  assert.ok(
    instances.includes('minInstanceMemoryMb('),
    '设置校验必须复用容器层的下限，而不是自己写一个 64',
  )
}

// ---- 2) 注册表写入串行化 ----
{
  assert.ok(
    instances.includes('function mutateRegistry'),
    '注册表必须经串行化的 mutateRegistry 写入',
  )
  // 所有变更点都不得再直接 saveRegistry（只有 mutateRegistry 内部可以）。
  const directSaves = instances
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.startsWith('saveRegistry('))
  assert.equal(
    directSaves.length, 1,
    `只有 mutateRegistry 内部可以调用 saveRegistry（实际 ${directSaves.length} 处：${directSaves.map((s) => s.number).join(', ')}）`,
  )
  // ensure 不得再持有注册表快照跨 docker run：createInstance 必须接收已解析的内存值。
  assert.ok(
    /async function createInstance\(memoryMb, uid, username\)/.test(instances),
    'createInstance 必须接收内存上限参数，而不是持有注册表',
  )
}

// ---- 3) 来源不可区分时不设 IP 维度 ----
{
  // 可信代理解析不出地址时，ipBucketKey 必须返回空串（不记账），
  // 而不是退回一个全体共用的键。
  assert.equal(ipBucketKey('172.20.0.2', { trustedProxiesResolved: false }), '', '不可区分时不得生成 IP 桶键')
  assert.equal(ipBucketKey('172.20.0.2', { trustedProxiesResolved: true }), 'ip:172.20.0.2', '可区分时按地址分桶')

  const keys = loginKeys('172.20.0.2', 'Alice', { trustedProxiesResolved: false })
  assert.equal(keys.ipKey, '', '不可区分时 ipKey 为空')
  assert.equal(keys.accountKey, 'account:alice', '账户桶始终存在（这是唯一的兜底）')

  // 可信代理条目：地址与主机名必须被区分对待。
  assert.equal(isAddressLiteral('172.20.0.2'), true)
  assert.equal(isAddressLiteral('10.0.0.0/8'), true)
  assert.equal(isAddressLiteral('::1'), true)
  assert.equal(isAddressLiteral('dsh-ingress'), false, '主机名必须走解析，不能直接当地址比')
  assert.equal(isAddressLiteral('proxy.internal'), false)

  // 主机名若被当成字面地址，就会永不匹配对端地址——这正是原缺陷。
  const peer = '172.20.0.2'
  assert.notEqual(
    clientIp({ 'x-real-ip': '203.0.113.9' }, peer, { trustedProxies: ['dsh-ingress'] }),
    '203.0.113.9',
    '未解析的主机名不得让转发头被采信',
  )

  // 网关必须把解析放到后台，不得阻塞监听（否则会拖慢入口可用性）。
  assert.ok(
    !/await resolveTrustedProxies\(\)/.test(auth),
    '不得在启动路径上 await 可信代理解析（DNS 可能要等超时）',
  )
  assert.ok(
    auth.includes('resolveTrustedProxies().catch('),
    '后台解析必须挂上 catch，避免未处理的拒绝',
  )
  // 解析未完成时必须是「不可区分」，而不是误判为可区分。
  assert.ok(
    /let trustedProxiesResolved = false/.test(auth),
    '解析完成前必须默认不可区分',
  )
}

// ---- 4) 每实例网络：命名与子网分配 ----
{
  // 子网分配函数在服务内部，这里按其定义复算，确保唯一且不重叠。
  const base = '10.213.0.0'
  const subnetOf = (uid) => {
    const slot = uid - UID_BASE + 1
    const [a, b] = base.split('.').map(Number)
    return `${a}.${b}.${Math.floor((slot * 8) / 256)}.${(slot * 8) % 256}/29`
  }
  const seen = new Set()
  for (let i = 0; i < 512; i += 1) {
    const cidr = subnetOf(UID_BASE + i)
    assert.ok(!seen.has(cidr), `子网 ${cidr} 重复（第 ${i} 个实例）`)
    seen.add(cidr)
  }
  assert.equal(seen.size, 512, '512 个实例的子网必须互不相同')

  // 服务必须真的按 uid 建网络、指定子网、并只接入白名单服务。
  assert.ok(instances.includes('function instanceNetworkName'), '必须按实例生成网络名')
  assert.ok(instances.includes('--subnet'), '必须显式指定子网，否则会耗尽 Docker 地址池')
  assert.ok(instances.includes('DSH_INSTANCE_REACHERS'), '可访问实例的服务必须是显式白名单')
  assert.ok(instances.includes('attachReachers'), '必须能在容器被外部重建后补回网络成员关系')

  // 绝不能改用 enable_icc=false：它会阻断同一网桥上的所有容器对，
  // 包括入口→实例这条必需路径（实测会导致全站不可用）。
  // 只看真正的 YAML 键（注释里提到这个词是在说明为什么不这么做）。
  const compose = fs.readFileSync(path.join(root, 'docker-compose.multiuser.yml'), 'utf8')
  const iccKey = compose
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#'))
    .some((line) => line.startsWith('com.docker.network.bridge.enable_icc'))
  assert.equal(iccKey, false, '不得使用 enable_icc=false：它连入口→实例的路径一起切断')
}

// ---- 5) 失败桶淘汰必须保护真实账户的锁定计数 ----
{
  // 攻击者可以用大量伪造用户名把失败桶顶到上限。淘汰策略必须优先丢弃「不属于任何
  // 真实账户」的键，否则受害者的 account: 桶会被顶掉——那等于绕过锁定。
  const pruneBody = auth.slice(auth.indexOf('if (live.size > MAX_FAILURE_KEYS)'), auth.indexOf('state.failures = Object.fromEntries(live)'))
  assert.ok(
    pruneBody.includes('realAccounts'),
    '淘汰必须区分真实账户与伪造键，否则攻击者能顶掉受害者的锁定计数',
  )
  assert.ok(
    /realAccounts\.has\(key\)/.test(pruneBody),
    '属于真实账户的键必须被保护（第一轮跳过）',
  )
  assert.ok(
    pruneBody.includes('state.users'),
    '真实账户名单必须取自 state.users（攻击者伪造不了）',
  )
  // 第一轮必须从最旧的开始（byOldest），而不是按最新排序。
  assert.ok(pruneBody.includes('byOldest'), '淘汰顺序必须从最旧的键开始')
}

process.stdout.write('dsh-security-fixes smoke: ok\n')
