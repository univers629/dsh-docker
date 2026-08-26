import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPPORTED_ROUTE_PROTOCOLS } from '../bin/dsh-model-settings-policy.mjs'

// seed-dsh-model-settings.mjs 的另一半：真正读写 YAML 的那部分。它需要 yaml 库，
// 而这个仓库不带 node_modules，所以按两条路跑——宿主上能解析到 yaml 就直接跑，
// 否则借 DSH 镜像里的 node（镜像里既有 yaml 也有 pi-ai 目录和 DSH 自己的校验函数）。
// 两样都没有就跳过：本机没装 Docker 不是这个仓库的缺陷。

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const seedScript = join(repoRoot, 'bin', 'seed-dsh-model-settings.mjs')
const candidateImages = ['dsh:local', 'ghcr.io/univers629/dsh-docker:latest']

/** 宿主上能不能解析到 yaml：能就用本机 node 跑，最快也最好调试。 */
const hostYamlRoot = (() => {
  for (const root of [
    ...(process.env.DSH_SEED_MODULE_ROOTS ?? '').split(':').filter((entry) => entry.length > 0),
    join(repoRoot, 'node_modules'),
    join(repoRoot, 'deepseek-harness', 'node_modules'),
  ]) {
    try {
      createRequire(join(root, 'probe.cjs'))('yaml')
      return root
    } catch {
      // 换下一个候选根目录。
    }
  }
  return ''
})()

const dockerImage = hostYamlRoot.length > 0 ? '' : (candidateImages.find((image) => {
  const probe = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' })
  return probe.status === 0
}) ?? '')

if (hostYamlRoot.length === 0 && dockerImage.length === 0) {
  console.log('seed-dsh-model-settings smoke: skipped (no host yaml module and no local DSH image)')
  process.exit(0)
}

const sandbox = join(repoRoot, '.tmp', 'seed-smoke')
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

/**
 * 跑一次 seed 脚本。home 为空时走纯变换模式（结果打到 stdout），否则读写这个目录。
 * 容器模式下 home 必须在仓库里：Docker 的文件共享只覆盖工程目录。
 */
function runSeed(payload, home = '') {
  const input = JSON.stringify(payload)
  if (dockerImage.length > 0) {
    const mounts = ['-v', join(repoRoot, 'bin') + ':/dsh-seed:ro']
    if (home.length > 0) mounts.push('-v', home + ':/seed-home')
    const argv = home.length > 0 ? ['--home', '/seed-home'] : []
    return spawnSync('docker', [
      'run', '--rm', '-i', ...mounts, '--entrypoint', 'node', dockerImage,
      '/dsh-seed/seed-dsh-model-settings.mjs', ...argv,
    ], { input, encoding: 'utf8' })
  }
  const argv = home.length > 0 ? ['--home', home] : []
  return spawnSync(process.execPath, [seedScript, ...argv], {
    input,
    encoding: 'utf8',
    env: { ...process.env, DSH_SEED_MODULE_ROOTS: hostYamlRoot },
  })
}

function transform(payload) {
  const run = runSeed(payload)
  assert.equal(run.status, 0, run.stdout + '\n' + run.stderr)
  return JSON.parse(run.stdout)
}

const brokerBase = 'http://dsh-key-broker:8080'
const placeholder = 'dsh-broker-placeholder'
const upstreams = [
  { name: 'deepseek', shape: 'any', models: [] },
  { name: 'justwoker', shape: 'responses', models: ['claude-opus-5-thinking'] },
  { name: 'badgw', shape: 'gemini', models: ['gemini-3-pro'] },
]

try {
  // -------------------------------------------------------------------------
  // 全新安装：两份文件都不存在（空文本）
  // -------------------------------------------------------------------------
  const fresh = transform({ brokerBase, placeholder, upstreams, settingsText: '', credentialsText: '' })
  // DSH 自己的 schema 必须放行：这里失败就意味着装完 WebUI 里一个供应商都看不到。
  assert.equal(fresh.validationFailure, '', fresh.validationFailure)
  if (dockerImage.length > 0) {
    // 镜像里跑的时候校验必须真的发生过，否则 validationFailure 为空只是"没校验"。
    assert.ok(fresh.supportedProtocols.length > 0, '镜像里必须能加载 llm-pi-ai 并取到协议清单')
    // 协议清单是契约：DSH 升级后自定义路由能声明的协议一旦变化，安装器的映射表就要跟着改。
    assert.deepEqual(fresh.supportedProtocols, [...SUPPORTED_ROUTE_PROTOCOLS])
    assert.ok(fresh.catalogAvailable, '镜像里必须能读到 pi-ai 的内置模型目录')
  }
  assert.deepEqual(fresh.written.map((entry) => entry.name), ['deepseek', 'justwoker'])
  assert.deepEqual(fresh.skipped.map((entry) => entry.name), ['badgw'])
  // base_url 不带版本段：broker 会把上游 base_url 的路径和客户端路径拼起来。
  assert.match(fresh.settingsText, /baseURL: http:\/\/dsh-key-broker:8080\/u\/deepseek$/m)
  assert.doesNotMatch(fresh.settingsText, /\/u\/\w+\/v1/)
  assert.match(fresh.settingsText, /apiKeyEnv: DEEPSEEK_API_KEY/)
  // 自定义路由必须显式声明协议和模型 id，否则 pi-ai 会拒绝整个 namespace。
  assert.match(fresh.settingsText, /api: openai-responses/)
  assert.match(fresh.settingsText, /id: claude-opus-5-thinking/)
  assert.match(fresh.settingsText, /^agent-default-model:/m)
  assert.deepEqual(fresh.credentialRefs.slice().sort(), ['DEEPSEEK_API_KEY', 'JUSTWOKER_API_KEY'])
  assert.match(fresh.credentialsText, /^version: 1$/m)
  assert.ok(fresh.credentialsText.includes('DEEPSEEK_API_KEY: ' + placeholder))
  // 目录路由不写 api：目录里的模型各自带着自己的协议，写死一个就全按它对待了。
  const deepseekBlock = fresh.settingsText.slice(
    fresh.settingsText.indexOf('deepseek:'),
    fresh.settingsText.indexOf('justwoker:'),
  )
  assert.doesNotMatch(deepseekBlock, /api:/)

  // -------------------------------------------------------------------------
  // 幂等：把产物再喂一遍，两份文本都不能变
  // -------------------------------------------------------------------------
  const again = transform({
    brokerBase,
    placeholder,
    upstreams,
    settingsText: fresh.settingsText,
    credentialsText: fresh.credentialsText,
  })
  assert.equal(again.settingsText, fresh.settingsText)
  assert.equal(again.credentialsText, fresh.credentialsText)
  // 默认模型只在缺失时设：用户选过之后每次重新配置都改回来就是骚扰。
  assert.equal(again.defaultModel, null)
  assert.deepEqual(again.credentialRefs, [])

  // -------------------------------------------------------------------------
  // 已有配置：注释、无关的键、用户自己选的默认模型都必须原样留下
  // -------------------------------------------------------------------------
  const existingSettings = [
    '# 这行注释是用户自己写的，安装器不能把它吃掉',
    'theme: dark',
    'agent-default-model:',
    '  provider: myown',
    '  model: my-model',
    'llm-pi-ai:',
    '  providers:',
    '    keepme:',
    '      baseURL: https://keep.example.com',
    '      api: openai-completions',
    '      models:',
    '        - id: keep-1',
    '',
  ].join('\n')
  const merged = transform({
    brokerBase,
    placeholder,
    upstreams,
    settingsText: existingSettings,
    credentialsText: 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-real-user-key\n',
  })
  assert.equal(merged.validationFailure, '', merged.validationFailure)
  assert.match(merged.settingsText, /# 这行注释是用户自己写的/)
  assert.match(merged.settingsText, /^theme: dark$/m)
  assert.match(merged.settingsText, /keepme:/)
  assert.match(merged.settingsText, /baseURL: https:\/\/keep\.example\.com/)
  // 用户已经选过默认模型，不改。
  assert.match(merged.settingsText, /model: my-model/)
  assert.equal(merged.defaultModel, null)
  // 已经有真实密钥的引用不写占位串，否则等于把用户的配置弄坏。
  assert.deepEqual(merged.credentialRefs, ['JUSTWOKER_API_KEY'])
  assert.match(merged.credentialsText, /DEEPSEEK_API_KEY: sk-real-user-key/)

  // -------------------------------------------------------------------------
  // --home 模式：落盘 + 中文摘要；顶层不是映射时一个字都不写
  // -------------------------------------------------------------------------
  const home = join(sandbox, 'dsh-home')
  mkdirSync(home, { recursive: true })
  const homeRun = runSeed({ brokerBase, placeholder, upstreams }, home)
  assert.equal(homeRun.status, 0, homeRun.stdout + '\n' + homeRun.stderr)
  assert.ok(existsSync(join(home, 'settings.yaml')), '--home 模式必须写出 settings.yaml')
  assert.ok(existsSync(join(home, '.credentials.yaml')), '--home 模式必须写出 .credentials.yaml')
  assert.match(readFileSync(join(home, 'settings.yaml'), 'utf8'), /llm-pi-ai:/)
  assert.ok(readFileSync(join(home, '.credentials.yaml'), 'utf8').includes(placeholder))
  assert.match(homeRun.stdout, /deepseek/)
  assert.match(homeRun.stdout, /默认模型/)
  // 写不进去的上游必须给出可操作的原因，而不是静默少一个供应商。
  assert.match(homeRun.stderr, /badgw/)

  const brokenHome = join(sandbox, 'broken-home')
  mkdirSync(brokenHome, { recursive: true })
  writeFileSync(join(brokenHome, 'settings.yaml'), '- 这是个序列，不是映射\n')
  const brokenRun = runSeed({ brokerBase, placeholder, upstreams }, brokenHome)
  assert.notEqual(brokenRun.status, 0, '顶层不是映射时必须失败退出')
  assert.equal(readFileSync(join(brokenHome, 'settings.yaml'), 'utf8'), '- 这是个序列，不是映射\n')
  assert.ok(!existsSync(join(brokenHome, '.credentials.yaml')), '失败时不能留下半份凭据文件')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('seed-dsh-model-settings smoke: ok (' + (dockerImage.length > 0 ? 'image ' + dockerImage : 'host node') + ')')
