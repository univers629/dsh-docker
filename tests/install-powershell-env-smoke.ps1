$ErrorActionPreference = 'Stop'

$installer = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\install.ps1'))
$start = $installer.IndexOf('function Set-ComposeEnvValue')
$end = $installer.IndexOf('function Ask')
if ($start -lt 0 -or $end -le $start) { throw 'Cannot locate installer environment helpers.' }
Invoke-Expression $installer.Substring($start, $end - $start)

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('dsh-powershell-env-' + [guid]::NewGuid().ToString('N'))
$envFile = Join-Path $temporary '.env'
$dockerLog = Join-Path $temporary 'docker.log'
$originalAccess = [Environment]::GetEnvironmentVariable('DSH_ACCESS_MODE', 'Process')
$accessExisted = Test-Path -LiteralPath Env:DSH_ACCESS_MODE
$expected = @(
    'DSH_ACCESS_MODE=local'
    'DSH_BIND_HOST=127.0.0.1'
    'DSH_TRUSTED_HOSTS='
    'DSH_DOCKER_NETWORK=dsh-private'
    'DSH_DOCKER_NETWORK_EXTERNAL=false'
)

function Write-TestEnvironment {
    Set-ComposeEnvValue $envFile 'DSH_RUN_AS_ROOT' 'false'
    Remove-ComposeEnvValue $envFile 'DSH_RUN_AS_ROOT'
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

$script:MockUid = '0'
function docker {
    $dockerArguments = @($args)
    $global:LASTEXITCODE = 0
    if ($dockerArguments[0] -eq 'exec') { return $script:MockUid }
    [IO.File]::WriteAllText($dockerLog, ("$env:DSH_ACCESS_MODE|" + ($dockerArguments -join ' ')))
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

    $env:DSH_ACCESS_MODE = 'basic'
    $exitCode = Invoke-ComposeWithEnvFile -Path $envFile -Arguments @('up','-d','--force-recreate') -EnvironmentKeys @('DSH_ACCESS_MODE')
    if ($exitCode -ne 0) { throw 'Mock Compose invocation failed.' }
    $call = [IO.File]::ReadAllText($dockerLog)
    if ($call -notmatch '^\|compose --env-file .*\.env up -d --force-recreate') { throw "Host environment was not isolated: $call" }
    if ($env:DSH_ACCESS_MODE -ne 'basic') { throw 'Host environment was not restored.' }

    Write-Output 'PowerShell compose environment smoke: ok'
} finally {
    if ($accessExisted) { [Environment]::SetEnvironmentVariable('DSH_ACCESS_MODE', $originalAccess, 'Process') }
    else { [Environment]::SetEnvironmentVariable('DSH_ACCESS_MODE', $null, 'Process') }
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
