// 模型开放的两条链路：撤销授权要生效、新账户默认要可配。
//
// 覆盖三个曾经各自独立的缺陷（它们叠在一起的表现是「面板说已更新，用户却看不到模型」）：
//
//   1. seedModelSettings 在 upstreams 为空时提前 return —— 实例创建时授权表还是空的
//      （全新部署：keys.json 里没有上游，「默认全部开放」展开成空数组），于是
//      settings.yaml 从未被写过。之后管理员补了密钥、保存了授权，实例仍然没有模型。
//   2. 授权表变化后不重写实例配置 —— 面板保存只调 syncBrokerGrants，实例侧无人过问。
//   3. 撤销授权不删路由 —— seeder 只写「这次被授权的」，旧 provider 一直留着。
//
// 另加：新账户默认（state.setup.defaultUpstreams）让管理员在还没有用户时就能设定。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { planSeed, piAiRoutePath } from '../bin/dsh-model-settings-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const auth = read('bin/dsh-auth.mjs')
const instances = read('bin/dsh-instances.mjs')
const store = read('bin/dsh-auth-store.mjs')
const adminHtml = read('bin/dsh-auth-web/admin.html')
const clientJs = read('dsh-home/docker-control/client/client.js')

// ---------------------------------------------------------------------------
// 1) 撤销授权必须删掉 provider 路由（seeder 的 planSeed）
// ---------------------------------------------------------------------------
{
  const brokerBase = 'http://dsh-key-broker:8080'
  const placeholder = 'dsh-broker-placeholder'
  const existing = {
    providers: {
      alpha: { baseURL: `${brokerBase}/u/alpha`, apiKeyEnv: 'ALPHA_API_KEY' },
      beta: { baseURL: `${brokerBase}/u/beta`, apiKeyEnv: 'BETA_API_KEY' },
      // 用户自己写的直连供应商：指向别处，任何情况下都不该被删
      mine: { baseURL: 'https://my-own.example/v1', apiKeyEnv: 'MINE_API_KEY' },
    },
  }

  // 只授权 alpha：beta 的授权被撤销，应被删；mine 不是代理路由，不动。
  const revoked = planSeed({
    upstreams: [{ name: 'alpha', shape: 'any', models: [] }],
    brokerBase,
    placeholder,
    catalog: {},
    existing,
  })
  const removedPaths = revoked.removals.map((p) => p.join('.'))
  assert.ok(
    removedPaths.includes('llm-pi-ai.providers.beta'),
    `撤销授权必须删掉 beta 的 provider 路由，实际 removals=${JSON.stringify(removedPaths)}`,
  )
  assert.ok(
    !removedPaths.includes('llm-pi-ai.providers.alpha'),
    '仍被授权的 alpha 不能被删',
  )
  assert.ok(
    !removedPaths.includes('llm-pi-ai.providers.mine'),
    '用户手写的直连供应商（baseURL 不是本部署代理）任何情况下都不能被删',
  )

  // 空授权（管理员取消全部勾选）→ 代理路由全部删掉，手写那条仍在
  const allRevoked = planSeed({
    upstreams: [],
    brokerBase,
    placeholder,
    catalog: {},
    existing,
  })
  const allPaths = allRevoked.removals.map((p) => p.join('.'))
  assert.ok(allPaths.includes('llm-pi-ai.providers.alpha'), '空授权时 alpha 也应被删')
  assert.ok(allPaths.includes('llm-pi-ai.providers.beta'), '空授权时 beta 也应被删')
  assert.ok(!allPaths.includes('llm-pi-ai.providers.mine'), '手写供应商始终不动')

  // 被授权的上游若因缺模型清单等原因规划失败，不能当成「已撤销」删掉。
  // granted 取 request.upstreams 而不是规划成功的 entries，正是为了这个。
  const skipped = planSeed({
    upstreams: [
      { name: 'alpha', shape: 'any', models: [] },
      { name: 'beta', shape: 'any', models: [] },
    ],
    brokerBase,
    placeholder,
    catalog: {},
    existing,
  })
  const skippedPaths = skipped.removals.map((p) => p.join('.'))
  assert.ok(
    !skippedPaths.includes('llm-pi-ai.providers.beta'),
    '仍被授权的 beta 即便这次没写成配置，也不能被当作撤销而删掉',
  )
}

// ---------------------------------------------------------------------------
// 2) 实例侧：空清单也要跑 seeder（不能提前 return）
// ---------------------------------------------------------------------------
{
  const seedFn = instances.match(/async function seedModelSettings\([\s\S]*?\n\}/)
  assert.ok(seedFn, 'dsh-instances.mjs 必须包含 seedModelSettings')
  const body = seedFn[0]
  assert.doesNotMatch(
    body,
    /if \(upstreams\.length === 0\)[\s\S]{0,120}?return/,
    'seedModelSettings 不得在 upstreams 为空时提前 return：' +
      '撤销授权要靠这次调用删掉旧路由，提前返回会让撤销不生效',
  )
}

// ---------------------------------------------------------------------------
// 3) 实例侧：reseed 端点存在，且授权变化时会被调用
// ---------------------------------------------------------------------------
{
  assert.match(
    instances,
    /if \(req\.method === 'POST' && p === '\/instances\/reseed'\)/,
    'dsh-instances 必须把 POST /instances/reseed 接上：授权表变化后要能重写实例的模型配置',
  )
  const reseedHandler = instances.match(/p === '\/instances\/reseed'[\s\S]*?\n {4}\}/)
  assert.ok(reseedHandler, 'reseed 处理块必须完整')
  assert.match(reseedHandler[0], /seedModelSettings\(/, 'reseed 必须调用 seedModelSettings')

  // 网关在保存「模型开放」后必须触发 reseed —— 这是缺陷 2 的落点。
  const update = auth.match(/async function handleAdminModelAccessUpdate\([\s\S]*?\n\}/)
  assert.ok(update, 'dsh-auth.mjs 必须包含 handleAdminModelAccessUpdate')
  assert.match(
    update[0],
    /callInstances\('\/instances\/reseed'/,
    '保存模型开放后必须调用 /instances/reseed，否则实例里的模型配置永远停在创建那一刻',
  )

  // 重新启用账户同理：停用期间授权表里的 upstreams 被写成空数组。
  const status = auth.match(/async function handleAdminUserStatus\([\s\S]*?\n\}/)
  assert.ok(status, 'dsh-auth.mjs 必须包含 handleAdminUserStatus')
  assert.match(status[0], /\/instances\/reseed/, '重新启用账户后必须 reseed')
}

// ---------------------------------------------------------------------------
// 4) 新账户默认：状态字段 + 注册时应用 + 接口 + 界面
// ---------------------------------------------------------------------------
{
  // 必须落在 setup 的对象字面量里，而不是注释里出现过这个词就算数。
  //
  // 两个坑都踩过：
  //   1. 用 /defaultUpstreams/ 匹配整份文件 —— 注释里也有这个词，删掉属性照样通过；
  //   2. 匹配 /setup:\s*\{[^}]*\}/ —— 文件顶部的格式说明注释里也有一行 `setup: {...}`，
  //      它排在真正的定义之前，会被先匹配到。
  // 所以先剥掉注释行，再找 setup 的字面量。
  const storeCode = store
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
  const setupLine = storeCode.match(/setup:\s*\{[^}]*\}/)
  assert.ok(setupLine, 'dsh-auth-store.mjs 必须定义 setup 的初始对象')
  assert.match(
    setupLine[0],
    /defaultUpstreams/,
    'state.setup 必须有 defaultUpstreams 字段：管理员要能在还没有用户时设定新账户默认',
  )
  assert.match(
    auth,
    /allowedUpstreams: normalizeDefaultUpstreams\(state\.setup\.defaultUpstreams\)/,
    '注册时必须按 state.setup.defaultUpstreams 初始化新账户的开放范围',
  )
  assert.match(auth, /function normalizeDefaultUpstreams\(/, '必须定义 normalizeDefaultUpstreams')
  // 路由要真的接在分派里，而不是只在注释或函数名里出现。
  assert.match(
    auth,
    /if \(req\.method === 'POST' && p === '\/api\/admin\/model-defaults'\)\s*return await handleAdminModelDefaultsUpdate/,
    '必须把 POST /api/admin/model-defaults 接到 handleAdminModelDefaultsUpdate',
  )
  // GET model-access 要把默认值一并返回，界面才渲染得出来
  const getAccess = auth.match(/async function handleAdminModelAccess\([\s\S]*?\n\}/)
  assert.ok(getAccess, '必须包含 handleAdminModelAccess')
  assert.match(getAccess[0], /defaultUpstreams/, 'GET model-access 必须返回 defaultUpstreams')

  // 界面：控件必须在"逐账户表"之外，否则没有用户时不可见
  assert.match(adminHtml, /id="models-default-grid"/, '管理面板必须有新账户默认的卡片组')
  assert.match(adminHtml, /id="models-default-save"/, '必须有保存按钮')
  const section = adminHtml.match(/<section class="section" id="section-models">[\s\S]*?<\/section>/)
  assert.ok(section, '必须能切出模型开放区块')
  const defaultIdx = section[0].indexOf('models-default-grid')
  const tableIdx = section[0].indexOf('models-body')
  assert.ok(
    defaultIdx > 0 && tableIdx > 0 && defaultIdx < tableIdx,
    '默认控件必须排在逐账户表之前，且不依赖表里有没有行',
  )
}

// ---------------------------------------------------------------------------
// 5) dsh-control 的实时状态卡片默认不打开
// ---------------------------------------------------------------------------
{
  assert.match(
    clientJs,
    /getItem\(METRICS_STORAGE_KEY\) === 'on'/,
    '实时状态卡片必须默认关闭：只有显式存过 on 才打开',
  )
  assert.doesNotMatch(
    clientJs,
    /getItem\(METRICS_STORAGE_KEY\) !== 'off'/,
    '旧写法（!= off 即默认开启）必须已被替换',
  )
}

// ---------------------------------------------------------------------------
// 6) 端到端：撤销后 provider 真的从 settings.yaml 消失
//
// 上面第 1 节只证明 planSeed 返回了正确的 removals 路径；真正删除发生在
// seed-dsh-model-settings.mjs 里。这一节跑真实脚本，断言写出来的 YAML。
//
// 被测文件从仓库取，不要用 /usr/local/lib/dsh 下那份：那是镜像里安装好的旧版本，
// 用它测等于什么都没测（第一次写这个探针时就踩了：容器里的旧代码 removals 为空，
// 端到端"通过"其实什么都没验证）。
// ---------------------------------------------------------------------------
if (process.platform === 'win32') {
  console.log('DYNAMIC-SKIPPED: seed-revoke-e2e: 需要 bash 与 DSH 的 node 模块根，只在 Linux 上跑')
} else {
  const { spawnSync } = await import('node:child_process')
  const helper = path.join(root, 'tests', 'helpers', 'seed-revoke-e2e.sh')
  const probe = spawnSync('bash', [helper, root], { encoding: 'utf8', timeout: 120000 })
  const detail = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim()
  assert.equal(
    probe.status,
    0,
    `撤销授权的端到端验证未通过（provider 应从 settings.yaml 消失）：\n${detail.slice(-1500)}`,
  )
}

console.log('model-access-reseed smoke: ok (撤销生效 / 默认可配 / 状态卡默认关闭)')
