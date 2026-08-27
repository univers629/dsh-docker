import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// install.sh 借镜像里的 node 合并 keys.json。model-key 这条路径不走 obtain_dsh_image，
// 所以 PENDING_IMAGE 是空的——以前那里直接用它，结果是 docker: invalid reference format，
// 并且报错文案只说"无法合并"。这一份按 PowerShell 侧的做法把相关函数区间取出来真跑，
// 覆盖镜像选取的三级回退和合并时实际发出的 docker 命令行。

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installer = await readFile(join(root, 'install.sh'), 'utf8')
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`].find(existsSync)
  : 'bash'

assert.ok(bash, 'bash is required for the node-tool-image smoke test')

const region = (from, to) => {
  const start = installer.indexOf(from)
  const end = installer.indexOf(to)
  assert.ok(start >= 0 && end > start, `cannot locate installer region: ${from} .. ${to}`)
  return installer.slice(start, end)
}

// 静态断言：那条 docker run 不能再直接吃 PENDING_IMAGE，否则 model-key 路径必然复现。
const mergeRegion = region("BROKER_MERGE_SCRIPT='", '# --no-model-broker 必须真的把密钥清掉')
assert.ok(!mergeRegion.includes('--entrypoint node "$PENDING_IMAGE"'), 'merge 仍在直接使用 PENDING_IMAGE')
assert.match(mergeRegion, /image="\$\(node_tool_image\)"/)
// model-key 动作的 seed 也必须走同一个回退，否则"补填密钥"写不出模型配置。
assert.ok(installer.includes('seed_dsh_model_settings "$(node_tool_image)"'), 'model-key 的 seed 没走 node_tool_image')

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-node-image-smoke-'))
const harness = join(sandbox, 'harness.sh')
const dockerLog = join(sandbox, 'docker.log')
await mkdir(join(sandbox, 'data', 'broker'), { recursive: true })
await writeFile(join(sandbox, 'data', 'broker', 'keys.json'),
  JSON.stringify({ version: 1, upstreams: [{ name: 'kept', baseUrl: 'https://kept.invalid', key: 'sk-kept' }] }, null, 2) + '\n')

const script = [
  'set -eu',
  'DEFAULT_PREBUILT_IMAGE="ghcr.io/univers629/dsh-docker:latest"',
  'PENDING_IMAGE=""',
  'MOCK_INSPECT_IMAGE="${MOCK_INSPECT_IMAGE:-}"',
  '# 只记录命令行：合并的输入里带着真实密钥，测试也不该把它落到日志里。',
  'DOCKER() {',
  '  if [ "${1:-}" = container ] && [ "${2:-}" = inspect ]; then',
  '    [ -n "$MOCK_INSPECT_IMAGE" ] || return 1',
  '    printf \'%s\\n\' "$MOCK_INSPECT_IMAGE"',
  '    return 0',
  '  fi',
  '  printf \'%s\\n\' "$*" >> "$MOCK_DOCKER_LOG"',
  '  cat > /dev/null',
  '  printf \'%s\' \'{"version": 1, "upstreams": [{"name": "merged"}]}\'',
  '}',
  '# command -v node 是唯一决定走宿主 node 还是借镜像 node 的判断，这里把它按需变成"没有"。',
  'command() {',
  '  if [ "${1:-}" = -v ] && [ "${2:-}" = node ] && [ "${MOCK_NO_NODE:-}" = 1 ]; then return 1; fi',
  '  builtin command "$@"',
  '}',
  'get_compose_env() {',
  '  local key="$1" fallback="$2" value',
  '  value="$(awk -F= -v key="$key" \'$1 == key { sub(/^[^=]*=/, ""); print; exit }\' .env 2>/dev/null || true)"',
  '  printf \'%s\' "${value:-$fallback}"',
  '}',
].join('\n')

await writeFile(harness, [
  script,
  region('json_escape() {', 'validate_upstream_name() {'),
  mergeRegion,
  'case "${MOCK_CASE}" in',
  '  image) node_tool_image ;;',
  '  merge) merge_broker_config \'[{"name": "incoming"}]\' ;;',
  'esac',
  '',
].join('\n'))

const run = (mockCase, env = {}) => spawnSync(bash, [harness], {
  cwd: sandbox,
  encoding: 'utf8',
  env: { ...process.env, MOCK_CASE: mockCase, MOCK_DOCKER_LOG: dockerLog, ...env },
})

try {
  // 1) .env 里记着的镜像优先：model-key 路径唯一可靠的线索就是它。
  await writeFile(join(sandbox, '.env'), 'DSH_IMAGE=ghcr.io/univers629/dsh-docker:pinned\nDSH_MODEL_BROKER=on\n')
  let result = run('image')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'ghcr.io/univers629/dsh-docker:pinned')

  // 2) .env 没有这一行时退回现有 dsh 容器实际在用的镜像。
  await writeFile(join(sandbox, '.env'), 'DSH_MODEL_BROKER=on\n')
  result = run('image', { MOCK_INSPECT_IMAGE: 'dsh:local' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'dsh:local')

  // 3) 两处都问不出来时才用预构建镜像。绝不能是空串：那正是 invalid reference format。
  result = run('image')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'ghcr.io/univers629/dsh-docker:latest')

  // 宿主没有 node 时的合并：docker run 必须拿到一个非空镜像引用。
  await writeFile(join(sandbox, '.env'), 'DSH_IMAGE=ghcr.io/univers629/dsh-docker:pinned\n')
  await rm(dockerLog, { force: true })
  result = run('merge', { MOCK_NO_NODE: '1' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /"name": "merged"/)
  const logged = await readFile(dockerLog, 'utf8')
  assert.match(logged, /^run --rm -i --entrypoint node ghcr\.io\/univers629\/dsh-docker:pinned -e /m)
  assert.ok(!/--entrypoint node -e /.test(logged), 'docker run 收到了空镜像引用')
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

console.log('install node-tool-image smoke: ok')
