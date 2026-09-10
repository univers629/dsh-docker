import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const patcher = resolve('bin/patch-profile-plugins.mjs')

// dsh-market 的 client bundle 用过两种形状的 URL 参数：1.35.0 之前是路径字面量，
// 之后包了一层 api()。补丁必须两种都认，否则会像 1.35.0 那样静默失配。
const clientShapes = [
  ['literal-url', 'return fetch("/dsh-market/update", {'],
  ['api-wrapped-url', 'return fetch(api("/dsh-market/update"), {'],
]

function marketClientSource(fetchLine) {
  return `
const doUpdate = () => {
  ${fetchLine}
    method: "POST"
  }).then((res) => res.json().then((body) => ({
    status: res.status,
    body
  }))).then(({ status, body }) => {
    return { status, body }
  })
}

const zhCN = {
  restartHint: "重启方式：关闭当前 dsh 进程后重新运行（例如 dsh web）",
}
const enUS = {
  restartHint: "To restart: stop the current dsh process and run it again (e.g. dsh web)",
}
`
}

// 市场自己那份组合补丁：它在 insert 块里既没有 config，也是唯一一处能声明
// "重启权交给 supervisor" 的地方。
const marketPatchSource = `# dsh bundle patch: inserts this plugin into a profile's layer stack.
- insert:
    - id: dsh-market
      name: 'dshmarket'
`

const marketHttpSource = `
export function sendJson(response, status, payload) {
    response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
}
`

function createProfile(fetchLine) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-patches-'))
  const marketRoot = join(root, 'node_modules', 'dshmarket')
  mkdirSync(join(marketRoot, 'client'), { recursive: true })
  mkdirSync(join(marketRoot, 'lib'), { recursive: true })
  writeFileSync(join(marketRoot, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(marketRoot, 'client', 'client.js'), marketClientSource(fetchLine))
  writeFileSync(join(marketRoot, 'lib', 'http.js'), marketHttpSource)
  writeFileSync(join(marketRoot, 'cordis.patch.yml'), marketPatchSource)
  return {
    root,
    client: join(marketRoot, 'client', 'client.js'),
    http: join(marketRoot, 'lib', 'http.js'),
    patch: join(marketRoot, 'cordis.patch.yml'),
    report: join(root, 'profile-patches.json'),
  }
}

function runPatcher(profile) {
  const result = spawnSync(process.execPath, [patcher], {
    cwd: resolve('.'),
    env: { ...process.env, DSH_PROFILE_ROOT: profile.root, DSH_PROFILE_PATCH_REPORT: profile.report },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

function readReport(profile) {
  return JSON.parse(readFileSync(profile.report, 'utf8'))
}

function stateOf(report, id) {
  return report.patches.find((entry) => entry.id === id)?.state
}

for (const [label, fetchLine] of clientShapes) {
  const profile = createProfile(fetchLine)
  try {
    const first = runPatcher(profile)
    assert.match(first.stderr, /fixed dsh-market non-JSON update responses/, label)
    assert.match(first.stderr, /kept dsh-market application errors out of gateway HTTP 502 responses/, label)
    assert.match(first.stderr, /told dsh-market the supervisor owns restarts/, label)
    assert.match(first.stderr, /pointed the dsh-market restart hint/, label)

    const patchedClient = readFileSync(profile.client, 'utf8')
    const patchedHttp = readFileSync(profile.http, 'utf8')
    const patchedPatch = readFileSync(profile.patch, 'utf8')
    assert.match(patchedClient, /await res\.text\(\)/, label)
    assert.match(patchedHttp, /status === 502 \? 422 : status/, label)
    // 市场的组合补丁要变成「插入行 + config.allowRestart: false」，缩进跟它自己的
    // name: 对齐 —— 缩进错一层 YAML 就会把 config 挂到别的层级上去。
    assert.equal(
      patchedPatch,
      marketPatchSource.replace(
        "      name: 'dshmarket'\n",
        "      name: 'dshmarket'\n      config:\n        allowRestart: false\n",
      ),
      label,
    )
    // 提示词要指向本工程真正的重启入口，不能再是那句在本容器里会制造故障的 dsh web。
    assert.match(patchedClient, /点设置页里的「重启 DSH」按钮/, label)
    assert.doesNotMatch(patchedClient, /关闭当前 dsh 进程后重新运行/, label)
    assert.doesNotMatch(patchedClient, /stop the current dsh process and run it again/, label)

    const firstReport = readReport(profile)
    assert.equal(stateOf(firstReport, 'market-non-json-update'), 'applied', label)
    assert.equal(stateOf(firstReport, 'market-application-status'), 'applied', label)
    assert.equal(stateOf(firstReport, 'market-restart-ownership'), 'applied', label)
    assert.equal(stateOf(firstReport, 'market-restart-hint'), 'applied', label)
    // vision-router 没装：absent 是正常结论，不能算失配。
    assert.equal(stateOf(firstReport, 'vision-router-remote-settings'), 'absent', label)
    assert.deepEqual(firstReport.unrecognized, [], label)

    const moduleUrl = `${pathToFileURL(profile.http).href}?test=${Date.now()}`
    const { sendJson } = await import(moduleUrl)
    const replies = []
    const response = {
      writeHead(status, headers) { replies.push({ status, headers, body: '' }) },
      end(body) { replies.at(-1).body = body },
    }

    sendJson(response, 502, { error: 'fresh release', stale: true })
    sendJson(response, 409, { error: 'busy' })
    assert.equal(replies[0].status, 422, label)
    assert.equal(replies[0].headers['content-type'], 'application/json; charset=utf-8', label)
    assert.deepEqual(JSON.parse(replies[0].body), { error: 'fresh release', stale: true }, label)
    assert.equal(replies[1].status, 409, label)

    const beforeSecondRun = readFileSync(profile.http, 'utf8')
    runPatcher(profile)
    assert.equal(readFileSync(profile.http, 'utf8'), beforeSecondRun, label)
    assert.equal((beforeSecondRun.match(/status === 502 \? 422 : status/g) ?? []).length, 1, label)
    // 幂等：第二遍不能再插一行 config，也不能再改一次提示词。
    assert.equal(readFileSync(profile.patch, 'utf8'), patchedPatch, label)
    assert.equal(readFileSync(profile.client, 'utf8'), patchedClient, label)
    assert.equal((patchedPatch.match(/allowRestart: false/g) ?? []).length, 1, label)

    const secondReport = readReport(profile)
    assert.equal(stateOf(secondReport, 'market-non-json-update'), 'current', label)
    assert.equal(stateOf(secondReport, 'market-application-status'), 'current', label)
    assert.equal(stateOf(secondReport, 'market-restart-ownership'), 'current', label)
    assert.equal(stateOf(secondReport, 'market-restart-hint'), 'current', label)
  } finally {
    rmSync(profile.root, { recursive: true, force: true })
  }
}

// 认不出上游形状时必须留下可被自检读到的证据，而不是只打一行 stderr。
{
  const profile = createProfile('return fetch(resolveUpdateEndpoint(), {')
  try {
    const result = runPatcher(profile)
    assert.match(result.stderr, /market-non-json-update: 认不出上游形状/)
    const report = readReport(profile)
    assert.equal(stateOf(report, 'market-non-json-update'), 'unrecognized')
    // 同一次运行里另一条仍要正常打上：一条失配不能连坐。
    assert.equal(stateOf(report, 'market-application-status'), 'applied')
    assert.deepEqual(report.unrecognized, ['market-non-json-update'])
  } finally {
    rmSync(profile.root, { recursive: true, force: true })
  }
}

// 上游哪天自己在插入行里写上 config 了：这时宁可不补，也不能写出第二个 config 键把
// profile 的组合搞坏 —— unrecognized 就是给这种情况留的口子，人得看到它。
{
  const profile = createProfile('return fetch("/dsh-market/update", {')
  writeFileSync(
    profile.patch,
    marketPatchSource.replace(
      "      name: 'dshmarket'\n",
      "      name: 'dshmarket'\n      config:\n        profile: web\n",
    ),
  )
  try {
    const result = runPatcher(profile)
    assert.match(result.stderr, /market-restart-ownership: 认不出上游形状/)
    const report = readReport(profile)
    assert.equal(stateOf(report, 'market-restart-ownership'), 'unrecognized')
    // 一条失配不能连坐：提示词那条照样要打上。
    assert.equal(stateOf(report, 'market-restart-hint'), 'applied')
    assert.equal((readFileSync(profile.patch, 'utf8').match(/\bconfig:/g) ?? []).length, 1)
  } finally {
    rmSync(profile.root, { recursive: true, force: true })
  }
}

console.log('profile plugin patches smoke: ok')
