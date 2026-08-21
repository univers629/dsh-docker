import { existsSync, appendFileSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

export const name = 'dsh-docker-control'
export const inject = ['webServer']

const BOOT_ID = `${Date.now()}-${process.pid}`

function sendJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(value))
}

function trustedLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (request.headers.forwarded !== undefined
    || request.headers['x-forwarded-for'] !== undefined
    || request.headers['x-real-ip'] !== undefined) return false
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

function nodeExecutable() {
  if (process.argv0 && process.argv0.startsWith('/') && existsSync(process.argv0)) return process.argv0
  return process.execPath
}

function restartLaunch() {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\\.(?:js|ts)|dsh)$/.test(entry)) {
    return {
      file: nodeExecutable(),
      args: [...process.execArgv, entry, ...process.argv.slice(2)],
      cwd: process.cwd(),
    }
  }
  return { file: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)], cwd: process.cwd() }
}

function scheduleRestart() {
  const launch = restartLaunch()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = join(tmpdir(), `dsh-docker-control-${stamp}.out.log`)
  const errPath = join(tmpdir(), `dsh-docker-control-${stamp}.err.log`)
  const out = openSync(outPath, 'a')
  const err = openSync(errPath, 'a')
  const helper = spawn(nodeExecutable(), ['-e', `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const file = ${JSON.stringify(launch.file)}
const args = ${JSON.stringify(launch.args)}
const cwd = ${JSON.stringify(launch.cwd)}
const outPath = ${JSON.stringify(outPath)}
const errPath = ${JSON.stringify(errPath)}
setTimeout(() => {
  try {
    const out = fs.openSync(outPath, 'a')
    const err = fs.openSync(errPath, 'a')
    const child = spawn(file, args, { cwd, detached: true, stdio: ['ignore', out, err], env: process.env })
    child.on('error', e => { try { fs.appendFileSync(errPath, '[dsh-docker-control] ' + e.message + '\\n') } catch {} })
    child.unref()
  } catch (e) {
    try { fs.appendFileSync(errPath, '[dsh-docker-control] ' + String(e) + '\\n') } catch {}
  }
}, 1200)
`], { detached: true, stdio: ['ignore', out, err], env: process.env })
  helper.unref()
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
  return { boot: BOOT_ID, pid: process.pid, helperPid: helper.pid, logOut: outPath, logErr: errPath }
}

export function apply(ctx) {
  const webServer = ctx.webServer
  webServer.register({
    kind: 'exact',
    path: '/dsh-docker-control/status',
    handler: (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      sendJson(response, 200, { ok: true, boot: BOOT_ID })
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/dsh-docker-control/restart',
    handler: (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!trustedLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: '重启仅允许已认证的回环请求 / restart requires an authenticated loopback request' })
        return
      }
      try {
        sendJson(response, 202, { ok: true, ...scheduleRestart() })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
