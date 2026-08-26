import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

// 运行身份与隔离的静态守卫：容器以非 root 的 dsh 账户运行 DSH，root 只留给
// PID 1、Nginx 主进程和特权代理；apt 依然可用，但必须经过白名单代理。
const files = Object.fromEntries(await Promise.all([
  ['compose', 'docker-compose.yml'],
  ['dockerfile', 'Dockerfile'],
  ['entrypoint', 'bin/entrypoint.sh'],
  ['supervisor', 'bin/dsh-supervisor'],
  ['helper', 'bin/dsh-privileged-helper.mjs'],
  ['client', 'bin/dsh-root'],
  ['aptShim', 'bin/dsh-apt-shim'],
  ['sudoShim', 'bin/dsh-sudo-shim'],
  ['updateShim', 'bin/dsh-update-shim'],
  ['hashPassword', 'bin/hash-dsh-password'],
  ['verifier', 'bin/verify-dsh-hardening'],
  ['nginx', 'nginx/dsh-nginx.conf'],
  ['keysCompose', 'docker-compose.keys.yml'],
  ['isolatedCompose', 'docker-compose.isolated.yml'],
  ['ingressConf', 'nginx/dsh-ingress.conf'],
  ['restart', 'bin/restart-dsh'],
  ['skill', 'dsh-home/skills/container-environment/SKILL.md'],
  ['dshSh', 'dsh.sh'],
  ['dshBat', 'dsh.bat'],
  ['installSh', 'install.sh'],
  ['installPs1', 'install.ps1'],
  ['envExample', '.env.example'],
].map(async ([name, path]) => [name, await readFile(new URL('../' + path, import.meta.url), 'utf8')])))

// --- 逃逸面：Compose 必须继续拒绝特权容器、Docker socket 和宿主 namespace ---
assert.match(files.compose, /^\s+user:\s+"0:0"$/m)
assert.match(files.compose, /security_opt:\s*\n(\s*#.*\n)*\s*- no-new-privileges:true/)
assert.doesNotMatch(files.compose, /privileged:\s*true/)
assert.doesNotMatch(files.compose, /docker\.sock/)
assert.doesNotMatch(files.compose, /pid:\s*host|network_mode:\s*host|ipc:\s*host|userns_mode:\s*host/)
assert.doesNotMatch(files.compose, /seccomp[:=]unconfined|apparmor[:=]unconfined/)
assert.doesNotMatch(files.compose, /DSH_RUN_AS_ROOT/)

// 能力集：先 drop ALL，再只补回降权启动与 apt/dpkg 真正需要的那几项。
assert.match(files.compose, /cap_drop:\s*\n\s*- ALL/)
const capAddBlock = /cap_add:\s*\n((?:\s+- [A-Z_]+\n)+)/.exec(files.compose)
assert.ok(capAddBlock, 'compose must declare an explicit cap_add allow list')
const grantedCapabilities = capAddBlock[1]
  .split('\n')
  .map((line) => line.replace(/\s*-\s*/, '').trim())
  .filter(Boolean)
assert.deepEqual(
  [...grantedCapabilities].sort(),
  ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID'],
  'compose must grant exactly the capabilities required to drop privileges and run apt',
)
for (const forbidden of [
  'SYS_ADMIN',
  'SYS_MODULE',
  'SYS_PTRACE',
  'SYS_RAWIO',
  'SYS_CHROOT',
  'SYS_BOOT',
  'MKNOD',
  'NET_ADMIN',
  'NET_RAW',
  'DAC_READ_SEARCH',
  'SETPCAP',
  'SETFCAP',
  'BPF',
  'PERFMON',
]) {
  assert.ok(!grantedCapabilities.includes(forbidden), `compose must not grant CAP_${forbidden}`)
}
assert.match(files.compose, /pids_limit:\s*\d+/)
// root 口令哈希只能挂到 /root 下（0700 root:root），dsh 账户读不到。
assert.match(files.compose, /\.\/data\/secret:\/root\/dsh-secret:ro/)
assert.match(files.compose, /DSH_PRIVILEGED_APT: "\$\{DSH_PRIVILEGED_APT:-nopasswd\}"/)
// 密钥配置只属于 dsh-key-broker：基文件和隔离叠加都不许把它挂进 DSH 容器。
assert.doesNotMatch(files.compose, /dsh-broker/)
// internal: true 是隔离模式的地基——没有默认网关，dsh 撤掉 default 之后才真的出不去。
assert.match(
  files.compose,
  /^ {2}dsh-internal:\n {4}name: "\$\{DSH_INTERNAL_NETWORK:-dsh-internal\}"\n {4}internal: true$/m,
)

// --- 叠加文件：旁路容器本身也必须是最小权限，而且不能开新的宿主入口 ---
//
// 按 2 空格缩进的服务名切块再断言：整文件正则分不开「dsh-ingress 必须发布 3080」和
// 「broker / egress 必须一个端口都不发布」这两条相反的要求。
const serviceBlocks = (source) => {
  const blocks = new Map()
  let current = null
  for (const line of source.split('\n')) {
    const header = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (header) {
      current = []
      blocks.set(header[1], current)
      continue
    }
    if (current && /^ {2}\S/.test(line)) current = null
    if (current) current.push(line)
  }
  return new Map([...blocks].map(([name, lines]) => [name, lines.join('\n')]))
}
const keysServices = serviceBlocks(files.keysCompose)
const isolatedServices = serviceBlocks(files.isolatedCompose)
assert.doesNotMatch(files.isolatedCompose, /dsh-broker/)

for (const [name, block] of [
  ['dsh-key-broker', keysServices.get('dsh-key-broker')],
  ['dsh-egress', isolatedServices.get('dsh-egress')],
]) {
  assert.ok(block, `${name} must be defined in its compose overlay`)
  // 这两个容器持有的东西比 dsh 更敏感（真实密钥、唯一出网通道），所以权限只能更小：
  // 非 root、零能力、只读根文件系统，而且绝不发布宿主端口——它们只在容器网络里被访问。
  assert.match(block, /^ +user: "1000:1000"$/m, `${name} must run as 1000:1000`)
  assert.match(block, /^ +read_only: true$/m, `${name} must use a read-only root filesystem`)
  assert.match(block, /cap_drop:\n +- ALL/, `${name} must drop all capabilities`)
  assert.match(block, /security_opt:\n(?: *#.*\n)* +- no-new-privileges:true/, `${name} must set no-new-privileges`)
  assert.doesNotMatch(block, /^ +ports:/m, `${name} must not publish host ports`)
  assert.doesNotMatch(block, /privileged:\s*true/, `${name} must not be privileged`)
  assert.doesNotMatch(block, /docker\.sock/, `${name} must not see the Docker socket`)
  assert.doesNotMatch(block, /cap_add:/, `${name} must not add capabilities back`)
}
// 密钥配置只读挂给 broker，而且是唯一的一处挂载。
assert.match(keysServices.get('dsh-key-broker'), /^ +- \.\/data\/broker:\/etc\/dsh-broker:ro$/m)

// 隔离后的 dsh：不再自己发布端口，只留 internal 网络，并带一个专用别名。
const isolatedDsh = isolatedServices.get('dsh')
assert.ok(isolatedDsh, 'isolated overlay must patch the dsh service')
assert.match(isolatedDsh, /^ +ports: !reset \[\]$/m)
assert.match(isolatedDsh, /networks: !override\n +dsh-internal:\n +aliases:\n +- dsh-app\b/)
const overrideNetworks = /networks: !override\n((?: {6,}.*\n)+)/.exec(isolatedDsh)
assert.ok(overrideNetworks, 'isolated overlay must override the dsh networks block')
assert.deepEqual(
  [...overrideNetworks[1].matchAll(/^ {6}(\S+):$/gm)].map(([, network]) => network),
  ['dsh-internal'],
  'isolated 模式下 dsh 只能挂 dsh-internal，default 与 dsh-private 都必须撤掉',
)
// entrypoint 靠这个变量渲染 apt.conf / pip.conf / npmrc / git 的代理配置：光有
// HTTP_PROXY 环境变量不够，apt 经特权代理以 root 运行时环境会被白名单清掉。
assert.match(isolatedDsh, /^ +DSH_EGRESS_PROXY_URL: "http:\/\/dsh-egress:3128"$/m)

// dsh-ingress：唯一的宿主入口，并在 dsh-private 上顶替 `dsh` 这个名字。
const isolatedIngress = isolatedServices.get('dsh-ingress')
assert.ok(isolatedIngress, 'isolated overlay must define dsh-ingress')
assert.match(isolatedIngress, /^ +user: "1000:1000"$/m)
assert.match(isolatedIngress, /cap_drop:\n +- ALL/)
assert.match(isolatedIngress, /^ +- "\$\{DSH_BIND_HOST:-127\.0\.0\.1\}:3080:3080"$/m)
assert.match(isolatedIngress, /dsh-private:\n(?: *#.*\n)* +aliases:\n +- dsh *$/m)
// healthcheck 探整条链路（ingress → dsh 的 /healthz = 204），只探本地监听的话上游挂了
// 依然会显示健康。
assert.match(isolatedIngress, /fetch\('http:\/\/127\.0\.0\.1:3080\/healthz'\)/)
assert.match(isolatedIngress, /response\.status === 204/)

// ingress 必须是 stream 四层转发，且上游是 dsh-app 而不是 dsh：Docker 内嵌 DNS 会把
// 查询方自己的 alias 也算进解析结果，ingress 解析 `dsh` 会解析到它自己并自连。
assert.match(files.ingressConf, /^stream \{$/m)
assert.match(files.ingressConf, /map \$server_port \$dsh_upstream \{\n +default dsh-app:3080;/)
assert.doesNotMatch(files.ingressConf, /default dsh:3080;/)
// 七层改写留给 dsh 容器里的 Nginx：这里一旦开 http 块、动 Host 或补 X-Forwarded-*，
// 那套「以回环身份呈现给 DSH」的同源与凭据边界就废了。注释里提到这些名字是在解释
// 为什么不能这么做，所以只看真正的指令行。
const ingressDirectives = files.ingressConf
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')
assert.doesNotMatch(ingressDirectives, /proxy_set_header|X-Forwarded|^http \{/m)

// --- 镜像：运行账户、apt 依赖、特权代理与包装脚本 ---
assert.match(files.dockerfile, /ARG DEBIAN_IMAGE=debian:13-slim/)
assert.match(files.dockerfile, /FROM \$\{DEBIAN_IMAGE\} AS runtime/)
assert.match(files.dockerfile, /DSH_UPDATE_STATE=\/data\/dsh\/update/)
assert.match(files.dockerfile, /DSH_NGINX_CONFIG=\/usr\/local\/share\/dsh\/nginx\.conf/)
const runtimeDockerfile = files.dockerfile.slice(files.dockerfile.indexOf('FROM ' + '$' + '{DEBIAN_IMAGE} AS runtime'))
assert.match(runtimeDockerfile, /RUN --mount=type=cache,target=\/var\/cache\/apt,sharing=locked/)
assert.match(runtimeDockerfile, /apt-get update/)
assert.match(runtimeDockerfile, /^\s+make \\$/m)
assert.match(runtimeDockerfile, /^\s+gcc \\$/m)
assert.match(runtimeDockerfile, /^\s+g\+\+ \\$/m)
// openssl 负责生成和校验 sha512crypt 口令哈希。
assert.match(runtimeDockerfile, /^\s+openssl \\$/m)
assert.doesNotMatch(runtimeDockerfile, /\bgosu\b|node:node|--chown=node/)
assert.match(runtimeDockerfile, /groupadd --gid 1000 dsh/)
assert.match(runtimeDockerfile, /useradd --uid 1000 --gid 1000 --home-dir \/data\/home --no-create-home --shell \/bin\/bash dsh/)
assert.match(runtimeDockerfile, /COPY bin\/dsh-privileged-policy\.mjs \/usr\/local\/lib\/dsh\/dsh-privileged-policy\.mjs/)
assert.match(runtimeDockerfile, /COPY bin\/dsh-privileged-helper\.mjs \/usr\/local\/lib\/dsh\/dsh-privileged-helper\.mjs/)
assert.match(runtimeDockerfile, /COPY bin\/dsh-root \/usr\/local\/bin\/dsh-root/)
assert.match(runtimeDockerfile, /COPY bin\/dsh-apt-shim \/usr\/local\/bin\/apt$/m)
assert.match(runtimeDockerfile, /COPY bin\/dsh-sudo-shim \/usr\/local\/bin\/sudo$/m)
assert.match(runtimeDockerfile, /COPY bin\/hash-dsh-password \/usr\/local\/bin\/hash-dsh-password/)
assert.match(runtimeDockerfile, /COPY bin\/verify-dsh-hardening \/usr\/local\/bin\/verify-dsh-hardening/)
// update-dsh 拆成 root 用的真实脚本和面向 dsh 账户的入口包装。
assert.match(runtimeDockerfile, /COPY bin\/update-dsh\.sh \/usr\/local\/lib\/dsh\/update-dsh\.sh/)
assert.match(runtimeDockerfile, /COPY bin\/dsh-update-shim \/usr\/local\/bin\/update-dsh/)
assert.match(runtimeDockerfile, /ln -sf apt \/usr\/local\/bin\/apt-get/)
assert.match(runtimeDockerfile, /chown 0:1000 \/run\/dsh-priv \/run\/dsh-state/)
assert.match(runtimeDockerfile, /chmod 750 \/run\/dsh-priv/)
assert.match(runtimeDockerfile, /chmod 770 \/run\/dsh-state/)
assert.match(runtimeDockerfile, /chmod 700 \/root\/dsh-secret/)
assert.match(runtimeDockerfile, /DSH_RUN_USER=dsh/)
assert.match(runtimeDockerfile, /DSH_RESTART_REQUEST_FILE=\/run\/dsh-state\/restart/)
assert.match(runtimeDockerfile, /DSH_ROOT_HASH_FILE=\/root\/dsh-secret\/root\.hash/)

assert.equal(existsSync(new URL('../docker-compose.system.yml', import.meta.url)), false, 'legacy system compose overlay must not ship in the project')
assert.match(files.compose, /DSH_SYSTEM_PACKAGES_PERSISTENT:\s*"false"/)
assert.match(files.dockerfile, /DSH_SYSTEM_PACKAGES_PERSISTENT=false/)
assert.doesNotMatch(files.dshSh, /docker-compose\.system\.yml/)
assert.match(files.installSh, /delete[\s\S]*docker-compose\.system\.yml/)
assert.doesNotMatch(files.dockerfile, /dsh-toolchain-apt|DSH_TOOLCHAIN_ROOT|XDG_DATA_DIRS=.*toolchain/)
assert.match(files.dockerfile, /profile\.d\/dsh-toolchain\.sh/)

// --- 入口：root 只做降权准备，然后把身份交给 dsh ---
assert.match(files.entrypoint, /entrypoint requires UID 0/)
assert.match(files.entrypoint, /DSH_CONTAINER_USER="\$DSH_RUN_USER"/)
assert.match(files.entrypoint, /DSH_CONTAINER_UID="\$DSH_RUN_UID"/)
assert.match(files.entrypoint, /DSH_CAN_INSTALL_SYSTEM_PACKAGES=true/)
assert.match(files.entrypoint, /chpasswd -e/)
assert.match(files.entrypoint, /passwd -l root/)
assert.match(files.entrypoint, /passwd -l "\$DSH_RUN_USER"/)
assert.match(files.entrypoint, /mkdir -p \/run\/dsh-priv \/run\/dsh-state/)
assert.match(files.entrypoint, /chmod 750 \/run\/dsh-priv/)
assert.match(files.entrypoint, /chmod 770 \/run\/dsh-state/)
assert.match(files.entrypoint, /align_data_ownership/)
assert.match(files.entrypoint, /chown -R "\$expected"/)
assert.match(files.entrypoint, /exec \/usr\/local\/bin\/dsh-supervisor/)
assert.match(files.entrypoint, /mkdir -p \/workspace \/data\/dsh\/profiles \/data\/home \/data\/agents \/data\/mcp/)
assert.doesNotMatch(files.entrypoint, /gosu|node:node|id -u node|DSH_RUN_AS_ROOT/)
assert.doesNotMatch(files.entrypoint, /\/data\/home\/tmp/)

// --- Supervisor：DSH 与准备脚本降权，特权代理以 root 常驻 ---
assert.match(files.supervisor, /setpriv --reuid "\$DSH_RUN_UID" --regid "\$DSH_RUN_GID" --init-groups -- "\$DSH_EXECUTABLE" "\$@" &/)
assert.match(files.supervisor, /run_unprivileged node \/usr\/local\/bin\/prepare-profile-modules\.mjs/)
assert.match(files.supervisor, /run_unprivileged node \/usr\/local\/bin\/install-docker-control\.mjs/)
assert.match(files.supervisor, /run_unprivileged node \/usr\/local\/bin\/patch-profile-plugins\.mjs/)
assert.match(files.supervisor, /start_privileged_helper/)
assert.match(files.supervisor, /node "\$DSH_PRIVILEGED_HELPER" &/)
assert.match(files.supervisor, /kill -TERM "\$helper_pid"/)
assert.match(files.restart, /DSH_RESTART_REQUEST_FILE:-\/run\/dsh-state\/restart/)

// --- 特权代理：默认拒绝，apt 白名单，任意命令要密码且有失败锁定 ---
assert.match(files.helper, /if \(typeof process\.getuid !== 'function' \|\| process\.getuid\(\) !== 0\)/)
assert.match(files.helper, /validateAptCommand/)
assert.match(files.helper, /registerFailure/)
assert.match(files.helper, /lockoutRemainingSeconds/)
assert.match(files.helper, /timingSafeEqual/)
assert.match(files.helper, /requiresPassword: true/)
assert.match(files.helper, /fs\.chmodSync\(SOCKET_PATH, 0o660\)/)
assert.match(files.helper, /stdio: \['ignore', 'pipe', 'pipe'\]/)
assert.doesNotMatch(files.helper, /shell:\s*true/)
assert.match(files.client, /DSH_ROOT_PASSWORD/)
assert.match(files.aptShim, /exec \/usr\/local\/bin\/dsh-root "\$command_name" "\$@"/)
assert.match(files.aptShim, /exec "\/usr\/bin\/\$command_name" "\$@"/)
assert.match(files.sudoShim, /exec \/usr\/local\/bin\/dsh-root run "\$@"/)
assert.match(files.sudoShim, /不支持在命令前设置环境变量/)
assert.match(files.updateShim, /exec \/usr\/local\/bin\/dsh-root update-dsh "\$@"/)
assert.match(files.hashPassword, /openssl passwd -6 -stdin/)
assert.match(files.hashPassword, /tr -d '\\r'/)

// --- 自检脚本：把加固状态当成运行时事实来验证 ---
for (const capability of ['CAP_SYS_ADMIN', 'CAP_SYS_MODULE', 'CAP_SYS_PTRACE', 'CAP_MKNOD', 'CAP_NET_RAW']) {
  assert.ok(files.verifier.includes(capability), `verifier must know about ${capability}`)
}
assert.match(files.verifier, /NoNewPrivs/)
assert.match(files.verifier, /docker\.sock/)
assert.match(files.verifier, /core_pattern/)
assert.match(files.verifier, /cgroup/)
for (const check of ['boot-chain-immutable', 'signal-isolation', 'apt-removal-guard']) {
  assert.ok(files.verifier.includes(check), `verifier must report ${check}`)
}
// 启动链自检必须按属主/权限位判定，而不是 os.access——docker exec 默认是容器 root，
// root 带 DAC_OVERRIDE，os.access 会一律报可写，结论会随调用身份漂移。
const bootChainCheck = files.verifier.slice(
  files.verifier.indexOf('def check_boot_chain():'),
  files.verifier.indexOf('def check_signal_isolation():'),
)
assert.ok(bootChainCheck.length > 0, 'verifier 必须包含 check_boot_chain')
assert.match(bootChainCheck, /os\.lstat\(/)
assert.match(bootChainCheck, /S_IWOTH/)
assert.doesNotMatch(bootChainCheck, /os\.access\(/)
// 以 root 跑自检时必须先降权再探 apt，否则测的是真实 apt 而不是特权代理这条链路。
assert.match(files.verifier, /SETPRIV/)

// --- 卸载保护：免密 apt 不能变成一条命令的自毁开关 ---
//
// 一条 `apt-get purge -y nginx` 就能把反向代理从容器可写层里删掉：已经在跑的进程
// 靠已删除的 inode 继续活着，容器一直报 healthy，直到下一次重启才发现起不来，而且
// docker restart 救不回来，必须 recreate。所以策略层必须点名保护启动链依赖的包，
// 代理还要在执行前用 apt -s 把计划算一遍，拦住“卸一个名单外的包、让 apt 级联把
// Nginx 带走”的绕法。
const policy = await readFile('bin/dsh-privileged-policy.mjs', 'utf8')
assert.match(policy, /PROTECTED_PACKAGES/)
assert.match(policy, /APT_REMOVAL_SUBCOMMANDS/)
assert.match(policy, /export function findProtectedRemovals\(/)
for (const name of ['nginx', 'nginx-common', 'openssl', 'ca-certificates', 'mawk', 'passwd']) {
  assert.ok(policy.includes(`'${name}'`), `卸载保护名单必须覆盖 ${name}`)
}
for (const subcommand of ['remove', 'purge', 'autoremove', 'autopurge']) {
  assert.ok(
    policy.includes(`'${subcommand}'`),
    `${subcommand} 必须同时出现在子命令白名单与卸载子命令集合里`,
  )
}
assert.match(files.helper, /findProtectedRemovals/)
assert.match(files.helper, /function simulateApt\(/)
assert.match(files.helper, /findBlockedRemovalPlan/)
// 模拟必须真的加 -s，否则预检本身就会把系统改了。
assert.match(files.helper, /\['-s', \.\.\.resolved\.argv\.slice\(1\)\]/)

// apt-mark 也要走 shim。少了这条软链，它会以 dsh 身份直接跑真实 apt-mark，
// 写 /var/lib/apt/extended_states 时报 mkstemp Permission denied，而 skill 里
// 一直宣称 apt-mark 可用。
for (const command of ['apt-get', 'apt-mark']) {
  assert.ok(
    new RegExp(`ln -sf apt /usr/local/bin/${command}`).test(files.dockerfile),
    `${command} 必须软链到 apt shim`,
  )
}
assert.match(files.aptShim, /apt\|apt-get\|apt-cache\|apt-mark/)

// Nginx worker 降权，主进程留给 Supervisor 管理。
assert.match(files.nginx, /^user dsh;$/m)

for (const variable of [
  'DSH_SYSTEM_OS',
  'DSH_SYSTEM_RELEASE',
  'DSH_SYSTEM_ARCH',
  'DSH_SYSTEM_PACKAGE_ARCH',
  'DSH_SYSTEM_ABI',
  'DSH_SYSTEM_LIBC',
  'DSH_CONTAINER_USER',
  'DSH_CONTAINER_UID',
  'DSH_CONTAINER_GID',
  // 只渲染「干活需要」的事实：能不能装包、装了能不能留住、该往哪写。安全态势
  // （沙箱模式、宿主访问、Docker socket、root 口令、userns-remap）对开发零帮助，
  // 只会给 Agent 画出一张提权/逃逸地图，所以不再进 SKILL，也不再 gsub。
  'DSH_WRITABLE_PATHS',
  'DSH_SYSTEM_PACKAGES_PERSISTENT',
  'DSH_CAN_INSTALL_SYSTEM_PACKAGES',
  'DSH_PRIVILEGED_APT',
  // 旁路服务的部署形态要如实告诉 Agent：密钥不在它手里、出网必须过代理。
  // 不写进 SKILL 的话它只会反复去试注定被拒的直连。
  'DSH_MODEL_BROKER',
  'DSH_MODEL_BROKER_BASE',
  'DSH_EGRESS_MODE',
  'DSH_EGRESS_PROXY_URL',
]) {
  assert.match(files.entrypoint, new RegExp(variable))
  assert.match(files.skill, new RegExp('@@' + variable + '@@'))
}
// 占位符必须双向一致，单向断言只能挡住一半：模板里写了但 entrypoint 没 gsub，用户会
// 在 SKILL 里读到字面量 @@X@@；entrypoint 渲染了但模板里没有，则是这次新增的部署形态
// 压根没告诉 Agent。两种都是静默失败，所以两个方向一起断。
const skillPlaceholders = new Set([...files.skill.matchAll(/@@([A-Z0-9_]+)@@/g)].map(([, name]) => name))
const renderedPlaceholders = new Set(
  [...files.entrypoint.matchAll(/gsub\(\/@@([A-Z0-9_]+)@@\//g)].map(([, name]) => name),
)
assert.deepEqual(
  [...skillPlaceholders].sort(),
  [...renderedPlaceholders].sort(),
  'SKILL 模板的占位符与 entrypoint 的 gsub 必须一一对应',
)
for (const leaked of [
  'DSH_PERMISSION_MODE',
  'DSH_HOST_ACCESS',
  'DSH_DOCKER_SOCKET_AVAILABLE',
  'DSH_ROOT_PASSWORD_CONFIGURED',
  'DSH_USERNS_REMAP',
]) {
  assert.ok(!skillPlaceholders.has(leaked), `SKILL 不应再暴露安全态势占位符 ${leaked}`)
}
// 攻击面情报（能力白名单、提权 socket 路径、口令哈希位置、信任边界自白）只留在 README，
// 不进 Agent 的 skill：它们对开发零帮助，只对想搞破坏的 Agent 有帮助。
assert.doesNotMatch(files.skill, /DAC_OVERRIDE|helper\.sock|dsh-secret|\/etc\/shadow/)
assert.doesNotMatch(files.skill, /real trust boundary|userns|DSH_TRUSTED_HOSTS/)
// 但「你无法提权、需要 root 就报告给用户」这句必须留着，否则 Agent 会自己去试。
assert.match(files.skill, /You cannot escalate to root/)
assert.match(files.skill, /dsh-root run/)
assert.match(files.skill, /sudo apt-get install/)

// --- 安装器：自定义 root 密码 + 运行身份与加固核验 ---
assert.doesNotMatch(files.installSh, /--run-as-root|--normal-user|--no-root(?!-password)/)
assert.match(files.installSh, /remove_compose_env DSH_RUN_AS_ROOT/)
assert.match(files.installSh, /assert_dsh_hardening/)
assert.match(files.installSh, /期望 1000/)
assert.match(files.installSh, /verify-dsh-hardening/)
assert.match(files.installSh, /--root-password/)
assert.match(files.installSh, /--no-root-password/)
assert.match(files.installSh, /write_root_password/)
assert.match(files.installSh, /hash-dsh-password "\$PENDING_IMAGE"/)
assert.match(files.installSh, /data\/secret\/root\.hash/)
assert.match(files.installSh, /mkdir -p data\/auth data\/secret/)
assert.match(files.installSh, /sed -n 1p \/run\/dsh\.pid/)
assert.match(files.installSh, /ensure_external_network/)
assert.match(files.installSh, /已改回由 DSH 自己管理/)
assert.match(files.installSh, /list_proxy_network_candidates/)
assert.match(files.installSh, /network create --label dsh\.created-by=dsh-docker-installer/)
assert.doesNotMatch(files.installSh, /请先在反向代理面板中创建它/)
assert.doesNotMatch(files.installSh, /cat \/run\/dsh\.pid/)
assert.match(files.installSh, /未知参数/)
assert.doesNotMatch(files.installSh, /fetch origin main/)
assert.doesNotMatch(files.installSh, /merge --ff-only FETCH_HEAD/)
assert.match(files.installSh, /compose .*build dsh/)
assert.match(files.installSh, /compose .*up -d --no-build --force-recreate/)
assert.doesNotMatch(files.installSh, /DOCKER image prune/)
assert.doesNotMatch(files.dshSh, /PREPARE_SYSTEM_VOLUMES/)
assert.match(files.dshSh, /DOCKER exec dsh \/usr\/local\/bin\/update-dsh/)
assert.match(files.dshSh, /compose .*stop dsh/)
assert.match(files.dshSh, /up -d --no-build dsh/)
assert.doesNotMatch(files.dshSh, /up -d --force-recreate/)
// 默认 shell 就是 DSH 真正的运行身份，root shell 只保留给宿主机管理员。
assert.match(files.dshSh, /DOCKER exec -it -u dsh dsh bash -l/)
assert.match(files.dshSh, /root-shell\)/)
assert.match(files.dshSh, /DOCKER exec dsh \/usr\/local\/bin\/verify-dsh-hardening/)
assert.match(files.dshBat, /docker exec -it -u dsh dsh bash -l/)
assert.match(files.dshBat, /:root_shell/)
assert.match(files.dshBat, /docker exec dsh \/usr\/local\/bin\/verify-dsh-hardening/)

assert.match(files.dshBat, /docker exec dsh \/usr\/local\/bin\/update-dsh/)
// 两个脚本的每一条 compose 调用都要带上按 .env 算出来的叠加文件列表，所以服务名前面
// 多了一个变量；正则跟着放宽，但仍然钉住「只操作 dsh 及旁路服务，不 force-recreate」。
assert.match(files.dshBat, /docker compose .*stop dsh/)
assert.match(files.dshBat, /docker compose .*up -d --no-build dsh/)
assert.doesNotMatch(files.dshBat, /up -d --force-recreate/)
assert.doesNotMatch(files.dshBat, /docker image prune/)

// --- 叠加文件与旁路子命令：两个入口脚本必须完全对齐 ---
for (const script of ['dshSh', 'dshBat']) {
  // 每个叠加文件都要在「文件存在」的前提下才追加：老部署目录里没有它们，而
  // docker compose 遇到缺失的 -f 会直接失败退出，连 stop / logs / status 都会废掉。
  assert.match(files[script], /docker-compose\.keys\.yml/, `${script} must overlay the key broker compose file`)
  assert.match(files[script], /docker-compose\.isolated\.yml/, `${script} must overlay the isolated compose file`)
  assert.match(files[script], /DSH_MODEL_BROKER/, `${script} must read the broker switch from .env`)
  assert.match(files[script], /DSH_EGRESS_MODE/, `${script} must read the egress switch from .env`)
  // 旁路容器的 /status 只能这样探：它们是 read_only + 非 root，不能落盘。
  assert.match(files[script], /dsh-key-broker node -e/, `${script} keys must probe the broker over HTTP`)
  assert.match(files[script], /dsh-egress node -e/, `${script} egress must probe the proxy over HTTP`)
  // 探的必须是回环上的 /status：broker 8080、egress 3128。dsh.sh 把端口作为参数传给
  // 共用的 status_probe，dsh.bat 只能把整段源码展开成两个变量，所以两种写法都接受。
  assert.match(files[script], /127\.0\.0\.1:8080\/status|status_probe 8080/)
  assert.match(files[script], /127\.0\.0\.1:3128\/status|status_probe 3128/)
  // 三个旁路容器的存在与健康都要在 status 里报出来。
  assert.match(files[script], /dsh-ingress/, `${script} status must mention the ingress container`)
}

// 子命令集合必须一致：Windows 用户少一个 keys / egress 就等于拿不到密钥代理的状态，
// 而这两个脚本是唯一的运维入口。
const shellSubcommands = new Set(
  [...files.dshSh.matchAll(/^ {2}([a-z][a-z|-]*)\)$/gm)].flatMap(([, group]) => group.split('|')),
)
const batchSubcommands = new Set(
  [...files.dshBat.matchAll(/^if \/i "%ACTION%"=="([a-z-]+)" goto :/gm)].map(([, name]) => name),
)
// default 是 .bat 被双击（无参数）时的入口，dsh.sh 用 ${1:-start} 表达同一件事。
batchSubcommands.delete('default')
assert.deepEqual(
  [...shellSubcommands].sort(),
  [...batchSubcommands].sort(),
  'dsh.sh 与 dsh.bat 的子命令集合必须一致',
)
for (const subcommand of ['start', 'stop', 'restart', 'logs', 'status', 'update', 'verify', 'keys', 'egress', 'remove']) {
  assert.ok(shellSubcommands.has(subcommand), `dsh.sh must implement ${subcommand}`)
}

assert.match(files.installPs1, /compose build dsh/)
assert.match(files.installPs1, /Invoke-ComposeWithEnvFile/)
assert.match(files.installPs1, /Assert-DshHardening/)
assert.match(files.installPs1, /期望 1000/)
assert.match(files.installPs1, /verify-dsh-hardening/)
assert.match(files.installPs1, /\[string\]\$RootPassword = ''/)
assert.match(files.installPs1, /\[switch\]\$NoRootPassword/)
assert.match(files.installPs1, /hash-dsh-password \$imageRef/)
assert.match(files.installPs1, /data\\secret\\root\.hash/)
assert.match(files.installPs1, /sed -n 1p \/run\/dsh\.pid/)
assert.match(files.installPs1, /Assert-ExternalNetwork/)
assert.match(files.installPs1, /已改回由 DSH 自己管理/)
assert.match(files.installPs1, /Get-ProxyNetworkCandidates/)
assert.match(files.installPs1, /network create --label dsh\.created-by=dsh-docker-installer/)
assert.doesNotMatch(files.installPs1, /cat \/run\/dsh\.pid/)
assert.match(files.installPs1, /delete[\s\S]*docker-compose\.system\.yml/)
assert.doesNotMatch(files.installPs1, /\[switch\]\$Root\b|\[switch\]\$User\b/)
assert.match(files.installPs1, /Remove-ComposeEnvValue \$pendingEnvFile 'DSH_RUN_AS_ROOT'/)
assert.match(files.installPs1, /fetch origin main/)
assert.match(files.installPs1, /merge --ff-only FETCH_HEAD/)
assert.match(files.installPs1, /Invoke-ComposeWithEnvFile[\s\S]{0,160}?'up','-d','--no-build','--force-recreate'/)
assert.doesNotMatch(files.envExample, /DSH_RUN_AS_ROOT/)
assert.match(files.envExample, /DSH_PRIVILEGED_APT=/)
assert.match(files.dockerfile, /COPY dsh-home\/ \/usr\/local\/share\/dsh-home\//)
assert.match(files.dockerfile, /COPY nginx\/dsh-nginx\.conf \/usr\/local\/share\/dsh\/nginx\.conf/)
assert.doesNotMatch(files.entrypoint, /\/etc\/dsh-home/)

assert.match(files.installSh, /label=dsh\.created-by=dsh-docker-installer/)
assert.match(files.installPs1, /label=dsh\.created-by=dsh-docker-installer/)
assert.match(files.installSh, /{{ len \.Containers }}/)
assert.match(files.installPs1, /{{ len \.Containers }}/)

console.log('least-privilege runtime smoke: ok')
