// dsh-instances 的纯策略层：实例身份分配、容器规格、闲置回收、水位决策、磁盘配额。
//
// 全部是纯函数，不碰 docker、不碰网络、不碰时钟——由服务层注入时间与观测值。
// 出处见 docs/auth-design.md §4.2（生命周期）、§4.3（水位决策环）、§4.5（资源账）。

/** 用户实例身份 UID 起始值：与容器内 dsh(1000) 彻底分开，落在系统账户区间之外。 */
export const UID_BASE = 100000

/** 每实例内存硬上限。宿主 8-10GB 可用内存下，该值决定同时在线实例数。 */
export const DEFAULT_MEMORY_MB = 200

/** Node 堆上限：留 40MB 给运行时自身，避免堆被打满触发 OOM killer 而不是 GC。 */
export const DEFAULT_NODE_HEAP_MB = 160

/** 闲置停用默认阈值：无活动超过该时长即停用，内存归零，数据保留。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** 收缩模式下收紧到的闲置阈值。 */
export const SHRINK_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** 水位阈值：≥70% 进入收缩，≥90% 进入紧急，回落 <60% 才恢复（滞回，避免抖动）。 */
export const WATERMARK = Object.freeze({ shrink: 0.70, emergency: 0.90, recover: 0.60 })

/** 每用户默认磁盘配额 5GB。 */
export const DEFAULT_DISK_QUOTA_BYTES = 5 * 1024 ** 3

/**
 * 容器内存上限的合法下限（MB）。
 *
 * 这不是「镜像能不能启动」的下限，而是**容器层不变式的下限**：buildContainerSpec 要求
 * Node 堆上限严格小于容器内存上限，否则抛错。把这个下限作为权威让设置接口复用，
 * 否则接口会接受 64-160 这些「看起来合法」的值，而创建实例时抛错——审计实测：
 * 设成 64MB 后所有 /instances/ensure 返回 500，用户登录卡在等待页。
 *
 * 留出 --control-... 之外的运行时余量（堆之外还有 nginx、supervisor 与原生模块）。
 * @param {number} [nodeHeapMb] 生效的 Node 堆上限。
 * @returns {number} 允许的最小容器内存（MB）。
 */
export function minInstanceMemoryMb(nodeHeapMb = DEFAULT_NODE_HEAP_MB) {
  // 堆之外至少留 40MB（与 DEFAULT_NODE_HEAP_MB 的取值口径一致）
  return Math.max(64, Math.ceil(nodeHeapMb) + 40)
}

/**
 * 分配下一个空闲 UID。从 UID_BASE 起递增，跳过已占用的值。
 * @param {number[]} used UID 集合。
 * @returns {number} 可用 UID。
 */
export function allocateUid(used) {
  const taken = new Set((used ?? []).filter((n) => Number.isInteger(n) && n >= UID_BASE))
  let candidate = UID_BASE
  while (taken.has(candidate)) candidate += 1
  return candidate
}

/**
 * 实例名（docker 容器名 / 网络别名）。由 uid 派生，稳定且可预测。
 * @param {number} uid 实例 UID。
 * @returns {string} 实例名。
 */
export function instanceName(uid) {
  if (!Number.isInteger(uid) || uid < UID_BASE) throw new Error(`invalid instance uid: ${uid}`)
  return `dsh-u${uid - UID_BASE + 1}`
}

/**
 * 实例入口端口：镜像内 nginx 监听 3080，再把请求转发给容器内的 DSH（3081）。
 * 每实例固定使用该端口，靠 docker 网络内按容器名访问，不发布宿主端口。
 */
export const INSTANCE_PORT = 3080

/**
 * 生成创建用户实例的 docker CLI 参数（数组形式，便于测试与 spawn）。
 *
 * 安全基线（与主 dsh 容器一致，见 docs/security.md）：
 *   cap_drop ALL、no-new-privileges、内存与 pids 上限、模型配置只读挂载、无 docker.sock。
 *
 * 存储后端（spec.storage）：
 *   bind（默认）—— 数据落在宿主目录，可直接检查与备份，适合 Linux 宿主。
 *   volume      —— 数据落在 Docker 卷里。镜像入口用 `install -o -g` 对齐挂载目录属主，
 *                  而 Windows/macOS 的绑定挂载无法表达属主（chown 报 EPERM），这类宿主
 *                  上容器会在启动阶段失败，只能用卷。
 * @param {object} spec 实例规格。
 * @param {string} spec.name 实例名。
 * @param {number} spec.uid 实例槽位号（用于命名与登记，不是容器内的运行身份）。
 * @param {string} spec.image 镜像引用。
 * @param {string} spec.network docker 网络名。
 * @param {string} [spec.dataDir] 宿主侧数据目录（storage=bind 时必填）。
 * @param {'bind'|'volume'} [spec.storage] 存储后端，默认 bind。
 * @param {string} [spec.volumeBase] 卷名前缀（storage=volume 时必填）。
 * @param {string} [spec.memoryMb] 内存上限 MB。
 * @param {string} [spec.nodeHeapMb] Node 堆上限 MB。
 * @returns {string[]} docker run 参数（不含 `docker run` 本身）。
 */
export function buildContainerSpec(spec) {
  const memoryMb = spec.memoryMb ?? DEFAULT_MEMORY_MB
  const heapMb = spec.nodeHeapMb ?? DEFAULT_NODE_HEAP_MB
  if (memoryMb < 64) throw new Error('memory limit below 64MB would not boot DSH')
  if (heapMb >= memoryMb) throw new Error('node heap must stay below the container memory limit')
  const { name, uid, image, network, dataDir } = spec
  if (!name || !Number.isInteger(uid) || !image || !network) {
    throw new Error('container spec requires name, uid, image and network')
  }
  const storage = spec.storage ?? 'bind'
  let homeSource
  let workspaceSource
  if (storage === 'volume') {
    if (!spec.volumeBase) throw new Error('volume storage requires volumeBase')
    homeSource = `${spec.volumeBase}-home`
    workspaceSource = `${spec.volumeBase}-workspace`
  } else {
    if (!dataDir) throw new Error('bind storage requires dataDir')
    homeSource = `${dataDir}/home`
    workspaceSource = `${dataDir}/workspace`
  }
  return [
    '--name', name,
    '--hostname', name,
    '--network', network,
    // 必须以 root 启动：镜像入口要 chown 挂载目录、写 /etc/shadow，再把 DSH 与 Nginx
    // 降权到容器内的 dsh 账户（主容器同样是 user: "0:0"）。用 --user 指定非 root
    // 身份会让入口直接以 77 退出。
    //
    // 因此**隔离来自容器与挂载边界，而不是 Unix 属主**：每个实例只挂载自己的数据目录，
    // 各实例在宿主上的属主都是镜像内的 dsh 账户。这一点在 docs/auth-design.md §4.1 说明。
    '--memory', `${memoryMb}m`,
    '--memory-swap', `${memoryMb}m`,
    '--pids-limit', '256',
    '--cap-drop', 'ALL',
    // 能力集与主容器一致：入口要 chown 挂载目录、写 /etc/shadow，再把 DSH 与 Nginx
    // 降权到运行账户。cap_drop ALL 之后必须把这几个加回来，否则启动阶段就会 EPERM。
    '--cap-add', 'CHOWN',
    '--cap-add', 'DAC_OVERRIDE',
    '--cap-add', 'FOWNER',
    '--cap-add', 'FSETID',
    '--cap-add', 'SETGID',
    '--cap-add', 'SETUID',
    '--cap-add', 'KILL',
    '--security-opt', 'no-new-privileges',
    // 不能加 --read-only：镜像入口脚本要写 /etc/shadow（容器 root 口令）与
    // /run/dsh-priv、/run/dsh-state，主容器出于同样原因也没有只读根。
    // 这里的安全边界是容器本身，不是只读根文件系统。
    // /tmp 保持容器自身可写层，不挂 tmpfs：DSH 的原生模块加载器会把 .node 物化到
    // 缓存目录再 dlopen，noexec 会让它失败。主容器同样如此。
    '-v', `${homeSource}:/data/dsh:rw`,
    '-v', `${workspaceSource}:/workspace:rw`,
    // 只做目录级挂载，不往 /data/dsh 里嵌文件：目录挂载套文件挂载在部分宿主上会失效。
    // 模型配置由管理器生成到 home 内；真实密钥始终只在 dsh-key-broker。见 auth-design §4.1。
    '-e', `NODE_OPTIONS=--max-old-space-size=${heapMb}`,
    '-e', 'DSH_AUTH_INSTANCE_UID=' + String(uid),
    // 认证在七层入口完成；实例内的 nginx 必须关闭 Basic Auth，否则会多出一道无人
    // 能通过的认证（configure-nginx-auth 只认 local / trusted-proxy / basic）。
    '-e', 'DSH_ACCESS_MODE=password',
    // 模型代理令牌：实例内的入口脚本把它写进 settings.yaml 的 provider 头，
    // 代理据此识别调用者并只放行该账户被开放的上游。
    ...(spec.brokerToken ? ['-e', `DSH_BROKER_INSTANCE_TOKEN=${spec.brokerToken}`] : []),
    '--restart', 'no',
    image,
  ]
}

/**
 * 判断实例是否应被闲置停用。
 *
 * 有运行中的会话/后台任务时**不停**（busy 优先）；busy 探针失败按 busy 处理——
 * 宁可多占一会儿内存，也不误杀用户正在跑的任务。
 * @param {object} input 判定输入。
 * @param {boolean} input.running 容器是否在运行。
 * @param {boolean} input.busy 是否有活跃会话/任务（探针失败时传 true）。
 * @param {boolean} input.pinned 是否被管理员固化为永久保留。
 * @param {number} input.lastSeenAt 最后活动时间（毫秒）。
 * @param {number} input.now 当前时间（毫秒）。
 * @param {number} input.idleTimeoutMs 闲置阈值。
 * @returns {{stop:boolean, reason:string}} 判定结果。
 */
export function decideIdle({ running, busy, pinned, lastSeenAt, now, idleTimeoutMs }) {
  if (!running) return { stop: false, reason: 'not_running' }
  // 固化优先于一切：那是管理员显式声明的「留着」，自动回收不得推翻它。
  if (pinned) return { stop: false, reason: 'pinned' }
  if (busy) return { stop: false, reason: 'busy' }
  const idleFor = now - lastSeenAt
  if (!Number.isFinite(lastSeenAt)) return { stop: false, reason: 'unknown_activity' }
  if (idleFor < idleTimeoutMs) return { stop: false, reason: 'recently_active' }
  return { stop: true, reason: 'idle' }
}

/**
 * 内存水位模式（带滞回：进入 70%，恢复到 60% 以下才退出）。
 *
 * 压力定义：`demand / (demand + available)`，即「在线实例的内存需求占内存池的比例」，
 * 取值恒在 [0,1)。例如 30 个在线实例（需求 6GB）、宿主可用 2GB → 6/(6+2)=0.75 → shrink。
 * @param {object} input 观测输入。
 * @param {number} input.onlineCount 在线实例数。
 * @param {number} input.perInstanceMb 每实例内存上限 MB。
 * @param {number} input.availableBytes 宿主可用内存字节。
 * @param {string} input.previous 上一次模式（用于滞回）。
 * @returns {'normal'|'shrink'|'emergency'} 当前模式。
 */
export function watermarkMode({ onlineCount, perInstanceMb, availableBytes, previous = 'normal' }) {
  const demanded = onlineCount * perInstanceMb * 1024 * 1024
  const total = demanded + availableBytes
  const ratio = total > 0 ? demanded / total : 0
  if (ratio >= WATERMARK.emergency) return 'emergency'
  if (ratio >= WATERMARK.shrink) return 'shrink'
  // 滞回：收缩中的系统要等水位真正回落到 recover 以下才恢复，避免在阈值上抖动
  if (previous !== 'normal' && ratio >= WATERMARK.recover) return 'shrink'
  return 'normal'
}

/**
 * 规划要回收的实例（最久未活跃优先，跳过 busy）。
 * @param {object} input 规划输入。
 * @param {Array<{name:string,lastSeenAt:number,busy:boolean,running:boolean}>} input.instances 实例观测。
 * @param {number} input.now 当前时间。
 * @param {number} input.idleTimeoutMs 本次生效的闲置阈值。
 * @param {number} [input.limit] 最多回收几个（紧急模式限流用）。
 * @returns {string[]} 应停用的实例名（按最久未活跃排序）。
 */
export function planReclaim({ instances, now, idleTimeoutMs, limit = Number.MAX_SAFE_INTEGER }) {
  return (instances ?? [])
    .filter((i) => i.running && !i.busy && decideIdle({ ...i, now, idleTimeoutMs }).stop)
    .sort((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0))
    .slice(0, Math.max(0, limit))
    .map((i) => i.name)
}

/**
 * 本次生效的闲置阈值（收缩模式收紧）。
 * @param {string} mode 水位模式。
 * @param {number} baseIdleTimeoutMs 基础阈值。
 * @returns {number} 生效阈值。
 */
export function effectiveIdleTimeout(mode, baseIdleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
  return mode === 'normal' ? baseIdleTimeoutMs : Math.min(baseIdleTimeoutMs, SHRINK_IDLE_TIMEOUT_MS)
}

/**
 * 是否允许唤醒新实例。紧急模式暂停唤醒，改为排队（返回 false 让调用方回 503）。
 * @param {string} mode 水位模式。
 * @param {number} queueDepth 当前排队数。
 * @param {number} [queueLimit] 队列上限。
 * @returns {{allow:boolean, reason:string}} 判定结果。
 */
export function decideWake(mode, queueDepth, queueLimit = 8) {
  if (mode === 'emergency') return { allow: false, reason: 'emergency' }
  if (queueDepth >= queueLimit) return { allow: false, reason: 'queue_full' }
  if (mode === 'shrink') return { allow: true, reason: 'queued' }
  return { allow: true, reason: 'immediate' }
}

/**
 * 磁盘配额判定。
 * @param {number} usedBytes 已用字节。
 * @param {number} quotaBytes 配额字节（0 或负数表示不限制）。
 * @param {number} [headroom] 触发告警的预留比例（默认 0.9）。
 * @returns {{allowed:boolean, percent:number, level:'ok'|'warn'|'over'}} 判定结果。
 */
export function checkDiskQuota(usedBytes, quotaBytes, headroom = 0.9) {
  if (!quotaBytes || quotaBytes <= 0) return { allowed: true, percent: 0, level: 'ok' }
  const percent = usedBytes / quotaBytes
  if (percent >= 1) return { allowed: false, percent, level: 'over' }
  if (percent >= headroom) return { allowed: true, percent, level: 'warn' }
  return { allowed: true, percent, level: 'ok' }
}
