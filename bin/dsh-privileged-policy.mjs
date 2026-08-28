// DSH 特权代理的策略层。
//
// 容器里的 DSH 以非 root 的 dsh 账户运行，需要 root 的操作一律交给以 root 运行的
// 特权代理（dsh-privileged-helper）。策略单独放在这里：既能被代理引用，也能在
// 宿主机上直接跑单元测试，不必启动容器。
//
// 设计原则：默认拒绝。apt 只放行固定的子命令、固定的选项和形如包名的参数；
// 任何能让 apt 执行任意命令的入口（-o/--option、-c/--config-file、本地 .deb
// 路径）都必须被挡在代理之外，否则“最小权限”只是摆设。

export class PolicyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PolicyError'
  }
}

export const APT_EXECUTABLES = new Map([
  ['apt', '/usr/bin/apt'],
  ['apt-get', '/usr/bin/apt-get'],
  ['apt-cache', '/usr/bin/apt-cache'],
  ['apt-mark', '/usr/bin/apt-mark'],
])

// 只放行安装/查询类子命令。source、download、build 之类会把外部文件带进 root
// 上下文，或需要额外的路径参数，因此不在白名单里。
const APT_SUBCOMMANDS = new Set([
  'update',
  'install',
  'reinstall',
  'remove',
  'purge',
  'autoremove',
  'autopurge',
  'upgrade',
  'dist-upgrade',
  'full-upgrade',
  'clean',
  'autoclean',
  'build-dep',
  'show',
  'showpkg',
  'search',
  'list',
  'policy',
  'depends',
  'rdepends',
  'madison',
  'hold',
  'unhold',
  'showhold',
  'auto',
  'manual',
  'showauto',
  'showmanual',
])

// 不接受包名的子命令：多余的位置参数通常意味着调用方在试探策略。
const APT_SUBCOMMANDS_WITHOUT_PACKAGES = new Set([
  'update',
  'clean',
  'autoclean',
  'upgrade',
  'dist-upgrade',
  'full-upgrade',
  'autoremove',
  'autopurge',
  'list',
  'showhold',
  'showauto',
  'showmanual',
])

const APT_FLAGS = new Set([
  '-y',
  '--yes',
  '--assume-yes',
  '-q',
  '-qq',
  '--quiet',
  '-s',
  '--simulate',
  '--dry-run',
  '--just-print',
  '--no-install-recommends',
  '--install-recommends',
  '--no-install-suggests',
  '--install-suggests',
  '-f',
  '--fix-broken',
  '-m',
  '--ignore-missing',
  '--fix-missing',
  '--only-upgrade',
  '--no-upgrade',
  '--reinstall',
  '--purge',
  '--autoremove',
  '--no-autoremove',
  '--download-only',
  '-d',
  '--verbose-versions',
  '-V',
  '--all-versions',
  '--installed',
  '--upgradable',
  '--all-names',
  '--names-only',
  '-n',
])

// Debian 包名、可选的架构限定和可选的版本锁定。禁止 /、*、? 和 shell 元字符，
// 所以 `apt-get install ./payload.deb` 与 apt 模式表达式都会被拒绝。
const PACKAGE_TOKEN = /^[a-z0-9][a-z0-9+.-]*(:[a-z0-9][a-z0-9-]*)?(=[A-Za-z0-9][A-Za-z0-9.:+~-]*)?$/

// 卸载保护名单。免密 apt 的本意是让 Agent 自己装开发依赖，但 remove/purge 同样在
// 白名单里，于是一条 `apt-get purge -y nginx` 就能把反向代理从容器可写层里抹掉：
// 已经在跑的进程靠已删除的 inode 继续存活，容器看起来一切正常，直到下一次重启才
// 发现 Nginx 再也起不来。这不是容器逃逸，而是一次单命令自毁，所以要单独挡住。
//
// 只保护“少了它容器就起不来 / 提权通道就废掉”的那几个包，用户自己装的东西照旧
// 可以随便卸，否则免密 apt 就失去意义了。libc6、dpkg、coreutils、util-linux 这类
// Essential 包由 apt 自己拒绝（策略同时禁掉了 --allow-remove-essential），这里列出
// 的是实测确认 apt 愿意卸、但卸掉之后启动链会断的那些。
const PROTECTED_PACKAGES = new Set([
  // 反向代理与鉴权入口：唯一对外暴露的端口由它提供。
  'nginx',
  'nginx-common',
  'nginx-core',
  'nginx-light',
  'nginx-full',
  'nginx-extras',
  'libnginx-mod-stream',
  // 出站 TLS 与 root 口令校验：openssl passwd -6 是特权代理验密码的唯一实现。
  'ca-certificates',
  'openssl',
  // 容器 root 口令的设定与账户管理：少了它 entrypoint 无法写口令。
  'passwd',
  'adduser',
  // Supervisor 记录 PID 用 awk，Debian 上由 mawk 提供；卸掉它启动即失败。
  'mawk',
  // 降权靠 setpriv。util-linux 通常是 Essential，这里显式重复一遍以防基础镜像变化。
  'util-linux',
])

// 卸载类子命令。autoremove/autopurge 不接受包名，但它们同样会摘掉变成孤儿的依赖，
// 所以一并纳入执行前的模拟检查。
const APT_REMOVAL_SUBCOMMANDS = new Set(['remove', 'purge', 'autoremove', 'autopurge'])

// 包名可能带 :arch 限定或 =version 锁定，取裸名再比对。
function barePackageName(token) {
  return String(token).split('=')[0].split(':')[0]
}

export function isProtectedPackage(token) {
  return PROTECTED_PACKAGES.has(barePackageName(token))
}

export function isRemovalSubcommand(subcommand) {
  return APT_REMOVAL_SUBCOMMANDS.has(String(subcommand))
}

// 解析 `apt-get -s` 的模拟输出。apt 用 `Remv <包名> [版本]` / `Purg <包名>` 描述计划
// 中的卸载动作，级联卸载也会出现在这里，所以“点名一个无害的依赖、让 apt 顺带把
// Nginx 带走”这种绕法同样会被识别出来。
export function findProtectedRemovals(simulationOutput) {
  const found = new Set()
  for (const rawLine of String(simulationOutput ?? '').split('\n')) {
    const match = /^\s*(?:Remv|Purg)\s+(\S+)/.exec(rawLine)
    if (!match) continue
    if (isProtectedPackage(match[1])) found.add(barePackageName(match[1]))
  }
  return [...found]
}
export function validateAptCommand(command, args) {
  const executable = APT_EXECUTABLES.get(command)
  if (!executable) {
    throw new PolicyError(`不允许的特权命令：${command}`)
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new PolicyError('apt 参数必须是字符串数组')
  }
  if (args.length > 256) {
    throw new PolicyError('apt 参数过多')
  }

  let subcommand = ''
  const packages = []
  for (const argument of args) {
    if (argument === '') {
      throw new PolicyError('apt 参数不允许为空字符串')
    }
    if (argument === '--') {
      throw new PolicyError('apt 参数不支持 -- 分隔符')
    }
    if (argument.startsWith('-')) {
      if (!APT_FLAGS.has(argument)) {
        throw new PolicyError(`不允许的 apt 选项：${argument}（-o/-c/-t 等可执行任意命令的选项一律禁止）`)
      }
      continue
    }
    if (!subcommand) {
      if (!APT_SUBCOMMANDS.has(argument)) {
        throw new PolicyError(`不允许的 apt 子命令：${argument}`)
      }
      subcommand = argument
      continue
    }
    if (!PACKAGE_TOKEN.test(argument)) {
      throw new PolicyError(`不是合法的包名：${argument}（不接受路径、本地 .deb 或通配模式）`)
    }
    packages.push(argument)
  }

  if (!subcommand) {
    throw new PolicyError('缺少 apt 子命令')
  }
  if (packages.length > 0 && APT_SUBCOMMANDS_WITHOUT_PACKAGES.has(subcommand)) {
    throw new PolicyError(`apt ${subcommand} 不接受包名参数`)
  }
  if (packages.length === 0 && !APT_SUBCOMMANDS_WITHOUT_PACKAGES.has(subcommand)) {
    throw new PolicyError(`apt ${subcommand} 需要至少一个包名`)
  }

  // 卸载类子命令是唯一能把运行时依赖从可写层里抹掉的入口。显式点名受保护的包在这里
  // 直接拒绝；级联卸载拦不住的部分由特权代理在真正执行前用 apt -s 模拟一遍兜住。
  const removal = APT_REMOVAL_SUBCOMMANDS.has(subcommand)
  if (removal) {
    const blocked = packages.filter((name) => isProtectedPackage(name))
    if (blocked.length > 0) {
      throw new PolicyError(
        `apt ${subcommand} 不允许卸载容器运行时依赖：${blocked.join(' ')}`,
      )
    }
  }

  return { executable, argv: [command, ...args], subcommand, packages, removal }
}

// 属主自愈。
//
// Agent 以 dsh 账户干活，工具链全都装在它自己的家目录里。这些目录里一旦混进 root
// 属主的文件（历史上最常见的来源是宿主机上以 root 身份 docker exec 跑过 npm/npx），
// npm 会直接以 EACCES 失败，并且只会建议 "sudo chown"——而容器里的 Agent 没有 root，
// 自己修不了，只能等下一次容器重启。所以这里开一个免密的窄动作。
//
// 它不扩大提权面：目标 uid/gid 由代理侧按运行账户决定（不接受请求里的值），路径是
// 固定白名单，chown 带 -h 不跟随符号链接（-R 本来也不跟随），所以 dsh 没法用一个
// 指向 /etc 的软链把系统文件改成自己的。能做的只有"把这几棵树改回自己名下"。
export const FIX_PERMS_TARGETS = ['/data/home', '/data/dsh', '/data/agents', '/data/mcp', '/workspace']

export const CHOWN_EXECUTABLE = '/usr/bin/chown'

export function buildFixPermsCommand(owner) {
  const uid = Number(owner?.uid)
  const gid = Number(owner?.gid)
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
    throw new PolicyError('属主自愈只能把文件改回非 root 的运行账户')
  }
  return {
    executable: CHOWN_EXECUTABLE,
    argv: ['chown', '-Rh', `${uid}:${gid}`, ...FIX_PERMS_TARGETS],
  }
}

export const DEFAULT_LOCKOUT = {
  maxFailures: 5,
  failureWindowSeconds: 900,
  baseLockSeconds: 300,
  maxLockSeconds: 3600,
  minDelayMs: 1000,
  perFailureDelayMs: 500,
  maxDelayMs: 8000,
}

export function emptyLockoutState() {
  return { failures: 0, firstFailureAt: 0, lockedUntil: 0, lockLevel: 0 }
}

export function normalizeLockoutState(value) {
  const state = emptyLockoutState()
  if (!value || typeof value !== 'object') return state
  for (const key of Object.keys(state)) {
    const number = Number(value[key])
    if (Number.isFinite(number) && number >= 0) state[key] = Math.floor(number)
  }
  return state
}

// 剩余锁定秒数。锁定期内一次密码校验都不做，离线暴力破解也拿不到哈希：
// /etc/shadow 和挂载进来的哈希文件都在 dsh 账户读不到的位置。
export function lockoutRemainingSeconds(state, nowSeconds) {
  const lockedUntil = normalizeLockoutState(state).lockedUntil
  return lockedUntil > nowSeconds ? lockedUntil - nowSeconds : 0
}

export function attemptDelayMs(state, config = DEFAULT_LOCKOUT) {
  const { failures } = normalizeLockoutState(state)
  return Math.min(config.minDelayMs + failures * config.perFailureDelayMs, config.maxDelayMs)
}

export function registerFailure(state, nowSeconds, config = DEFAULT_LOCKOUT) {
  const current = normalizeLockoutState(state)
  const withinWindow =
    current.firstFailureAt > 0 && nowSeconds - current.firstFailureAt <= config.failureWindowSeconds
  const next = {
    failures: withinWindow ? current.failures + 1 : 1,
    firstFailureAt: withinWindow ? current.firstFailureAt : nowSeconds,
    lockedUntil: current.lockedUntil,
    lockLevel: current.lockLevel,
  }
  if (next.failures >= config.maxFailures) {
    next.lockLevel = current.lockLevel + 1
    const lockSeconds = Math.min(
      config.baseLockSeconds * 2 ** (next.lockLevel - 1),
      config.maxLockSeconds,
    )
    next.lockedUntil = nowSeconds + lockSeconds
    next.failures = 0
    next.firstFailureAt = 0
  }
  return next
}

export function registerSuccess() {
  return emptyLockoutState()
}
