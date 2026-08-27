#!/usr/bin/env node
// 把模型密钥代理的部署事实写进 DSH 自己的配置文件里，格式和位置都用 DSH 官方那套：
//   - $DSH_HOME/settings.yaml 的 llm-pi-ai.providers.<上游名>（WebUI 的"模型"页读写的正是这里）
//   - $DSH_HOME/.credentials.yaml 的 refs.<上游名>_API_KEY = 占位密钥
//   - $DSH_HOME/settings.yaml 的 agent-default-model（只在还没设过的时候）
// 这样装完就能在 WebUI 里选模型，不用手抄 base_url，也不用把真实密钥填进容器。
//
// 上游清单（名字、API 形态、模型 id）总是从 stdin 的 JSON 读；两份文件的读写有两种模式：
//   node seed-dsh-model-settings.mjs --home /data/dsh   # 直接读写这个 DSH_HOME，打印中文摘要
//   node seed-dsh-model-settings.mjs                    # 纯变换：结果连同新文本一起打到 stdout
// 安装器用第一种（脚本跑在镜像里，DSH_HOME 挂进去），测试用第二种。
//   printf '%s' '{}' | node seed-dsh-model-settings.mjs --catalog   # 只导出目录快照
//
// 依赖解析：yaml 与 pi-ai 目录都按候选根目录去找（镜像里是 /app/dsh/node_modules），
// 找不到 yaml 就直接失败——手写 YAML 合并会毁掉用户已有的配置和注释，宁可不写。

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { planSeed } from './dsh-model-settings-policy.mjs'

const DSH_ROOTS = (process.env.DSH_SEED_MODULE_ROOTS ?? '/app/dsh/node_modules:/opt/dsh-docker-control/node_modules')
  .split(':')
  .filter((entry) => entry.length > 0)

/** 在候选根目录里找一个包并加载。yaml 有 CJS 构建，require 最省事。 */
function loadPackage(specifier) {
  for (const root of DSH_ROOTS) {
    try {
      return createRequire(root + '/dsh-seed-resolver.cjs')(specifier)
    } catch {
      // 换下一个根目录。
    }
  }
  // 调用方自己的 node_modules（宿主上跑测试时走这条）。
  try {
    return createRequire(import.meta.url)(specifier)
  } catch {
    return undefined
  }
}

/** 目录快照：{ [providerId]: { api, models: [id] } }。取不到就返回空对象。 */
async function loadCatalog() {
  for (const root of DSH_ROOTS) {
    const entry = root + '/@earendil-works/pi-ai/dist/providers/all.js'
    let module
    try {
      module = await import(pathToFileURL(entry).href)
    } catch {
      continue
    }
    const catalog = {}
    for (const provider of module.builtinProviders()) {
      const models = module.getBuiltinModels(provider.id) ?? []
      catalog[provider.id] = {
        api: models[0]?.api ?? '',
        baseUrl: provider.baseUrl ?? '',
        models: models.map((model) => model.id),
      }
    }
    return catalog
  }
  return {}
}

/**
 * 用 DSH 自己导出的 schema 过一遍写出来的 section，并顺手取回它支持的协议清单。
 *
 * 这一步不是锦上添花：profile 里有一个字段不合规，DSH 会拒绝整个 llm-pi-ai
 * namespace，结果是"所有供应商一起消失"，而那时候用户已经看不到安装器的输出了。
 * 校验器用的是 llm-pi-ai 导出的 Config（真正注册在 settings 命名空间上的那个 schema
 * 的同一份定义）；它内部的 assertServiceable 没有导出，所以字段形态之外的规则
 * （自定义路由必须有模型 id）由 dsh-model-settings-policy.mjs 自己保证。
 *
 * @returns { failure, protocols } failure 为空串表示通过；protocols 空数组表示
 *   这次没能加载到 llm-pi-ai（例如宿主上跑测试），此时不能把"通过"当成结论。
 */
async function validateSection(providers) {
  for (const root of DSH_ROOTS) {
    const entry = root + '/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
    let module
    try {
      module = await import(pathToFileURL(entry).href)
    } catch {
      continue
    }
    const protocols = typeof module.supportedProtocols === 'function' ? module.supportedProtocols() : []
    if (typeof module.Config !== 'function') return { failure: '', protocols }
    try {
      module.Config({ providers })
      return { failure: '', protocols }
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error), protocols }
    }
  }
  return { failure: '', protocols: [] }
}

/**
 * 第一方 DeepSeek 命名空间也过一遍它自己导出的 Config：写坏这一节的后果比 pi-ai
 * 更重——它是开箱默认选中的供应商，配置被拒等于装完一个模型都用不了。
 * @returns 空串表示通过（也包括"这次没加载到这个包"）。
 */
async function validateNativeSection(section) {
  if (section === undefined) return ''
  for (const root of DSH_ROOTS) {
    const entry = root + '/@deepseek-ai/dsh-llm-deepseek/lib/index.js'
    let module
    try {
      module = await import(pathToFileURL(entry).href)
    } catch {
      continue
    }
    if (typeof module.Config !== 'function') return ''
    try {
      module.Config(section)
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  return ''
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

/** 空文本要给出一个"空映射"文档，setIn 才有地方落键。 */
function loadDocument(yaml, text) {
  const document = yaml.parseDocument(text ?? '', { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length > 0) throw new Error(document.errors[0].message)
  if (document.contents === null) document.contents = document.createNode({})
  if (!yaml.isMap(document.contents)) throw new Error('文档的顶层不是映射，安装器不改它')
  return document
}

/** 参数 --home DIR：直接读写这个 DSH_HOME 里的两份文件，并打印中文摘要。 */
function homeArgument() {
  const index = process.argv.indexOf('--home')
  return index >= 0 ? process.argv[index + 1] : ''
}

function readTextOrEmpty(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

/** 原子写：同目录临时文件 + rename，避免 DSH 读到半份文档。 */
function writeAtomic(file, text, mode) {
  const temporary = file + '.dsh-seed.' + process.pid + '.tmp'
  writeFileSync(temporary, text, { mode })
  renameSync(temporary, file)
}

async function runSeed(payload) {
  const yaml = loadPackage('yaml')
  if (yaml === undefined || typeof yaml.parseDocument !== 'function') {
    throw new Error('找不到 yaml 库（候选根目录：' + DSH_ROOTS.join(' ') + '）')
  }
  const catalog = await loadCatalog()
  const settings = loadDocument(yaml, payload.settingsText)
  const credentials = loadDocument(yaml, payload.credentialsText)
  const existingProviders = settings.getIn(['llm-pi-ai', 'providers'], true)
  const existingRefs = credentials.getIn(['refs'], true)
  const plan = planSeed({
    upstreams: payload.upstreams ?? [],
    brokerBase: payload.brokerBase ?? '',
    placeholder: payload.placeholder ?? '',
    catalog,
    existing: {
      // 传整份 profile（不只是名字）：判断某条同名 pi-ai 路由是不是安装器自己写的
      // 重复行，要看它的 baseURL 指向哪里。
      providers: existingProviders && yaml.isMap(existingProviders)
        ? existingProviders.toJSON?.() ?? {}
        : {},
      // 已经有值的引用不碰：用户自己在 WebUI 里填过真实密钥的话，占位串盖回去
      // 就等于把他的配置弄坏。
      refs: existingRefs && yaml.isMap(existingRefs)
        ? existingRefs.items
          .filter((item) => String(item.value?.value ?? item.value ?? '').length > 0)
          .map((item) => String(item.key))
        : [],
      defaultModel: settings.getIn(['agent-default-model', 'model']) !== undefined,
    },
  })

  const written = []
  for (const entry of plan.entries) {
    const base = entry.path
    // baseURL / apiKeyEnv 跟着部署走，每次都覆盖；其余字段属于用户，只补缺。
    for (const [key, value] of Object.entries(entry.always)) settings.setIn([...base, key], value)
    for (const [key, value] of Object.entries(entry.whenMissing)) {
      if (settings.getIn([...base, key]) === undefined) settings.setIn([...base, key], value)
    }
    written.push({
      name: entry.name,
      source: entry.source,
      provider: entry.provider,
      api: entry.api,
      models: entry.models,
      baseURL: entry.always.baseURL,
      apiKeyEnv: entry.credentialRef,
    })
  }
  // 旧版安装器留下的重复 pi-ai 路由：删掉它，顺带把空掉的容器键也清掉，
  // 否则 settings.yaml 里会剩一个 providers: {} 这样的空节点。
  const removed = []
  for (const path of plan.removals) {
    if (settings.getIn(path) === undefined) continue
    settings.deleteIn(path)
    removed.push(path.join('.'))
    const parent = settings.getIn(path.slice(0, -1), true)
    if (parent && yaml.isMap(parent) && parent.items.length === 0) settings.deleteIn(path.slice(0, -1))
    const grandparent = settings.getIn(path.slice(0, -2), true)
    if (grandparent && yaml.isMap(grandparent) && grandparent.items.length === 0) settings.deleteIn(path.slice(0, -2))
  }
  if (plan.defaultModel !== null) {
    settings.setIn(['agent-default-model', 'provider'], plan.defaultModel.provider)
    settings.setIn(['agent-default-model', 'model'], plan.defaultModel.model)
  }
  // version 要先落：新建的凭据文件里它应该出现在 refs 前面，和 DSH 自己写出来的一样。
  if (Object.keys(plan.refs).length > 0 && credentials.getIn(['version']) === undefined) {
    credentials.setIn(['version'], 1)
  }
  for (const [ref, value] of Object.entries(plan.refs)) {
    credentials.setIn(['refs', ref], value)
  }

  const providersJson = settings.getIn(['llm-pi-ai', 'providers'], true)?.toJSON?.() ?? {}
  const validation = await validateSection(providersJson)
  const nativeFailure = await validateNativeSection(settings.getIn(['llm-deepseek'], true)?.toJSON?.())
  return {
    settingsText: String(settings),
    credentialsText: String(credentials),
    written,
    removed,
    skipped: plan.skipped,
    defaultModel: plan.defaultModel,
    credentialRefs: Object.keys(plan.refs),
    catalogAvailable: Object.keys(catalog).length > 0,
    // 空数组表示这次没能加载 llm-pi-ai，validationFailure 为空串也不代表校验过了。
    supportedProtocols: validation.protocols,
    validationFailure: validation.failure.length > 0 ? validation.failure : nativeFailure,
  }
}

/** --home 模式：落盘并打印人能看的摘要。返回退出码。 */
function applyToHome(home, payload, result) {
  const settingsFile = join(home, 'settings.yaml')
  const credentialsFile = join(home, '.credentials.yaml')
  if (result.validationFailure.length > 0) {
    process.stderr.write('[错误] DSH 拒绝了这份模型配置，没有写入任何文件：\n')
    process.stderr.write('       ' + result.validationFailure + '\n')
    return 1
  }
  if (result.settingsText !== payload.settingsText) {
    writeAtomic(settingsFile, result.settingsText, 0o644)
  }
  // 凭据文件里现在只有占位串，但权限按真实密钥的规格给：用户随时可能在 WebUI 里
  // 填一个真的进去，那时候文件权限已经是对的了。
  if (result.credentialsText !== payload.credentialsText) {
    writeAtomic(credentialsFile, result.credentialsText, 0o600)
  }
  for (const entry of result.written) {
    const models = entry.source !== 'declared' && entry.models.length > 3
      ? entry.models.slice(0, 3).join('、') + ' 等 ' + entry.models.length + ' 个'
      : entry.models.join('、')
    const kind = entry.source === 'native'
      ? 'DSH 自带的 ' + entry.provider + ' 供应商（不会多出一行）'
      : entry.source === 'catalog' ? 'DSH 内置目录路由' : '自定义路由（' + entry.api + '）'
    process.stdout.write('    - ' + entry.name + '：' + kind +
      '，模型 ' + (models.length > 0 ? models : '（目录提供）') + '\n')
  }
  for (const path of result.removed) {
    process.stdout.write('    已删除旧版安装器留下的重复配置：' + path + '\n')
  }
  if (result.defaultModel !== null) {
    process.stdout.write('    默认模型：' + result.defaultModel.provider + ' / ' + result.defaultModel.model + '\n')
  }
  for (const entry of result.skipped) {
    process.stderr.write('[警告] 上游 ' + entry.name + ' 没有写进 DSH 配置：' + entry.reason + '\n')
  }
  return 0
}

function main() {
  const wantCatalog = process.argv.includes('--catalog')
  const home = homeArgument()
  return readStdin().then(async (input) => {
    if (wantCatalog) {
      process.stdout.write(JSON.stringify({ catalog: await loadCatalog() }, null, 2))
      return
    }
    const payload = JSON.parse(input.length > 0 ? input : '{}')
    if (home.length > 0) {
      payload.settingsText = readTextOrEmpty(join(home, 'settings.yaml'))
      payload.credentialsText = readTextOrEmpty(join(home, '.credentials.yaml'))
    }
    const result = await runSeed(payload)
    if (home.length === 0) {
      process.stdout.write(JSON.stringify(result, null, 2))
      return
    }
    process.exitCode = applyToHome(home, payload, result)
  })
}

main().catch((error) => {
  process.stderr.write('[seed-dsh-model-settings] ' + (error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
})
