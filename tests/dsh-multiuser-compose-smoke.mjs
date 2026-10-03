// 多用户部署接线的冒烟测试：真实调用 compose 校验配置，并用真实 nginx 校验入口配置语法。
//
// 覆盖点：
//   * docker compose 配置能解析，且叠加层确实替换了入口与网络（不再由 dsh 发布 3080）；
//   * 用户实例没有静态声明，也没有发布宿主端口；
//   * dsh-instances 是唯一挂 docker.sock 的服务；
//   * 七层入口配置里的 auth_request / auth_request_set / resolver / 变量上游都在位，
//     并且不再使用单用户模式的 Basic Auth 指令。

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const composeBase = path.join(root, 'docker-compose.yml')
const composeMulti = path.join(root, 'docker-compose.multiuser.yml')
const composeAuth = path.join(root, 'docker-compose.auth.yml')
const ingressConf = path.join(root, 'nginx', 'dsh-multiuser.conf')
const authgateConf = path.join(root, 'nginx', 'dsh-authgate.conf')

const conf = fs.readFileSync(ingressConf, 'utf8')

// ---------------------------------------------------------------- 入口配置静态断言
// 含 `$` 的断言一律用字符串包含，避免正则里 `\$` 与 `$` 锚点的转义歧义。
assert.ok(/location = \/__dsh_auth\/verify\s*\{[^}]*internal;/.test(conf), 'verify endpoint is internal-only')
assert.ok(conf.includes('auth_request /__dsh_auth/verify;'), 'auth_request is wired')
assert.ok(conf.includes('auth_request_set $dsh_instance $upstream_http_x_dsh_instance;'), 'instance comes from the verify response header')
assert.ok(conf.includes('proxy_pass http://$dsh_instance:3080;'), 'upstream is selected per session')
assert.ok(/resolver 127\.0\.0\.11/.test(conf), 'docker embedded DNS is configured for variable upstreams')
assert.ok(conf.includes('error_page 401 = @to_login;'), 'unauthenticated requests are sent to the login page')
assert.ok(conf.includes('return 302 /login?redirect=$request_uri;'), 'login redirect preserves the original target')
assert.ok(conf.includes('error_page 502 503 504 = @to_waking;'), 'an unreachable instance routes to the wake-up page')
assert.ok(conf.includes('proxy_intercept_errors on;'), 'upstream 502/503/504 must be intercepted, otherwise the raw error page reaches the browser')
assert.ok(conf.includes('return 302 /waking?redirect=$request_uri;'), 'wake-up redirect preserves the original target')
assert.ok(!/auth_basic\s+(on|off)?\s*;/.test(conf), 'multi-user ingress must not use Basic Auth')
assert.ok(!/^\s*stream\s*\{/m.test(conf), 'multi-user ingress is layer 7, not a TCP stream proxy')
assert.ok(/location ~ \^\/\(login\|register\|waking\|account\)\$/.test(conf), 'auth pages, including the account page, are served by the gateway')
assert.ok(/location ~ \^\/admin\(\/\|\$\)/.test(conf), 'the admin panel is served by the gateway')
assert.ok(/location \^~ \/api\/admin\//.test(conf), 'admin APIs are served by the gateway')
assert.ok(conf.includes('location ~ ^/(app\\.css|backdrop\\.js|account-panel\\.js)$'), 'gateway static assets, including the shared account panel, are served by the gateway')
assert.ok(conf.includes('location /api/auth/'), 'auth APIs bypass auth_request and are handled by the gateway')

// 限速必须只落在「提交凭据」的接口上：
// 账户面板一次打开就并发读取会话/通行密钥/状态，把读也计入额度会让正常使用撞 429。
assert.ok(conf.includes('location ~ ^/api/auth/(login|register|password|totp/|passkey/)'), 'credential-submitting endpoints are the rate-limited set')
assert.ok(/limit_req zone=dsh_auth_zone/.test(conf), 'the credential set is rate limited')
const readOnlyBlock = /location \/api\/auth\/ \{([\s\S]*?)\n        \}/.exec(conf)
assert.ok(readOnlyBlock, 'the read-only auth location exists')
assert.ok(!readOnlyBlock[1].includes('limit_req'), 'read-only auth endpoints must not be rate limited')
// 30r/m（0.5 次每秒）对交互式使用过紧，正常点几下就会 429
const rate = /limit_req_zone \$binary_remote_addr zone=dsh_auth_zone:10m rate=(\d+)r\/m;/.exec(conf)
assert.ok(rate, 'the rate zone is declared')
assert.ok(Number(rate[1]) >= 120, `the auth rate must leave room for interactive use, got ${rate[1]}r/m`)

// 单管理员入口：认证同样交给网关，且必须拦截上游错误、给出自动重试的过渡页。
const authgateSource = fs.readFileSync(authgateConf, 'utf8')
assert.ok(authgateSource.includes('auth_request /__dsh_auth/verify;'), 'the single-admin entry authenticates through the gateway')
assert.ok(authgateSource.includes('proxy_intercept_errors on;'), 'the single-admin entry intercepts upstream errors')
assert.ok(authgateSource.includes('location @unavailable'), 'dsh being unreachable shows a retrying page instead of a raw 502')
assert.ok(/add_header Retry-After/.test(authgateSource), 'the retrying page tells the browser when to come back')
assert.ok(authgateSource.includes('return 404;'), 'register and admin routes do not exist in single-administrator mode')
assert.ok(!/auth_basic\s+on/.test(authgateSource), 'the single-admin entry must not use Basic Auth')

// ---------------------------------------------------------------- compose 配置
let compose
try {
  // 分层：基础 + 认证层 + 多用户层，并激活多用户 profile。
  // 两个入口（authgate / ingress）都会发布同一个宿主端口，靠 profile 二选一。
  const composeArgs = ['compose', '-f', composeBase, '-f', composeAuth, '-f', composeMulti, '--profile', 'multiuser']
  const stdout = execFileSync('docker', [...composeArgs, 'config', '--format', 'json'], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
  })
  compose = JSON.parse(stdout)

  // 单管理员组合只应得到网关 + authgate，不应出现实例编排或多用户入口
  const authOnly = JSON.parse(execFileSync('docker', [
    'compose', '-f', composeBase, '-f', composeAuth, '--profile', 'authgate', 'config', '--format', 'json',
  ], { cwd: root, encoding: 'utf8', timeout: 120_000 }))
  const authOnlyServices = Object.keys(authOnly.services).sort()
  assert.deepEqual(authOnlyServices, ['dsh', 'dsh-auth', 'dsh-authgate'], 'password + single admin deploys exactly the gateway and its layer-7 entry')
  assert.ok(!('dsh-instances' in authOnly.services), 'no instance orchestration in single-administrator mode')
} catch (error) {
  // 没有 docker CLI 时不能假装验证过：明确报出跳过原因。
  const message = String(error?.stderr ?? error?.message ?? error)
  if (/ENOENT|not recognized|not found/i.test(message)) {
    console.log('dsh-multiuser compose smoke: skipped (docker CLI unavailable); static assertions passed')
    process.exit(0)
  }
  throw new Error(`docker compose config failed: ${message}`)
}

const services = compose.services
assert.ok(services['dsh-auth'], 'dsh-auth service exists in multi-user mode')
assert.ok(services['dsh-instances'], 'dsh-instances service exists in multi-user mode')
assert.ok(services['dsh-ingress'], 'layer-7 ingress exists in multi-user mode')

// 入口：只有 ingress 发布端口，dsh 本体不再对外
const published = Object.entries(services).filter(([, s]) => (s.ports ?? []).length > 0).map(([name]) => name)
assert.deepEqual(published, ['dsh-ingress'], `only the ingress may publish ports, got ${published.join(',')}`)
assert.equal(String(services['dsh-ingress'].ports[0].published), '3080', 'ingress publishes 3080')

// 用户实例不得静态声明：它们由编排服务按需创建
for (const name of Object.keys(services)) {
  assert.ok(!/^dsh-u\d+$/.test(name), `user instances must not be declared statically: ${name}`)
}

// 挂 docker.sock 的只能是编排服务
for (const [name, service] of Object.entries(services)) {
  const mounts = [...(service.volumes ?? [])].map((v) => `${v.source ?? v[0] ?? ''}`)
  const hasSocket = mounts.some((source) => source.includes('docker.sock'))
  if (name === 'dsh-instances') assert.ok(hasSocket, 'dsh-instances holds the docker socket')
  else assert.ok(!hasSocket, `${name} must not mount the docker socket`)
}

// 认证网关与编排服务必须是非特权、无能力提升
assert.ok((services['dsh-auth'].cap_drop ?? []).includes('ALL'), 'auth gateway drops all capabilities')
assert.ok(JSON.stringify(services['dsh-auth'].security_opt ?? []).includes('no-new-privileges'), 'auth gateway forbids privilege gain')
assert.equal(services['dsh-auth'].read_only, true, 'auth gateway runs with a read-only root filesystem')

// 管理员工作台在网络里有 dsh-admin 别名（root 的会话要能路由到它）
const adminNetworks = services.dsh.networks ?? {}
const aliases = Object.values(adminNetworks).flatMap((n) => n?.aliases ?? [])
assert.ok(aliases.includes('dsh-admin'), 'the admin workspace is reachable as dsh-admin')

// 控制面网络必须是 internal：用户实例不在其中，无法调用编排服务
assert.ok(compose.networks['dsh-mgmt'], 'management network exists')
assert.equal(compose.networks['dsh-mgmt'].internal, true, 'management network has no external gateway')

// ---------------------------------------------------------------- 真实 nginx 语法校验
// 在真实镜像里用 nginx -t 校验入口配置：静态断言查不出指令拼写、上下文错误与括号问题。
const dockerBin = process.env.DSH_DOCKER_BIN ?? 'docker'
const probe = spawnSync(dockerBin, ['--version'], { encoding: 'utf8', timeout: 30_000 })
if (probe.status !== 0) {
  console.log('dsh-multiuser compose smoke: ok (compose verified; nginx syntax check skipped: no docker)')
  process.exit(0)
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-multiuser-conf-'))
fs.writeFileSync(path.join(sandbox, 'nginx.conf'), conf)
fs.writeFileSync(path.join(sandbox, 'mime.types'), 'types { text/html html; }\n')
const image = process.env.DSH_NGINX_IMAGE ?? 'docker.m.daocloud.io/library/nginx:1.27-alpine'
// 校验前要先满足三件事，否则失败原因会与配置正确性无关：
//   1. 挂在只读目录上的配置必须先复制到可写位置才能改写 include 路径；
//   2. 配置里的 `user dsh` 需要一个真实存在的账户，alpine 里没有；
//   3. nginx -t 会检查 pid 与临时目录的可写性，/tmp 在容器里可写。
const probeScript = [
  'adduser -D -u 1000 dsh 2>/dev/null || true',
  'mkdir -p /usr/local/share/dsh-pwa /data/dsh',
  'cp /conf/nginx.conf /tmp/nginx.conf',
  "sed -i 's#include /etc/nginx/mime.types;#include /conf/mime.types;#' /tmp/nginx.conf",
  'nginx -t -c /tmp/nginx.conf',
].join(' && ')
const check = spawnSync(dockerBin, [
  'run', '--rm',
  '-v', `${sandbox}:/conf:ro`,
  '--entrypoint', 'sh',
  image,
  '-c',
  probeScript,
], { encoding: 'utf8', timeout: 300_000 })
fs.rmSync(sandbox, { recursive: true, force: true })

if (check.status !== 0) {
  const output = `${check.stdout ?? ''}${check.stderr ?? ''}`
  if (/Unable to find image|pull access denied|no such host|TLS|network is unreachable|i\/o timeout/i.test(output)) {
    console.log('dsh-multiuser compose smoke: ok (compose verified; nginx syntax check skipped: image unavailable)')
    process.exit(0)
  }
  throw new Error(`nginx rejected the multi-user ingress config:\n${output}`)
}

console.log('dsh-multiuser compose smoke: ok')
