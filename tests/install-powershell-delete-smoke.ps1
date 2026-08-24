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
    Remove-DshProject
    if (Test-Path -LiteralPath $project) { throw 'Windows delete did not remove the project directory.' }
    $calls = [IO.File]::ReadAllText($dockerLog)
    foreach ($pattern in @(
        'compose -p dsh-docker .*down --volumes --remove-orphans',
        'container ls -aq --filter label=com\.docker\.compose\.project=dsh-docker',
        'image ls .*reference=dsh:\*',
        'image ls -q --filter label=org\.opencontainers\.image\.title=dsh-docker',
        'volume ls -q --filter label=com\.docker\.compose\.project=dsh-docker',
        'network ls -q --filter label=com\.docker\.compose\.project=dsh-docker',
        'builder prune -af'
    )) {
        if ($calls -notmatch $pattern) { throw "Missing Docker call matching $pattern`n$calls" }
    }
    if ($calls -match 'name=dsh|dpanel-local') { throw "Unsafe Docker filter or external network call found:`n$calls" }
    Write-Output 'PowerShell installer delete smoke: ok'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
