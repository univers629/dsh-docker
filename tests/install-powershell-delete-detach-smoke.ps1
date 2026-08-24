$ErrorActionPreference = 'Stop'

# 验证 install.ps1 delete 在脚本自身位于待删除目录内时，会先复制到临时目录再执行删除。
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('dsh-powershell-delete-detach-' + [guid]::NewGuid().ToString('N'))
$project = Join-Path $temporary 'dsh-docker'
$binDir = Join-Path $temporary 'bin'
$dockerLog = Join-Path $temporary 'docker.log'
$originalPath = $env:PATH
try {
    New-Item -ItemType Directory -Path $project -Force | Out-Null
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'install.ps1') -Destination (Join-Path $project 'install.ps1')
    foreach ($file in @('docker-compose.yml','Dockerfile','dsh.bat')) {
        [IO.File]::WriteAllText((Join-Path $project $file), $file)
    }
    $shim = @(
        '@echo off',
        'echo %* >> "%DSH_MOCK_LOG%"',
        'if "%1"=="info" (echo linux& exit /b 0)',
        'if "%1"=="container" if "%2"=="inspect" exit /b 1',
        'exit /b 0'
    ) -join [Environment]::NewLine
    [IO.File]::WriteAllText((Join-Path $binDir 'docker.cmd'), $shim)
    [IO.File]::WriteAllText($dockerLog, '')

    $env:DSH_MOCK_LOG = $dockerLog
    $env:PATH = "$binDir;$originalPath"
    $env:DSH_DELETE_CONFIRMED = '1'
    $hostExe = (Get-Process -Id $PID).Path
    if (-not $hostExe) { $hostExe = 'powershell.exe' }
    $output = (& $hostExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $project 'install.ps1') -DshAction delete -Dir $project 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Installer delete failed with exit code ${LASTEXITCODE}:`n$output" }
    $match = [regex]::Match($output, '已复制到 (\S+) 后')
    if (-not $match.Success) { throw "Installer did not run the delete from a copy outside the deleted directory:`n$output" }
    $tempScript = $match.Groups[1].Value
    if (Test-Path -LiteralPath $tempScript) { throw "Temporary installer copy was left behind at $tempScript" }
    if (Test-Path -LiteralPath $project) { throw "Windows delete did not remove the project directory.`n$output" }
    $calls = [IO.File]::ReadAllText($dockerLog)
    foreach ($pattern in @(
        'compose -p dsh-docker .*down --volumes --remove-orphans',
        'builder prune -af'
    )) {
        if ($calls -notmatch $pattern) { throw "Missing Docker call matching $pattern`n$calls" }
    }
    if ($calls -match 'name=dsh|dpanel-local') { throw "Unsafe Docker filter or external network call found:`n$calls" }
    Write-Output 'PowerShell installer delete detach smoke: ok'
} finally {
    $env:PATH = $originalPath
    $env:DSH_MOCK_LOG = $null
    $env:DSH_DELETE_CONFIRMED = $null
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
