// 每用户模型上游授权：策略层 + 接线检查。
//
// 这个功能的立足点是「限制真的限制得住」：用户能在自己的 settings.yaml 里手写
// 任意上游名，因此闸门必须在代理侧，而不是靠生成配置时不给。
//
// 关于覆盖范围（如实说明）：代理强制上游为 https、拒绝环回与私网解析结果，这两条
// 都是它的 SSRF 与密钥保护规则，不该为了测试放宽，因此这里不起真实代理进程做端到端
// （那需要伪造一个公网 HTTPS 上游）。授权判定是纯逻辑，这里完整覆盖；「代理确实在
// 放行前调用它」与「编排侧确实把令牌接上」由接线断言保证，真实栈上的端到端另行实测。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { brokerTokenDigest, callerTokenFromHeaders, identifyCaller, isUpstreamAllowed, parseGrants } from '../bin/dsh-broker-grants.mjs'
import { ADMIN_UID } from '../bin/dsh-instances-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- 1) 令牌与识别 ----
{
  const token = 'tok-abc-123'
  const grants = parseGrants(JSON.stringify({
    version: 1,
    users: {
      100000: { tokenDigest: brokerTokenDigest(token), upstreams: ['main', 'fast'] },
      100001: { tokenDigest: brokerTokenDigest('other'), upstreams: [] },
    },
  }))
  assert.equal(grants.users.size, 2)

  const caller = identifyCaller(grants, token)
  assert.equal(caller.uid, '100000')
  assert.equal(isUpstreamAllowed(caller, 'main'), true)
  assert.equal(isUpstreamAllowed(caller, 'fast'), true)
  // 核心断言：未列入的上游必须被拒
  assert.equal(isUpstreamAllowed(caller, 'secret-upstream'), false, 'an unlisted upstream must be refused')

  // 空清单 = 明确不可用，而不是「不限」
  const empty = identifyCaller(grants, 'other')
  assert.equal(isUpstreamAllowed(empty, 'main'), false, 'an empty grant list means no access')

  assert.equal(identifyCaller(grants, 'wrong'), null, 'an unknown token identifies nobody')
  assert.equal(identifyCaller(grants, ''), null, 'a missing token identifies nobody')
  assert.equal(identifyCaller(grants, undefined), null, 'an absent token identifies nobody')
  assert.equal(identifyCaller(parseGrants(''), token), null, 'an empty grants file grants nothing')

  // 默认拒绝：没被识别出来的人，什么都拿不到
  assert.equal(isUpstreamAllowed(null, 'main'), false, 'an unidentified caller gets nothing')
  console.log('令牌与识别：ok')
}

// ---- 2) 只存摘要，不存明文 ----
{
  const token = 'super-secret-instance-token'
  const grants = parseGrants(JSON.stringify({
    version: 1,
    users: { 100000: { tokenDigest: brokerTokenDigest(token), upstreams: ['main'] } },
  }))
  assert.ok(!JSON.stringify(grants).includes(token), 'the raw token must never be stored')
  assert.notEqual(brokerTokenDigest(token), token)
  assert.equal(brokerTokenDigest(token), brokerTokenDigest(token), 'the digest is stable')
  console.log('只存摘要：ok')
}

// ---- 3) 授权表的解析与拒绝 ----
{
  assert.throws(() => parseGrants('{"version":2}'), /版本/)
  assert.throws(() => parseGrants('{"users":{"abc":{}}}'), /uid/)
  assert.throws(() => parseGrants('{"users":[]}'), /users/)
  assert.throws(() => parseGrants('not json'), /JSON/)
  assert.throws(() => parseGrants('[]'), /对象/)

  // 空文本是合法状态（授权表还没生成），等价于「谁都没授权」
  assert.equal(parseGrants('').users.size, 0)
  assert.equal(parseGrants('{}').users.size, 0)

  // upstreams 缺失按空清单处理（不可用），而不是报错或视为不限
  const missing = parseGrants('{"users":{"100000":{"tokenDigest":"x"}}}')
  assert.equal(isUpstreamAllowed(identifyCaller(missing, 'anything'), 'main'), false)
  console.log('解析与拒绝：ok')
}

// ---- 4) 头部解析 ----
{
  assert.equal(callerTokenFromHeaders({ 'x-dsh-instance-token': ' t ' }), 't')
  assert.equal(callerTokenFromHeaders({}), '')
  assert.equal(callerTokenFromHeaders({ 'x-dsh-instance-token': ['a', 'b'] }), 'a', 'a repeated header takes the first value')
  assert.equal(callerTokenFromHeaders({ 'x-dsh-instance-token': 123 }), '', 'a non-string header is ignored')
  console.log('头部解析：ok')
}

// ---- 5) 令牌不透传给上游 ----
{
  const { STRIPPED_REQUEST_HEADERS } = await import('../bin/dsh-key-broker-policy.mjs')
  assert.ok(
    STRIPPED_REQUEST_HEADERS.includes('x-dsh-instance-token'),
    'the instance token identifies the caller; forwarding it upstream would leak it',
  )
  console.log('令牌不外泄：ok')
}

// ---- 6) 代理确实在放行前调用授权判定 ----
{
  const broker = fs.readFileSync(path.join(root, 'bin', 'dsh-key-broker.mjs'), 'utf8')
  assert.ok(broker.includes('identifyCaller('), 'the broker identifies the caller')
  assert.ok(broker.includes('isUpstreamAllowed('), 'the broker checks the grant before forwarding')
  const body = broker.slice(broker.indexOf('const server = http.createServer'))
  const identifyAt = body.indexOf('identifyCaller(')
  const forwardAt = body.indexOf('forward(request, response, route)')
  assert.ok(identifyAt > 0 && forwardAt > 0 && identifyAt < forwardAt, 'authorization happens before forwarding')
  assert.ok(/deny\(response, 401/.test(body), 'an unidentified caller is refused with 401')
  assert.ok(/deny\(response, 403/.test(body), 'an unauthorized upstream is refused with 403')
  console.log('接线（代理侧）：ok')
}

// ---- 7) 编排侧确实把令牌与授权接到实例配置上 ----
{
  const instances = fs.readFileSync(path.join(root, 'bin', 'dsh-instances.mjs'), 'utf8')
  assert.ok(instances.includes('readGrants()'), 'instance creation reads the grant table')
  assert.ok(instances.includes('readTokens()'), 'instance creation reads the instance token')
  assert.ok(instances.includes('extraHeaders'), 'the token is passed to the seeder as provider headers')
  assert.ok(instances.includes('x-dsh-instance-token'), 'the header name matches what the broker reads')

  const policy = fs.readFileSync(path.join(root, 'bin', 'dsh-instances-policy.mjs'), 'utf8')
  assert.ok(policy.includes('DSH_BROKER_INSTANCE_TOKEN'), 'the token is injected into the container environment')

  const seeder = fs.readFileSync(path.join(root, 'bin', 'seed-dsh-model-settings.mjs'), 'utf8')
  assert.ok(seeder.includes('extraHeaders'), 'the seeder forwards extra headers into the provider config')

  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')
  assert.ok(dockerfile.includes('seed-dsh-model-settings.mjs'), 'the seeder ships in the image (it runs at instance creation)')
  console.log('接线（编排侧）：ok')
}

// ---- 8) 管理员工作台同样要有身份 ----
//
// root 没有实例容器（它直接用静态声明的管理工作台），但代理按 uid 识别调用者，
// 所以它同样需要 uid 与令牌。缺了任一个，管理员在自己的工作台里发模型请求会被
// 代理以「认不出调用者」拒掉，而配置看上去一切正常。
{
  const policy = fs.readFileSync(path.join(root, 'bin', 'dsh-instances-policy.mjs'), 'utf8')
  assert.ok(policy.includes('ADMIN_UID'), 'a reserved uid exists for the administrator')

  const auth = fs.readFileSync(path.join(root, 'bin', 'dsh-auth.mjs'), 'utf8')
  assert.ok(auth.includes('migrateAdminIdentity'), 'existing administrators are migrated on startup')
  assert.match(
    auth,
    /role !== 'root'/,
    'the migration targets the administrator account',
  )
  assert.ok(
    auth.includes('adminBrokerToken'),
    'the administrator token comes from the deployment declaration, not a random value: ' +
      'the same value has to reach the settings.yaml header written by the installer and the panel',
  )

  // 授权表按 uid 生成，root 的 uid 必须在其中，否则代理认不出它。
  const grants = parseGrants(JSON.stringify({
    version: 1,
    users: { [String(ADMIN_UID)]: { tokenDigest: brokerTokenDigest('admin-token'), upstreams: ['vyceai'] } },
  }))
  const caller = identifyCaller(grants, 'admin-token')
  assert.ok(caller, 'the administrator uid is accepted by the broker')
  assert.equal(caller.uid, String(ADMIN_UID))
  assert.ok(isUpstreamAllowed(caller, 'vyceai'), 'the administrator gets its granted upstreams')
  console.log('管理员身份：ok')
}

// ---- 9) settings.yaml 变更后 supervisor 会重启 DSH ----
//
// DSH 只在启动时导入 settings.yaml（随后改名成 .imported），它没有热加载。
// 没有这一步，面板里保存成功、工作台里却看不到新供应商。
{
  const supervisor = fs.readFileSync(path.join(root, 'bin', 'dsh-supervisor'), 'utf8')
  assert.ok(
    supervisor.includes('DSH_SETTINGS_FILE'),
    'the supervisor watches the model settings file',
  )
  assert.match(
    supervisor,
    /-f "\$DSH_SETTINGS_FILE"/,
    'the watch triggers on the file reappearing, which is exactly what a save does',
  )
  assert.ok(
    supervisor.includes('DSH_RESTART_REQUEST_FILE'),
    'the restart reuses the existing request-file path so the shutdown path stays single',
  )
  console.log('模型配置重启：ok')
}

console.log('dsh-broker-grants smoke: ok')
