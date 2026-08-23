$ErrorActionPreference = 'Stop'

$installer = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\install.ps1'))
$start = $installer.IndexOf('function Get-DockerEngineOs')
$end = $installer.IndexOf('function Get-GitHubSshKeys')
if ($start -lt 0 -or $end -le $start) { throw 'Cannot locate Docker Desktop helper functions.' }
Invoke-Expression $installer.Substring($start, $end - $start)

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('dsh-powershell-runtime-' + [guid]::NewGuid().ToString('N'))
$fakeBin = Join-Path $temporary 'bin'
$state = Join-Path $temporary 'engine.txt'
$originalPath = $env:PATH
$originalState = $env:DSH_DOCKER_TEST_STATE

try {
    New-Item -ItemType Directory -Path $fakeBin -Force | Out-Null
    $mock = @"
@echo off
if not "%1"=="info" goto desktop
if not exist "%DSH_DOCKER_TEST_STATE%" exit /b 1
type "%DSH_DOCKER_TEST_STATE%"
exit /b 0
:desktop
if not "%1"=="desktop" exit /b 1
if not "%2"=="start" exit /b 1
echo linux>"%DSH_DOCKER_TEST_STATE%"
exit /b 0
"@
    [IO.File]::WriteAllText((Join-Path $fakeBin 'docker.cmd'), $mock)
    $env:PATH = "$fakeBin;$originalPath"
    $env:DSH_DOCKER_TEST_STATE = $state

    Ensure-DockerEngine
    if (([IO.File]::ReadAllText($state)).Trim() -ne 'linux') { throw 'Docker Desktop was not started.' }

    [IO.File]::WriteAllText($state, 'windows')
    $rejectedWindowsEngine = $false
    try { Ensure-DockerEngine } catch { $rejectedWindowsEngine = $_.Exception.Message -match 'Linux' }
    if (-not $rejectedWindowsEngine) { throw 'Windows Containers mode was not rejected.' }

    Write-Output 'PowerShell Docker runtime smoke: ok'
} finally {
    $env:PATH = $originalPath
    if ($null -eq $originalState) { Remove-Item Env:DSH_DOCKER_TEST_STATE -ErrorAction SilentlyContinue }
    else { $env:DSH_DOCKER_TEST_STATE = $originalState }
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
