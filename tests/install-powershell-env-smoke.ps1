$ErrorActionPreference = 'Stop'

$installer = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\install.ps1'))
$start = $installer.IndexOf('function Set-ComposeEnvValue')
$end = $installer.IndexOf('function Get-ComposeEnvValue')
if ($start -lt 0 -or $end -le $start) { throw 'Cannot locate Set-ComposeEnvValue.' }
Invoke-Expression $installer.Substring($start, $end - $start)

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('dsh-powershell-env-' + [guid]::NewGuid().ToString('N'))
$envFile = Join-Path $temporary '.env'
$expected = @(
    'DSH_RUN_AS_ROOT=true'
    'DSH_ACCESS_MODE=local'
    'DSH_BIND_HOST=127.0.0.1'
    'DSH_TRUSTED_HOSTS='
    'DSH_DOCKER_NETWORK=dsh-private'
    'DSH_DOCKER_NETWORK_EXTERNAL=false'
)

function Write-TestEnvironment {
    Set-ComposeEnvValue $envFile 'DSH_RUN_AS_ROOT' 'true'
    Set-ComposeEnvValue $envFile 'DSH_ACCESS_MODE' 'local'
    Set-ComposeEnvValue $envFile 'DSH_BIND_HOST' '127.0.0.1'
    Set-ComposeEnvValue $envFile 'DSH_TRUSTED_HOSTS' ''
    Set-ComposeEnvValue $envFile 'DSH_DOCKER_NETWORK' 'dsh-private'
    Set-ComposeEnvValue $envFile 'DSH_DOCKER_NETWORK_EXTERNAL' 'false'
}

function Assert-TestEnvironment {
    $actual = @([IO.File]::ReadAllLines($envFile))
    if ($actual.Count -ne $expected.Count -or (Compare-Object $expected $actual -SyncWindow 0)) {
        throw "Unexpected .env content: $($actual -join '; ')"
    }
}

try {
    New-Item -ItemType Directory -Path $temporary | Out-Null

    Write-TestEnvironment
    Assert-TestEnvironment

    Write-TestEnvironment
    Assert-TestEnvironment

    [IO.File]::WriteAllText($envFile, (($expected -join '') + [Environment]::NewLine))
    Write-TestEnvironment
    Assert-TestEnvironment

    Write-Output 'PowerShell compose environment smoke: ok'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
