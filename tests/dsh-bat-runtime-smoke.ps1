$ErrorActionPreference = 'Stop'

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('dsh-bat-runtime-' + [guid]::NewGuid().ToString('N'))
$fakeBin = Join-Path $temporary 'bin'
$state = Join-Path $temporary 'engine.txt'
$log = Join-Path $temporary 'docker.log'
$originalPath = $env:PATH
$originalState = $env:DSH_DOCKER_TEST_STATE
$originalLog = $env:DSH_DOCKER_TEST_LOG

try {
    New-Item -ItemType Directory -Path $fakeBin -Force | Out-Null
    $mock = @'
using System;
using System.IO;

public static class DockerMock {
    public static int Main(string[] args) {
        var state = Environment.GetEnvironmentVariable("DSH_DOCKER_TEST_STATE");
        var log = Environment.GetEnvironmentVariable("DSH_DOCKER_TEST_LOG");
        File.AppendAllText(log, string.Join(" ", args) + Environment.NewLine);
        if (args.Length > 0 && args[0] == "info") {
            if (!File.Exists(state)) return 1;
            Console.WriteLine(File.ReadAllText(state).Trim());
            return 0;
        }
        if (args.Length > 1 && args[0] == "desktop" && args[1] == "start") {
            File.WriteAllText(state, "linux");
        }
        if (args.Length > 1 && args[0] == "inspect" && args[1] == "--format") {
            Console.WriteLine("exited");
        }
        return 0;
    }
}
'@
    $mockSource = Join-Path $temporary 'DockerMock.cs'
    $mockExe = Join-Path $fakeBin 'docker.exe'
    [IO.File]::WriteAllText($mockSource, $mock)
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo "/out:$mockExe" $mockSource
    if ($LASTEXITCODE -ne 0) { throw 'Failed to compile docker.exe test double.' }
    $env:PATH = "$fakeBin;$originalPath"
    $env:DSH_DOCKER_TEST_STATE = $state
    $env:DSH_DOCKER_TEST_LOG = $log

    & cmd.exe /d /c (Join-Path $PSScriptRoot '..\dsh.bat') status
    if ($LASTEXITCODE -ne 0) {
        $diagnosticCalls = if (Test-Path $log) { [IO.File]::ReadAllText($log) } else { '<no log>' }
        $diagnosticState = if (Test-Path $state) { [IO.File]::ReadAllText($state) } else { '<no state>' }
        throw "dsh.bat exited with $LASTEXITCODE. Calls: $diagnosticCalls State: $diagnosticState"
    }
    $calls = [IO.File]::ReadAllText($log)
    if ($calls -notmatch 'desktop start' -or $calls -notmatch 'compose ps') {
        throw "Unexpected Docker calls: $calls"
    }

    & cmd.exe /d /c (Join-Path $PSScriptRoot '..\dsh.bat') start
    if ($LASTEXITCODE -ne 0) { throw "dsh.bat start exited with $LASTEXITCODE." }
    & cmd.exe /d /c (Join-Path $PSScriptRoot '..\dsh.bat') stop
    if ($LASTEXITCODE -ne 0) { throw "dsh.bat stop exited with $LASTEXITCODE." }

    $calls = [IO.File]::ReadAllText($log)
    if ($calls -notmatch 'container inspect dsh' -or $calls -notmatch 'start dsh' -or $calls -notmatch 'compose stop dsh') {
        throw "Windows lifecycle did not reuse and stop the existing container: $calls"
    }
    if ($calls -match 'force-recreate|compose down|image prune') {
        throw "Windows lifecycle unexpectedly recreated, removed, or pruned the container: $calls"
    }
    Write-Output 'dsh.bat Docker runtime smoke: ok'
} finally {
    $env:PATH = $originalPath
    if ($null -eq $originalState) { Remove-Item Env:DSH_DOCKER_TEST_STATE -ErrorAction SilentlyContinue }
    else { $env:DSH_DOCKER_TEST_STATE = $originalState }
    if ($null -eq $originalLog) { Remove-Item Env:DSH_DOCKER_TEST_LOG -ErrorAction SilentlyContinue }
    else { $env:DSH_DOCKER_TEST_LOG = $originalLog }
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
