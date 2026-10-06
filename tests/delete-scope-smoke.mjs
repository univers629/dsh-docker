// 回归：删除流程必须覆盖 DSH 创建的全部资源类型。
//
// 这是对 delete_project 的结构验证——逐项确认每一类资源都有对应的清理动作。
// 删除不可恢复：漏掉一类就会在宿主上留下孤儿容器/卷/网络，用户以为卸干净了、
// 磁盘却还在涨。
//
// 命名边界的**行为**验证在 tests/user-instances-cleanup-smoke.mjs 里（那里用
// 回放式 docker 桩断言「只删 DSH 自己的」）。本文件只回答「有没有这一类动作」，
// 两个文件合起来才构成完整覆盖。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installSh = readFileSync(join(root, 'install.sh'), 'utf8')

const deleteSlice = installSh.slice(
  installSh.indexOf('delete_project() {'),
  installSh.indexOf('prune_project_keep() {'),
)
assert.ok(deleteSlice.length > 0, '应能定位 delete_project')

// DSH 在宿主上创建的每一类资源，都必须有对应的清理动作。
// 左列是断言的正则，右列说明它覆盖哪一类资源。
const requiredSteps = [
  [
    /compose -p "\$project_name" "\$\{compose_files\[@\]\}" down --volumes --remove-orphans/,
    'compose 服务与它声明的网络',
  ],
  [
    /label=com\.docker\.compose\.project=\$project_name/,
    '按 compose 项目标签清容器、镜像、卷、网络',
  ],
  [
    /for container_name in dsh dsh-key-broker dsh-key-admin dsh-egress dsh-ingress/,
    '按名字兜底删已知容器（叠加文件缺失时的补救）',
  ],
  [
    /cleanup_user_instances/,
    '每用户实例资源（无 Docker 标签，只能按命名规则）',
  ],
  [
    /label=org\.opencontainers\.image\.title=dsh-docker/,
    '按镜像 OCI 标签清预构建镜像',
  ],
  [
    /label=dsh\.created-by=dsh-docker-installer/,
    '安装器自己创建的外部代理网络',
  ],
  [/builder prune -af/, '构建缓存'],
  [/prune_project_keep|rm -rf -- "\$target_abs"/, '工程目录（含保留分支）'],
]
for (const [re, label] of requiredSteps) {
  assert.match(deleteSlice, re, `删除流程缺少对「${label}」的清理`)
}

// 每用户实例的命名规则必须与 dsh-instances 的实现一致；两边漂移会造成漏删。
const policy = readFileSync(join(root, 'bin', 'dsh-instances-policy.mjs'), 'utf8')
const instances = readFileSync(join(root, 'bin', 'dsh-instances.mjs'), 'utf8')
const cleanFn = installSh.slice(
  installSh.indexOf('cleanup_user_instances() {'),
  installSh.indexOf('delete_project() {'),
)
assert.ok(cleanFn.length > 0, '应能定位 cleanup_user_instances')

assert.match(policy, /return `dsh-u\$\{uid - UID_BASE \+ 1\}`/, '实例容器命名应为 dsh-u<N>')
assert.match(cleanFn, /dsh-u\*/, 'cleanup_user_instances 应按 dsh-u* 匹配容器')

assert.match(instances, /volumePrefix: process\.env\.DSH_INSTANCE_VOLUME_PREFIX \?\? 'dsh-user'/, '卷前缀应为 dsh-user')
assert.match(cleanFn, /DSH_INSTANCE_VOLUME_PREFIX:-dsh-user/, 'cleanup_user_instances 应采用同一个卷前缀')

assert.match(instances, /network: process\.env\.DSH_INSTANCE_NETWORK \?\? 'dsh-instances-net'/, '实例网络前缀应为 dsh-instances-net')
assert.match(cleanFn, /DSH_INSTANCE_NETWORK:-dsh-instances-net/, 'cleanup_user_instances 应采用同一个网络前缀')

// 只做锚定匹配，禁止通配删除：写宽一个字符就可能删掉别人的资源。
assert.match(
  cleanFn,
  /case "\$name" in\s*\n\s*dsh-u\*\) case "\$num" in ''\|\*\[!0-9\]\*\) continue/,
  '实例容器必须按「前缀 + 纯数字」严格匹配，不能通配',
)
assert.ok(
  !/DOCKER (container|volume|network) (rm|prune)[^\n]*\*/.test(cleanFn),
  'cleanup_user_instances 不得对通配符做删除',
)

console.log('delete scope smoke: ok（删除流程覆盖 DSH 全部资源类型）')
