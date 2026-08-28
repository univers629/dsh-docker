import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const watcher = resolve('bin/watch-profile-plugins.mjs')
const patcher = resolve('bin/patch-profile-plugins.mjs')

// dsh-market 的 hot-mount 安装不重启进程，所以 supervisor 那一次补丁不会发生。
// watcher 存在的唯一理由就是补上这个窗口，测试也就只验证两件事：启动时补一遍、
// 插件目录变化后再补一遍。
const marketHttpSource = `
export function sendJson(response, status, payload) {
    response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
}
`

function createProfile() {
  // realpathSync.native：Windows 的 %TEMP% 是 8.3 短名（SMALLS~1），libuv 的
  // fs-event 在短名目录上会直接 abort。容器里是 Linux，这一步只为让测试能在
  // 开发机上跑起来。
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-profile-watch-')))
  return {
    root,
    modules: join(root, 'node_modules'),
    report: join(root, 'profile-patches.json'),
  }
}

function installMarket(profile) {
  const marketRoot = join(profile.modules, 'dshmarket')
  mkdirSync(join(marketRoot, 'lib'), { recursive: true })
  writeFileSync(join(marketRoot, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(marketRoot, 'lib', 'http.js'), marketHttpSource)
  return join(marketRoot, 'lib', 'http.js')
}

function watchEnv(profile) {
  return {
    ...process.env,
    DSH_PROFILE_ROOT: profile.root,
    DSH_PROFILE_PATCHER: patcher,
    DSH_PROFILE_PATCH_REPORT: profile.report,
    // 默认 1500/5000 会让测试白等好几秒。
    DSH_PROFILE_WATCH_DEBOUNCE_MS: '50',
    DSH_PROFILE_WATCH_POLL_MS: '150',
    DSH_PROFILE_WATCH_REWATCH_MS: '150',
  }
}

function readReport(profile) {
  return JSON.parse(readFileSync(profile.report, 'utf8'))
}

function stateOf(report, id) {
  return report.patches.find((entry) => entry.id === id)?.state
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (predicate()) return
    } catch {}
    if (Date.now() > deadline) throw new Error(`超时：${label}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

// --once：只补一遍就退出，不常驻。供 supervisor 之外的一次性场景和本测试使用。
{
  const profile = createProfile()
  try {
    const http = installMarket(profile)
    const result = spawnSync(process.execPath, [watcher, '--once'], {
      env: watchEnv(profile),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(http, 'utf8'), /status === 502 \? 422 : status/)
    assert.equal(stateOf(readReport(profile), 'market-application-status'), 'applied')
  } finally {
    rmSync(profile.root, { recursive: true, force: true })
  }
}

// 常驻模式：先在空 profile 上起来（这时没有插件，报告里全是 absent），再模拟一次
// hot-mount 安装，watcher 必须自己发现并补上。
{
  const profile = createProfile()
  mkdirSync(profile.modules, { recursive: true })
  const child = spawn(process.execPath, [watcher], {
    env: watchEnv(profile),
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  let exited = false
  child.on('exit', () => { exited = true })
  try {
    await waitFor(() => existsSync(profile.report), '首轮报告未生成')
    assert.equal(stateOf(readReport(profile), 'market-application-status'), 'absent')

    const http = installMarket(profile)
    await waitFor(
      () => /status === 502 \? 422 : status/.test(readFileSync(http, 'utf8')),
      '热挂载后补丁没被重打',
    )
    await waitFor(
      () => stateOf(readReport(profile), 'market-application-status') === 'applied',
      '热挂载后报告没更新',
    )
    assert.equal(exited, false, 'watcher 不应在常驻模式下退出')
  } finally {
    child.kill('SIGKILL')
    rmSync(profile.root, { recursive: true, force: true })
  }
}

console.log('profile watch smoke: ok')
