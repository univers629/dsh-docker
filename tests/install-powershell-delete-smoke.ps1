$ErrorActionPreference = 'Stop'

$installer = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\install.ps1'))
$start = $installer.IndexOf('function Test-DshContainer')
$end = $installer.IndexOf('function Get-DockerDesktopExecutable')
if ($start -lt 0 -or $end -le $start) { throw 'Cannot locate installer delete helpers.' }
Invoke-Expression $installer.Substring($start, $end - $start)

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('dsh-powershell-delete-' + [guid]::NewGuid().ToString('N'))
$project = Join-Path $temporary 'dsh-docker'
$dockerLog = Join-Path $temporary 'docker.log'
$script:NonInteractive = $false
$script:Dir = $project
# 这一段测的是"全部删除"，环境里残留的 DSH_DELETE_KEEP 会让它悄悄走成保留模式。
$env:DSH_DELETE_KEEP = $null

function Confirm-DshDelete { }
function docker {
    $arguments = @($args)
    [IO.File]::AppendAllText($dockerLog, (($arguments -join ' ') + [Environment]::NewLine))
    $global:LASTEXITCODE = 0
    if ($arguments[0] -eq 'container' -and $arguments[1] -eq 'inspect') { $global:LASTEXITCODE = 1; return }
    if ($arguments[0] -eq 'container' -and $arguments[1] -eq 'ls') { return 'cid-project' }
    if ($arguments[0] -eq 'image' -and $arguments[1] -eq 'ls') {
        $line = $arguments -join ' '
        if ($line -match 'reference=dsh:\*') { return 'dsh:local' }
        if ($line -match 'org\.opencontainers\.image\.title=dsh-docker') { return 'img-title' }
        return 'img-project'
    }
    if ($arguments[0] -eq 'volume' -and $arguments[1] -eq 'ls') { return 'vol-project' }
    if ($arguments[0] -eq 'network' -and $arguments[1] -eq 'ls') { return 'net-project' }
    if ($arguments[0] -eq 'network' -and $arguments[1] -eq 'inspect') { return 'dsh-docker' }
}

try {
    New-Item -ItemType Directory -Path $project -Force | Out-Null
    foreach ($file in @('docker-compose.yml','docker-compose.system.yml','Dockerfile','install.ps1')) {
        [IO.File]::WriteAllText((Join-Path $project $file), $file)
    }
    # 预构建安装的镜像引用只记在 .env 里，删除必须按它精确清理。
    [IO.File]::WriteAllText((Join-Path $project '.env'), "DSH_ACCESS_MODE=local`nDSH_IMAGE=ghcr.io/univers629/dsh-docker:latest`n")
    Remove-DshProject
    if (Test-Path -LiteralPath $project) { throw 'Windows delete did not remove the project directory.' }
    $calls = [IO.File]::ReadAllText($dockerLog)
    foreach ($pattern in @(
        'compose -p dsh-docker .*down --volumes --remove-orphans',
        'container ls -aq --filter label=com\.docker\.compose\.project=dsh-docker',
        'image rm -f ghcr\.io/univers629/dsh-docker:latest',
        'image ls .*reference=dsh:\*',
        'image ls -q --filter label=org\.opencontainers\.image\.title=dsh-docker',
        'volume ls -q --filter label=com\.docker\.compose\.project=dsh-docker',
        'network ls -q --filter label=com\.docker\.compose\.project=dsh-docker',
        'builder prune -af'
    )) {
        if ($calls -notmatch $pattern) { throw "Missing Docker call matching $pattern`n$calls" }
    }
    if ($calls -match 'name=dsh|dpanel-local') { throw "Unsafe Docker filter or external network call found:`n$calls" }
    # --- 二级分支：保留会话 / 工作目录 / 插件 ---
    $keepProject = Join-Path $temporary 'dsh-docker-keep'
    $script:Dir = $keepProject
    New-Item -ItemType Directory -Path $keepProject -Force | Out-Null
    foreach ($file in @('docker-compose.yml','Dockerfile','install.ps1','.env')) {
        [IO.File]::WriteAllText((Join-Path $keepProject $file), $file)
    }
    $keepPaths = @('workspace\notes.txt', 'data\dsh\sessions\2026-08-28.jsonl', 'data\dsh\profiles\web\package.json')
    $gonePaths = @('data\dsh\settings.yaml', 'data\dsh\.credentials.yaml', 'data\broker\keys.json', 'data\secret\root.hash', 'data\home\.npmrc')
    foreach ($relative in ($keepPaths + $gonePaths)) {
        $full = Join-Path $keepProject $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $full) -Force | Out-Null
        [IO.File]::WriteAllText($full, $relative)
    }
    $env:DSH_DELETE_KEEP = '1'
    try { Remove-DshProject } finally { $env:DSH_DELETE_KEEP = $null }
    if (-not (Test-Path -LiteralPath $keepProject)) { throw '保留模式不能删掉整个工程目录。' }
    foreach ($relative in $keepPaths) {
        if (-not (Test-Path -LiteralPath (Join-Path $keepProject $relative))) { throw "保留模式把 $relative 删掉了。" }
    }
    foreach ($relative in ($gonePaths + @('docker-compose.yml','Dockerfile','install.ps1','.env'))) {
        if (Test-Path -LiteralPath (Join-Path $keepProject $relative)) { throw "保留模式没有删掉 $relative。" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $keepProject '.dsh-preserved'))) { throw '保留模式没有写下 .dsh-preserved 标记。' }

    Write-Output 'PowerShell installer delete smoke: ok'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
