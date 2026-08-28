import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_BLOCK_LIST,
  DEFAULT_CONNECT_PORTS,
  DEFAULT_FORWARD_PORTS,
  DEPLOYMENT_EGRESS_MODES,
  EGRESS_POLICY_VERSION,
  EgressPolicyError,
  PROXY_EGRESS_MODES,
  assertConnectTarget,
  assertForwardRequest,
  createGuardedLookup,
  describeBlockedAddress,
  describeBlockedResolvedAddress,
  egressPolicyFromEnv,
  isBlockedAddress,
  isBlockedResolvedAddress,
  isHostAllowed,
  matchBlockedHost,
  normalizeEgressPolicy,
  normalizeTarget,
  parseAllowList,
  parseAllowListMode,
  parseDeploymentEgressMode,
  parseEgressPolicyText,
  parsePortSet,
  parseProxyEgressMode,
  resolveAllowList,
  resolveEgressRules,
  serializeEgressPolicy,
  stripHopByHopHeaders,
} from '../bin/dsh-egress-policy.mjs'

// 出站代理是容器里 Agent 唯一的出网通道，所以策略层必须能在宿主机上直接单测，
// 并且要跑一遍真正的端到端转发：策略写对了但代理接错了，等于没有白名单。

const root = fileURLToPath(new URL('..', import.meta.url))

// --- 默认白名单：Debian / npm / PyPI / GitHub / uv 生态必须齐全 ---
for (const host of [
  'deb.debian.org',
  'security.debian.org',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'ghcr.io',
  'astral.sh',
  'github-releases.githubusercontent.com',
]) {
  assert.ok(DEFAULT_ALLOWED_HOSTS.includes(host), `默认白名单缺少 ${host}`)
}
assert.deepEqual(parseAllowList(undefined), Array.from(DEFAULT_ALLOWED_HOSTS))
assert.deepEqual(parseAllowList('   '), Array.from(DEFAULT_ALLOWED_HOSTS))
assert.deepEqual(Array.from(DEFAULT_CONNECT_PORTS), [443])
assert.deepEqual(Array.from(DEFAULT_FORWARD_PORTS), [80, 443])

// --- parseAllowList：小写化、去空、去重、通配校验 ---
assert.deepEqual(parseAllowList('GitHub.com, API.GitHub.com'), ['github.com', 'api.github.com'])
assert.deepEqual(parseAllowList('github.com.\n github.com\tghcr.io'), ['github.com', 'ghcr.io'])
assert.deepEqual(parseAllowList(['  Ghcr.IO  ', 'ghcr.io']), ['ghcr.io'])
assert.deepEqual(parseAllowList('*.githubusercontent.com'), ['*.githubusercontent.com'])
assert.deepEqual(parseAllowList('a.example.com,,b.example.com'), ['a.example.com', 'b.example.com'])
assert.deepEqual(parseAllowList('', ['fallback.example.com']), ['fallback.example.com'])

const badAllowLists = [
  'bad_host.com',
  '-lead.example.com',
  'trail-.example.com',
  'foo..com',
  '*',
  '*.com',
  '*.*.example.com',
  'foo.*.example.com',
  'evil*.example.com',
  '127.0.0.1',
  '10.0.0.5',
  '169.254.169.254',
  '::1',
  'localhost',
  'db.internal',
  'printer.local',
  '2130706433',
  ',,,',
  ['ok.example.com', 42],
  { host: 'ok.example.com' },
  `${'x'.repeat(64)}.example.com`,
]
for (const value of badAllowLists) {
  assert.throws(
    () => parseAllowList(value),
    EgressPolicyError,
    `白名单必须拒绝 ${JSON.stringify(value)}`,
  )
}

// --- resolveAllowList：默认追加在内置白名单之上，replace 才整体顶替 ---
// 这条语义是刻意的：自定义域名如果顶掉内置白名单，apt / pip / npm 会立刻全部 403，
// 而现场只能看到一个 403，看不出白名单被换了。
assert.deepEqual(resolveAllowList(undefined, undefined), Array.from(DEFAULT_ALLOWED_HOSTS))
assert.deepEqual(resolveAllowList('', 'replace'), Array.from(DEFAULT_ALLOWED_HOSTS))
const appended = resolveAllowList('search.example.com', undefined)
assert.deepEqual(appended, [...DEFAULT_ALLOWED_HOSTS, 'search.example.com'])
assert.ok(isHostAllowed('deb.debian.org', appended), '追加模式必须保留内置软件源')
assert.ok(isHostAllowed('search.example.com', appended), '追加模式必须放行自定义域名')
// 追加进来的域名和内置项重复时只留一条，顺序以内置白名单为先。
assert.deepEqual(resolveAllowList('GitHub.com', 'append'), Array.from(DEFAULT_ALLOWED_HOSTS))
assert.deepEqual(resolveAllowList('search.example.com', 'REPLACE'), ['search.example.com'])
assert.equal(isHostAllowed('deb.debian.org', resolveAllowList('search.example.com', 'replace')), false)
assert.equal(parseAllowListMode(undefined), 'append')
assert.equal(parseAllowListMode(' Append '), 'append')
assert.equal(parseAllowListMode('replace'), 'replace')
for (const mode of ['merge', 'off', '1', 42]) {
  assert.throws(() => parseAllowListMode(mode), EgressPolicyError, `白名单模式必须拒绝 ${JSON.stringify(mode)}`)
}

// --- parsePortSet ---
assert.deepEqual(Array.from(parsePortSet('80,443')), [80, 443])
assert.deepEqual(Array.from(parsePortSet(' 8443 ')), [8443])
assert.deepEqual(Array.from(parsePortSet(8443)), [8443])
assert.deepEqual(Array.from(parsePortSet(undefined, [443])), [443])
assert.deepEqual(Array.from(parsePortSet(new Set([443, 443]))), [443])
for (const value of ['0', '65536', 'abc', '-1', '44 3a', [], true]) {
  assert.throws(() => parsePortSet(value), EgressPolicyError, `端口集合必须拒绝 ${String(value)}`)
}

// --- isHostAllowed：精确、通配、后缀混淆、大小写、末尾点 ---
assert.equal(isHostAllowed('github.com', ['github.com']), true)
assert.equal(isHostAllowed('GitHub.COM', ['github.com']), true)
assert.equal(isHostAllowed('github.com.', ['github.com']), true)
assert.equal(isHostAllowed('github.com', ['GitHub.com.']), true)
assert.equal(isHostAllowed('a.foo.com', ['*.foo.com']), true)
assert.equal(isHostAllowed('a.b.foo.com', ['*.foo.com']), true)
assert.equal(isHostAllowed('A.B.FOO.COM.', ['*.foo.com']), true)
assert.equal(isHostAllowed('foo.com', ['*.foo.com']), false, '通配不匹配裸域名本身')
assert.equal(isHostAllowed('evilfoo.com', ['*.foo.com']), false, '后缀混淆必须被拒')
assert.equal(isHostAllowed('evilgithub.com', ['github.com']), false)
assert.equal(isHostAllowed('evilgithub.com', ['*.github.com']), false)
assert.equal(isHostAllowed('github.com.evil.com', ['github.com']), false)
assert.equal(isHostAllowed('', ['github.com']), false)
assert.equal(isHostAllowed(undefined, ['github.com']), false)
assert.equal(isHostAllowed('github.com', []), false)
assert.equal(isHostAllowed('github.com', new Set(['github.com'])), true)
assert.equal(isHostAllowed('github.com', 'ghcr.io,github.com'), true)

// --- isBlockedAddress：IP 字面量、私网、环回、链路本地、localhost ---
const blockedHosts = [
  '127.0.0.1',
  '127.1.2.3',
  '10.0.0.1',
  '10.255.255.254',
  '192.168.1.1',
  '172.16.0.1',
  '172.31.255.255',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '8.8.8.8',
  '::1',
  '[::1]',
  '::',
  'fd00::1',
  'fe80::1',
  '::ffff:127.0.0.1',
  '2130706433',
  '0x7f000001',
  'localhost',
  'LOCALHOST.',
  'localhost.localdomain',
  'app.localhost',
  'db.internal',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'printer.local',
  'box.localdomain',
  '',
  'bad_host.com',
  'foo..com',
]
for (const host of blockedHosts) {
  assert.equal(isBlockedAddress(host), true, `${host} 必须被地址检查拒绝`)
  assert.equal(typeof describeBlockedAddress(host), 'string')
}
for (const host of [
  'github.com',
  'a.b.githubusercontent.com',
  'deb.debian.org',
  'ghcr.io',
  'upstream.dsh-egress-test',
]) {
  assert.equal(isBlockedAddress(host), false, `${host} 不该被地址检查拒绝`)
  assert.equal(describeBlockedAddress(host), null)
}
assert.match(describeBlockedAddress('169.254.169.254'), /metadata/)
assert.match(describeBlockedAddress('127.0.0.1'), /环回/)
assert.match(describeBlockedAddress('10.1.2.3'), /私网/)
assert.match(describeBlockedAddress('fd00::1'), /本地/)

// --- normalizeTarget：host[:port]、IPv6 字面量、端口兜底 ---
assert.deepEqual(normalizeTarget('github.com:443', 80), { host: 'github.com', port: 443 })
assert.deepEqual(normalizeTarget('GitHub.com.', 443), { host: 'github.com', port: 443 })
assert.deepEqual(normalizeTarget('  github.com:8443  ', 443), { host: 'github.com', port: 8443 })
assert.deepEqual(normalizeTarget('github.com:0', 443), { host: 'github.com', port: 443 })
assert.deepEqual(normalizeTarget('github.com:70000', 443), { host: 'github.com', port: 443 })
assert.deepEqual(normalizeTarget('github.com:abc', 443), { host: 'github.com', port: 443 })
assert.deepEqual(normalizeTarget('[::1]:443', 80), { host: '::1', port: 443 })
assert.deepEqual(normalizeTarget('[::1]', 80), { host: '::1', port: 80 })
assert.deepEqual(normalizeTarget('::1', 443), { host: '::1', port: 443 })
assert.deepEqual(normalizeTarget('', 443), { host: '', port: 443 })
assert.deepEqual(normalizeTarget(undefined, 443), { host: '', port: 443 })

// --- assertConnectTarget ---
const connectAllowList = ['github.com', '*.github.com', 'registry.npmjs.org']
assert.deepEqual(assertConnectTarget('github.com:443', connectAllowList), {
  host: 'github.com',
  port: 443,
})
assert.deepEqual(assertConnectTarget('API.GitHub.com.:443', connectAllowList), {
  host: 'api.github.com',
  port: 443,
})
assert.deepEqual(assertConnectTarget('github.com', connectAllowList), {
  host: 'github.com',
  port: 443,
})
assert.deepEqual(assertConnectTarget('registry.npmjs.org:8443', connectAllowList, [8443]), {
  host: 'registry.npmjs.org',
  port: 8443,
})

const deniedConnect = [
  ['github.com:80', connectAllowList],
  ['github.com:22', connectAllowList],
  ['evilgithub.com:443', connectAllowList],
  ['github.com.evil.com:443', connectAllowList],
  ['127.0.0.1:443', connectAllowList],
  ['169.254.169.254:443', connectAllowList],
  ['10.1.2.3:443', connectAllowList],
  ['192.168.1.1:443', connectAllowList],
  ['172.20.0.1:443', connectAllowList],
  ['[::1]:443', connectAllowList],
  ['[fd00::1]:443', connectAllowList],
  ['localhost:443', connectAllowList],
  ['user@github.com:443', connectAllowList],
  ['github.com:443/secret', connectAllowList],
  ['github.com:443 extra', connectAllowList],
  ['http://github.com:443', connectAllowList],
  ['', connectAllowList],
  [undefined, connectAllowList],
]
for (const [authority, allowList] of deniedConnect) {
  assert.throws(
    () => assertConnectTarget(authority, allowList),
    EgressPolicyError,
    `CONNECT 必须拒绝 ${String(authority)}`,
  )
}

// --- assertForwardRequest ---
const forwardAllowList = ['deb.debian.org', 'registry.npmjs.org', '*.githubusercontent.com']
const debian = assertForwardRequest(
  'http://deb.debian.org/debian/dists/stable/InRelease',
  forwardAllowList,
)
assert.equal(debian.host, 'deb.debian.org')
assert.equal(debian.port, 80)
assert.equal(debian.url.pathname, '/debian/dists/stable/InRelease')
assert.deepEqual(
  (({ host, port }) => ({ host, port }))(
    assertForwardRequest('https://registry.npmjs.org/express', forwardAllowList),
  ),
  { host: 'registry.npmjs.org', port: 443 },
)
assert.equal(
  assertForwardRequest('http://DEB.Debian.org.:80/debian/', forwardAllowList).host,
  'deb.debian.org',
)
assert.equal(
  assertForwardRequest('https://a.b.githubusercontent.com/blob', forwardAllowList).host,
  'a.b.githubusercontent.com',
)
assert.equal(
  assertForwardRequest('http://deb.debian.org:8080/debian/', forwardAllowList, [8080]).port,
  8080,
)

const deniedForward = [
  ['/latest/meta-data/', forwardAllowList],
  ['ftp://deb.debian.org/debian/', forwardAllowList],
  ['file:///etc/passwd', forwardAllowList],
  ['gopher://deb.debian.org/', forwardAllowList],
  ['http://user:pass@deb.debian.org/debian/', forwardAllowList],
  ['http://127.0.0.1/', forwardAllowList],
  ['http://169.254.169.254/latest/meta-data/', forwardAllowList],
  ['http://localhost/x', forwardAllowList],
  ['http://[::1]/x', forwardAllowList],
  ['https://10.0.0.1/x', forwardAllowList],
  ['http://192.168.0.1:443/', forwardAllowList],
  ['http://evil.githubusercontent.com.evil.com/x', forwardAllowList],
  ['http://evilgithubusercontent.com/x', forwardAllowList],
  ['http://githubusercontent.com/x', forwardAllowList],
  ['http://deb.debian.org:22/debian/', forwardAllowList],
  ['not a url', forwardAllowList],
  ['', forwardAllowList],
  [undefined, forwardAllowList],
]
for (const [rawUrl, allowList] of deniedForward) {
  assert.throws(
    () => assertForwardRequest(rawUrl, allowList),
    EgressPolicyError,
    `正向代理必须拒绝 ${String(rawUrl)}`,
  )
}

// 拒绝原因会进审计日志，所以它不能回显路径和 query（里面可能带令牌）。
assert.throws(
  () => assertForwardRequest('http://evil.example.com/x?token=SECRET-TOKEN', forwardAllowList),
  (error) => {
    assert.ok(error instanceof EgressPolicyError)
    assert.ok(error.message.includes('evil.example.com'), '拒绝原因要点明主机名')
    assert.equal(error.message.includes('SECRET-TOKEN'), false, '拒绝原因不能回显 query')
    return true
  },
)

// --- 逐跳头剥离 ---
const stripped = stripHopByHopHeaders({
  Host: 'deb.debian.org',
  'User-Agent': 'apt/2.9',
  'Proxy-Connection': 'keep-alive',
  'Proxy-Authorization': 'Basic c2VjcmV0',
  Connection: 'keep-alive',
  'Keep-Alive': 'timeout=5',
  TE: 'trailers',
  Trailer: 'X-Foo',
  'Transfer-Encoding': 'chunked',
  Upgrade: 'websocket',
})
assert.deepEqual(stripped, { host: 'deb.debian.org', 'user-agent': 'apt/2.9' })

// --- nginx 入口转发器：必须是非 root worker 的四层转发 ---
const ingressPath = path.join(root, 'nginx', 'dsh-ingress.conf')
const ingress = fs.readFileSync(ingressPath, 'utf8')
assert.match(ingress, /^user dsh;$/m)
assert.doesNotMatch(ingress, /user\s+root;/)
assert.match(ingress, /^stream \{$/m)
// 变量形式的 proxy_pass 是刻意的：字面量只在启动时解析一次，dsh 容器重启换 IP 后
// 会一直连旧地址。断言同时接受两种写法，但目标必须是 dsh:3080。
assert.match(ingress, /proxy_pass\s+\$dsh_upstream;/)
// 上游必须是 dsh-app 而不是 dsh：dsh-ingress 在 dsh-private 上顶着 alias `dsh`，
// 直接写 dsh 会被 Docker 内嵌 DNS 解析到 ingress 自己（实测自连失败）。
assert.match(ingress, /\bdsh-app:3080\b/)
assert.doesNotMatch(ingress, /default\s+dsh:3080;/)
assert.match(ingress, /resolver\s+127\.0\.0\.11/)
assert.doesNotMatch(ingress, /proxy_set_header/, '四层转发不该改任何 header')
assert.match(ingress, /^daemon off;$/m)

// --- 交付格式：LF、UTF-8 无 BOM、结尾换行 ---
for (const file of [
  'bin/dsh-egress-policy.mjs',
  'bin/dsh-egress-proxy.mjs',
  'nginx/dsh-ingress.conf',
  'tests/egress-proxy-smoke.mjs',
]) {
  const raw = fs.readFileSync(path.join(root, file))
  assert.equal(raw.includes(0x0d), false, `${file} 不能有 CR`)
  assert.equal(raw[raw.length - 1], 0x0a, `${file} 结尾要有换行`)
  assert.notEqual(raw[0], 0xef, `${file} 不能有 BOM`)
}
assert.ok(
  fs.readFileSync(path.join(root, 'bin', 'dsh-egress-proxy.mjs'), 'utf8').startsWith('#!/usr/bin/env node\n'),
  '代理脚本要有 shebang',
)

// --- DNS rebinding 防护：解析结果也必须是公网单播地址 ---
//
// 白名单只写域名，域名的解析结果却由 DNS 决定。所以「白名单里的域名解析到内网」
// 这条路必须在建连前堵住，否则白名单等于没有。
for (const address of [
  '127.0.0.1',
  '127.53.0.1',
  '10.0.0.5',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '224.0.0.1',
  '::1',
  'fe80::1',
  'fd00::1',
  '::ffff:127.0.0.1',
  '::ffff:10.0.0.5',
]) {
  assert.ok(
    isBlockedResolvedAddress(address),
    `解析到 ${address} 必须被拒绝`,
  )
  assert.equal(typeof describeBlockedResolvedAddress(address), 'string')
}

// 公网单播地址放行；解析结果不是 IP（比如 DNS 桩返回了名字）同样拒绝。
for (const address of ['1.1.1.1', '151.101.1.140', '2606:4700::1111', '::ffff:151.101.1.140']) {
  assert.equal(describeBlockedResolvedAddress(address), null, `${address} 应当放行`)
}
assert.equal(typeof describeBlockedResolvedAddress('github.com'), 'string')
assert.equal(typeof describeBlockedResolvedAddress(''), 'string')

// 172.16/12 的边界不能扩大到 172.15 / 172.32。
assert.equal(describeBlockedResolvedAddress('172.15.0.1'), null)
assert.equal(describeBlockedResolvedAddress('172.32.0.1'), null)

// 受控解析器：逐条过滤，留下公网地址；全被拒时给 EGRESSBLOCKED。
{
  const answers = new Map([
    ['mixed.example.com', [{ address: '10.0.0.5', family: 4 }, { address: '93.184.216.34', family: 4 }]],
    ['evil.example.com', [{ address: '127.0.0.1', family: 4 }]],
    ['clean.example.com', [{ address: '93.184.216.34', family: 4 }]],
    ['empty.example.com', []],
  ])
  const stubLookup = (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    const opts = typeof options === 'function' ? {} : options
    const list = answers.get(hostname) ?? []
    process.nextTick(() => {
      if (opts && opts.all) done(null, list)
      else if (list.length === 0) done(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
      else done(null, list[0].address, list[0].family)
    })
  }
  const lookup = createGuardedLookup(stubLookup)
  const call = (hostname, options) =>
    new Promise((resolve) => {
      lookup(hostname, options, (error, addressOrList, family) =>
        resolve({ error, addressOrList, family }),
      )
    })

  // 混合应答：私网那条被丢掉，只留公网地址。
  const mixed = await call('mixed.example.com', { family: 0 })
  assert.equal(mixed.error, null)
  assert.equal(mixed.addressOrList, '93.184.216.34')
  assert.equal(mixed.family, 4)

  // all:true 时返回过滤后的数组，形状和 dns.lookup 一致。
  const mixedAll = await call('mixed.example.com', { all: true })
  assert.equal(mixedAll.error, null)
  assert.deepEqual(mixedAll.addressOrList, [{ address: '93.184.216.34', family: 4 }])

  const blocked = await call('evil.example.com', {})
  assert.equal(blocked.error?.code, 'EGRESSBLOCKED')
  assert.match(blocked.error.message, /evil\.example\.com/)
  assert.match(blocked.error.message, /环回/)

  const clean = await call('clean.example.com', {})
  assert.equal(clean.error, null)
  assert.equal(clean.addressOrList, '93.184.216.34')

  // 一条都没解析出来时也必须报错，不能回一个空地址让上层去连。
  const empty = await call('empty.example.com', {})
  assert.equal(empty.error?.code, 'EGRESSBLOCKED')
}

// --- 出站策略文件：模式、两份清单、缺字段与空数组的语义 ---
//
// 策略文件是面板与代理之间唯一的契约，写错一个字段的后果是「以为在挡、其实全放行」，
// 所以每条语义都在这里钉住。
for (const host of ['*.trycloudflare.com', '*.ngrok-free.app', '*.devtunnels.ms', '*.ts.net', '*.cpolar.cn']) {
  assert.ok(DEFAULT_BLOCK_LIST.includes(host), `内置黑名单缺少 ${host}`)
}
assert.deepEqual(Array.from(DEPLOYMENT_EGRESS_MODES), ['open', 'blocklist', 'allowlist'])
assert.deepEqual(Array.from(PROXY_EGRESS_MODES), ['allowlist', 'blocklist'])

// 代理进程里没有 open：收到它按 allowlist 处理（fail closed）。
assert.equal(parseProxyEgressMode('open'), 'allowlist')
assert.equal(parseProxyEgressMode(''), 'allowlist')
assert.equal(parseProxyEgressMode('blocklist'), 'blocklist')
assert.throws(() => parseProxyEgressMode('off'), EgressPolicyError)
// 部署形态那一层三个值都合法，open 是缺省。
assert.equal(parseDeploymentEgressMode(undefined), 'open')
assert.equal(parseDeploymentEgressMode('blocklist'), 'blocklist')
assert.throws(() => parseDeploymentEgressMode('allow'), EgressPolicyError)

// 缺 block 字段 = 补内置隧道清单（安装器只写一个 mode 就靠这条）。
const seeded = normalizeEgressPolicy({ mode: 'blocklist' })
assert.equal(seeded.version, EGRESS_POLICY_VERSION)
assert.equal(seeded.block.length, DEFAULT_BLOCK_LIST.length)
assert.ok(seeded.block.every((entry) => entry.enabled === true && entry.note !== ''))
assert.deepEqual(seeded.allow, [])
// 显式空数组 = 明确什么都不挡，不能被「补默认」覆盖掉。
assert.deepEqual(normalizeEgressPolicy({ mode: 'blocklist', block: [] }).block, [])
// 字符串条目、大小写、重复、末尾点都归一化；enabled 只有显式 false 才算关掉。
assert.deepEqual(
  normalizeEgressPolicy({
    allow: ['Search.Example.com.', { host: 'search.example.com' }, { host: 'a.example.com', enabled: false }],
    block: [],
  }).allow,
  [
    { host: 'search.example.com', enabled: true, note: '' },
    { host: 'a.example.com', enabled: false, note: '' },
  ],
)
assert.throws(() => normalizeEgressPolicy({ allow: ['bad_host.com'], block: [] }), EgressPolicyError)
assert.throws(() => parseEgressPolicyText('{'), EgressPolicyError)
// 空文本按空策略处理（第一次写文件之前的状态）。
assert.equal(parseEgressPolicyText('   ').mode, 'allowlist')
assert.equal(
  parseEgressPolicyText(serializeEgressPolicy({ mode: 'blocklist', block: [] })).mode,
  'blocklist',
)

// resolveEgressRules：allowlist 下清单为空回落到内置白名单，blocklist 下为空就是不挡。
const allowRules = resolveEgressRules({ mode: 'allowlist', allow: [], block: [] })
assert.equal(allowRules.mode, 'allowlist')
assert.deepEqual(allowRules.allowList, Array.from(DEFAULT_ALLOWED_HOSTS))
assert.deepEqual(allowRules.blockList, [])
const blockRules = resolveEgressRules({ mode: 'blocklist' })
assert.equal(blockRules.mode, 'blocklist')
assert.deepEqual(blockRules.blockList, Array.from(DEFAULT_BLOCK_LIST))
// 取消勾选的条目不进规则。
assert.deepEqual(
  resolveEgressRules({
    mode: 'blocklist',
    block: [{ host: '*.ngrok.io' }, { host: '*.loca.lt', enabled: false }],
  }).blockList,
  ['*.ngrok.io'],
)

// matchBlockedHost：与白名单同一套匹配规则，返回命中的条目好写清拒绝原因。
assert.equal(matchBlockedHost('abc.trycloudflare.com', DEFAULT_BLOCK_LIST), '*.trycloudflare.com')
assert.equal(matchBlockedHost('trycloudflare.com', DEFAULT_BLOCK_LIST), '')
assert.equal(matchBlockedHost('eviltrycloudflare.com', DEFAULT_BLOCK_LIST), '')
assert.equal(matchBlockedHost('github.com', DEFAULT_BLOCK_LIST), '')
assert.equal(matchBlockedHost('github.com', undefined), '')

// blocklist 规则下的三道闸门：前两道（地址形态、端口）与 allowlist 完全一致，
// 只有最后一道域名判定反过来。
const blocklistGate = {
  mode: 'blocklist',
  allowList: [],
  blockList: ['*.trycloudflare.com', 'evil.example.com'],
}
const passThrough = assertForwardRequest('http://anything.example.com/x', blocklistGate, DEFAULT_FORWARD_PORTS)
assert.equal(passThrough.host, 'anything.example.com')
assert.equal(passThrough.port, 80)
assert.deepEqual(assertConnectTarget('anything.example.com:443', blocklistGate, DEFAULT_CONNECT_PORTS), {
  host: 'anything.example.com',
  port: 443,
})
for (const [target, hit] of [
  ['http://abc.trycloudflare.com/x', '*.trycloudflare.com'],
  ['http://evil.example.com/x', 'evil.example.com'],
]) {
  assert.throws(() => assertForwardRequest(target, blocklistGate, DEFAULT_FORWARD_PORTS), (error) => {
    assert.ok(error instanceof EgressPolicyError)
    assert.match(error.message, /出站黑名单/)
    assert.ok(error.message.includes(hit), `拒绝原因要点明命中的条目：${error.message}`)
    return true
  })
}
assert.throws(() => assertConnectTarget('abc.trycloudflare.com:443', blocklistGate, DEFAULT_CONNECT_PORTS), EgressPolicyError)
// 裸 IP、元数据地址、整数形式地址、带凭据的 URL 在 blocklist 下同样被拒。
for (const target of [
  'http://127.0.0.1/x',
  'http://169.254.169.254/latest/',
  'http://10.0.0.5/x',
  'http://2130706433/x',
  'http://user:pw@example.com/x',
  'http://localhost/x',
  'http://db.internal/x',
]) {
  assert.throws(() => assertForwardRequest(target, blocklistGate, DEFAULT_FORWARD_PORTS), EgressPolicyError)
}
// 端口闸门也不因为「默认放行」而放松。
assert.throws(() => assertConnectTarget('example.com:22', blocklistGate, DEFAULT_CONNECT_PORTS), EgressPolicyError)
assert.throws(() => assertForwardRequest('http://example.com:8080/x', blocklistGate, DEFAULT_FORWARD_PORTS), EgressPolicyError)

// egressPolicyFromEnv：老部署没有策略文件时的等价策略。
const envPolicy = egressPolicyFromEnv({
  DSH_EGRESS_MODE: 'blocklist',
  DSH_EGRESS_ALLOWED_HOSTS: 'search.example.com',
})
assert.equal(envPolicy.mode, 'blocklist')
assert.deepEqual(envPolicy.allow.map((entry) => entry.host), ['search.example.com'])
// blocklist 模式下没有策略文件，也不能变成「黑名单模式但一条都不挡」。
assert.equal(envPolicy.block.length, DEFAULT_BLOCK_LIST.length)
assert.equal(egressPolicyFromEnv({}).mode, 'allowlist')

// --- 端到端：真起一个上游 + 真起代理进程 ---
const UPSTREAM_HOST = 'upstream.dsh-egress-test'
const BLOCKED_HOST = 'evilgithub.com'
const PAYLOAD = '出站白名单代理透传成功 payload\n'

const upstream = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/payload') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(PAYLOAD)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('missing\n')
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

// 代理只认域名（IP 字面量一律拒绝），而测试机上没有任何域名能稳定解析到
// 127.0.0.1。所以给子进程预加载一个只改 dns.lookup 的桩：转发逻辑、套接字和
// HTTP 解析全都是真的，只有名字解析被钉到回环地址。
const preloadPath = path.join(os.tmpdir(), `dsh-egress-lookup-${process.pid}.mjs`)
fs.writeFileSync(
  preloadPath,
  [
    "import dns from 'node:dns'",
    '',
    'const target = process.env.DSH_TEST_UPSTREAM_HOST',
    'const real = dns.lookup',
    'dns.lookup = (hostname, options, callback) => {',
    '  if (hostname !== target) return real(hostname, options, callback)',
    '  let opts = options',
    '  let done = callback',
    "  if (typeof opts === 'function') { done = opts; opts = {} }",
    "  const all = Boolean(opts && opts.all)",
    "  process.nextTick(() => done(null, all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4))",
    '}',
    '',
  ].join('\n'),
  'utf8',
)

const child = spawn(
  process.execPath,
  ['--import', pathToFileURL(preloadPath).href, path.join(root, 'bin', 'dsh-egress-proxy.mjs')],
  {
    env: {
      ...process.env,
      DSH_EGRESS_PORT: '0',
      DSH_EGRESS_BIND: '127.0.0.1',
      DSH_EGRESS_ALLOWED_HOSTS: UPSTREAM_HOST,
      // replace：这一份子进程只放行假上游，端到端地覆盖「顶替内置白名单」这条路径，
      // 也让 /status 里的 allowedHosts 是确定的 1。
      DSH_EGRESS_ALLOWED_HOSTS_MODE: 'replace',
      DSH_EGRESS_ALLOWED_PORTS: `80,443,${upstreamPort}`,
      DSH_EGRESS_MAX_SOCKETS: '32',
      DSH_TEST_UPSTREAM_HOST: UPSTREAM_HOST,
      // 假上游只能听回环，所以这一份子进程显式关掉解析结果的公网校验。
      // 守卫开启时的行为由下面单独一个严格子进程覆盖。
      DSH_EGRESS_ALLOW_PRIVATE_UPSTREAM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)

let auditLog = ''
let proxyStderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  auditLog += chunk
})
child.stderr.on('data', (chunk) => {
  proxyStderr += chunk
})

function proxyRequest(target, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: proxyPort, method, path: target, agent: false },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => resolve({ status: response.statusCode, body }))
      },
    )
    request.on('error', reject)
    request.end()
  })
}

// 通过隧道跑一次裸 HTTP 请求，验证 CONNECT 是纯字节转发。
function tunnelRequest(authority, requestLine) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1')
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      raw += chunk
      if (requestLine && raw.includes('\r\n\r\n') && !socket.tunnelStarted) {
        socket.tunnelStarted = true
        if (raw.startsWith('HTTP/1.1 200')) socket.write(requestLine)
        else socket.end()
      }
    })
    socket.on('close', () => resolve(raw))
    socket.on('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
  })
}

// 等 listen 审计事件，拿到内核实际分配的端口。两个代理子进程共用这段逻辑。
function waitForListen(proc, readLog, readStderr) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`代理未在 15s 内启动：${readStderr()}`)), 15_000)
    const onData = () => {
      for (const line of readLog().split('\n')) {
        if (line.trim() === '') continue
        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (entry.event === 'listen' && entry.port > 0) {
          clearTimeout(timer)
          proc.stdout.off('data', onData)
          resolve(entry)
          return
        }
      }
    }
    proc.stdout.on('data', onData)
    // 可能在挂监听之前就已经收到过 listen 行，先自查一遍缓冲。
    onData()
    proc.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`代理提前退出（code=${code}）：${readStderr()}`))
    })
  })
}

// SIGTERM 收尾，超时再 SIGKILL，不留端口占用。
async function stopProxy(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise((resolve) => {
    const force = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve()
    }, 5_000)
    force.unref()
    proc.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
    proc.kill('SIGTERM')
  })
}

let proxyPort = 0
try {
  const listenEntry = await waitForListen(
    child,
    () => auditLog,
    () => proxyStderr,
  )
  proxyPort = listenEntry.port
  // 这一份显式关掉了守卫，listen 事件必须如实汇报，否则运行期没法核查。
  assert.equal(listenEntry.resolvedAddressGuard, 'off')

  // 白名单内：absolute-URI 请求原样透传，响应体一致。
  const allowed = await proxyRequest(`http://${UPSTREAM_HOST}:${upstreamPort}/payload`)
  assert.equal(allowed.status, 200)
  assert.equal(allowed.body, PAYLOAD)

  // query 里的令牌必须转发给上游，但绝不能出现在审计日志里。
  const withQuery = await proxyRequest(
    `http://${UPSTREAM_HOST}:${upstreamPort}/payload?token=SECRET-TOKEN-abc`,
  )
  assert.equal(withQuery.status, 200)
  assert.equal(withQuery.body, PAYLOAD)

  // 白名单外：403 + 一行中文说明，说明里带主机名。
  const denied = await proxyRequest(`http://${BLOCKED_HOST}/anything`)
  assert.equal(denied.status, 403)
  assert.ok(denied.body.includes(BLOCKED_HOST), `403 响应体要点明主机：${denied.body}`)
  assert.match(denied.body, /白名单/)

  // 直连 IP / 元数据地址即使端口被放行也走不通。
  const metadata = await proxyRequest('http://169.254.169.254:443/latest/meta-data/')
  assert.equal(metadata.status, 403)
  const loopback = await proxyRequest(`http://127.0.0.1:${upstreamPort}/payload`)
  assert.equal(loopback.status, 403)

  // --- 默认配置（守卫开启）下，白名单域名解析到回环也必须被拒 ---
  //
  // 用同一个 DNS 桩起第二个代理，唯一区别是不设
  // DSH_EGRESS_ALLOW_PRIVATE_UPSTREAM。这是真端到端地验证 DNS rebinding 防护：
  // 主机名在白名单里、端口也放行，但解析结果是 127.0.0.1，所以连都不该连。
  const strictChild = spawn(
    process.execPath,
    ['--import', pathToFileURL(preloadPath).href, path.join(root, 'bin', 'dsh-egress-proxy.mjs')],
    {
      env: {
        ...process.env,
        DSH_EGRESS_PORT: '0',
        DSH_EGRESS_BIND: '127.0.0.1',
        DSH_EGRESS_ALLOWED_HOSTS: UPSTREAM_HOST,
        DSH_EGRESS_ALLOWED_HOSTS_MODE: 'replace',
        DSH_EGRESS_ALLOWED_PORTS: `80,443,${upstreamPort}`,
        DSH_TEST_UPSTREAM_HOST: UPSTREAM_HOST,
        DSH_EGRESS_ALLOW_PRIVATE_UPSTREAM: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let strictLog = ''
  let strictStderr = ''
  strictChild.stdout.setEncoding('utf8')
  strictChild.stderr.setEncoding('utf8')
  strictChild.stdout.on('data', (chunk) => {
    strictLog += chunk
  })
  strictChild.stderr.on('data', (chunk) => {
    strictStderr += chunk
  })
  try {
    const strictListen = await waitForListen(
      strictChild,
      () => strictLog,
      () => strictStderr,
    )
    assert.equal(strictListen.resolvedAddressGuard, 'on')

    const rebind = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: strictListen.port,
          path: `http://${UPSTREAM_HOST}:${upstreamPort}/payload`,
          agent: false,
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () => resolve({ status: response.statusCode, body }))
        },
      )
      request.on('error', reject)
      request.end()
    })
    // 403 而不是 502：这是策略拒绝，不是上游故障。
    assert.equal(rebind.status, 403)
    assert.match(rebind.body, /环回/)
    assert.equal(rebind.body.includes(PAYLOAD.trim()), false, '被拒的请求不能拿到上游内容')

    // CONNECT 隧道同样过不去。
    const rebindTunnel = await new Promise((resolve, reject) => {
      const socket = net.connect(strictListen.port, '127.0.0.1')
      let raw = ''
      socket.setEncoding('utf8')
      socket.on('error', reject)
      socket.on('data', (chunk) => {
        raw += chunk
      })
      socket.on('close', () => resolve(raw))
      socket.on('connect', () => {
        socket.write(
          `CONNECT ${UPSTREAM_HOST}:${upstreamPort} HTTP/1.1\r\nHost: ${UPSTREAM_HOST}\r\n\r\n`,
        )
      })
    })
    assert.match(rebindTunnel, /^HTTP\/1\.1 403 Forbidden/)
    assert.match(rebindTunnel, /环回/)

    // 审计日志要留下拒绝记录，且原因说明是解析结果被挡。
    const strictTraffic = strictLog
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.action === 'http' || entry.action === 'connect')
    assert.ok(
      strictTraffic.every((entry) => entry.decision === 'deny'),
      `守卫开启时不该有放行记录：${strictLog}`,
    )
    assert.ok(
      strictTraffic.some((entry) => typeof entry.reason === 'string' && entry.reason.includes('解析到')),
      `审计日志要写明解析结果被拒：${strictLog}`,
    )
    assert.equal(strictLog.includes('/payload'), false, '审计日志不能记录路径')
  } finally {
    await stopProxy(strictChild)
  }

  // --- 策略文件 + blocklist 模式：文件优先于环境变量，并按 mtime 热加载 ---
  //
  // 面板改清单靠的就是这条路径：写文件，代理自己重新读。所以这里必须端到端验证
  // 三件事——启动时文件压过 .env、blocklist 的放行/拒绝方向、改文件之后不重启就生效。
  const policyPath = path.join(os.tmpdir(), `dsh-egress-policy-${process.pid}.json`)
  const writePolicy = (policy) => fs.writeFileSync(policyPath, serializeEgressPolicy(policy), 'utf8')
  writePolicy({ mode: 'blocklist', allow: [], block: [{ host: BLOCKED_HOST, note: '测试用' }] })

  const policyChild = spawn(
    process.execPath,
    ['--import', pathToFileURL(preloadPath).href, path.join(root, 'bin', 'dsh-egress-proxy.mjs')],
    {
      env: {
        ...process.env,
        DSH_EGRESS_PORT: '0',
        DSH_EGRESS_BIND: '127.0.0.1',
        DSH_EGRESS_POLICY_FILE: policyPath,
        DSH_EGRESS_POLICY_RELOAD_MS: '200',
        // 故意给一份会拒掉假上游的环境变量配置：文件生效的话这两行就不该起作用。
        DSH_EGRESS_MODE: 'allowlist',
        DSH_EGRESS_ALLOWED_HOSTS: 'only-in-env.example.com',
        DSH_EGRESS_ALLOWED_HOSTS_MODE: 'replace',
        DSH_EGRESS_ALLOWED_PORTS: `80,443,${upstreamPort}`,
        DSH_TEST_UPSTREAM_HOST: UPSTREAM_HOST,
        DSH_EGRESS_ALLOW_PRIVATE_UPSTREAM: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let policyLog = ''
  let policyStderr = ''
  policyChild.stdout.setEncoding('utf8')
  policyChild.stderr.setEncoding('utf8')
  policyChild.stdout.on('data', (chunk) => {
    policyLog += chunk
  })
  policyChild.stderr.on('data', (chunk) => {
    policyStderr += chunk
  })

  // 这一段要在两个端口上发请求，所以不复用上面那两个绑定了 proxyPort 的帮手。
  const requestVia = (port, target) =>
    new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: target, agent: false }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => resolve({ status: response.statusCode, body }))
      })
      request.on('error', reject)
      request.end()
    })
  const statusVia = async (port) => JSON.parse((await requestVia(port, '/status')).body)
  // 热加载是轮询，所以只能等条件成立；等不到就当失败，不允许「反正会好」。
  const waitForStatus = async (port, predicate, label) => {
    const deadline = Date.now() + 10_000
    let last
    while (Date.now() < deadline) {
      last = await statusVia(port)
      if (predicate(last)) return last
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`${label} 未在 10s 内生效：${JSON.stringify(last)}`)
  }

  try {
    const policyListen = await waitForListen(
      policyChild,
      () => policyLog,
      () => policyStderr,
    )
    const policyPort = policyListen.port
    // listen 审计与 /status 都要如实报出模式和规则来源，否则运行期没法核查。
    assert.equal(policyListen.mode, 'blocklist')
    assert.equal(policyListen.policySource, 'file')
    const initialStatus = await statusVia(policyPort)
    assert.equal(initialStatus.mode, 'blocklist')
    assert.equal(initialStatus.policySource, 'file')
    assert.equal(initialStatus.blockedHosts, 1)

    // blocklist 默认放行：假上游不在黑名单里就该通，而它并不在环境变量那份白名单里，
    // 所以这一条同时证明了「文件压过 .env」。
    const blockModeAllowed = await requestVia(policyPort, `http://${UPSTREAM_HOST}:${upstreamPort}/payload`)
    assert.equal(blockModeAllowed.status, 200)
    assert.equal(blockModeAllowed.body, PAYLOAD)

    // 命中黑名单：403，说明里点出命中的条目。
    const blockModeDenied = await requestVia(policyPort, `http://${BLOCKED_HOST}/anything`)
    assert.equal(blockModeDenied.status, 403)
    assert.match(blockModeDenied.body, /黑名单/)
    assert.ok(blockModeDenied.body.includes(BLOCKED_HOST))

    // 前两道闸门在 blocklist 下照旧：裸 IP 与元数据地址仍然不通。
    assert.equal((await requestVia(policyPort, `http://127.0.0.1:${upstreamPort}/payload`)).status, 403)
    assert.equal((await requestVia(policyPort, 'http://169.254.169.254/latest/meta-data/')).status, 403)

    // 热加载：把假上游也加进黑名单，不重启进程，几百毫秒后同一条请求就该被拒。
    await new Promise((resolve) => setTimeout(resolve, 50))
    writePolicy({
      mode: 'blocklist',
      allow: [],
      block: [{ host: BLOCKED_HOST }, { host: UPSTREAM_HOST }],
    })
    await waitForStatus(policyPort, (state) => state.blockedHosts === 2, '策略文件热加载')
    const afterReload = await requestVia(policyPort, `http://${UPSTREAM_HOST}:${upstreamPort}/payload`)
    assert.equal(afterReload.status, 403)
    assert.equal(afterReload.body.includes(PAYLOAD.trim()), false, '被拒的请求不能拿到上游内容')

    // 写坏文件：保留上一份规则并记一条 policy-error，绝不因为一次写坏就全放行。
    await new Promise((resolve) => setTimeout(resolve, 50))
    fs.writeFileSync(policyPath, '{ not json', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 600))
    const brokenStatus = await statusVia(policyPort)
    assert.equal(brokenStatus.policySource, 'file')
    assert.equal(brokenStatus.blockedHosts, 2)
    assert.ok(
      policyLog.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
        .some((entry) => entry.event === 'policy-error'),
      `写坏策略文件要记一条 policy-error：${policyLog}`,
    )

    // 文件被删：回落到环境变量那套（allowlist + 只放行 only-in-env.example.com）。
    fs.rmSync(policyPath, { force: true })
    const envFallback = await waitForStatus(policyPort, (state) => state.policySource === 'env', '删文件后回落环境变量')
    assert.equal(envFallback.mode, 'allowlist')
    assert.equal(envFallback.allowedHosts, 1)
    assert.equal((await requestVia(policyPort, `http://${UPSTREAM_HOST}:${upstreamPort}/payload`)).status, 403)
  } finally {
    await stopProxy(policyChild)
    fs.rmSync(policyPath, { force: true })
  }

  // --- 默认（append）模式：真起一个进程，确认 loadConfig 的接线没错 ---
  //
  // 单测已经覆盖 resolveAllowList，但「代理进程真的读了 DSH_EGRESS_ALLOWED_HOSTS_MODE」
  // 只有起进程才能证明：接错了就会退回整体替换，装完之后 apt 会突然 403。
  const appendChild = spawn(
    process.execPath,
    [path.join(root, 'bin', 'dsh-egress-proxy.mjs')],
    {
      env: {
        ...process.env,
        DSH_EGRESS_PORT: '0',
        DSH_EGRESS_BIND: '127.0.0.1',
        // 刻意不设 DSH_EGRESS_ALLOWED_HOSTS_MODE：测的就是缺省行为。
        DSH_EGRESS_ALLOWED_HOSTS: 'search.example.com',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let appendLog = ''
  let appendStderr = ''
  appendChild.stdout.setEncoding('utf8')
  appendChild.stderr.setEncoding('utf8')
  appendChild.stdout.on('data', (chunk) => {
    appendLog += chunk
  })
  appendChild.stderr.on('data', (chunk) => {
    appendStderr += chunk
  })
  try {
    const appendListen = await waitForListen(
      appendChild,
      () => appendLog,
      () => appendStderr,
    )
    const appendStatus = await new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: appendListen.port, path: '/status', agent: false },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () => resolve({ status: response.statusCode, body }))
        },
      )
      request.on('error', reject)
      request.end()
    })
    assert.equal(appendStatus.status, 200)
    assert.equal(
      JSON.parse(appendStatus.body).allowedHosts,
      DEFAULT_ALLOWED_HOSTS.length + 1,
      `默认模式必须是内置白名单 + 自定义域名：${appendStatus.body}`,
    )
  } finally {
    await stopProxy(appendChild)
  }

  // CONNECT：白名单内建隧道并原样转发字节，白名单外 403。
  const tunnel = await tunnelRequest(
    `${UPSTREAM_HOST}:${upstreamPort}`,
    `GET /payload HTTP/1.1\r\nHost: ${UPSTREAM_HOST}\r\nConnection: close\r\n\r\n`,
  )
  assert.match(tunnel, /^HTTP\/1\.1 200 Connection Established/)
  assert.ok(tunnel.includes(PAYLOAD.trim()), `隧道里没拿到上游响应：${tunnel}`)
  const deniedTunnel = await tunnelRequest(`${BLOCKED_HOST}:443`, null)
  assert.match(deniedTunnel, /^HTTP\/1\.1 403 Forbidden/)
  assert.ok(deniedTunnel.includes(BLOCKED_HOST))

  // 探针端点：相对路径不会被当成转发目标。
  const health = await proxyRequest('/healthz')
  assert.equal(health.status, 204)
  assert.equal(health.body, '')

  const status = await proxyRequest('/status')
  assert.equal(status.status, 200)
  const parsed = JSON.parse(status.body)
  assert.equal(parsed.allowedHosts, 1)
  assert.equal(parsed.maxSockets, 32)
  assert.ok(parsed.httpPorts.includes(upstreamPort))
  assert.ok(parsed.connectPorts.includes(443))
  assert.ok(parsed.allowedCount >= 3, `allow 计数不对：${status.body}`)
  assert.ok(parsed.deniedCount >= 4, `deny 计数不对：${status.body}`)
  assert.equal(typeof parsed.activeConnections, 'number')
  assert.equal(status.body.includes(UPSTREAM_HOST), false, '/status 不能暴露目标地址明细')

  // 审计日志：一行一条 JSON，有判定和耗时，没有 query、没有 header 值。
  const entries = auditLog
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
  const traffic = entries.filter((entry) => entry.action === 'http' || entry.action === 'connect')
  assert.ok(traffic.length >= 6, `审计日志条数不对：${traffic.length}`)
  for (const entry of traffic) {
    assert.ok(['allow', 'deny'].includes(entry.decision))
    assert.equal(typeof entry.target, 'string')
    assert.equal(typeof entry.ms, 'number')
    assert.equal(typeof entry.bytes, 'number')
    assert.ok(typeof entry.ts === 'string' && entry.ts.endsWith('Z'))
  }
  assert.ok(
    traffic.some(
      (entry) => entry.action === 'http' && entry.decision === 'allow' && entry.status === 200,
    ),
  )
  assert.ok(traffic.some((entry) => entry.action === 'connect' && entry.decision === 'allow'))
  assert.equal(auditLog.includes('SECRET-TOKEN-abc'), false, '审计日志不能记录 query')
  assert.equal(auditLog.includes('/payload'), false, '审计日志不能记录路径')
} finally {
  // 子进程和上游都必须收干净，不留端口占用。
  await stopProxy(child)
  await new Promise((resolve) => upstream.close(resolve))
  try {
    fs.rmSync(preloadPath, { force: true })
  } catch {
    // 临时文件删不掉不影响结论
  }
}

console.log('egress proxy smoke: ok')
