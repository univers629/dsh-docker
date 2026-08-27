$ErrorActionPreference = 'Stop'

# install.ps1 的模型密钥代理部分只能靠这种方式测：安装器本身是个带 param 的脚本，
# 整段跑起来会去碰 docker。所以按 tests/install-powershell-network-smoke.ps1 的做法，
# 把要测的函数区间原样取出来执行，再用假的 Read-Host 驱动真正的问答代码。
# 这一份专门覆盖 --model-api / --model-header 与交互向导：PowerShell 侧曾经出现过
# 「向导调用了一个不存在的函数」这种只有真跑一遍才会暴露的缺口。

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installer = [IO.File]::ReadAllText((Join-Path $repoRoot 'install.ps1'))

function Get-InstallerRegion {
    param([string]$From, [string]$To)
    $start = $installer.IndexOf($From)
    $end = $installer.IndexOf($To)
    if ($start -lt 0 -or $end -le $start) { throw "Cannot locate installer region: $From .. $To" }
    return $installer.Substring($start, $end - $start)
}

# 模型密钥代理的全部助手函数 + 交互向导。
Invoke-Expression (Get-InstallerRegion 'function Get-ModelDefaultBaseUrl' 'function Show-BrokerSkippedNotice')
# 问答助手（Ask / Ask-Optional / Ask-Secret / Ask-YesNo）也要用真的实现，
# 否则测不出 Ask-Optional 是否存在。
Invoke-Expression (Get-InstallerRegion 'function Ask {' 'function Get-ProxyNetworkCandidates')

# 安装器里的全局状态。
$script:BrokerUpstreams = New-Object System.Collections.ArrayList
$script:BrokerProfiles = @{}
$script:BrokerModels = @{}
$script:ModelApi = @()
$script:ModelHeader = @()
$script:ModelId = @()

# 假 Read-Host：按顺序吐出预置答案，队列空了就说明问答步骤比预期多。
$script:Answers = New-Object System.Collections.Generic.Queue[string]
function Read-Host {
    param([Parameter(Position = 0)][string]$Prompt, [switch]$AsSecureString)
    if ($script:Answers.Count -eq 0) { throw "Unexpected prompt: $Prompt" }
    $answer = $script:Answers.Dequeue()
    if ($AsSecureString) { return (ConvertTo-SecureString $answer -AsPlainText -Force) }
    return $answer
}

function Assert-Equal {
    param($Expected, $Actual, [string]$What)
    if ($Expected -ne $Actual) { throw "${What}：期望 [$Expected]，实际 [$Actual]" }
}

# ---------------------------------------------------------------------------
# Ask-Optional：空回车是合法答案，不能回落到默认值
# ---------------------------------------------------------------------------
@('', '  spaced  ') | ForEach-Object { $script:Answers.Enqueue($_) }
Assert-Equal '' (Ask-Optional '请求头') 'Ask-Optional 空回车'
Assert-Equal 'spaced' (Ask-Optional '请求头' 'old-value') 'Ask-Optional 去空白'

# ---------------------------------------------------------------------------
# 交互向导整跑一遍：Codex 那类客户端 = responses 形态 + 三个固定请求头
# ---------------------------------------------------------------------------
$codexKey = 'sk-test-powershell-broker-key'
@(
    'justwoker',                          # 上游名字
    'https://api.justwoker.icu',          # base_url
    '2',                                  # API 形态：只用 Responses
    $codexKey,                            # 密钥
    $codexKey,                            # 密钥确认
    '60',                                 # 每分钟上限
    '2000',                               # 每日配额
    'y',                                  # 需要固定请求头
    'user-agent=codex_cli_rs/0.101.0',    # 请求头 1
    'originator=codex_cli_rs',            # 请求头 2
    'version=0.101.0',                    # 请求头 3
    '',                                   # 请求头输入结束
    'gpt-fake-1, gpt-fake-2',             # 要在 DSH 里启用的模型 id
    'n'                                   # 不再添加上游
) | ForEach-Object { $script:Answers.Enqueue($_) }
Read-BrokerUpstreams
if ($script:Answers.Count -ne 0) { throw "向导没问完所有预置答案，剩余 $($script:Answers.Count) 条" }
Assert-Equal 1 $script:BrokerUpstreams.Count '向导收集到的上游数量'

$entry = $script:BrokerUpstreams[0]
Assert-Equal 'justwoker' $entry.name '上游名字'
Assert-Equal 'https://api.justwoker.icu' $entry.baseUrl '上游 base_url'
Assert-Equal $codexKey $entry.key '上游密钥'
Assert-Equal 60 $entry.requestsPerMinute '每分钟上限'
Assert-Equal 2000 $entry.dailyRequestBudget '每日配额'
# 默认认证头不该被抄进配置：抄了就会在 broker 改默认值之后变成静默的行为分叉。
if ($entry.Contains('headerName')) { throw 'responses 形态不应写出 headerName' }
if ($entry.allowedPathPrefixes -notcontains '/v1/responses') { throw 'responses 形态必须放行 /v1/responses' }
if ($entry.allowedPathPrefixes -contains '/v1/chat/completions') { throw 'responses 形态不应放行 chat/completions' }
Assert-Equal 'codex_cli_rs/0.101.0' $entry.extraHeaders['user-agent'] '固定请求头 user-agent'
Assert-Equal 'codex_cli_rs' $entry.extraHeaders['originator'] '固定请求头 originator'
Assert-Equal '0.101.0' $entry.extraHeaders['version'] '固定请求头 version'
# 形态要记在内存里：写 DSH settings.yaml 时靠它决定 api 是 responses 还是 chat。
Assert-Equal 'responses' (Get-BrokerUpstreamProfile 'justwoker') '向导记下的 API 形态'
Assert-Equal 'any' (Get-BrokerUpstreamProfile 'never-configured') '没配过的上游按 any 处理'
# 模型 id 只进 DSH 的 settings.yaml，不进 keys.json（broker 不认这个字段）。
Assert-Equal 'gpt-fake-1, gpt-fake-2' $script:BrokerModels['justwoker'] '向导记下的模型 id'
if ($entry.Contains('models')) { throw 'keys.json 不应带 models 字段' }

# 写盘之后交给 broker 自己的 parseBrokerConfig 校验：那是唯一权威的校验器。
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ("dsh-ps-broker-" + [guid]::NewGuid().ToString('N'))
$keysPath = Join-Path $sandbox 'data\broker\keys.json'
try {
    Write-BrokerConfig $keysPath | Out-Null
    if (-not (Test-Path -LiteralPath $keysPath -PathType Leaf)) { throw "Write-BrokerConfig 没写出 $keysPath" }
    $validator = Join-Path $sandbox 'validate.mjs'
    $validatorSource = @'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { parseBrokerConfig } = await import(process.env.DSH_POLICY_URL)
const parsed = parseBrokerConfig(readFileSync(process.env.DSH_KEYS_PATH, 'utf8'))
const upstream = parsed.upstreams.get('justwoker')
assert.ok(upstream, 'justwoker upstream missing')
assert.equal(upstream.baseUrl, 'https://api.justwoker.icu')
assert.equal(upstream.headerName, 'authorization')
assert.equal(upstream.headerValue, 'Bearer ' + process.env.DSH_EXPECTED_KEY)
assert.ok(upstream.allowedPathPrefixes.includes('/v1/responses'))
assert.ok(!upstream.allowedPathPrefixes.includes('/v1/chat/completions'))
assert.equal(upstream.extraHeaders['user-agent'], 'codex_cli_rs/0.101.0')
assert.equal(upstream.extraHeaders.originator, 'codex_cli_rs')
assert.equal(upstream.extraHeaders.version, '0.101.0')
assert.equal(upstream.requestsPerMinute, 60)
assert.equal(upstream.dailyRequestBudget, 2000)
'@
    [IO.File]::WriteAllText($validator, $validatorSource, (New-Object System.Text.UTF8Encoding($false)))
    $env:DSH_KEYS_PATH = $keysPath
    $env:DSH_EXPECTED_KEY = $codexKey
    $env:DSH_POLICY_URL = ([uri](Join-Path $repoRoot 'bin\dsh-key-broker-policy.mjs')).AbsoluteUri
    $validatorOutput = & node $validator 2>&1
    if ($LASTEXITCODE -ne 0) { throw "parseBrokerConfig 拒绝了向导写出的 keys.json：$validatorOutput" }
} finally {
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:DSH_KEYS_PATH, Env:DSH_EXPECTED_KEY, Env:DSH_POLICY_URL -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 目录里没有的上游必须给模型 id：空回车要重问，不能放过去
# 放过去的后果是 DSH 侧那条供应商一个模型都没有，用户装完在 WebUI 里选不到东西。
# ---------------------------------------------------------------------------
$script:BrokerUpstreams.Clear()
$script:BrokerProfiles = @{}
$script:BrokerModels = @{}
@(
    'gatewaytest',                        # 上游名字（不在内置目录里）
    'https://api.gatewaytest.invalid/v1', # base_url
    '1',                                  # API 形态：OpenAI 兼容
    'sk-gatewaytest',                     # 密钥
    'sk-gatewaytest',                     # 密钥确认
    '0',                                  # 每分钟上限
    '0',                                  # 每日配额
    'n',                                  # 不需要固定请求头
    '',                                   # 模型 id：空回车 → 必须重问
    'only-model-1',                       # 重问后填上
    'n'                                   # 不再添加上游
) | ForEach-Object { $script:Answers.Enqueue($_) }
Read-BrokerUpstreams
if ($script:Answers.Count -ne 0) { throw "目录外上游的向导没问完预置答案，剩余 $($script:Answers.Count) 条" }
Assert-Equal 'only-model-1' $script:BrokerModels['gatewaytest'] '重问之后记下的模型 id'

# 内置目录里的上游相反：空回车是合法答案，安装器沿用目录里的整份清单。
$script:BrokerUpstreams.Clear()
$script:BrokerProfiles = @{}
$script:BrokerModels = @{}
@('deepseek', 'https://api.deepseek.com', '1', 'sk-deepseek', 'sk-deepseek', '0', '0', 'n', '', 'n') |
    ForEach-Object { $script:Answers.Enqueue($_) }
Read-BrokerUpstreams
if ($script:Answers.Count -ne 0) { throw "目录内上游的向导没问完预置答案，剩余 $($script:Answers.Count) 条" }
if ($script:BrokerModels.ContainsKey('deepseek') -and $script:BrokerModels['deepseek']) {
    throw '目录内上游空回车不应记下模型 id'
}

# ---------------------------------------------------------------------------
# -ModelApi / -ModelHeader：非交互路径
# ---------------------------------------------------------------------------
$script:BrokerUpstreams.Clear()
$script:BrokerProfiles = @{}
$script:ModelApi = @('JustWoker=Responses')
$script:ModelHeader = @('justwoker=user-agent=codex_cli_rs/0.101.0', 'justwoker=originator=codex_cli_rs')
Test-ModelSpecFormat
Assert-Equal 'responses' (Get-ModelApiOverride 'justwoker') '-ModelApi 大小写归一'
# -ModelId 同一个上游可以给多条，也可以在一条里用逗号分隔，最后合成一条。
$script:ModelId = @('JustWoker=claude-opus-5-thinking', 'justwoker=gpt-5.2,gpt-5.2-codex')
Test-ModelSpecFormat
Assert-Equal 'claude-opus-5-thinking,gpt-5.2,gpt-5.2-codex' (Get-ModelIdOverride 'justwoker') '-ModelId 合并'
Assert-Equal '' (Get-ModelIdOverride 'deepseek') '没有 -ModelId 时返回空串'
$script:ModelId = @()
Assert-Equal '' (Get-ModelApiOverride 'deepseek') '没有覆盖时返回空串'
# 先落到变量再数：@(命令) 会把「返回值本身是数组」再包一层，数出来永远是 1。
$headerOverrides = Get-ModelHeaderOverrides 'justwoker'
Assert-Equal 2 $headerOverrides.Count '-ModelHeader 条数'
Assert-Equal 'user-agent=codex_cli_rs/0.101.0' $headerOverrides[0] '-ModelHeader 顺序'
$noOverrides = Get-ModelHeaderOverrides 'nosuch'
Assert-Equal 0 $noOverrides.Count '没有匹配时返回空数组'

Add-BrokerUpstream -Name 'justwoker' -BaseUrl 'https://api.justwoker.icu' -Key $codexKey `
    -ApiProfile (Get-ModelApiOverride 'justwoker') -ExtraHeader (Get-ModelHeaderOverrides 'justwoker')
$flagEntry = $script:BrokerUpstreams[0]
if ($flagEntry.allowedPathPrefixes -notcontains '/v1/responses') { throw '-ModelApi responses 必须放行 /v1/responses' }
Assert-Equal 'codex_cli_rs/0.101.0' $flagEntry.extraHeaders['user-agent'] '-ModelHeader 写入 extraHeaders'
Assert-Equal 'codex_cli_rs' $flagEntry.extraHeaders['originator'] '-ModelHeader 多条累积'

# 名字推断：anthropic 默认走 messages，认证头必须是 x-api-key 且自带 anthropic-version。
$script:BrokerUpstreams.Clear()
$script:ModelApi = @()
$script:ModelHeader = @()
Add-BrokerUpstream -Name 'anthropic' -BaseUrl 'https://api.anthropic.com' -Key 'sk-ant-test-key'
$anthropicEntry = $script:BrokerUpstreams[0]
Assert-Equal 'x-api-key' $anthropicEntry.headerName 'anthropic 的认证头'
Assert-Equal '{key}' $anthropicEntry.headerTemplate 'anthropic 的认证头模板'
Assert-Equal '2023-06-01' $anthropicEntry.extraHeaders['anthropic-version'] 'anthropic-version'
Assert-Equal 'messages' (Get-BrokerUpstreamProfile 'anthropic') 'anthropic 推断出的形态'

# ---------------------------------------------------------------------------
# 拒绝项：形态写错、请求头格式错、覆盖认证头
# ---------------------------------------------------------------------------
foreach ($case in @(
    @{ Api = @('justwoker=grpc'); Header = @(); Match = '未知的 API 形态' },
    @{ Api = @('justwoker'); Header = @(); Match = 'NAME=PROFILE' },
    @{ Api = @(); Header = @('justwoker=user-agent'); Match = 'NAME=HEADER=VALUE' },
    @{ Api = @(); Header = @('justwoker=authorization=Bearer leaked'); Match = '由密钥代理自己管理' },
    @{ Api = @(); Header = @('justwoker=x-api-key=leaked'); Match = '由密钥代理自己管理' },
    @{ Api = @(); Header = @('justwoker=bad header=1'); Match = '不是合法的 HTTP 头名' }
)) {
    $script:ModelApi = $case.Api
    $script:ModelHeader = $case.Header
    $failure = $null
    try { Test-ModelSpecFormat } catch { $failure = $_.Exception.Message }
    if (-not $failure) { throw "应当被拒绝但通过了：$($case.Api -join ',') $($case.Header -join ',')" }
    if ($failure -notmatch $case.Match) { throw "拒绝原因不对：$failure（期望包含 $($case.Match)）" }
}

# -ModelId 也必须是 NAME=ID：写错了要当场报错，而不是在 DSH 拒绝整份 settings 之后才发现。
$script:ModelApi = @()
$script:ModelHeader = @()
$script:ModelId = @('justwoker')
$idFailure = $null
try { Test-ModelSpecFormat } catch { $idFailure = $_.Exception.Message }
if (-not $idFailure) { throw '-ModelId 缺少 = 应当被拒绝' }
if ($idFailure -notmatch 'NAME=ID') { throw "拒绝原因不对：$idFailure" }
$script:ModelId = @()

Write-Output 'PowerShell model-broker smoke: ok'
