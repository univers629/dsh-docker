// 回归：判定端点（/__dsh_auth/verify）必须按节流把会话活动时间落盘。
//
// 为什么这是缺陷而不是"理论上更整齐"：每个请求都会 readState()，而 readState() 对刚读出的
// **磁盘快照**跑 prune（按 lastSeenAt + idleTtlMs 判闲置）。只改内存的话，这次判定滑动
// 过的活动时间在下一个请求里就被磁盘上的旧值覆盖——用户一直在用工作台（页面资源与轮询
// 都只经过 verify），却会在闲置窗口到点后被登出；网关重启后同样如此。
//
// 两轮用同一段脚本，只有 DSH_AUTH_ACTIVITY_PERSIST_SECONDS 不同：
//   固定组（0 = 每次判定都落盘）：整个观察期都应放行，且库里的 lastSeenAt 始终新鲜；
//   对照组（3600 = 几乎不落盘，等价于修复前的行为）：用户在持续访问中仍会被登出——
//   这条断言把"修复前是什么样"钉在测试里，否则测试只能证明现在不报错。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const GATEWAY = path.join(root, 'bin', 'dsh-auth.mjs')
const PASSWORD = 'activity-persist-42'

// 闲置窗口要明显大于"一次请求来回"的耗时，否则两组都会因为单纯太慢而失败。
const IDLE_TTL_SECONDS = 4
const OBSERVE_MS = (IDLE_TTL_SECONDS + 3) * 1000

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等端口真正可再次监听：SIGKILL 之后立刻重启会撞 EADDRINUSE。 */
async function waitForPortFree(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return
    await sleep(100)
  }
  throw new Error(`port ${port} did not free up`)
}

async function runScenario(activityPersistSeconds, idleTtlSeconds = IDLE_TTL_SECONDS) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-activity-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let output = ''
  const start = () => {
    const proc = spawn(process.execPath, [GATEWAY], {
      env: {
        ...process.env,
        DSH_AUTH_LISTEN: `127.0.0.1:${port}`,
        DSH_AUTH_STATE: path.join(sandbox, 'state.json'),
        DSH_AUTH_TOTP_KEY: path.join(sandbox, 'totp.key'),
        DSH_AUTH_INITIAL_PASSWORD: PASSWORD,
        DSH_AUTH_IDLE_TTL_SECONDS: String(idleTtlSeconds),
        DSH_AUTH_ACTIVITY_PERSIST_SECONDS: String(activityPersistSeconds),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', (chunk) => { output += chunk })
    proc.stderr.on('data', (chunk) => { output += chunk })
    return proc
  }
  const stop = (proc) => new Promise((resolve) => {
    // 子进程可能已经退出（启动失败或被上一次 stop 终止），此时 'exit' 不会再触发；
    // 不处理的话调用方会挂在一个永不 settle 的 promise 上。
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve()
      return
    }
    proc.once('exit', () => resolve())
    proc.kill('SIGKILL')
  })
  const waitForListen = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`${base}/api/auth/status`, { signal: AbortSignal.timeout(2000) })
        if (response.ok) return
      } catch {}
      await sleep(100)
    }
    throw new Error(`gateway did not start: ${output}`)
  }

  let child = start()
  try {
    await waitForListen()

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'root', password: PASSWORD }),
    })
    assert.equal(login.status, 200, `登录应成功：${output}`)
    const cookie = (login.headers.getSetCookie?.() ?? [])
      .map((entry) => entry.split(';')[0])
      .find((entry) => entry.startsWith('dsh_auth_session='))
    assert.ok(cookie, '应拿到会话 Cookie')

    const verify = () => fetch(`${base}/__dsh_auth/verify`, { headers: { cookie } })
    // 会话被回收后就再也读不到它，用 null 表达"库里已经没有了"。
    const persistedAge = () => {
      const state = JSON.parse(fs.readFileSync(path.join(sandbox, 'state.json'), 'utf8'))
      const session = state.sessions[0]
      return session ? Date.now() - session.lastSeenAt : null
    }

    const startedAt = Date.now()
    let firstRejectedAt = null
    let lastAge = null
    while (Date.now() - startedAt < OBSERVE_MS) {
      const status = (await verify()).status
      if (status !== 204 && firstRejectedAt === null) firstRejectedAt = Date.now() - startedAt
      lastAge = persistedAge()
      await sleep(300)
    }

    // 重启一次：证明滑动过的活动时间真的落在了磁盘上，而不只是活在内存里。
    await stop(child)
    await waitForPortFree(port)
    child = start()
    await waitForListen()
    const afterRestart = (await verify()).status

    return { firstRejectedAt, lastAge, afterRestart, observeMs: OBSERVE_MS }
  } finally {
    await stop(child)
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

const fixed = await runScenario(0)
assert.equal(
  fixed.firstRejectedAt,
  null,
  `持续访问期间不得把会话判为闲置（观察 ${fixed.observeMs}ms，闲置窗口 ${IDLE_TTL_SECONDS}s；`
  + `第 ${fixed.firstRejectedAt}ms 就被拒了）`,
)
assert.ok(
  fixed.lastAge !== null && fixed.lastAge < IDLE_TTL_SECONDS * 1000,
  `活动时间必须一直保持新鲜，实际库里的 lastSeenAt 距今 ${fixed.lastAge}ms`,
)
assert.equal(fixed.afterRestart, 204, '重启后会话仍应有效：活动时间已经落盘')

// 节流上限必须由闲置窗口推导：配置成"几乎不落盘"（3600 秒）而窗口只有 4 秒时，
// 实现要自行把间隔压到窗口的四分之一，否则活跃会话在窗口到点前一次都来不及落盘——
// 这正是修复前"一直在访问也会被登出"的机理。这条断言把推导钉住。
const derived = await runScenario(3600, 4)
assert.equal(
  derived.firstRejectedAt,
  null,
  `配置的节流间隔长于闲置窗口时，实现必须自行收紧，否则用户会在访问中被登出（第 ${derived.firstRejectedAt}ms）`,
)
assert.ok(
  derived.lastAge !== null && derived.lastAge < IDLE_TTL_SECONDS * 1000,
  `推导出的间隔应让活动时间保持新鲜，实际距今 ${derived.lastAge}ms`,
)

// 机制对照：窗口远长于节流间隔（3600s vs 推导后的 900s）时不会落盘，因此库里的活动
// 时间停在创建时刻——"不落盘则窗口不滑动"就是修复前那个缺陷的机理。修复后无法再用
// 短窗口复现它，因为短窗口会自动收紧节流。

const control = await runScenario(3600, 3600)
assert.equal(control.firstRejectedAt, null, '窗口远长于节流间隔时会话不该被回收（这里只是不落盘）')
assert.ok(
  control.lastAge !== null && control.lastAge >= control.observeMs - 1500,
  `不落盘时库里的活动时间应停在创建时刻（距今应接近观察时长 ${control.observeMs}ms，实际 ${control.lastAge}ms）`,
)

// 节流必须按**会话**而不是按进程：一个会话刚落过盘，不能因此让另一个活跃会话等满一整个
// 窗口。用两个会话在同一次检查里验证：窗口是 2 秒，两者都静置 2.5 秒后先后各判定一次，
// 两次都应落盘（进程级节流会让第二次被跳过）。
{
  const sandbox = fs.mkdtempSync(join(os.tmpdir(), 'dsh-activity-pair-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let output = ''
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_AUTH_LISTEN: `127.0.0.1:${port}`,
      DSH_AUTH_STATE: join(sandbox, 'state.json'),
      DSH_AUTH_TOTP_KEY: join(sandbox, 'totp.key'),
      DSH_AUTH_INITIAL_PASSWORD: PASSWORD,
      DSH_AUTH_IDLE_TTL_SECONDS: '3600',
      DSH_AUTH_ACTIVITY_PERSIST_SECONDS: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetch(`${base}/api/auth/status`, { signal: AbortSignal.timeout(2000) })).ok) break
      } catch {}
      await sleep(100)
    }
    const loginOnce = async () => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ username: 'root', password: PASSWORD }),
      })
      assert.equal(response.status, 200, `登录应成功：${output}`)
      const cookie = (response.headers.getSetCookie?.() ?? [])
        .map((entry) => entry.split(';')[0])
        .find((entry) => entry.startsWith('dsh_auth_session='))
      assert.ok(cookie, '应拿到会话 Cookie')
      return cookie
    }
    const cookieA = await loginOnce()
    const cookieB = await loginOnce()
    const sessions = () => JSON.parse(fs.readFileSync(join(sandbox, 'state.json'), 'utf8')).sessions
    const initA = sessions().find((s) => s.lastSeenAt === s.createdAt)
    assert.ok(initA, '新会话的活动时间应与创建时间相同')

    await sleep(2500)
    await fetch(`${base}/__dsh_auth/verify`, { headers: { cookie: cookieA } })
    await fetch(`${base}/__dsh_auth/verify`, { headers: { cookie: cookieB } })
    await sleep(300)

    const advanced = sessions().filter((s) => s.lastSeenAt > s.createdAt).length
    assert.equal(advanced, 2, `两个会话都应各自落盘活动时间，实际只有 ${advanced} 个`)
  } finally {
    child.kill('SIGKILL')
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

console.log('dsh-auth activity persist smoke: ok')
