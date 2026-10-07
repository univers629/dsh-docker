#!/usr/bin/env node
// DSH 用户实例编排服务（dsh-instances）。
//
// 它是整个部署里**唯一持有 docker.sock 的组件**（见 docs/auth-design.md §3.2 T11）：
//   * 不含任何用户数据、不跑 Agent、不在 Agent 可达的网络里；
//   * 只在 dsh-mgmt 内网上接受 dsh-auth 的调用，且每次调用都要共享令牌；
//   * 只做实例模板相关的事（创建/启停/删除/统计），不接受任意命令或路径参数。
//
// 职责：按模板创建每用户独立 DSH 容器、把数据目录 chown 给该实例身份、空闲回收、
// 按内存水位动态收紧阈值并暂停唤醒。所有判定逻辑在 dsh-instances-policy.mjs 里，
// 本文件只负责 IO 与调度。

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'

import { readJsonFile, writeJsonAtomic } from './dsh-auth-store.mjs'
import {
  DEFAULT_DISK_QUOTA_BYTES,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MEMORY_MB,
  DEFAULT_NODE_HEAP_MB,
  INSTANCE_PORT,
  UID_BASE,
  allocateUid,
  buildContainerSpec,
  checkDiskQuota,
  decideIdle,
  decideWake,
  effectiveIdleTimeout,
  instanceName,
  minInstanceMemoryMb,
  planReclaim,
  watermarkMode,
} from './dsh-instances-policy.mjs'

const execFileAsync = promisify(execFile)

const CONFIG = {
  // 密钥代理与授权表：实例的模型配置要按「该用户被开放的上游」生成
  brokerUrl: (process.env.DSH_BROKER_URL ?? 'http://dsh-key-broker:8080').replace(/\/+$/, ''),
  grantsFile: process.env.DSH_BROKER_GRANTS_FILE ?? '/data/auth/broker-grants.json',
  // 代理的密钥配置：这里只读「上游名与模型清单」两项非秘密事实，用来填 DSH 路由。
  // 真实密钥仍然只在代理容器里。
  brokerKeysFile: process.env.DSH_BROKER_KEYS_FILE ?? '/data/broker/keys.json',
  // 实例令牌的明文存放处：只有编排服务（root）能读，用来注入到实例环境变量
  tokensFile: process.env.DSH_BROKER_TOKENS_FILE ?? '/data/auth/broker-tokens.json',
  // 占位密钥：真实密钥只在代理里，实例侧填这个串即可（与安装器同一常量）。
  placeholderKey: process.env.DSH_BROKER_PLACEHOLDER_KEY ?? 'dsh-broker-placeholder',
  listen: process.env.DSH_INSTANCES_LISTEN ?? '0.0.0.0:8092',
  tokenFile: process.env.DSH_INSTANCES_TOKEN_FILE ?? '/data/auth/instances.token',
  stateFile: process.env.DSH_INSTANCES_STATE ?? '/data/auth/instances.json',
  usersDir: process.env.DSH_USERS_DIR ?? '/data/users',
  image: process.env.DSH_INSTANCE_IMAGE ?? '',
  // 实例网络：这张网络**不再**被所有实例共用。编排服务会为每个实例另建一张专属网络
  // （见 instanceNetworkName），把入口与密钥代理接进去，而不把其它实例接进去。
  // 实测：不同网络之间默认隔离（按 IP 直连也被阻断），而多归属的入口能到达所有实例。
  //
  // 不能改用 enable_icc=false：它会阻断同一网桥上的**所有**容器对，包括入口→实例
  // 这条必需路径（实测：入口也连不上了），结果是全站不可用。
  network: process.env.DSH_INSTANCE_NETWORK ?? 'dsh-instances-net',
  // 需要接入每个实例网络的服务：入口负责把用户请求转到实例，代理负责让实例调用模型，
  // 出站代理（仅隔离模式存在）负责实例的出网。它们的网络成员身份就是「谁能访问实例
  // HTTP 面」的全部答案，因此这里是白名单，而不是「所有容器都能连」。
  // 列出的服务不存在时 connect 会失败——那是正常情况（例如未启用密钥代理），忽略即可。
  reachers: (process.env.DSH_INSTANCE_REACHERS ?? 'dsh-ingress,dsh-key-broker,dsh-egress')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
  // 每实例网络所用的子网基址（/16）。默认取一个不易与常见网段冲突的私有段；
  // 按 uid 槽位切成 /29（每张 8 个地址：网络、网关、6 个容器足够）。
  // 显式指定子网是为了避免 Docker 从默认地址池里整块整块地分配——池只有十几个 /16，
  // 按默认行为建几十张网络就会耗尽。
  subnetBase: process.env.DSH_INSTANCE_SUBNET_BASE ?? '10.213.0.0',
  docker: process.env.DSH_DOCKER ?? 'docker',
  // 自身容器名：用于 inspect 自己的挂载表，把容器内路径映射回宿主路径。
  selfName: process.env.DSH_INSTANCES_SELF_NAME ?? 'dsh-instances',
  // 可选的显式宿主路径，覆盖自动推导（自动推导失败时的兜底）。
  hostUsersDir: process.env.DSH_HOST_USERS_DIR ?? '',
  // 实例数据放在宿主目录（bind，适合 Linux）还是 Docker 卷（volume）。
  // Windows/macOS 的绑定挂载无法表达属主，镜像入口对齐属主时会失败，只能用卷。
  storage: process.env.DSH_INSTANCE_STORAGE === 'volume' ? 'volume' : 'bind',
  // 卷名前缀；bind 模式下也会用到其中的槽位号生成实例名。
  volumePrefix: process.env.DSH_INSTANCE_VOLUME_PREFIX ?? 'dsh-user',
  // docker 命令前缀：以空格分隔，前置到每次调用（例如通过 sudo 调用，或指向包装脚本）。
  // 不含引号解析，只用于简单前缀。
  dockerArgs: (process.env.DSH_DOCKER_ARGS ?? '').split(/\s+/).filter(Boolean),
  baseIdleTimeoutMs: Number(process.env.DSH_IDLE_TIMEOUT_SECONDS ?? 1800) * 1000,
  diskQuotaBytes: Number(process.env.DSH_USER_DISK_QUOTA_BYTES ?? DEFAULT_DISK_QUOTA_BYTES),
  memoryMb: Number(process.env.DSH_INSTANCE_MEMORY_MB ?? DEFAULT_MEMORY_MB),
  // busy 探针：在实例内执行，退出码 0 表示「忙」。未配置时退化为 CPU 采样启发式。
  busyProbe: process.env.DSH_INSTANCES_BUSY_PROBE ?? '',
  busyCpuPercent: Number(process.env.DSH_INSTANCES_BUSY_CPU_PERCENT ?? 5),
  sweepIntervalMs: Number(process.env.DSH_INSTANCES_SWEEP_SECONDS ?? 30) * 1000,
  usageTtlMs: Number(process.env.DSH_INSTANCES_USAGE_TTL_SECONDS ?? 600) * 1000,
  wakeTimeoutMs: Number(process.env.DSH_INSTANCES_WAKE_TIMEOUT_SECONDS ?? 60) * 1000,
  // 实例内 DSH 本体的端口（nginx 在 3080，转发到它）。
  instanceWebPort: Number(process.env.DSH_WEB_PORT ?? 3081),
  // 容器内的 nginx 入口端口。浏览器走的是 入口 → 容器名 → 容器 nginx:3080 → DSH，
  // 而 instanceWebPort 是直连 DSH（3081）。只探 3081 会在容器 nginx 尚未监听时报「就绪」，
  // 于是入口 502、等待页来回跳。
  instanceEntryPort: Number(process.env.DSH_INSTANCE_ENTRY_PORT ?? 3080),
}

/** 磁盘占用缓存：uid → { bytes, at }。避免每次清扫都对大目录跑 du。 */
const usageCache = new Map()

/**
 * 运行时可调设置（管理员面板写入，落盘在注册表里随服务重启恢复）。
 *
 * 这些值在 .env 里也有环境变量默认，但水位与闲置策略是**运维过程中要调**的参数：
 * 改 .env 要重建容器，而管理员在面板上调一个阈值不该付出那个代价。因此优先级是
 * 「注册表里的运行时值 > 环境变量默认」。磁盘配额不在其中：它是按账户的账，不属于全局。
 */
const RUNTIME_DEFAULTS = Object.freeze({
  idleTimeoutSeconds: Math.round(CONFIG.baseIdleTimeoutMs / 1000),
  memoryMb: CONFIG.memoryMb,
})

/** 生效的闲置阈值（毫秒）：运行时值优先。 */
function runtimeIdleTimeoutMs(registry) {
  const seconds = registry?.settings?.idleTimeoutSeconds
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : CONFIG.baseIdleTimeoutMs
}

/** 生效的每实例内存上限（MB）：运行时值优先。 */
function runtimeMemoryMb(registry) {
  const value = registry?.settings?.memoryMb
  return Number.isFinite(value) && value >= 64 ? value : CONFIG.memoryMb
}

/** 校验并归一化管理员提交的运行时设置。 */
function normalizeRuntimeSettings(input, current) {
  const output = { ...current }
  if (input?.idleTimeoutSeconds !== undefined) {
    const seconds = Number(input.idleTimeoutSeconds)
    // 60 秒下限：再短会让用户在等待页与工作台之间反复弹跳
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 7 * 24 * 3600) {
      return { error: 'invalid_idle_timeout' }
    }
    output.idleTimeoutSeconds = seconds
  }
  if (input?.memoryMb !== undefined) {
    const memoryMb = Number(input.memoryMb)
    // 下限必须与容器层的不变式一致（堆上限 < 容器内存），而不是「镜像能启动」的 64MB。
    // 否则接口会接受一个让 buildContainerSpec 抛错的值：保存成功，但之后所有实例创建
    // 都失败（审计实测 64MB → /instances/ensure 500）。
    const floor = minInstanceMemoryMb(nodeHeapMb())
    if (!Number.isInteger(memoryMb) || memoryMb < floor || memoryMb > 4096) {
      return { error: 'invalid_memory', min: floor }
    }
    output.memoryMb = memoryMb
  }
  return { settings: output }
}

/** 生效的 Node 堆上限（与 buildContainerSpec 的默认口径一致）。 */
function nodeHeapMb() {
  const configured = Number(process.env.DSH_INSTANCE_NODE_HEAP_MB)
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_NODE_HEAP_MB
}

// ---------------------------------------------------------------- 每实例网络
//
// 租户隔离不能依赖「共用一张网桥 + 相信对端」：实例内 nginx 在 password 模式下不做
// 认证，插件控制面又把「对端是 127.0.0.1」当作可信（经对端 nginx 反代后该条件恰好
// 成立）。审计实测：bob 的容器可以 GET/PUT alice 的 /dsh-docker-control/config。
//
// 因此每个实例独占一张网络，只把「确实需要访问实例 HTTP 面」的服务接进去
// （入口与密钥代理），其余实例一律不在其中。实测确认：不同网络之间默认隔离
// （连按 IP 直连也被阻断），而多归属的入口能同时到达所有实例。
//
// 显式指定 /29 子网：Docker 默认地址池只有十几个 /16，按默认行为每建一张网络就吃掉
// 一整块，几十个实例就会耗尽地址池。按 uid 槽位切 /29 可以支撑上千个实例。

/** 某实例的专属网络名。 */
function instanceNetworkName(uid) {
  return `${CONFIG.network}-u${uid - UID_BASE + 1}`
}

/**
 * 某实例网络的 /29 子网。
 *
 * 槽位从 1 开始，每个槽位占 8 个地址；第三段按 32 个槽位进位，保证 subnetBase 的
 * /16 内不重叠。uid 槽位本身由 UID_BASE 起递增，因此不会撞车。
 * @param {number} uid 用户 uid。
 * @returns {string} CIDR。
 */
function instanceSubnet(uid) {
  const slot = uid - UID_BASE + 1
  const [a, b] = CONFIG.subnetBase.split('.').map((part) => Number(part))
  const third = Math.floor((slot * 8) / 256)
  const fourth = (slot * 8) % 256
  return `${a}.${b}.${third}.${fourth}/29`
}

/**
 * 确保实例网络存在，并把需要访问实例的服务接进去。
 *
 * 幂等：网络已存在时不重复创建；服务已接入时 docker network connect 会报错，按成功处理。
 * @param {number} uid 用户 uid。
 * @returns {Promise<string>} 网络名。
 */
async function ensureInstanceNetwork(uid) {
  const name = instanceNetworkName(uid)
  const existing = await docker(['network', 'inspect', name, '--format', '{{.Name}}'], { allowFailure: true })
  if (!existing.ok) {
    await docker(['network', 'create', '--subnet', instanceSubnet(uid), name])
  }
  await attachReachers(name)
  return name
}

/**
 * 把需要访问实例 HTTP 面的服务接入该网络。
 *
 * 单独成函数是因为「容器被外部重建」会丢掉动态接入的网络成员关系，而登录路径上的
 * ensure 需要能把它补回来。服务不存在（例如未启用密钥代理）时 connect 失败，忽略。
 * @param {string} network 实例网络名。
 * @returns {Promise<void>}
 */
async function attachReachers(network) {
  for (const reacher of CONFIG.reachers) {
    await docker(['network', 'connect', network, reacher], { allowFailure: true })
  }
}

/**
 * 删除实例的专属网络（实例删除时调用）。
 *
 * 必须先断开入口与代理：Docker 拒绝删除仍有活动端点的网络，而这两个服务被接在每个
 * 实例网络上（它们需要能到达实例）。不先断开的话 rm 会失败，网络与它占用的 /29 子网
 * 就都留在那里——实测遗漏过两张。
 * @param {number} uid 用户 uid。
 * @returns {Promise<void>}
 */
async function removeInstanceNetwork(uid) {
  const name = instanceNetworkName(uid)
  for (const reacher of CONFIG.reachers) {
    await docker(['network', 'disconnect', '-f', name, reacher], { allowFailure: true })
  }
  await docker(['network', 'rm', name], { allowFailure: true })
}

/** 实例注册表：uid → 记录。落盘以保证重启后仍能回收旧实例。 */function loadRegistry() {
  const state = readJsonFile(CONFIG.stateFile, { version: 1, instances: {} })
  return state?.instances ? state : { version: 1, instances: {} }
}

function saveRegistry(registry) {
  writeJsonAtomic(CONFIG.stateFile, registry)
}

/**
 * 注册表的写操作串行化。
 *
 * 原实现是「读快照 → 改 → 整份写回」，而 handler 会跨 await 持有快照（实例创建要等
 * docker run 数秒），于是并发时后写者把先写者静默覆盖——审计实测：管理员保存的运行时
 * 设置（闲置阈值、每实例内存）在并发创建实例时被回退，两次请求都返回 200 但最终值仍是旧的。
 * 认证网关早先修过同一类缺陷（修订号 CAS），这里用更贴合本服务的方式：把全部变更收敛到
 * 单一 promise 链，并在**临界区内重新读盘**，因此不会再写过期快照。
 *
 * 链上某次失败不应中断后续变更：调用者各自拿到自己的异常。
 * @param {(registry: object) => (any|Promise<any>)} mutator 在临界区内修改注册表。
 * @returns {Promise<any>} mutator 的返回值。
 */
function mutateRegistry(mutator) {
  const run = registryChain.then(async () => {
    const registry = loadRegistry()
    const result = await mutator(registry)
    saveRegistry(registry)
    return result
  })
  registryChain = run.then(() => undefined, () => undefined)
  return run
}

let registryChain = Promise.resolve()

let cachedToken = ''

/**
 * 读取调用方令牌。令牌由 dsh-auth 创建（它以 uid 1000 运行并写出 0600 文件，root 读得到；
 * 反过来 root 写 0600 则 uid 1000 读不到），因此这里必须容忍「还没创建好」：
 * 不缓存失败，也不因此退出——退出只会变成重启循环，运维看到的是反复重启而不是明确原因。
 * @returns {string} 令牌；不可用时返回空串。
 */
function loadToken() {
  if (cachedToken) return cachedToken
  try {
    const token = fs.readFileSync(CONFIG.tokenFile, 'utf8').trim()
    if (token.length >= 32) cachedToken = token
  } catch {
    /* 尚未创建 */
  }
  return cachedToken
}

async function docker(args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync(CONFIG.docker, [...CONFIG.dockerArgs, ...args], { timeout: 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return { ok: true, stdout: stdout.trim() }
  } catch (error) {
    if (allowFailure) return { ok: false, stdout: '', error: String(error?.stderr ?? error?.message ?? error) }
    throw new Error(`docker ${args[0]} failed: ${error?.stderr ?? error?.message ?? error}`)
  }
}

let hostUsersDirCache = ''

/**
 * 数据目录的**宿主**路径。
 *
 * `-v` 的 source 由 Docker 守护进程在宿主上解析，而本服务看到的是容器内路径
 * （/data/users）。直接把自己看到的路径传下去，守护进程会在宿主上找不到它，于是
 * docker run 失败。这里通过 inspect 自己的挂载表把容器内路径映射回宿主路径，因此
 * 常规部署无需额外配置；映射不到时回退到显式配置的 DSH_HOST_USERS_DIR。
 * @returns {Promise<string>} 宿主侧的数据目录前缀。
 */
async function hostUsersDir() {
  if (hostUsersDirCache) return hostUsersDirCache
  if (CONFIG.hostUsersDir) {
    hostUsersDirCache = CONFIG.hostUsersDir
    return hostUsersDirCache
  }
  const inspected = await docker(['inspect', CONFIG.selfName, '--format', '{{json .Mounts}}'], { allowFailure: true })
  if (inspected.ok && inspected.stdout) {
    try {
      const mounts = JSON.parse(inspected.stdout)
      // 取最长的匹配目标，避免 /data 覆盖 /data/users 这类前缀歧义
      const match = mounts
        .filter((mount) => mount.Destination && CONFIG.usersDir.startsWith(mount.Destination))
        .sort((a, b) => b.Destination.length - a.Destination.length)[0]
      if (match?.Source) {
        // 宿主路径一律归一化为正斜杠：Windows 上宿主路径是反斜杠，与后面的 posix 拼接
        // 会得到混合分隔符（C:\a\b/c/d），Docker 与各处路径处理都难以预期。
        const source = match.Source.replace(/\\/g, '/')
        const relative = path.posix.relative(match.Destination, CONFIG.usersDir)
        hostUsersDirCache = relative ? path.posix.join(source, relative) : source
        process.stdout.write(`[dsh-instances] host data dir resolved to ${hostUsersDirCache}\n`)
        return hostUsersDirCache
      }
    } catch (error) {
      process.stderr.write(`[dsh-instances] cannot parse own mounts: ${error?.message ?? error}\n`)
    }
  }
  throw new Error(
    `cannot resolve the host path of ${CONFIG.usersDir}; set DSH_HOST_USERS_DIR to the absolute host directory ` +
    `mounted at ${CONFIG.usersDir}, or set DSH_INSTANCES_SELF_NAME so this service can inspect its own mounts`,
  )
}

// ---------------------------------------------------------------- 实例操作

/** 查询容器状态：'running' | 'exited' | 'missing'。 */
async function containerStatus(name) {
  const result = await docker(['inspect', '--format', '{{.State.Status}}', name], { allowFailure: true })
  if (!result.ok) return 'missing'
  return result.stdout || 'missing'
}

/**
 * 查询容器所在的第一个网络；容器不存在或查询失败返回空串。
 *
 * 只用于"实例是否挂在配置的专用网络上"这一判定：网络名来自编排服务自己的环境
 * （CONFIG.network），探测失败按"不匹配"处理会让实例被重建一次——数据在卷/绑定
 * 目录里不受影响，代价可接受；按"匹配"处理则永远无法收敛。
 */
async function containerNetwork(name) {
  const result = await docker(
    ['inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}', name],
    { allowFailure: true },
  )
  if (!result.ok) return ''
  return result.stdout.trim().split(/\s+/)[0] ?? ''
}

/**
 * 准备实例数据目录（仅 bind 模式）。模型配置直接生成在实例的 DSH home 内，只做目录级挂载。
 *
 * 属主不在编排侧修复：编排服务以 root 跑在主容器里，但宿主上的数据树属主统一由容器内
 * 的特权代理负责（bin/dsh-privileged-helper.mjs 的 fix-perms 动作，目标集见
 * bin/dsh-privileged-policy.mjs 的 FIX_PERMS_TARGETS）。两处各自 chown 会在目标集或
 * 时机不一致时留下双方都不管的目录，因此这里只建目录，属主交给唯一的权威路径。
 *
 * @param {number} uid 实例槽位号。
 * @returns {Promise<string>} 该实例数据目录的宿主路径（供 -v 使用）。
 */
async function prepareDataDir(uid) {
  const dir = path.posix.join(await hostUsersDir(), String(uid))
  const localDir = path.join(CONFIG.usersDir, String(uid))
  for (const sub of ['home', 'workspace']) {
    fs.mkdirSync(path.join(localDir, sub), { recursive: true, mode: 0o750 })
  }
  // 模型配置不在这里手写：交给 bin/seed-dsh-model-settings.mjs。那份脚本会用 DSH
  // 自己导出的 schema 校验结果、并按 YAML 节点合并以保留用户已有配置与注释。
  // 手写字符串拼接会把用户配置和注释一起毁掉，写坏一个字段还会让 DSH 拒绝整个
  // llm-pi-ai namespace（所有供应商一起消失）。
  return dir
}

/**
 * 读取密钥代理配置里每个上游的模型清单。
 *
 * 代理的配置由 key-admin 管理（keys.json 的 upstreams[].models）。这里只读它来
 * 填 DSH 侧的路由：seeder 要求非内置目录的上游必须显式列出模型，否则整条上游会被跳过。
 *
 * @returns {Record<string, string[]>} 上游名 → 模型 id 数组。
 */
function readUpstreamModels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG.brokerKeysFile, 'utf8'))
    const map = {}
    for (const entry of parsed?.upstreams ?? []) {
      if (typeof entry?.name !== 'string') continue
      map[entry.name.toLowerCase()] = (Array.isArray(entry.models) ? entry.models : [])
        .map((model) => (typeof model === 'string' ? model : model?.id))
        .filter((id) => typeof id === 'string' && id.length > 0)
    }
    return map
  } catch {
    // 读不到就返回空：seeder 会跳过这些上游并在 stderr 说明原因，不影响登录
    return {}
  }
}

/** 读取「uid → 被开放的上游」授权表；文件缺失或损坏时返回空表。 */
function readGrants() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG.grantsFile, 'utf8'))
    return parsed && typeof parsed.users === 'object' && parsed.users !== null ? parsed.users : {}
  } catch {
    // 授权表还没生成（例如全新部署、dsh-auth 尚未启动）时按「没有授权」处理。
    // 这不是放行：实例拿到空 providers，模型用不了，但用户仍能登录与干活。
    return {}
  }
}

/** 读取「用户 id → 实例令牌明文」，用于注入实例环境变量。 */
function readTokens() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG.tokensFile, 'utf8'))
    return parsed && typeof parsed.tokens === 'object' && parsed.tokens !== null ? parsed.tokens : {}
  } catch {
    return {}
  }
}

/**
 * 创建并启动实例。
 *
 * 不持有注册表：内存上限由调用方在临界区内读好后传入（见 mutateRegistry），
 * 返回待落盘的记录。这样 docker run 的数秒等待不会让任何快照过期。
 * @param {number} memoryMb 容器内存上限（已在临界区内取值）。
 * @param {number} uid 用户 uid。
 * @param {string} username 用户名。
 * @returns {Promise<object>} 待写入注册表的实例记录。
 */
async function createInstance(memoryMb, uid, username) {
  if (!CONFIG.image) throw new Error('DSH_INSTANCE_IMAGE is required to create instances')
  const name = instanceName(uid)
  const volumeBase = `${CONFIG.volumePrefix}-${uid}`
  // 该用户被开放的上游 + 本实例的代理令牌。
  // 授权表由 dsh-auth 写；令牌明文只在这里读到（代理侧只有摘要）。
  const grant = readGrants()[String(uid)]
  const upstreams = Array.isArray(grant?.upstreams) ? grant.upstreams : []
  const token = readTokens()[username] ?? ''

  // bind 模式：宿主目录由我们准备；volume 模式由 Docker 创建卷。
  const dataDir = CONFIG.storage === 'bind' ? await prepareDataDir(uid) : ''
  // 每实例专属网络：只有入口与密钥代理会被接进来，其它实例不在其中。
  const network = await ensureInstanceNetwork(uid)
  const args = buildContainerSpec({
    name,
    uid,
    image: CONFIG.image,
    network,
    // bind 的挂载点必须用宿主路径：Docker 守护进程在宿主上解析 -v 的 source。
    ...(CONFIG.storage === 'bind' ? { dataDir } : { storage: 'volume', volumeBase }),
    memoryMb,
    // 令牌注入环境变量：seed 脚本据此把 x-dsh-instance-token 写进 provider 头，
    // 代理按它识别调用者并只放行被开放的上游。
    brokerToken: token,
  })
  await docker(['run', '-d', ...args])

  // 模型配置：只为该账户被开放的上游生成 provider，并带上实例令牌头。
  // 交给 seed 脚本（保留用户已有配置与注释，并用 DSH 自己的 schema 校验）。
  await seedModelSettings(name, uid, upstreams, token, readUpstreamModels())
  // 注意：这里**不写注册表**。容器创建要等 docker run，若在期间持有注册表快照再整份
  // 写回，就会覆盖同时发生的其它变更（审计实测：管理员保存的运行时设置被回退）。
  // 改为返回记录，由调用方在串行化的临界区内落盘。
  return {
    uid,
    username,
    name,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    // bind 模式记宿主路径（删除时按它清理）；volume 模式不记路径，删除时按卷名清理。
    dataDir: CONFIG.storage === 'bind' ? dataDir : '',
    storage: CONFIG.storage,
  }
}

/**
 * 为实例写入模型配置。
 *
 * 在容器内执行 seed 脚本：两种存储模式（bind 宿主目录 / volume 卷）都能写，
 * 且不必让编排服务知道 DSH_HOME 在宿主上的绝对路径。
 *
 * 失败不让实例创建失败：用户仍能登录，只是模型配置需要他自己在设置里填。
 *
 * @param {string} name 容器名。
 * @param {number} uid 实例槽位。
 * @param {string[]} upstreams 该账户被开放的上游名。
 * @param {string} token 该实例的代理令牌。
 * @returns {Promise<void>} 完成。
 */
async function seedModelSettings(name, uid, upstreams, token, models = {}) {
  // 空清单也要跑一次：seeder 会把不再被授权的 provider 路由删掉（见它的
  // removedProviders 处理）。早先在这里提前 return，结果是管理员取消勾选后
  // settings.yaml 里那条路由还在，撤销授权不生效。
  const payload = JSON.stringify({
    brokerBase: CONFIG.brokerUrl,
    placeholder: CONFIG.placeholderKey,
    // shape 用 broker 侧那套词汇（any/chat/responses/messages）：'any' 表示
    // 「不显式收窄形态」，自定义路由会落到 openai-completions——这正是代理的默认。
    // 不用我自己猜的 'openai'（那不在合法取值里，会被 seeder 拒绝并跳过）。
    // 模型清单来自代理配置：seeder 要求非内置目录的上游必须显式列出模型，
    // 否则整条上游会被跳过（现象是「授权了却一个模型都没有」）。
    upstreams: upstreams.map((upstream) => ({
      name: upstream,
      shape: 'any',
      models: models[upstream.toLowerCase()] ?? [],
    })),
    // 每个 provider 都带上实例令牌：代理据此识别调用者并只放行被开放的上游
    extraHeaders: { 'x-dsh-instance-token': token },
  })
  // 用 base64 传载荷：JSON 里可能含引号与反斜杠，走 shell 字符串容易被解释坏。
  const encoded = Buffer.from(payload, 'utf8').toString('base64')
  // 必须以容器内的 dsh 身份执行：DSH 以该身份运行，读不到 root 属主的
  // settings.yaml / .credentials.yaml 会直接启动失败（credentials 与 hmr 插件报 EACCES）。
  // 末尾再把属主对齐一次：容器内可能已存在 root 属主的旧文件。
  const script = [
    `printf %s '${encoded}' | base64 -d | su dsh -s /bin/sh -c 'node /usr/local/lib/dsh/seed-dsh-model-settings.mjs --home /data/dsh'`,
    'chown dsh:dsh /data/dsh/settings.yaml /data/dsh/.credentials.yaml 2>/dev/null || true',
  ].join(' && ')
  const result = await docker(['exec', name, 'sh', '-c', script], { allowFailure: true })
  if (!result.ok) {
    process.stderr.write(`[dsh-instances] cannot seed model settings for ${name} (uid ${uid}): ${result.stderr ?? ''}${result.stdout ?? ''}\n`)
  }
}

async function startInstance(name) {
  await docker(['start', name])
}

async function stopInstance(name) {
  await docker(['stop', '--time', '10', name], { allowFailure: true })
}

async function removeInstance(name) {
  await docker(['rm', '-f', name], { allowFailure: true })
}

/**
 * busy 探针：判断实例内是否有正在进行的工作，决定能否停用。
 *
 * 优先级：显式探针命令（约定打印 busy/idle）→ CPU 采样启发式。任何无法得出结论的
 * 情况（命令失败、输出无法解析）一律按「忙」处理：宁可多占内存，也不中断正在跑的任务。
 * @param {string} name 实例名。
 * @returns {Promise<boolean>} 是否处于忙碌状态。
 */
async function probeBusy(name) {
  if (CONFIG.busyProbe) {
    const result = await docker(['exec', name, 'sh', '-c', CONFIG.busyProbe], { allowFailure: true })
    if (!result.ok) return true
    const verdict = result.stdout.trim().toLowerCase()
    if (verdict === 'busy') return true
    if (verdict === 'idle') return false
    return true
  }
  const result = await docker(['stats', '--no-stream', '--format', '{{.CPUPerc}}', name], { allowFailure: true })
  if (!result.ok) return true
  const percent = Number.parseFloat(result.stdout.replace('%', ''))
  if (!Number.isFinite(percent)) return true
  return percent > CONFIG.busyCpuPercent
}

/**
 * 磁盘占用（字节）。`du` 递归扫描代价高，所以按 uid 缓存，最多每
 * DSH_INSTANCES_USAGE_TTL_SECONDS 秒重算一次；扫描失败按 0 处理（不误报超限）。
 * @param {number} uid 实例 UID。
 * @returns {Promise<number>} 占用字节数。
 */
async function diskUsageBytes(uid) {
  const dir = path.join(CONFIG.usersDir, String(uid))
  const cached = usageCache.get(uid)
  const at = Date.now()
  if (cached && at - cached.at < CONFIG.usageTtlMs) return cached.bytes
  let bytes = 0
  try {
    const { stdout } = await execFileAsync('du', ['-sb', dir], { timeout: 30_000, windowsHide: true })
    const parsed = Number.parseInt(stdout.split(/\s+/)[0], 10)
    if (Number.isFinite(parsed)) bytes = parsed
  } catch {
    bytes = cached?.bytes ?? 0
  }
  usageCache.set(uid, { bytes, at })
  return bytes
}

/**
 * 实例是否已能服务：必须探到**实例内的 DSH 本体**，而不是 nginx。
 *
 * 实例的 nginx /healthz 是无条件 204，nginx 一起来就会通过；此时 DSH 还没监听 3081，
 * 任何真实请求都会被 nginx 以 502 拒绝。早先只探 nginx，导致登录后立刻跳转、用户撞上
 * 原始 502（手动刷新时 DSH 已就绪，于是看起来「刷新一下就好」）。
 * @param {string} name 实例名。
 * @returns {Promise<boolean>} DSH 已能响应时返回 true。
 */
async function probeReady(name) {
  // 探容器的入口端口：这样 nginx 未监听（连接被拒）与 DSH 未就绪（5xx）都会判为未就绪，
  // 与入口侧看到的成败一致。
  const probe = "fetch('http://127.0.0.1:" + CONFIG.instanceEntryPort + "/').then(r=>process.exit(r.status>=500?1:0)).catch(()=>process.exit(1))"
  const result = await docker(['exec', name, 'node', '-e', probe], { allowFailure: true })
  return result.ok
}

/**
 * 等待实例可服务。登录流程不等待（会撞代理超时），因此该函数只服务于内部运维路径。
 * @param {string} name 实例名。
 * @returns {Promise<boolean>} 在超时前就绪返回 true。
 */
async function waitReady(name) {
  const deadline = Date.now() + CONFIG.wakeTimeoutMs
  while (Date.now() < deadline) {
    if (await probeReady(name)) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

/** 观测所有实例（状态 + busy + 最近活动）。 */
async function observe(registry) {
  const out = []
  for (const record of Object.values(registry.instances)) {
    const status = await containerStatus(record.name)
    const running = status === 'running'
    out.push({
      uid: record.uid,
      username: record.username,
      name: record.name,
      status,
      running,
      busy: running ? await probeBusy(record.name) : false,
      lastSeenAt: record.lastSeenAt ?? 0,
      // 固化标记要透出去：管理面板据此显示与切换，回收策略据此豁免。
      pinned: record.pinned === true,
    })
  }
  return out
}

function hostAvailableBytes() {
  try {
    // Linux 容器内 /proc/meminfo 给的是宿主口径（cgroup v1）或容器口径（v2）；
    // 这里只需要数量级用于水位，取 MemAvailable 即可。
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const match = /MemAvailable:\s+(\d+) kB/.exec(text)
    if (match) return Number(match[1]) * 1024
  } catch {
    /* 非 Linux 宿主（本地测试）走下面的兜底 */
  }
  return Number(process.env.DSH_INSTANCES_FAKE_AVAILABLE_BYTES ?? 4 * 1024 ** 3)
}

let watermark = 'normal'
let lastSweepAt = 0

/** 观测当前水位与生效阈值，不产生副作用（只读接口用这个）。 */
async function assess(registry) {
  const instances = await observe(registry)
  const onlineCount = instances.filter((i) => i.running).length
  const mode = watermarkMode({
    onlineCount,
    perInstanceMb: runtimeMemoryMb(registry),
    availableBytes: hostAvailableBytes(),
    previous: watermark,
  })
  return { instances, onlineCount, mode, idleTimeoutMs: effectiveIdleTimeout(mode, runtimeIdleTimeoutMs(registry)) }
}

/** 一次清扫：算水位 → 更新模式 → 回收空闲实例。 */
async function sweep(registry) {
  const { instances, onlineCount, mode, idleTimeoutMs } = await assess(registry)
  watermark = mode
  const now = Date.now()
  // 紧急模式一次只回收少量实例，避免同一时刻集中 stop 造成负载尖峰
  const reclaim = planReclaim({ instances, now, idleTimeoutMs, limit: mode === 'emergency' ? 3 : Number.MAX_SAFE_INTEGER })
  for (const name of reclaim) {
    await stopInstance(name)
    process.stdout.write(`[dsh-instances] idle stop ${name} (mode=${watermark})\n`)
  }
  // 修复 reacher 的成员关系。
  //
  // 入口与代理是**动态接入**每个实例网络的，而 docker compose 重建容器时只会恢复
  // compose 文件里声明的网络，动态接入的那些会丢失（实测：重建 ingress 后它不再在
  // 任何 dsh-instances-net-u* 上，用户请求直接 502）。ensure 也会补，但它只在有登录
  // 或唤醒时发生——若重建后没人登录，故障就一直挂着。因此放进周期清扫：它总是会跑，
  // 且 attachReachers 幂等，重复调用无害。
  for (const instance of instances) {
    if (!instance.running) continue
    await attachReachers(instanceNetworkName(instance.uid))
  }
  lastSweepAt = now
  return { instances, onlineCount, idleTimeoutMs, reclaimed: reclaim }
}

// ---------------------------------------------------------------- HTTP

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' })
  res.end(payload)
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** 恒时比较请求里的 Bearer 令牌。返回 'ok' | 'denied' | 'unprovisioned'。 */
function authorize(req) {
  const token = loadToken()
  if (!token) return 'unprovisioned'
  const header = req.headers.authorization
  if (typeof header !== 'string') return 'denied'
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (provided.length !== token.length) return 'denied'
  let diff = 0
  for (let i = 0; i < token.length; i++) diff |= provided.charCodeAt(i) ^ token.charCodeAt(i)
  return diff === 0 ? 'ok' : 'denied'
}

const server = http.createServer(async (req, res) => {
  // 与 dsh-auth 相同的防护：畸形请求目标解析必须在 try 之内，否则 async 监听器里
  // 的 ERR_INVALID_URL 会成为 unhandled rejection 并终止进程。
  let url
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    res.writeHead(400, { 'content-length': '0', connection: 'close' })
    return res.end()
  }
  const p = url.pathname
  try {
    if (req.method === 'GET' && p === '/healthz') {
      res.writeHead(204, { 'content-length': '0' })
      return res.end()
    }
    const authResult = authorize(req)
    if (authResult === 'unprovisioned') {
      // 令牌尚未由 dsh-auth 创建：明确区分于「凭据不对」，否则运维会一直排查令牌值
      return sendJson(res, 503, { ok: false, code: 'token_unprovisioned' })
    }
    if (authResult !== 'ok') return sendJson(res, 401, { ok: false, code: 'unauthorized' })

    const registry = loadRegistry()
    if (req.method === 'GET' && p === '/status') {
      // 只读：观测水位与用量，不触发回收（回收只发生在周期清扫与显式 stop 上）
      const { instances, onlineCount, mode, idleTimeoutMs } = await assess(registry)
      const withQuota = []
      for (const instance of instances) {
        const used = await diskUsageBytes(instance.uid)
        withQuota.push({ ...instance, usedBytes: used, quota: checkDiskQuota(used, CONFIG.diskQuotaBytes) })
      }
      return sendJson(res, 200, {
        ok: true,
        watermark: mode,
        onlineCount,
        idleTimeoutMs,
        lastSweepAt,
        memoryMbPerInstance: runtimeMemoryMb(registry),
        // 运行时设置与出厂默认一起回给面板：面板要显示「当前值」与「默认值」，
        // 并标出哪些已被改过（改过的可以一键恢复默认）。
        settings: {
          idleTimeoutSeconds: Math.round(runtimeIdleTimeoutMs(registry) / 1000),
          memoryMb: runtimeMemoryMb(registry),
        },
        defaults: { ...RUNTIME_DEFAULTS },
        instances: withQuota,
      })
    }
    // 运行时设置的写入端：管理员面板改闲置阈值与每实例内存。
    // 只写注册表、不动 docker：新值在下一次创建实例时生效，已运行的实例保持原样
    // （Docker 不允许改运行中容器的 --memory）。
    if (req.method === 'POST' && p === '/settings') {
      const body = await readBody(req)
      // 校验与落盘都在临界区内：否则并发写会把这一次的设置静默回退。
      let applied = null
      let invalid = ''
      await mutateRegistry((current) => {
        const normalized = normalizeRuntimeSettings(body, current.settings ?? {})
        if (normalized.error) {
          invalid = normalized.error
          return
        }
        current.settings = normalized.settings
        applied = { ...normalized.settings }
      })
      if (invalid) return sendJson(res, 400, { ok: false, code: invalid })
      process.stdout.write(`[dsh-instances] runtime settings updated: ${JSON.stringify(applied)}\n`)
      return sendJson(res, 200, { ok: true, settings: applied, defaults: { ...RUNTIME_DEFAULTS } })
    }
    // 固化 / 取消固化：把某个容器标记为永久保留，回收策略从此跳过它。
    if (req.method === 'POST' && p === '/instances/pin') {
      const body = await readBody(req)
      const uid = Number(body?.uid)
      let outcome = null
      await mutateRegistry((current) => {
        const target = current.instances[uid]
        if (!target) return
        target.pinned = body?.pinned === true
        outcome = { name: target.name, pinned: target.pinned }
      })
      if (!outcome) return sendJson(res, 404, { ok: false, code: 'not_found' })
      process.stdout.write(`[dsh-instances] instance ${outcome.name} pinned=${outcome.pinned}\n`)
      return sendJson(res, 200, { ok: true, uid, pinned: outcome.pinned })
    }
    if (req.method === 'GET' && p === '/instances') {
      const instances = await observe(registry)
      return sendJson(res, 200, { ok: true, instances })
    }
    if (req.method === 'POST' && p === '/instances/ensure') {
      const body = await readBody(req)
      const uid = Number(body?.uid)
      const username = typeof body?.username === 'string' ? body.username : ''
      if (!Number.isInteger(uid) || uid < UID_BASE) return sendJson(res, 400, { ok: false, code: 'invalid_uid' })
      const decision = decideWake(watermark, 0)
      if (!decision.allow) return sendJson(res, 503, { ok: false, code: 'busy_system', mode: watermark })
      // 全部注册表变更都在串行化的临界区内完成。容器创建（docker run）耗时数秒，
      // 但它**不再持有快照跨 await**：记录在创建成功后才由本次临界区写回，
      // 因此不会覆盖同时发生的设置变更。
      const outcome = await mutateRegistry(async (current) => {
        const existing = current.instances[uid]
        const status = existing ? await containerStatus(existing.name) : 'missing'
        if (!existing || status === 'missing') {
          const record = await createInstance(runtimeMemoryMb(current), uid, username)
          current.instances[uid] = record
          // 立即返回：容器启动需数秒到数十秒，调用方通过 /instances/state 轮询就绪状态。
          return { name: record.name, status: 'created' }
        }
        // 网络收敛：实例必须挂在自己的专属网络上（旧版本创建在共享网络上，那会让
        // 任一用户容器读写其它租户的 DSH 配置）。期望网络是权威，不匹配就移除重建——
        // 数据在卷或绑定目录里，重建只影响容器进程本身。
        //
        // 同时修复「容器被外部重建后丢掉网络」的情况：docker run 时指定的网络会保留，
        // 但动态接入的网络在重建后丢失。ensure 是登录路径上必经的一步，因此这里顺带
        // 重新接入需要访问实例的服务（幂等），使成员关系总能自愈。
        const expected = instanceNetworkName(uid)
        const network = await containerNetwork(existing.name)
        if (network !== expected) {
          process.stdout.write(`[dsh-instances] rebuilding ${existing.name} to attach network ${expected} (was '${network || 'unknown'}')\n`)
          await removeInstance(existing.name)
          const record = await createInstance(runtimeMemoryMb(current), uid, username)
          current.instances[uid] = record
          return { name: record.name, status: 'recreated' }
        }
        // 网络名对上了，但成员关系可能因外部重建而缺失：补回入口/代理的接入。
        await attachReachers(expected)
        if (status !== 'running') {
          await startInstance(existing.name)
          existing.lastSeenAt = Date.now()
          return { name: existing.name, status: 'started' }
        }
        existing.lastSeenAt = Date.now()
        return { name: existing.name, status: 'running' }
      })
      return sendJson(res, 200, {
        ok: true,
        name: outcome.name,
        status: outcome.status,
        url: `http://${outcome.name}:${INSTANCE_PORT}`,
      })
    }
    // 按当前授权表重写实例的模型配置。
    //
    // 为什么需要它：seedModelSettings 只在 createInstance 里调用一次，而授权表会
    // 在实例创建之后变化（管理员在「模型开放」里改勾选）。实例创建时若授权表还是
    // 空的（全新部署：keys.json 里还没有上游，「默认全部开放」展开为空数组），
    // seedModelSettings 会直接 return —— 之后管理员补了密钥、又保存了授权，
    // 实例里始终没有 settings.yaml，用户看到的模型页一张卡片都没有。
    //
    // 不动容器：只重写 /data/dsh 下的两份配置文件，DSH 对它们是热加载的。
    if (req.method === 'POST' && p === '/instances/reseed') {
      const body = await readBody(req)
      const uid = Number(body?.uid)
      if (!Number.isInteger(uid) || uid < UID_BASE) return sendJson(res, 400, { ok: false, code: 'invalid_uid' })
      const record = registry.instances[uid]
      if (!record) return sendJson(res, 404, { ok: false, code: 'not_found' })
      const grant = readGrants()[String(uid)]
      const upstreams = Array.isArray(grant?.upstreams) ? grant.upstreams : []
      const token = readTokens()[record.username] ?? ''
      await seedModelSettings(record.name, uid, upstreams, token, readUpstreamModels())
      process.stdout.write(`[dsh-instances] reseeded ${record.name} with ${upstreams.length} upstream(s)\n`)
      return sendJson(res, 200, { ok: true, uid, upstreams })
    }
    if (req.method === 'GET' && p === '/instances/state') {
      const uid = Number(url.searchParams.get('uid'))
      const record = registry.instances[uid]
      if (!record) return sendJson(res, 404, { ok: false, code: 'not_found' })
      const status = await containerStatus(record.name)
      if (status !== 'running') {
        return sendJson(res, 200, { ok: true, uid, name: record.name, status, running: false, ready: false })
      }
      const ready = await probeReady(record.name)
      return sendJson(res, 200, { ok: true, uid, name: record.name, status, running: true, ready })
    }
    if (req.method === 'POST' && p === '/instances/touch') {
      const body = await readBody(req)
      const uid = Number(body?.uid)
      const touched = await mutateRegistry((current) => {
        const target = current.instances[uid]
        if (!target) return false
        target.lastSeenAt = Date.now()
        return true
      })
      if (!touched) return sendJson(res, 404, { ok: false, code: 'not_found' })
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && p === '/instances/stop') {
      const body = await readBody(req)
      const uid = Number(body?.uid)
      if (!registry.instances[uid]) return sendJson(res, 404, { ok: false, code: 'not_found' })
      await stopInstance(registry.instances[uid].name)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && p === '/instances/delete') {
      const body = await readBody(req)
      const uid = Number(body?.uid)
      const record = registry.instances[uid]
      if (!record) return sendJson(res, 404, { ok: false, code: 'not_found' })
      await removeInstance(record.name)
      const purge = body?.purge === true
      // 数据是否**确认**删除，决定调用方能否安全复用该 uid。
      // 审计发现：卷删除用了 allowFailure、bind 删除只写日志，两者失败时仍回 purged:true，
      // 调用方据此认为「数据已清理」而不记 uid 墓碑，于是下一个注册者继承上一个租户的
      // 遗留卷/目录。因此这里必须如实上报，失败时 purged 为 false。
      let purged = !purge
      if (purge) {
        purged = true
        if (CONFIG.storage === 'bind') {
          try {
            fs.rmSync(path.join(CONFIG.usersDir, String(uid)), { recursive: true, force: true })
          } catch (error) {
            purged = false
            process.stderr.write(`[dsh-instances] purge ${uid} failed: ${error?.message ?? error}\n`)
          }
        }
        // volume 模式连卷一起删：只删容器会留下一份谁也看不到的孤儿数据。
        // 这里刻意不用 allowFailure：删除失败必须影响 purged 的取值。
        try {
          await docker(['volume', 'rm', '-f', `${CONFIG.volumePrefix}-${uid}-home`, `${CONFIG.volumePrefix}-${uid}-workspace`])
        } catch (error) {
          purged = false
          process.stderr.write(`[dsh-instances] purge volumes for ${uid} failed: ${error?.message ?? error}\n`)
        }
      }
      await mutateRegistry((current) => {
        delete current.instances[uid]
      })
      // 实例的专属网络随实例一起删除，否则会留下无人使用的网络（Docker 地址池有限）。
      await removeInstanceNetwork(uid)
      return sendJson(res, 200, { ok: true, purged, purgeRequested: purge })
    }
    return sendJson(res, 404, { ok: false, code: 'not_found' })
  } catch (error) {
    process.stderr.write(`[dsh-instances] request failed: ${error?.message ?? error}\n`)
    if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal_error' })
    else res.end()
  }
})

const [host, port] = CONFIG.listen.includes(':') ? CONFIG.listen.split(':') : ['0.0.0.0', CONFIG.listen]

server.listen(Number(port), host, () => {
  const registry = loadRegistry()
  process.stdout.write(`[dsh-instances] listening on ${host}:${port} (instances=${Object.keys(registry.instances).length}, image=${CONFIG.image || 'unset'})\n`)
  // 启动时立刻修补一次 reacher 成员关系，不等第一个清扫周期。
  // compose up 会重建入口/代理容器，动态接入的每实例网络随之丢失；编排服务自己通常
  // 也在同一批重建里，所以「启动后第一次修补」正是最常见的恢复时机。
  void (async () => {
    for (const record of Object.values(loadRegistry().instances)) {
      await attachReachers(instanceNetworkName(record.uid))
    }
  })().catch((error) => {
    process.stderr.write(`[dsh-instances] reacher attach failed: ${error?.message ?? error}\n`)
  })
})

// 周期清扫：空闲回收 + 水位调整。首次延迟一个周期，避免启动瞬间抢资源。
const timer = setInterval(() => {
  try {
    void sweep(loadRegistry())
  } catch (error) {
    process.stderr.write(`[dsh-instances] sweep failed: ${error?.message ?? error}\n`)
  }
}, CONFIG.sweepIntervalMs)
timer.unref?.()

// 兜底：编排服务是唯一持有 docker.sock 的进程，任何遗漏的异步拒绝都不允许终止它。
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[dsh-instances] unhandled rejection: ${reason?.stack ?? reason}\n`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
