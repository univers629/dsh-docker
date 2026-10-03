// 契约测试：没有 YAML 解析器时，插件必须**拒绝**保存 settings.yaml，而不是写进一个
// 连它自己都读不回来的文件。生产里解析器总是可达（插件自己声明了 yaml 依赖，DSH 也
// 随带一份，插件用 createRequire 相对自身向上解析），所以这条保险分支只能在隔离环境
// 里验证：子进程清空 NODE_PATH、在临时目录里加载插件，确保解析器确实不可达。
//
// 若运行环境里解析器意外可达（例如有人在仓库祖先目录装了 yaml），本测试会打印跳过
// 说明而不是假装通过——"没跑到"必须看得见。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const pluginPath = join(repo, 'dsh-home', 'docker-control', 'lib', 'index.js')
const work = mkdtempSync(join(tmpdir(), 'dsh-control-noyaml-'))
const home = join(work, 'home')
const settings = join(home, 'settings.yaml')
const original = 'demo:\n  enabled: true\n'
mkdirSync(home, { recursive: true })
writeFileSync(settings, original)

// 子进程只做一件事：加载插件、取出 /config 路由、发一次合法 PUT，把结果 JSON 打到
// stdout。它不添加任何 NODE_PATH，因此解析器只能靠插件自己的位置向上找。
const driver = `
const routes = []
const { apply } = await import(${JSON.stringify(pathToFileURL(pluginPath).href)})
apply({ webServer: { register(route) { routes.push(route); return () => {} } } })
const route = routes.find(entry => entry.path.endsWith('/config'))
const call = async (method, body) => {
  let status
  let payload = ''
  await route.handler({
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081' },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }, { writeHead(value) { status = value }, end(chunk = '') { payload += chunk } })
  return { status, payload }
}
// PUT 需要携带当前 revision（乐观并发），所以先读一次拿到它，再发这次写入。
const current = await call('GET')
const revision = JSON.parse(current.payload).revision
const saved = await call('PUT', { text: 'demo:\\n  enabled: false\\n', revision })
process.stdout.write(JSON.stringify({ status: saved.status, body: saved.payload }))
`

try {
  // 继承的 NODE_PATH 必须留着：运行环境可能靠它解析进程预加载模块（例如 harness 注入
  // 的 --require）。但若其中某一项恰好提供 yaml，解析器就会可达、拒绝分支跑不到——那种
  // 情况下过滤掉它，并让下游的"解析器可达则跳过"分支把这件事说出来。
  const inherited = (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean)
  const withoutYaml = inherited.filter((entry) => !existsSync(join(entry, 'yaml')))
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_PATH: withoutYaml.join(delimiter),
      DSH_HOME: home,
      DSH_APP_DIR: join(work, 'app'),
      DSH_UPDATE_STATE: join(work, 'update'),
      DSH_UPDATE_EXECUTABLE: join(work, 'update-dsh'),
      DSH_RESTART_EXECUTABLE: process.execPath,
    },
  })
  assert.equal(result.status, 0, `子进程失败：${result.stderr || result.stdout}`)

  const parsed = JSON.parse(result.stdout)
  if (parsed.status === 200) {
    console.log('docker control no-yaml smoke: skipped（该环境里 YAML 解析器可达，无法验证拒绝保存分支）')
  } else {
    assert.equal(parsed.status, 500, `无解析器时必须拒绝保存，实际 HTTP ${parsed.status}`)
    assert.match(parsed.body, /YAML 解析器不可用/, '拒绝原因必须可读，运维才知道要装什么')
    assert.equal(
      readFileSync(settings, 'utf8'),
      original,
      '拒绝保存时设置文件必须原样保留：写到一半比不写更糟，容器会带着读不回来的配置启动',
    )
    console.log('docker control no-yaml smoke: ok')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
