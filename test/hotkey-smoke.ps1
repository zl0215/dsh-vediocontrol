# hotkey-smoke.ps1 - ad-hoc end-to-end smoke test for hotkey.ps1.
#
# Verifies, against a real hidden powershell.exe child and real global input:
#   * invalid / missing DSH_PTT_KEY -> "error invalid-key" on stdout, exit 1
#   * F2: "ready" line, then "down"/"up" for injected input, install-to-ready time
#   * auto-repeat guard: several injected key-downs -> exactly one "down"
#   * negative matching: another key does not trigger the listener
#   * ControlRight / ShiftRight etc. (extended-key + scan-code side detection)
#   * liveness: the process is still pumping and responsive after ~20 s
#   * clean termination when killed
#
# Usage (from any PowerShell):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\hotkey-smoke.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\hotkey-smoke.ps1 -AllKeys
#
# Exit code 0 iff every check passed.

param(
    [switch]$AllKeys,
    [int]$LivenessSeconds = 20,
    [switch]$SkipLiveness
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$HookPath = Join-Path $Root 'hotkey.ps1'
$InjectPath = Join-Path $PSScriptRoot 'hotkey-inject.ps1'
$PwshExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $PwshExe)) { $PwshExe = (Get-Command powershell.exe).Source }

if (-not (Test-Path $HookPath)) { throw "hotkey.ps1 not found at $HookPath" }
if (-not (Test-Path $InjectPath)) { throw "hotkey-inject.ps1 not found at $InjectPath" }

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-ptt-hotkey-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

$script:Passed = 0
$script:Failed = 0
$script:Failures = @()

function Assert-That {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][bool]$Condition,
        [string]$Detail = ''
    )
    if ($Condition) {
        $script:Passed++
        Write-Output ('PASS  ' + $Name + $(if ($Detail) { '  [' + $Detail + ']' } else { '' }))
    }
    else {
        $script:Failed++
        $script:Failures += $Name
        Write-Output ('FAIL  ' + $Name + $(if ($Detail) { '  [' + $Detail + ']' } else { '' }))
    }
}

function Get-Lines {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return @() }
    try {
        $raw = @(Get-Content -Path $Path -ErrorAction Stop)
        return $raw
    }
    catch {
        return @()
    }
}

function Get-LineCount {
    param([string]$Path, [string]$Literal)
    $lines = @(Get-Lines $Path)
    $n = 0
    foreach ($line in $lines) { if ($line -ceq $Literal) { $n++ } }
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

function Set-HookEnv {
    param([string]$Key)
    if ([string]::IsNullOrEmpty($Key)) {
        Remove-Item Env:DSH_PTT_KEY -ErrorAction SilentlyContinue
    }
    else {
        $env:DSH_PTT_KEY = $Key
    }
}

function Clear-HookEnv {
    Remove-Item Env:DSH_PTT_KEY -ErrorAction SilentlyContinue
}

function Run-HookOnce {
    param([string]$Key)
    $tag = if ([string]::IsNullOrEmpty($Key)) { 'unset' } else { ($Key -replace '[^A-Za-z0-9]', '') }
    $outPath = Join-Path $TempDir ('once-' + $tag + '-' + [guid]::NewGuid().ToString('N') + '.out')
    $errPath = Join-Path $TempDir ('once-' + $tag + '-' + [guid]::NewGuid().ToString('N') + '.err')
    Set-HookEnv $Key
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $process = Start-Process -FilePath $PwshExe `
            -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $HookPath `
            -RedirectStandardOutput $outPath -RedirectStandardError $errPath `
            -WindowStyle Hidden -PassThru -Wait
    }
    finally {
        Clear-HookEnv
    }
    $sw.Stop()
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Stdout = @(Get-Lines $outPath)
        Stderr = @(Get-Lines $errPath)
        ElapsedMs = $sw.ElapsedMilliseconds
    }
}

function Start-Listener {
    param([Parameter(Mandatory = $true)][string]$Key)
    $tag = ($Key -replace '[^A-Za-z0-9]', '')
    $outPath = Join-Path $TempDir ('listener-' + $tag + '.out')
    $errPath = Join-Path $TempDir ('listener-' + $tag + '.err')
    Set-HookEnv $Key
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $process = Start-Process -FilePath $PwshExe `
            -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $HookPath `
            -RedirectStandardOutput $outPath -RedirectStandardError $errPath `
            -WindowStyle Hidden -PassThru
    }
    finally {
        Clear-HookEnv
    }
    $readyMs = Wait-ForLineCount -Path $outPath -Literal 'ready' -Count 1 -TimeoutMilliseconds 20000
    return [pscustomobject]@{
        Key = $Key
        Process = $process
        OutPath = $outPath
        ErrPath = $errPath
        ReadyMs = $readyMs
        SpawnToReadyMs = if ($readyMs -lt 0) { -1 } else { $sw.ElapsedMilliseconds }
    }
}

function Stop-Listener {
    param($Listener)
    if (-not $Listener.Process.HasExited) {
        Stop-Process -Id $Listener.Process.Id -Force -ErrorAction SilentlyContinue
    }
    $exited = $Listener.Process.WaitForExit(3000)
    return [bool]$exited
}

function Invoke-Injector {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [string]$Mode = 'tap',
        [int]$HoldMilliseconds = 150,
        [int]$Repeats = 4
    )
    $output = & $PwshExe -NoProfile -ExecutionPolicy Bypass -File $InjectPath `
        -Key $Key -Mode $Mode -HoldMilliseconds $HoldMilliseconds -Repeats $Repeats -Quiet 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @($output) }
}

function Format-Transcript {
    param([string]$Path)
    $lines = @(Get-Lines $Path)
    return ($lines -join ' / ')
}

# ---------------------------------------------------------------------------
Write-Output '== dsh push-to-talk: hotkey.ps1 smoke test =='
Write-Output ('host:        ' + $PSVersionTable.PSVersion.ToString() + ' (' + [System.Environment]::OSVersion.VersionString + ')')
Write-Output ('listener:    ' + $HookPath + ' (' + (Get-Item $HookPath).Length + ' bytes)')
Write-Output ('injector:    ' + $InjectPath)
Write-Output ('powershell:  ' + $PwshExe)
Write-Output ''

# ---------------------------------------------------------------------------
# 1. invalid / missing DSH_PTT_KEY
# ---------------------------------------------------------------------------
Write-Output '[invalid-key handling]'
$invalidCases = @(
    @{ Label = 'unset'; Key = ''; ExpectInStdout = 'error invalid-key' },
    @{ Label = 'unknown (VolumeUp)'; Key = 'VolumeUp'; ExpectInStdout = 'error invalid-key' },
    @{ Label = 'out-of-range (F13)'; Key = 'F13'; ExpectInStdout = 'error invalid-key' },
    @{ Label = 'non-canonical case (f2)'; Key = 'f2'; ExpectInStdout = 'error invalid-key' }
)
foreach ($case in $invalidCases) {
    $run = Run-HookOnce $case.Key
    $stdout = ($run.Stdout -join ' / ')
    $exactlyOneLine = (@($run.Stdout).Count -eq 1)
    Assert-That -Name ('invalid ' + $case.Label + ': exit code 1') -Condition ($run.ExitCode -eq 1) -Detail ('exit=' + $run.ExitCode + ', elapsedMs=' + $run.ElapsedMs)
    Assert-That -Name ('invalid ' + $case.Label + ': stdout is one line "error invalid-key"') -Condition ($exactlyOneLine -and $stdout -eq $case.ExpectInStdout) -Detail ('stdout="' + $stdout + '"')
    Assert-That -Name ('invalid ' + $case.Label + ': short runtime') -Condition ($run.ElapsedMs -lt 5000) -Detail ($run.ElapsedMs.ToString() + ' ms')
}
Write-Output ''

# ---------------------------------------------------------------------------
# 2. F2 lifecycle: ready, injected down/up, repeat guard, negative match,
#    liveness after N seconds, clean kill.
# ---------------------------------------------------------------------------
Write-Output '[F2 lifecycle]'
$f2 = Start-Listener -Key 'F2'
try {
    Assert-That -Name 'F2: "ready" received' -Condition ($f2.ReadyMs -ge 0) -Detail ('spawn-to-ready ' + $f2.SpawnToReadyMs + ' ms')
    Assert-That -Name 'F2: process alive after ready' -Condition (-not $f2.Process.HasExited) -Detail ('pid=' + $f2.Process.Id)

    $inject = Invoke-Injector -Key 'F2' -Mode 'tap' -HoldMilliseconds 200
    Assert-That -Name 'F2: injector SendInput succeeded' -Condition ($inject.ExitCode -eq 0) -Detail ('injector exit=' + $inject.ExitCode)
    $downMs = Wait-ForLineCount -Path $f2.OutPath -Literal 'down' -Count 1 -TimeoutMilliseconds 5000
    $upMs = Wait-ForLineCount -Path $f2.OutPath -Literal 'up' -Count 1 -TimeoutMilliseconds 5000
    Assert-That -Name 'F2: injected tap produced "down"' -Condition ($downMs -ge 0) -Detail ('after ' + $downMs + ' ms')
    Assert-That -Name 'F2: injected tap produced "up"' -Condition ($upMs -ge 0) -Detail ('after ' + $upMs + ' ms')
    Assert-That -Name 'F2: transcript is exactly ready/down/up' -Condition ((Format-Transcript $f2.OutPath) -eq 'ready / down / up') -Detail ('transcript: ' + (Format-Transcript $f2.OutPath))

    $injectOther = Invoke-Injector -Key 'F1' -Mode 'tap' -HoldMilliseconds 100
    Start-Sleep -Milliseconds 400
    $linesAfterOther = @(Get-Lines $f2.OutPath)
    Assert-That -Name 'F2: other key (F1) does not trigger' -Condition (@($linesAfterOther).Count -eq 3) -Detail ('lines=' + (@($linesAfterOther).Count) + ', transcript: ' + (Format-Transcript $f2.OutPath))

    $injectRepeat = Invoke-Injector -Key 'F2' -Mode 'repeat' -HoldMilliseconds 300 -Repeats 5
    Start-Sleep -Milliseconds 600
    $downCount = Get-LineCount -Path $f2.OutPath -Literal 'down'
    $upCount = Get-LineCount -Path $f2.OutPath -Literal 'up'
    Assert-That -Name 'F2: auto-repeat guard (5 injected downs -> 1 extra down)' -Condition ($downCount -eq 2 -and $upCount -eq 2) -Detail ('down=' + $downCount + ', up=' + $upCount + ', injector exit=' + $injectRepeat.ExitCode)

    if (-not $SkipLiveness) {
        $seconds = [Math]::Max(1, $LivenessSeconds)
        Write-Output ('      (waiting ' + $seconds + ' s to prove the message loop keeps running...)')
        Start-Sleep -Seconds $seconds
        Assert-That -Name ('F2: alive after ' + $seconds + ' s') -Condition (-not $f2.Process.HasExited) -Detail ('pid=' + $f2.Process.Id)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $injectLate = Invoke-Injector -Key 'F2' -Mode 'tap' -HoldMilliseconds 120
        $lateUpMs = Wait-ForLineCount -Path $f2.OutPath -Literal 'up' -Count 3 -TimeoutMilliseconds 5000
        $roundTrip = $sw.ElapsedMilliseconds
        Assert-That -Name ('F2: still pumping after ' + $seconds + ' s (new down/up pair)') -Condition ($lateUpMs -ge 0 -and (Get-LineCount -Path $f2.OutPath -Literal 'down') -eq 3) -Detail ('round-trip incl. injector start ' + $roundTrip + ' ms, injector exit=' + $injectLate.ExitCode)
    }

    $stderr = @(Get-Lines $f2.ErrPath)
    Assert-That -Name 'F2: nothing on stderr' -Condition (@($stderr).Count -eq 0) -Detail ('stderr=' + ($stderr -join ' / '))
    $killed = Stop-Listener $f2
    Assert-That -Name 'F2: ends when killed' -Condition ($killed -and $f2.Process.HasExited) -Detail ('pid=' + $f2.Process.Id)
    Write-Output ('      F2 transcript: ' + (Format-Transcript $f2.OutPath))
}
finally {
    if (-not $f2.Process.HasExited) { Stop-Process -Id $f2.Process.Id -Force -ErrorAction SilentlyContinue }
}
Write-Output ''

# ---------------------------------------------------------------------------
# 3. Right-hand modifier targets: extended-key Ctrl, scan-code Shift.
# ---------------------------------------------------------------------------
Write-Output '[modifier targets]'
$negativeMap = @{
    'ControlRight' = 'ControlLeft'
    'ControlLeft' = 'ControlRight'
    'ShiftRight' = 'ShiftLeft'
    'ShiftLeft' = 'ShiftRight'
    'AltRight' = 'AltLeft'
    'AltLeft' = 'AltRight'
}
$modifierKeys = @('ControlRight', 'ControlLeft', 'AltRight', 'AltLeft', 'ShiftRight', 'ShiftLeft')
foreach ($key in $modifierKeys) {
    $listener = Start-Listener -Key $key
    try {
        Assert-That -Name ($key + ': "ready" received') -Condition ($listener.ReadyMs -ge 0) -Detail ('spawn-to-ready ' + $listener.SpawnToReadyMs + ' ms')
        $inject = Invoke-Injector -Key $key -Mode 'tap' -HoldMilliseconds 150
        $null = Wait-ForLineCount -Path $listener.OutPath -Literal 'up' -Count 1 -TimeoutMilliseconds 5000
        Assert-That -Name ($key + ': injected tap produced down/up') -Condition ((Format-Transcript $listener.OutPath) -eq 'ready / down / up') -Detail ('transcript: ' + (Format-Transcript $listener.OutPath) + ', injector exit=' + $inject.ExitCode)

        $other = $negativeMap[$key]
        $null = Invoke-Injector -Key $other -Mode 'tap' -HoldMilliseconds 100
        $before = (@(Get-Lines $listener.OutPath)).Count
        Start-Sleep -Milliseconds 400
        $after = (@(Get-Lines $listener.OutPath)).Count
        Assert-That -Name ($key + ': other side (' + $other + ') ignored') -Condition ($before -eq $after -and $before -eq 3) -Detail ('lines before=' + $before + ', after=' + $after + ', transcript: ' + (Format-Transcript $listener.OutPath))

        $killed = Stop-Listener $listener
        Assert-That -Name ($key + ': ends when killed') -Condition ($killed) -Detail ('pid=' + $listener.Process.Id)
    }
    finally {
        if (-not $listener.Process.HasExited) { Stop-Process -Id $listener.Process.Id -Force -ErrorAction SilentlyContinue }
    }
}
Write-Output ''

# ---------------------------------------------------------------------------
# 4. Optional full key matrix.
# ---------------------------------------------------------------------------
if ($AllKeys) {
    Write-Output '[all 18 target keys]'
    $everyKey = @(
        'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
        'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight'
    )
    foreach ($key in $everyKey) {
        $listener = Start-Listener -Key $key
        try {
            $inject = Invoke-Injector -Key $key -Mode 'tap' -HoldMilliseconds 100
            $null = Wait-ForLineCount -Path $listener.OutPath -Literal 'up' -Count 1 -TimeoutMilliseconds 5000
            $transcript = Format-Transcript $listener.OutPath
            Assert-That -Name ($key + ': ready/down/up') -Condition ($transcript -eq 'ready / down / up') -Detail ('ready=' + $listener.ReadyMs + ' ms, transcript: ' + $transcript)
        }
        finally {
            Stop-Listener $listener | Out-Null
        }
    }
    Write-Output ''
}

# ---------------------------------------------------------------------------
$summary = 'RESULT: ' + $script:Passed + ' passed, ' + $script:Failed + ' failed'
Write-Output $summary
if ($script:Failed -gt 0) {
    Write-Output ('failed checks: ' + ($script:Failures -join '; '))
}

# best-effort cleanup of our temp artifacts
try { Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }

if ($script:Failed -gt 0) { exit 1 }
exit 0
