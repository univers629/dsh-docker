$ErrorActionPreference = 'Stop'

$installer = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\install.ps1'))
$start = $installer.IndexOf('function Get-ProxyNetworkCandidates')
$end = $installer.IndexOf('function Get-DockerEngineOs')
if ($start -lt 0 -or $end -le $start) { throw 'Cannot locate installer network helpers.' }
Invoke-Expression $installer.Substring($start, $end - $start)

$script:MockNetworks = @('bridge','host','none')
$script:DockerCalls = New-Object System.Collections.Generic.List[string]
$script:AskAnswer = $true

function docker {
    $dockerArguments = @($args)
    $script:DockerCalls.Add($dockerArguments -join ' ')
    $global:LASTEXITCODE = 0
    if ($dockerArguments[0] -eq 'network') {
        switch ($dockerArguments[1]) {
            'ls' { return $script:MockNetworks }
            'inspect' {
                if ($script:MockNetworks -contains $dockerArguments[2]) { return '[]' }
                $global:LASTEXITCODE = 1
                return
            }
            'create' {
                $script:MockNetworks += $dockerArguments[-1]
                return $dockerArguments[-1]
            }
        }
    }
}

function Ask-YesNo { param([string]$Message, [bool]$Default = $true) return $script:AskAnswer }

$candidates = Get-ProxyNetworkCandidates
if ($candidates.Count -ne 0) { throw "Built-in networks must not be offered as proxy candidates: $($candidates -join ' ')" }
$script:MockNetworks = @('bridge','host','none','dsh-private','dsh-docker_default','proxy-net')
$candidates = Get-ProxyNetworkCandidates
if (($candidates -join ' ') -ne 'proxy-net') { throw "Unexpected proxy candidates: $($candidates -join ' ')" }

# 已存在的外部网络：直接通过，且绝不创建任何东西。
Assert-ExternalNetwork -Name 'proxy-net' -Interactive $false
if ($script:DockerCalls -join ' ' -match 'network create') { throw 'An existing network must not be recreated.' }

# 已经存在的 dsh-private 照旧当外部网络使用，不影响老部署。
Assert-ExternalNetwork -Name 'dsh-private' -Interactive $false

# 不存在时，dsh-private 不能当外部网络：这正是老向导默认值造成的错误配置。
$script:MockNetworks = @('bridge','host','none','proxy-net')
$reserved = $null
try { Assert-ExternalNetwork -Name 'dsh-private' -Interactive $false } catch { $reserved = $_.Exception.Message }
if ($reserved -notmatch '内部网络名') { throw "dsh-private was not rejected: $reserved" }

# 缺失 + 非交互：报错并给出可直接执行的命令。
$missing = $null
try { Assert-ExternalNetwork -Name 'dsh-proxy' -Interactive $false } catch { $missing = $_.Exception.Message }
if ($missing -notmatch 'docker network create dsh-proxy') { throw "Missing network hint absent: $missing" }
if ($missing -notmatch 'docker network connect dsh-proxy') { throw "Connect hint absent: $missing" }

# 缺失 + 交互并同意：安装器负责创建，并打上自己的标签便于删除时回收。
$script:DockerCalls.Clear()
Assert-ExternalNetwork -Name 'dsh-proxy' -Interactive $true
$created = @($script:DockerCalls | Where-Object { $_ -match '^network create' })
if ($created.Count -ne 1) { throw "Expected exactly one network create call: $($script:DockerCalls -join '; ')" }
if ($created[0] -notmatch 'dsh\.created-by=dsh-docker-installer') { throw "Created network is not labelled: $($created[0])" }
if ($created[0] -notmatch 'dsh-proxy$') { throw "Created network name is wrong: $($created[0])" }

# 缺失 + 交互但拒绝：仍然按错误处理。
$script:MockNetworks = @('bridge','host','none')
$script:AskAnswer = $false
$declined = $null
try { Assert-ExternalNetwork -Name 'dsh-proxy' -Interactive $true } catch { $declined = $_.Exception.Message }
if ($declined -notmatch 'docker network create dsh-proxy') { throw "Declined creation was not reported: $declined" }

Write-Output 'PowerShell external-network smoke: ok'
