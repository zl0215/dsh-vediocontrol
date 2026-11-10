# hotkey-shot-smoke.ps1 - focused test for the two-key protocol of hotkey.ps1.
#
# Verifies, against a real hidden powershell.exe child and real global input:
#   * DSH_PTT_KEY=F2 + DSH_PTT_SHOT_KEY=F3 -> ready, then "down main"/"up main"
#     and "down shot"/"up shot" for injected input
#   * the other keys (F1, F4) do not trigger anything
#   * duplicate binding (shot key == main key) -> "error duplicate-key", exit 1
#   * an invalid shot key -> "error invalid-key", exit 1
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\hotkey-shot-smoke.ps1

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$HookPath = Join-Path $Root 'hotkey.ps1'
$InjectPath = Join-Path $PSScriptRoot 'hotkey-inject.ps1'
$PwshExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $PwshExe)) { $PwshExe = (Get-Command powershell.exe).Source }
if (-not (Test-Path $HookPath)) { throw "hotkey.ps1 not found at $HookPath" }
if (-not (Test-Path $InjectPath)) { throw "hotkey-inject.ps1 not found at $InjectPath" }

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-ptt-shot-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

$script:Passed = 0
$script:Failed = 0

function Assert-That {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    if ($Condition) {
        $script:Passed++
        Write-Output ('PASS  ' + $Name + $(if ($Detail) { '  [' + $Detail + ']' } else { '' }))
    }
    else {
        $script:Failed++
        Write-Output ('FAIL  ' + $Name + $(if ($Detail) { '  [' + $Detail + ']' } else { '' }))
    }
}

function Get-Lines {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return @() }
    return @(Get-Content -Path $Path -ErrorAction SilentlyContinue)
}

function Get-LineCount {
    param([string]$Path, [string]$Literal)
    $n = 0
    foreach ($line in @(Get-Lines $Path)) { if ($line -ceq $Literal) { $n++ } }
    return $n
}

function Wait-ForLineCount {
    param([string]$Path, [string]$Literal, [int]$Count, [int]$TimeoutMilliseconds)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        if ((Get-LineCount -Path $Path -Literal $Literal) -ge $Count) { return $sw.ElapsedMilliseconds }
        Start-Sleep -Milliseconds 25
    }
    return -1
}

function Invoke-Injector {
    param([string]$Key, [string]$Mode = 'tap', [int]$HoldMilliseconds = 150)
    $output = & $PwshExe -NoProfile -ExecutionPolicy Bypass -File $InjectPath `
        -Key $Key -Mode $Mode -HoldMilliseconds $HoldMilliseconds -Quiet 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @($output) }
}

function Start-TwoKeyHook {
    $outPath = Join-Path $TempDir 'listener.out'
    $errPath = Join-Path $TempDir 'listener.err'
    $env:DSH_PTT_KEY = 'F2'
    $env:DSH_PTT_SHOT_KEY = 'F3'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $process = Start-Process -FilePath $PwshExe `
            -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $HookPath `
            -RedirectStandardOutput $outPath -RedirectStandardError $errPath `
            -WindowStyle Hidden -PassThru
    }
    finally {
        Remove-Item Env:DSH_PTT_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:DSH_PTT_SHOT_KEY -ErrorAction SilentlyContinue
    }
    $readyMs = Wait-ForLineCount -Path $outPath -Literal 'ready' -Count 1 -TimeoutMilliseconds 20000
    return [pscustomobject]@{
        Process = $process
        OutPath = $outPath
        ErrPath = $errPath
        ReadyMs = $readyMs
        SpawnToReadyMs = $sw.ElapsedMilliseconds
    }
}

function Run-HookOnce {
    param([string]$Key, [string]$ShotKey)
    $outPath = Join-Path $TempDir ('once-' + [guid]::NewGuid().ToString('N') + '.out')
    $errPath = Join-Path $TempDir ('once-' + [guid]::NewGuid().ToString('N') + '.err')
    if ([string]::IsNullOrEmpty($Key)) { Remove-Item Env:DSH_PTT_KEY -ErrorAction SilentlyContinue }
    else { $env:DSH_PTT_KEY = $Key }
    if ([string]::IsNullOrEmpty($ShotKey)) { Remove-Item Env:DSH_PTT_SHOT_KEY -ErrorAction SilentlyContinue }
    else { $env:DSH_PTT_SHOT_KEY = $ShotKey }
    try {
        $process = Start-Process -FilePath $PwshExe `
            -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $HookPath `
            -RedirectStandardOutput $outPath -RedirectStandardError $errPath `
            -WindowStyle Hidden -PassThru -Wait
    }
    finally {
        Remove-Item Env:DSH_PTT_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:DSH_PTT_SHOT_KEY -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = @(Get-Lines $outPath) }
}

Write-Output '== dsh push-to-talk: hotkey.ps1 two-key smoke test =='

# Parameter errors.
$dup = Run-HookOnce -Key 'F2' -ShotKey 'F2'
Assert-That -Name 'duplicate key -> exit 1' -Condition ($dup.ExitCode -eq 1) -Detail ('exit=' + $dup.ExitCode)
Assert-That -Name 'duplicate key -> "error duplicate-key"' -Condition ((($dup.Stdout -join ' / ')) -eq 'error duplicate-key') -Detail (($dup.Stdout -join ' / '))
$badShot = Run-HookOnce -Key 'F2' -ShotKey 'VolumeUp'
Assert-That -Name 'invalid shot key -> exit 1' -Condition ($badShot.ExitCode -eq 1) -Detail ('exit=' + $badShot.ExitCode)
Assert-That -Name 'invalid shot key -> "error invalid-key"' -Condition ((($badShot.Stdout -join ' / ')) -eq 'error invalid-key') -Detail (($badShot.Stdout -join ' / '))

# Two-key lifecycle.
$hook = Start-TwoKeyHook
try {
    Assert-That -Name 'two-key helper: "ready" received' -Condition ($hook.ReadyMs -ge 0) -Detail ('spawn-to-ready ' + $hook.SpawnToReadyMs + ' ms')

    $null = Invoke-Injector -Key 'F2' -Mode 'tap' -HoldMilliseconds 150
    $mainDown = Wait-ForLineCount -Path $hook.OutPath -Literal 'down main' -Count 1 -TimeoutMilliseconds 5000
    $mainUp = Wait-ForLineCount -Path $hook.OutPath -Literal 'up main' -Count 1 -TimeoutMilliseconds 5000
    Assert-That -Name 'F2 tap -> "down main"' -Condition ($mainDown -ge 0)
    Assert-That -Name 'F2 tap -> "up main"' -Condition ($mainUp -ge 0)

    $null = Invoke-Injector -Key 'F3' -Mode 'tap' -HoldMilliseconds 150
    $shotDown = Wait-ForLineCount -Path $hook.OutPath -Literal 'down shot' -Count 1 -TimeoutMilliseconds 5000
    $shotUp = Wait-ForLineCount -Path $hook.OutPath -Literal 'up shot' -Count 1 -TimeoutMilliseconds 5000
    Assert-That -Name 'F3 tap -> "down shot"' -Condition ($shotDown -ge 0)
    Assert-That -Name 'F3 tap -> "up shot"' -Condition ($shotUp -ge 0)

    $null = Invoke-Injector -Key 'F1' -Mode 'tap' -HoldMilliseconds 100
    $null = Invoke-Injector -Key 'F4' -Mode 'tap' -HoldMilliseconds 100
    Start-Sleep -Milliseconds 500
    $lines = @(Get-Lines $hook.OutPath)
    Assert-That -Name 'unrelated keys add no events' -Condition ($lines.Count -eq 5) -Detail ('lines=' + $lines.Count + ': ' + ($lines -join ' / '))
    $stderr = @(Get-Lines $hook.ErrPath)
    Assert-That -Name 'nothing on stderr' -Condition ($stderr.Count -eq 0) -Detail (($stderr -join ' / '))
}
finally {
    if (-not $hook.Process.HasExited) { Stop-Process -Id $hook.Process.Id -Force -ErrorAction SilentlyContinue }
}

Write-Output ('transcript: ' + ((Get-Lines $hook.OutPath) -join ' / '))
Write-Output ('passed=' + $script:Passed + ' failed=' + $script:Failed)
Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
if ($script:Failed -gt 0) { exit 1 }
Write-Output 'SHOT SMOKE OK'
