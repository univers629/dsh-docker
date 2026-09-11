// The container metrics endpoint: fixture parsing, the rate window, the
// working-set calculation, and the HTTP route's auth gate.
//
// Every case drives the real module against fixtures, because /sys/fs/cgroup
// and /proc/net/dev cannot be rewritten in place. The clock is injected, so
// the rate assertions are exact and the test never sleeps.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-metrics-smoke-'))
const cgroup = join(root, 'cgroup')
const netDev = join(root, 'net-dev')

// The module reads all three lazily, so they can be pointed here and the
// window changed between cases inside one process.
process.env.DSH_METRICS_CGROUP_ROOT = cgroup
process.env.DSH_METRICS_NET_DEV = netDev
process.env.DSH_METRICS_SAMPLE_TTL_MS = '0'

const T0 = 1_789_000_000_000

const netDevHeader = 'Inter-|   Receive                                                |  Transmit\n'
  + ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n'

function writeCounters({ cpuUsec, quota = '200000 100000', memoryCurrent, memoryMax = '2000000000', inactiveFile, io, ethRx, ethTx }) {
  mkdirSync(cgroup, { recursive: true })
  writeFileSync(join(cgroup, 'cpu.stat'), `usage_usec ${cpuUsec}\nuser_usec ${cpuUsec - 1}\nsystem_usec 1\n`, 'utf8')
  writeFileSync(join(cgroup, 'cpu.max'), `${quota}\n`, 'utf8')
  writeFileSync(join(cgroup, 'memory.current'), `${memoryCurrent}\n`, 'utf8')
  writeFileSync(join(cgroup, 'memory.max'), `${memoryMax}\n`, 'utf8')
  writeFileSync(join(cgroup, 'memory.stat'), `anon 100\nfile 200\ninactive_file ${inactiveFile}\nactive_file 0\n`, 'utf8')
  writeFileSync(join(cgroup, 'io.stat'), io, 'utf8')
  writeFileSync(netDev, `${netDevHeader}    lo: 999999 1 0 0 0 0 0 0 999999 1 0 0 0 0 0 0\n  eth0: ${ethRx} 10 0 0 0 0 0 0 ${ethTx} 20 0 0 0 0 0 0\n`, 'utf8')
}

const metrics = await import('../dsh-home/docker-control/lib/metrics.js')

try {
  // 1. 第一个样本：只有累计量，还没有速率，而且不能抛。
  writeCounters({
    cpuUsec: 5_000_000,
    memoryCurrent: 1_000_000_000,
    inactiveFile: 250_000_000,
    io: '8:0 rbytes=1000 wbytes=2000 rios=1 wios=2 dbytes=0 dios=0\n8:16 rbytes=500 wbytes=500 rios=1 wios=1 dbytes=0 dios=0\n',
    ethRx: 1000,
    ethTx: 2000,
  })
  metrics.resetContainerMetrics()
  const first = metrics.containerMetrics(T0)
  assert.equal(first.ok, true)
  assert.equal(first.intervalMs, null, '没有基线时不报窗口')
  assert.equal(first.cpu.cores, null, '没有基线时没有 CPU 速率')
  assert.equal(first.cpu.quotaCores, 2, 'cpu.max 200000/100000 = 2 核配额')
  assert.equal(first.memory.usedBytes, 750_000_000, '内存要报工作集 = current - inactive_file')
  assert.equal(first.memory.limitBytes, 2_000_000_000)
  assert.equal(first.memory.percent, 37.5)
  assert.equal(first.network.rxBytesTotal, 1000, 'lo 的流量不计入')
  assert.equal(first.network.txBytesTotal, 2000)
  assert.equal(first.disk.readBytesTotal, 1500, '多块设备要相加')
  assert.equal(first.disk.writeBytesTotal, 2500)

  // 2. 第二个样本：按真实窗口算速率，1 秒窗口下数字是确定的。
  writeCounters({
    cpuUsec: 7_000_000,
    memoryCurrent: 1_000_000_000,
    inactiveFile: 250_000_000,
    io: '8:0 rbytes=501000 wbytes=2000 rios=1 wios=2 dbytes=0 dios=0\n8:16 rbytes=500 wbytes=500 rios=1 wios=1 dbytes=0 dios=0\n',
    ethRx: 1_001_000,
    ethTx: 1_002_000,
  })
  const second = metrics.containerMetrics(T0 + 1000)
  assert.equal(second.intervalMs, 1000)
  assert.equal(second.cpu.cores, 2, '+2 秒 CPU / 1 秒窗口 = 2 核')
  assert.equal(second.cpu.percent, 200)
  assert.equal(second.network.rxBytesPerSec, 1_000_000)
  assert.equal(second.network.txBytesPerSec, 1_000_000)
  assert.equal(second.disk.readBytesPerSec, 500_000)
  assert.equal(second.disk.writeBytesPerSec, 0, '没长就是 0，不是 null')

  // 3. 窗口内的重复调用复用同一份快照：两个标签页不会互相打乱采样窗口。
  process.env.DSH_METRICS_SAMPLE_TTL_MS = '900'
  const cached = metrics.containerMetrics(T0 + 1100)
  assert.equal(cached, second, '900ms 内要复用同一份快照')
  const fresh = metrics.containerMetrics(T0 + 5000)
  assert.notEqual(fresh, second, '超过窗口要重新采样')
  assert.equal(fresh.intervalMs, 4000)
  process.env.DSH_METRICS_SAMPLE_TTL_MS = '0'

  // 4. 计数器回退（容器被重建、计数归零）时不能给出负数速率。
  writeCounters({
    cpuUsec: 1,
    memoryCurrent: 1_000_000,
    inactiveFile: 0,
    io: '8:0 rbytes=0 wbytes=0 rios=0 wios=0 dbytes=0 dios=0\n',
    ethRx: 0,
    ethTx: 0,
  })
  const rewound = metrics.containerMetrics(T0 + 6000)
  assert.equal(rewound.cpu.cores, null)
  assert.equal(rewound.network.rxBytesPerSec, null)
  assert.equal(rewound.disk.readBytesPerSec, null)

  // 5. 没有 cgroup v2：CPU/内存/磁盘给 null，网络照旧，且绝不抛。
  rmSync(cgroup, { recursive: true, force: true })
  metrics.resetContainerMetrics()
  const degraded = metrics.containerMetrics(T0 + 7000)
  assert.equal(degraded.cpu.cores, null)
  assert.equal(degraded.memory.usedBytes, null)
  assert.equal(degraded.disk.readBytesTotal, null)
  assert.equal(degraded.network.rxBytesTotal, 0, '没有 cgroup 也要有网络数字')

  // 6. 没有配额（cpu.max = max）时 quotaCores 为 null，而不是 0 或 NaN。
  writeCounters({
    cpuUsec: 10,
    quota: 'max 100000',
    memoryCurrent: 4_000_000,
    memoryMax: 'max',
    inactiveFile: 0,
    io: '8:0 rbytes=7 wbytes=9 rios=1 wios=1 dbytes=0 dios=0\n',
    ethRx: 5,
    ethTx: 6,
  })
  metrics.resetContainerMetrics()
  const unlimited = metrics.containerMetrics(T0 + 8000)
  assert.equal(unlimited.cpu.quotaCores, null)
  assert.equal(unlimited.memory.limitBytes, null)
  assert.equal(unlimited.memory.percent, null, '没有限额就不算百分比')

  // 7. 路由本身：非 GET 405、非回环 403、回环 GET 200 且形状正确。
  const routes = new Map()
  const offs = []
  const ctx = {
    webServer: { register: route => { routes.set(route.path, route.handler) } },
    effect: install => { const off = install(); offs.push(typeof off === 'function' ? off : () => {}) },
  }
  const { apply } = await import('../dsh-home/docker-control/lib/index.js')
  apply(ctx)
  const handler = routes.get('/dsh-docker-control/metrics')
  assert.equal(typeof handler, 'function', '插件必须注册 /dsh-docker-control/metrics')

  const makeRequest = (method, overrides = {}) => ({
    method,
    url: '/dsh-docker-control/metrics',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://127.0.0.1:3081', host: '127.0.0.1:3081', ...overrides },
  })
  const makeResponse = () => {
    const captured = { status: 0, body: '' }
    return {
      captured,
      writeHead: status => { captured.status = status },
      end: chunk => { if (typeof chunk === 'string') captured.body += chunk },
    }
  }

  const ok = makeResponse()
  await handler(makeRequest('GET'), ok)
  assert.equal(ok.captured.status, 200)
  const body = JSON.parse(ok.captured.body)
  assert.equal(body.ok, true)
  assert.equal(body.network.rxBytesTotal, 5, '路由要把真实读数透出来')
  assert.equal(body.disk.writeBytesTotal, 9)

  const wrongMethod = makeResponse()
  await handler(makeRequest('POST'), wrongMethod)
  assert.equal(wrongMethod.captured.status, 405, '监控是只读端点')

  const fromOutside = makeResponse()
  const outsideRequest = makeRequest('GET')
  outsideRequest.socket.remoteAddress = '10.0.0.7'
  await handler(outsideRequest, fromOutside)
  assert.equal(fromOutside.captured.status, 403, '非回环请求必须被拒')

  const mismatched = makeResponse()
  await handler(makeRequest('GET', { origin: 'http://evil.example' }), mismatched)
  assert.equal(mismatched.captured.status, 403, 'origin 与 host 不一致要拒')

  // 浏览器对同源 GET/HEAD 不发送 Origin，读端点必须放行；写端点仍然必须证明来源。
  const noOriginRead = makeResponse()
  const bareRead = makeRequest('GET')
  delete bareRead.headers.origin
  await handler(bareRead, noOriginRead)
  assert.equal(noOriginRead.captured.status, 200, '同源 GET 不带 Origin 必须放行')

  const readOnlyWrite = makeResponse()
  await handler(makeRequest('POST'), readOnlyWrite)
  assert.equal(readOnlyWrite.captured.status, 405, '监控是只读端点，写方法一律 405')

  const restartHandler = routes.get('/dsh-docker-control/restart')
  assert.equal(typeof restartHandler, 'function', '插件必须注册重启路由')
  const noOriginWrite = makeResponse()
  const bareWrite = makeRequest('POST')
  bareWrite.url = '/dsh-docker-control/restart'
  delete bareWrite.headers.origin
  await restartHandler(bareWrite, noOriginWrite)
  assert.equal(noOriginWrite.captured.status, 403, '不带 Origin 的写请求仍然要拒')

  for (const off of offs) off()
  process.stdout.write('container metrics smoke: ok\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
