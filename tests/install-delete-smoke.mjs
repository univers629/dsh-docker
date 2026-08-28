import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const install = await readFile(join(root, 'install.sh'), 'utf8')
const functionStart = install.indexOf('delete_project() {')
const functionEnd = install.indexOf('\nif [ "$ACTION" = delete ]', functionStart)
assert.ok(functionStart >= 0 && functionEnd > functionStart, 'cannot locate Linux delete function')
const deleteFunction = install.slice(functionStart, functionEnd)
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`].find(existsSync)
  : 'bash'
assert.ok(bash, 'bash is required for the delete smoke test')

const bashPath = (path) => process.platform === 'win32'
  ? path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
  : path

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-delete-smoke-'))
const project = join(sandbox, 'dsh-docker')
const dockerLog = join(sandbox, 'docker.log')
await mkdir(project)
for (const file of ['docker-compose.yml', 'docker-compose.system.yml', 'Dockerfile', 'install.sh']) {
  await writeFile(join(project, file), `${file}\n`)
}
await chmod(join(project, 'install.sh'), 0o755)

const harness = `set -euo pipefail
TARGET_DIR="$1"
MOCK_LOG="$2"
HOME="$3"
INTERACTIVE=true
confirm_delete() { :; }
container_exists() { return 1; }
DOCKER() {
  printf '%s\\n' "$*" >> "$MOCK_LOG"
  if [ "\${1:-}" = container ] && [ "\${2:-}" = ls ]; then printf '%s\\n' cid-project; fi
  if [ "\${1:-}" = image ] && [ "\${2:-}" = ls ]; then
    case "$*" in
      *"--format "*) printf '%s\\n' dsh:local ;;
      *"label=com.docker.compose.project="*) printf '%s\\n' img-project ;;
      *"label=org.opencontainers.image.title=dsh-docker"*) printf '%s\\n' img-title ;;
    esac
  fi
  if [ "\${1:-}" = volume ] && [ "\${2:-}" = ls ]; then printf '%s\\n' vol-project; fi
  if [ "\${1:-}" = network ] && [ "\${2:-}" = ls ]; then printf '%s\\n' net-project; fi
  if [ "\${1:-}" = network ] && [ "\${2:-}" = inspect ]; then printf '%s\\n' dsh-docker; fi
}
${deleteFunction}
delete_project
`

try {
  const result = spawnSync(bash, ['-c', harness, 'dsh-delete-smoke', bashPath(project), bashPath(dockerLog), bashPath(sandbox)], {
    cwd: sandbox,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(existsSync(project), false, 'Linux delete did not remove the project directory')
  const calls = await readFile(dockerLog, 'utf8')
  assert.match(calls, /compose -p dsh-docker .*down --volumes --remove-orphans/)
  assert.match(calls, /container ls -aq --filter label=com\.docker\.compose\.project=dsh-docker/)
  assert.match(calls, /image ls .*reference=dsh:\*/)
  assert.match(calls, /image ls -q --filter label=org\.opencontainers\.image\.title=dsh-docker/)
  assert.match(calls, /volume ls -q --filter label=com\.docker\.compose\.project=dsh-docker/)
  assert.match(calls, /network ls -q --filter label=com\.docker\.compose\.project=dsh-docker/)
  assert.match(calls, /builder prune -af/)
  assert.doesNotMatch(calls, /name=dsh|dpanel-local/)
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

// --- 二级分支：保留会话 / 工作目录 / 插件 ---
//
// 这一段盯的是"删完还能接着用"：三条保留路径必须原地留下，其它一切（源码、.env、
// 密钥、密码哈希、工具链）必须消失，并且要留下 .dsh-preserved 标记——下一次安装
// 靠它认出这个目录，否则会报"已存在但不是 Git 工程"。
const keepSandbox = await mkdtemp(join(tmpdir(), 'dsh-delete-keep-'))
const keepProject = join(keepSandbox, 'dsh-docker')
const keepLog = join(keepSandbox, 'docker.log')
await mkdir(keepProject)
for (const file of ['docker-compose.yml', 'Dockerfile', 'install.sh', '.env']) {
  await writeFile(join(keepProject, file), `${file}\n`)
}
await chmod(join(keepProject, 'install.sh'), 0o755)
const keepPaths = [
  'workspace/notes.txt',
  'data/dsh/sessions/2026-08-28.jsonl',
  'data/dsh/profiles/web/package.json',
]
const gonePaths = [
  'data/dsh/settings.yaml',
  'data/dsh/.credentials.yaml',
  'data/dsh/.dsh-runtime-owner',
  'data/broker/keys.json',
  'data/secret/root.hash',
  'data/home/.npmrc',
  'data/agents/agent.yaml',
  'data/mcp/servers.json',
]
for (const relative of [...keepPaths, ...gonePaths]) {
  await mkdir(join(keepProject, dirname(relative)), { recursive: true })
  await writeFile(join(keepProject, relative), `${relative}\n`)
}

try {
  const result = spawnSync(bash, ['-c', harness, 'dsh-delete-smoke', bashPath(keepProject), bashPath(keepLog), bashPath(keepSandbox)], {
    cwd: keepSandbox,
    encoding: 'utf8',
    env: { ...process.env, DSH_DELETE_KEEP: '1' },
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(existsSync(keepProject), true, '保留模式不能删掉整个工程目录')
  for (const relative of keepPaths) {
    assert.equal(existsSync(join(keepProject, relative)), true, `保留模式把 ${relative} 删掉了`)
  }
  for (const relative of gonePaths) {
    assert.equal(existsSync(join(keepProject, relative)), false, `保留模式没有删掉 ${relative}`)
  }
  for (const file of ['docker-compose.yml', 'Dockerfile', 'install.sh', '.env']) {
    assert.equal(existsSync(join(keepProject, file)), false, `保留模式没有删掉 ${file}`)
  }
  assert.equal(existsSync(join(keepProject, '.dsh-preserved')), true, '保留模式没有写下 .dsh-preserved 标记')
  assert.match(result.stdout, /已保留：.*workspace/)
} finally {
  await rm(keepSandbox, { recursive: true, force: true })
}

console.log('Linux installer delete smoke: ok')
