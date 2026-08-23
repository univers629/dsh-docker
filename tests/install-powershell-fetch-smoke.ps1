$ErrorActionPreference = 'Stop'

$installer = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\install.ps1'))
$start = $installer.IndexOf('function Get-GitHubSshKeys')
$end = $installer.IndexOf('function Fetch-ArchiveProject')
if ($start -lt 0 -or $end -le $start) { throw 'Cannot locate PowerShell Git helper functions.' }
Invoke-Expression $installer.Substring($start, $end - $start)

function Get-GitHubSshKeys { return @('C:\Users\tester\.ssh\github') }

$GitHubSshUrl = 'ssh://git@ssh.github.com:443/univers629/dsh-docker.git'
$GitHubHttpsUrl = 'https://github.com/univers629/dsh-docker.git'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('dsh-powershell-fetch-' + [guid]::NewGuid().ToString('N'))
$fakeBin = Join-Path $temporary 'bin'
$log = Join-Path $temporary 'git.log'
$originalPath = $env:PATH
$originalSsh = $env:GIT_SSH_COMMAND

try {
    New-Item -ItemType Directory -Path $fakeBin -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fakeBin 'git.cmd'), "@echo off`r`necho %GIT_SSH_COMMAND%^|%*>>`"$log`"`r`nif `"%GIT_SSH_COMMAND%`"==`"`" exit /b 1`r`nexit /b 0`r`n")
    $env:PATH = "$fakeBin;$originalPath"
    $env:GIT_SSH_COMMAND = 'original-ssh-command'

    if (-not (Invoke-GitHubClone 'target-dir')) { throw 'Mock HTTPS-to-SSH clone fallback did not succeed.' }
    $calls = @([IO.File]::ReadAllLines($log))
    if ($calls.Count -ne 2 -or $calls[0] -notmatch '^\|clone https://github\.com/univers629/dsh-docker\.git target-dir$') {
        throw "HTTPS was not the first Git call: $($calls -join '; ')"
    }
    if ($calls[1] -notmatch 'BatchMode=yes.*github.*IdentitiesOnly=yes\|clone ssh://git@ssh\.github\.com:443/univers629/dsh-docker\.git target-dir') {
        throw "SSH key was not the second Git call: $($calls -join '; ')"
    }
    if ($env:GIT_SSH_COMMAND -ne 'original-ssh-command') { throw 'GIT_SSH_COMMAND was not restored.' }
    Write-Output 'PowerShell HTTPS-to-SSH fallback smoke: ok'
} finally {
    $env:PATH = $originalPath
    if ($null -eq $originalSsh) { Remove-Item Env:GIT_SSH_COMMAND -ErrorAction SilentlyContinue }
    else { $env:GIT_SSH_COMMAND = $originalSsh }
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
