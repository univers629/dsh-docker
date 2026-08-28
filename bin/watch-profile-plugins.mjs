#!/usr/bin/env node
// 监视 profile 的插件目录，一有变化就重跑 patch-profile-plugins.mjs。
//
// 为什么需要它：supervisor 只在拉起 DSH 之前补一次（prepare_dsh），而 dsh-market 的
// hot-mount 安装是"restart-free"的——插件装完直接挂进运行中的 composition，进程根本
// 不重启，那一次补丁就永远不会发生。client bundle 是每次请求现读、cache-control:
// no-cache，所以补完文件刷新页面即刻生效；host 侧的模块要等下一次重启才换掉，这是
// Node ESM 的限制，任何方案都绕不过。
//
// 实现上刻意不用 { recursive: true }：profile 的 node_modules 动辄上千个目录，递归
// watch 会按目录数吃 inotify 配额。这里只 watch node_modules 这一层（装卸包一定会动
// 它），再叠加一个"顶层条目名 + mtime"的轮询兜底，覆盖 fs.watch 漏报和目录被整体
// 替换的情况。manage-dsh-plugin 就是原子替换整个 profile 目录，watch 句柄会随旧
// inode 一起失效，所以下面必须能重建 watch。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const profileRoot = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web'
const modulesDir = path.join(profileRoot, 'node_modules')
const patcher = process.env.DSH_PROFILE_PATCHER ?? '/usr/local/bin/patch-profile-plugins.mjs'
const debounceMs = Number(process.env.DSH_PROFILE_WATCH_DEBOUNCE_MS) || 1500
const pollMs = Number(process.env.DSH_PROFILE_WATCH_POLL_MS) || 5000
const rewatchMs = Number(process.env.DSH_PROFILE_WATCH_REWATCH_MS) || 5000
const once = process.argv.includes('--once')

let watcher
let debounce
let running = false
let queued = false
let stopping = false
let fingerprint

function log(message) {
  process.stderr.write(`[profile-watch] ${message}\n`)
}

// 顶层条目名 + mtime。包被装卸或整个包目录被替换都会改变它；包内深层文件的原地
// 改写不会，那种情况靠 fs.watch 报上来。
function readFingerprint() {
  let entries
  try {
    entries = fs.readdirSync(modulesDir, { withFileTypes: true })
  } catch {
    return ''
  }
  const rows = []
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    let stamp = ''
    try {
      stamp = String(fs.statSync(path.join(modulesDir, entry.name)).mtimeMs)
    } catch {}
    rows.push(`${entry.name}:${stamp}`)
  }
  return rows.join('\n')
}

function runPatcher() {
  if (running) {
    queued = true
    return
  }
  running = true
  const child = spawn(process.execPath, [patcher], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  })
  child.on('error', (error) => {
    log(`补丁脚本起不来：${error.message}`)
  })
  child.on('exit', (code, signal) => {
    running = false
    if (code !== 0) log(`补丁脚本退出码 ${code ?? signal}`)
    // 补丁自己会改文件，从而触发新的 watch 事件；fingerprint 必须在跑完之后刷新，
    // 否则会跟自己的写入较劲，无限循环。
    fingerprint = readFingerprint()
    if (queued && !stopping) {
      queued = false
      schedule()
    }
  })
}

function schedule() {
  if (stopping) return
  clearTimeout(debounce)
  debounce = setTimeout(runPatcher, debounceMs)
}

function watch() {
  if (stopping) return
  try {
    watcher = fs.watch(modulesDir, { persistent: true }, () => schedule())
  } catch (error) {
    log(`${modulesDir} 暂时监视不了（${error.message}），${rewatchMs}ms 后重试`)
    setTimeout(watch, rewatchMs)
    return
  }
  const rewatch = () => {
    if (stopping) return
    try { watcher.close() } catch {}
    // 目录被整体替换后旧句柄监视的是已经没人引用的 inode，必须重新打开。
    setTimeout(watch, rewatchMs)
    schedule()
  }
  watcher.on('error', rewatch)
  watcher.on('close', () => {
    if (!stopping) rewatch()
  })
}

function stop() {
  stopping = true
  clearTimeout(debounce)
  try { watcher?.close() } catch {}
  process.exit(0)
}

// 启动时先补一遍：watcher 起来之前发生的安装不会有事件，而这一次也顺便把
// verify-dsh-hardening 要读的报告写出来。
runPatcher()

if (!once) {
  fingerprint = readFingerprint()
  watch()
  // 这个 interval 故意不 unref：它是进程的存活锚点。fs.watch 在目录被替换后可能
  // 短暂关闭，那段窗口里不能让整个 watcher 直接退出。
  setInterval(() => {
    const next = readFingerprint()
    if (next === fingerprint) return
    fingerprint = next
    schedule()
  }, pollMs)
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.on('SIGHUP', stop)
}
