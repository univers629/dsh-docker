import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalDshHome = process.env.DSH_HOME
const originalDshAppDir = process.env.DSH_APP_DIR
const originalUpdateState = process.env.DSH_UPDATE_STATE
const originalUpdateExecutable = process.env.DSH_UPDATE_EXECUTABLE
const testHome = await mkdtemp(join(tmpdir(), 'dsh-docker-control-'))
process.env.DSH_HOME = testHome
process.env.DSH_APP_DIR = join(testHome, 'app')
process.env.DSH_UPDATE_STATE = join(testHome, 'update')
process.env.DSH_UPDATE_EXECUTABLE = join(testHome, 'update-dsh')
const { apply, inject, name } = await import(`../dsh-home/docker-control/lib/index.js?test=${Date.now()}`)

try {
  assert.equal(name, 'dsh-docker-control')
  assert.deepEqual(inject, ['webServer'])

  const routes = []
  apply({
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  })

  assert.deepEqual(routes.map(route => route.path), [
    '/dsh-docker-control/info',
    '/dsh-docker-control/update/status',
    '/dsh-docker-control/update',
    '/dsh-docker-control/config',
    '/dsh-docker-control/status',
    '/dsh-docker-control/restart',
  ])

  function response() {
    return {
      status: undefined,
      headers: undefined,
      body: '',
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(body = '') {
        this.body += body
      },
    }
  }

  const statusRoute = routes.find(route => route.path === '/dsh-docker-control/status')
  const statusResponse = response()
  statusRoute.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, statusResponse)
  assert.equal(statusResponse.status, 200)
  const statusBody = JSON.parse(statusResponse.body)
  assert.equal(statusBody.ok, true)
  assert.equal(typeof statusBody.boot, 'string')

  const infoRoute = routes.find(route => route.path.endsWith('/info'))
  const infoResponse = response()
  await infoRoute.handler({
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081' },
  }, infoResponse)
  assert.equal(infoResponse.status, 200)
  const infoBody = JSON.parse(infoResponse.body)
  assert.equal(infoBody.ok, true)
  assert.equal(infoBody.dsh.version, 'unknown')
  assert.equal(typeof infoBody.system.nodeVersion, 'string')

  const updateStatusRoute = routes.find(route => route.path.endsWith('/update/status'))
  const updateStatusResponse = response()
  updateStatusRoute.handler({
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081' },
  }, updateStatusResponse)
  assert.equal(updateStatusResponse.status, 200)
  assert.equal(JSON.parse(updateStatusResponse.body).state, 'idle')

  const updateRoute = routes.find(route => route.path.endsWith('/update'))
  const deniedUpdate = response()
  updateRoute.handler({
    method: 'POST',
    socket: { remoteAddress: '203.0.113.10' },
    headers: { host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081' },
  }, deniedUpdate)
  assert.equal(deniedUpdate.status, 403)

  const updater = join(testHome, 'update-dsh')
  await writeFile(updater, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await mkdir(join(testHome, 'update', '.lock'), { recursive: true })
  await writeFile(join(testHome, 'update', '.lock', 'pid'), `${process.pid}\n`)
  const busyUpdate = response()
  updateRoute.handler({
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081' },
  }, busyUpdate)
  assert.equal(busyUpdate.status, 409)
  await rm(join(testHome, 'update', '.lock'), { recursive: true, force: true })

  const configRoute = routes.find(route => route.path.endsWith('/config'))
  const configPath = join(testHome, 'settings.yaml')
  await writeFile(configPath, 'demo:\n  enabled: true\n', { mode: 0o600 })
  const configGet = response()
  await configRoute.handler({
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081' },
  }, configGet)
  assert.equal(configGet.status, 200)
  const configBody = JSON.parse(configGet.body)
  assert.equal(configBody.text, 'demo:\n  enabled: true\n')
  assert.match(configBody.revision, /^[a-f0-9]{64}$/)

  function jsonRequest(method, body, headers = {}) {
    return {
      method,
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081', ...headers },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }
  }

  const configPut = response()
  await configRoute.handler(jsonRequest('PUT', { text: 'demo:\n  enabled: false\n', revision: configBody.revision }), configPut)
  assert.equal(configPut.status, 200, configPut.body)
  assert.equal(await readFile(configPath, 'utf8'), 'demo:\n  enabled: false\n')
  if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o777, 0o600)
  const savedBody = JSON.parse(configPut.body)

  const invalidYaml = response()
  await configRoute.handler(jsonRequest('PUT', { text: 'demo: [\n', revision: savedBody.revision }), invalidYaml)
  assert.equal(invalidYaml.status, 422)
  assert.equal(await readFile(configPath, 'utf8'), 'demo:\n  enabled: false\n')

  const duplicateKey = response()
  await configRoute.handler(jsonRequest('PUT', { text: 'demo: true\ndemo: false\n', revision: savedBody.revision }), duplicateKey)
  assert.equal(duplicateKey.status, 422)
  assert.equal(await readFile(configPath, 'utf8'), 'demo:\n  enabled: false\n')

  for (const invalidRoot of ['- item\n', 'plain scalar\n']) {
    const invalidRootResponse = response()
    await configRoute.handler(jsonRequest('PUT', { text: invalidRoot, revision: savedBody.revision }), invalidRootResponse)
    assert.equal(invalidRootResponse.status, 422)
    assert.equal(await readFile(configPath, 'utf8'), 'demo:\n  enabled: false\n')
  }

  const oversized = response()
  await configRoute.handler(jsonRequest('PUT', { text: `value: ${'x'.repeat(1024 * 1024)}\n`, revision: savedBody.revision }), oversized)
  assert.equal(oversized.status, 422)
  assert.equal(await readFile(configPath, 'utf8'), 'demo:\n  enabled: false\n')

  const missingRevision = response()
  await configRoute.handler(jsonRequest('PUT', { text: 'demo: true\n' }), missingRevision)
  assert.equal(missingRevision.status, 400)
  assert.equal(await readFile(configPath, 'utf8'), 'demo:\n  enabled: false\n')

  const concurrentA = response()
  const concurrentB = response()
  await Promise.all([
    configRoute.handler(jsonRequest('PUT', { text: 'demo: first\n', revision: savedBody.revision }), concurrentA),
    configRoute.handler(jsonRequest('PUT', { text: 'demo: second\n', revision: savedBody.revision }), concurrentB),
  ])
  assert.deepEqual([concurrentA.status, concurrentB.status].sort(), [200, 409])
  const concurrentWinner = concurrentA.status === 200 ? JSON.parse(concurrentA.body) : JSON.parse(concurrentB.body)

  const conflict = response()
  await configRoute.handler(jsonRequest('PUT', { text: 'demo:\n  enabled: true\n', revision: savedBody.revision }), conflict)
  assert.equal(conflict.status, 409)
  assert.equal(JSON.parse(conflict.body).conflict, true)

  const finalPut = response()
  await configRoute.handler(jsonRequest('PUT', { text: 'demo:\n  enabled: true\n', revision: concurrentWinner.revision }), finalPut)
  assert.equal(finalPut.status, 200)

  const deniedConfig = response()
  await configRoute.handler({
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081', 'x-forwarded-for': '203.0.113.10' },
  }, deniedConfig)
  assert.equal(deniedConfig.status, 403)

  const restartRoute = routes.find(route => route.path.endsWith('/restart'))
  const rejected = response()
  restartRoute.handler({
    method: 'POST', socket: { remoteAddress: '203.0.113.10' },
    headers: { host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081' },
  }, rejected)
  assert.equal(rejected.status, 403)
  assert.equal(JSON.parse(rejected.body).ok, false)

  const forwarded = response()
  restartRoute.handler({
    method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081', 'x-forwarded-for': '203.0.113.10' },
  }, forwarded)
  assert.equal(forwarded.status, 403)

  console.log('docker-control host smoke: ok')
} finally {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  if (originalDshAppDir === undefined) delete process.env.DSH_APP_DIR
  else process.env.DSH_APP_DIR = originalDshAppDir
  if (originalUpdateState === undefined) delete process.env.DSH_UPDATE_STATE
  else process.env.DSH_UPDATE_STATE = originalUpdateState
  if (originalUpdateExecutable === undefined) delete process.env.DSH_UPDATE_EXECUTABLE
  else process.env.DSH_UPDATE_EXECUTABLE = originalUpdateExecutable
  await rm(testHome, { recursive: true, force: true })
}
