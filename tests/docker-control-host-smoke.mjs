import assert from 'node:assert/strict'
import { apply, inject, name } from '../dsh-home/docker-control/lib/index.js'

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

const statusRoute = routes.find(route => route.path.endsWith('/status'))
const statusResponse = response()
statusRoute.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, statusResponse)
assert.equal(statusResponse.status, 200)
const statusBody = JSON.parse(statusResponse.body)
assert.equal(statusBody.ok, true)
assert.equal(typeof statusBody.boot, 'string')

const restartRoute = routes.find(route => route.path.endsWith('/restart'))
const rejected = response()
restartRoute.handler({
  method: 'POST',
  socket: { remoteAddress: '203.0.113.10' },
  headers: { host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081' },
}, rejected)
assert.equal(rejected.status, 403)
assert.equal(JSON.parse(rejected.body).ok, false)

const forwarded = response()
restartRoute.handler({
  method: 'POST',
  socket: { remoteAddress: '127.0.0.1' },
  headers: {
    host: '127.0.0.1:3081',
    origin: 'http://127.0.0.1:3081',
    'x-forwarded-for': '203.0.113.10',
  },
}, forwarded)
assert.equal(forwarded.status, 403)

console.log('docker-control host smoke: ok')
