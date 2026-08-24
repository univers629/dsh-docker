import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const bash = process.platform === 'win32'
  ? [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`].find(existsSync)
  : 'bash'
assert.ok(bash, 'bash is required for the delete detach smoke test')

const bashPath = (path) => process.platform === 'win32'
  ? path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
  : path

const installer = await readFile(join(root, 'install.sh'), 'utf8')

const dockerMock = [
  '#!/usr/bin/env bash',
  'printf "%s\\n" "$*" >> "$DSH_MOCK_LOG"',
  'if [ "$1" = info ]; then exit 0; fi',
  'if [ "$1" = container ] && [ "$2" = inspect ]; then exit 1; fi',
  'exit 0',
  '',
].join('\n')

const harness = [
  'set -euo pipefail',
  'export PATH="$1:$PATH"',
  'export DSH_MOCK_LOG="$2"',
  'export DSH_DELETE_CONFIRMED=1',
  'cd "$3"',
  'script="$4"',
  'shift 4',
  'bash "$script" delete "$@"',
].join('\n')

const runScenario = async (name, { fromInside = false, scriptOutside = false } = {}) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-delete-detach-'))
  const project = join(sandbox, 'dsh-docker')
  const binDir = join(sandbox, 'bin')
  const log = join(sandbox, 'docker.log')
  try {
    await mkdir(project)
    await mkdir(binDir)
    const installerPath = scriptOutside ? join(sandbox, 'install.sh') : join(project, 'install.sh')
    await writeFile(installerPath, installer)
    await chmod(installerPath, 0o755)
    if (scriptOutside) await writeFile(join(project, 'install.sh'), 'stub\n')
    for (const file of ['docker-compose.yml', 'Dockerfile', 'dsh.sh']) {
      await writeFile(join(project, file), `${file}\n`)
    }
    await writeFile(join(binDir, 'docker'), dockerMock)
    await chmod(join(binDir, 'docker'), 0o755)
    await writeFile(log, '')

    const cwd = fromInside ? project : sandbox
    const scriptArg = scriptOutside || fromInside ? './install.sh' : 'dsh-docker/install.sh'
    const extraArgs = scriptOutside ? ['--dir', 'dsh-docker'] : []
    const result = spawnSync(bash, [
      '-c',
      harness,
      'dsh-delete-detach-smoke',
      bashPath(binDir),
      bashPath(log),
      bashPath(cwd),
      scriptArg,
      ...extraArgs,
    ], { cwd: sandbox, encoding: 'utf8' })

    assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`)
    const tempCopy = /已复制到 (\S+) 后/.exec(result.stdout)?.[1]
    if (scriptOutside) {
      assert.equal(tempCopy, undefined, `${name}: installer copied itself without needing to`)
    } else {
      assert.ok(tempCopy, `${name}: installer did not run the delete from a copy outside the deleted directory`)
      const cleanupCheck = spawnSync(bash, ['-c', 'test ! -e "$1"', 'dsh-delete-detach-smoke', tempCopy], { encoding: 'utf8' })
      assert.equal(cleanupCheck.status, 0, `${name}: temporary installer copy was left behind at ${tempCopy}`)
    }
    assert.equal(existsSync(project), false, `${name}: project directory was not removed`)
    const calls = await readFile(log, 'utf8')
    assert.match(calls, /compose -p dsh-docker .*down --volumes --remove-orphans/, name)
    assert.match(calls, /builder prune -af/, name)
    assert.doesNotMatch(calls, /name=dsh|dpanel-local/, name)
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
}

await runScenario('installer in project, run from parent directory')
await runScenario('installer in project, run from project directory', { fromInside: true })
await runScenario('installer outside project', { scriptOutside: true })

console.log('Linux installer delete detach smoke: ok')
