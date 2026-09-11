// Container metrics for the sidebar card.
//
// Every number here is this container's own accounting, never the host's:
//   * CPU, memory and block I/O come from the cgroup v2 tree. Inside a
//     container /proc/stat and /proc/meminfo report the host, so a "container
//     monitor" must not read them.
//   * Network comes from /proc/net/dev, which is per network namespace.
// The three paths are overridable so the smoke test can point them at
// fixtures it rewrites between calls.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CGROUP_ROOT = process.env.DSH_METRICS_CGROUP_ROOT || '/sys/fs/cgroup'
const NET_DEV_FILE = process.env.DSH_METRICS_NET_DEV || '/proc/net/dev'
// A snapshot younger than this is reused: two open tabs then share one
// sampling window instead of fighting over it, and a fast poll can never
// produce a divide-by-almost-zero rate.
const SAMPLE_TTL_MS = Number(process.env.DSH_METRICS_SAMPLE_TTL_MS ?? 900)

// Both the three paths and the window are read through these helpers so the
// smoke test can repoint them, and change the window, inside one process.
function cgroupRoot() {
  return process.env.DSH_METRICS_CGROUP_ROOT || CGROUP_ROOT
}

function netDevFile() {
  return process.env.DSH_METRICS_NET_DEV || NET_DEV_FILE
}

function sampleTtlMs() {
  return Number(process.env.DSH_METRICS_SAMPLE_TTL_MS ?? SAMPLE_TTL_MS)
}

let previous = null
let latest = null

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readCpuUsec() {
  const text = readText(join(cgroupRoot(), 'cpu.stat'))
  if (text === null) return null
  const matched = /^usage_usec\s+(\d+)\s*$/m.exec(text)
  return matched === null ? null : finite(Number(matched[1]))
}

function readCpuQuotaCores() {
  const text = readText(join(cgroupRoot(), 'cpu.max'))
  if (text === null) return null
  const [quota, period] = text.trim().split(/\s+/)
  if (quota === undefined || quota === 'max') return null
  const cores = Number(quota) / Number(period)
  return Number.isFinite(cores) && cores > 0 ? cores : null
}

function readMemoryBytes() {
  const rawCurrent = readText(join(cgroupRoot(), 'memory.current'))
  const rawMax = readText(join(cgroupRoot(), 'memory.max'))
  const rawStat = readText(join(cgroupRoot(), 'memory.stat'))
  const current = rawCurrent === null ? null : finite(Number(rawCurrent.trim()))
  const max = rawMax === null || rawMax.trim() === 'max' ? null : finite(Number(rawMax.trim()))
  // memory.current counts page cache. Report the working set instead — the
  // number `docker stats` shows — so a container that has merely read a lot of
  // files does not look like it is about to run out of memory.
  const inactive = rawStat === null ? null : finite(Number((/^inactive_file\s+(\d+)/m.exec(rawStat) ?? [])[1]))
  const used = current === null ? null : inactive === null ? current : Math.max(0, current - inactive)
  return { usedBytes: used, limitBytes: max === null || max <= 0 ? null : max }
}

// cgroup v2 io.stat reports bytes per device, for this cgroup only.
function readIoBytes() {
  const text = readText(join(cgroupRoot(), 'io.stat'))
  if (text === null) return { readBytes: null, writeBytes: null }
  let readBytes = 0
  let writeBytes = 0
  let seen = false
  for (const line of text.split('\n')) {
    const read = /\brbytes=(\d+)/.exec(line)
    const write = /\bwbytes=(\d+)/.exec(line)
    if (read !== null) {
      readBytes += Number(read[1])
      seen = true
    }
    if (write !== null) {
      writeBytes += Number(write[1])
      seen = true
    }
  }
  return seen ? { readBytes, writeBytes } : { readBytes: null, writeBytes: null }
}

function readNetBytes() {
  const text = readText(netDevFile())
  if (text === null) return { rxBytes: null, txBytes: null }
  let rxBytes = 0
  let txBytes = 0
  let seen = false
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const name = line.slice(0, colon).trim()
    // Loopback traffic is real traffic for the container, but counting it
    // would make the card look busy whenever the page polls itself.
    if (name === '' || name === 'lo') continue
    const fields = line.slice(colon + 1).trim().split(/\s+/)
    if (fields.length < 9) continue
    const rx = Number(fields[0])
    const tx = Number(fields[8])
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue
    rxBytes += rx
    txBytes += tx
    seen = true
  }
  return seen ? { rxBytes, txBytes } : { rxBytes: null, txBytes: null }
}

function readCounters(at) {
  const memory = readMemoryBytes()
  const io = readIoBytes()
  const net = readNetBytes()
  return {
    at,
    cpuUsec: readCpuUsec(),
    quotaCores: readCpuQuotaCores(),
    usedBytes: memory.usedBytes,
    limitBytes: memory.limitBytes,
    readBytes: io.readBytes,
    writeBytes: io.writeBytes,
    rxBytes: net.rxBytes,
    txBytes: net.txBytes,
  }
}

// Bytes (or microseconds) per second between two samples; null whenever either
// side is unavailable or a counter went backwards.
function rate(current, before, elapsedMs) {
  if (current === null || before === null || !(elapsedMs > 0)) return null
  const delta = current - before
  if (!(delta >= 0)) return null
  return (delta * 1000) / elapsedMs
}

function snapshot(counters, before, intervalMs) {
  const elapsed = before === null ? 0 : counters.at - before.at
  const cpuCores = rate(counters.cpuUsec, before === null ? null : before.cpuUsec, elapsed)
  const rxRate = rate(counters.rxBytes, before === null ? null : before.rxBytes, elapsed)
  const txRate = rate(counters.txBytes, before === null ? null : before.txBytes, elapsed)
  const readRate = rate(counters.readBytes, before === null ? null : before.readBytes, elapsed)
  const writeRate = rate(counters.writeBytes, before === null ? null : before.writeBytes, elapsed)
  const memoryPercent = counters.usedBytes === null || counters.limitBytes === null
    ? null
    : Math.min(100, (counters.usedBytes / counters.limitBytes) * 100)
  const quotaCores = before === null ? counters.quotaCores : (before.quotaCores ?? counters.quotaCores)
  return {
    ok: true,
    sampledAt: counters.at,
    // Null means "no baseline yet": the client shows values but no rate line.
    intervalMs: intervalMs > 0 ? intervalMs : null,
    cpu: {
      cores: cpuCores === null ? null : cpuCores / 1_000_000,
      percent: cpuCores === null ? null : cpuCores / 10_000,
      quotaCores,
    },
    memory: {
      usedBytes: counters.usedBytes,
      limitBytes: counters.limitBytes,
      percent: memoryPercent,
    },
    network: {
      rxBytesPerSec: rxRate,
      txBytesPerSec: txRate,
      rxBytesTotal: counters.rxBytes,
      txBytesTotal: counters.txBytes,
    },
    disk: {
      readBytesPerSec: readRate,
      writeBytesPerSec: writeRate,
      readBytesTotal: counters.readBytes,
      writeBytesTotal: counters.writeBytes,
    },
  }
}

// The one entry point the route uses. `nowMs` is injectable for tests.
export function containerMetrics(nowMs = Date.now()) {
  if (latest !== null && nowMs - latest.at < sampleTtlMs()) return latest.value
  const counters = readCounters(nowMs)
  const intervalMs = previous === null ? 0 : counters.at - previous.at
  const value = snapshot(counters, previous, intervalMs)
  previous = counters
  latest = { at: nowMs, value }
  return value
}

// Tests start from a clean slate; production never calls this.
export function resetContainerMetrics() {
  previous = null
  latest = null
}
