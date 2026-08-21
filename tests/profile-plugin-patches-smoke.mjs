import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'dsh-profile-patches-'))
const marketRoot = join(root, 'node_modules', 'dshmarket')
const marketClient = join(marketRoot, 'client', 'client.js')
const marketHttp = join(marketRoot, 'lib', 'http.js')
const patcher = resolve('bin/patch-profile-plugins.mjs')

mkdirSync(join(marketRoot, 'client'), { recursive: true })
mkdirSync(join(marketRoot, 'lib'), { recursive: true })
writeFileSync(join(marketRoot, 'package.json'), JSON.stringify({ type: 'module' }))
writeFileSync(marketClient, `
const doUpdate = () => {
  return fetch("/dsh-market/update", {
    method: "POST"
  }).then((res) => res.json().then((body) => ({
    status: res.status,
    body
  }))).then(({ status, body }) => {
    return { status, body }
  })
}
`)
writeFileSync(marketHttp, `
export function sendJson(response, status, payload) {
    response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
}
`)

function runPatcher() {
  const result = spawnSync(process.execPath, [patcher], {
    cwd: resolve('.'),
    env: { ...process.env, DSH_PROFILE_ROOT: root },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

try {
  const first = runPatcher()
  assert.match(first.stderr, /fixed dsh-market non-JSON update responses/)
  assert.match(first.stderr, /kept dsh-market application errors out of gateway HTTP 502 responses/)

  const patchedClient = readFileSync(marketClient, 'utf8')
  const patchedHttp = readFileSync(marketHttp, 'utf8')
  assert.match(patchedClient, /await res\.text\(\)/)
  assert.match(patchedHttp, /status === 502 \? 422 : status/)

  const moduleUrl = `${pathToFileURL(marketHttp).href}?test=${Date.now()}`
  const { sendJson } = await import(moduleUrl)
  const replies = []
  const response = {
    writeHead(status, headers) { replies.push({ status, headers, body: '' }) },
    end(body) { replies.at(-1).body = body },
  }

  sendJson(response, 502, { error: 'fresh release', stale: true })
  sendJson(response, 409, { error: 'busy' })
  assert.equal(replies[0].status, 422)
  assert.equal(replies[0].headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(replies[0].body), { error: 'fresh release', stale: true })
  assert.equal(replies[1].status, 409)

  const beforeSecondRun = readFileSync(marketHttp, 'utf8')
  runPatcher()
  assert.equal(readFileSync(marketHttp, 'utf8'), beforeSecondRun)
  assert.equal((beforeSecondRun.match(/status === 502 \? 422 : status/g) ?? []).length, 1)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('profile plugin patches smoke: ok')
