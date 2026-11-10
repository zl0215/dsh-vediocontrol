# run-tests.ps1 - run every test shipped with the push-to-talk plugin.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\run-tests.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\run-tests.ps1 -SkipSlow
#
# The Windows helper tests spawn real powershell.exe children and inject real
# global input, so they need a normal interactive Windows desktop session.
# Exit code 0 iff every test passed.

param([switch]$SkipSlow)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Pwsh = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $Pwsh)) { $Pwsh = (Get-Command powershell.exe).Source }

$node = $null
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) { $node = $nodeCommand.Source }
if (-not $node) {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { $node = $candidate; break }
    }
}
if (-not $node) { throw 'Node.js >= 20 was not found on PATH; install it or pass a node path.' }

$script:Passed = 0
$script:Failed = 0
$script:Failures = @()

function Run-Step {
    param([string]$Name, [scriptblock]$Body)
    Write-Output ''
    Write-Output ('== ' + $Name + ' ==')
    $code = 0
    try { & $Body } catch { Write-Output ('ERROR: ' + $_.Exception.Message); $code = 1 }
    if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }
    if ($code -eq 0) {
        $script:Passed++
        Write-Output ('PASS  ' + $Name)
    }
    else {
        $script:Failed++
        $script:Failures += $Name
        Write-Output ('FAIL  ' + $Name + ' (exit ' + $code + ')')
    }
}

Write-Output '== dsh-push-to-talk test runner =='
Write-Output ('node:      ' + $node)
Write-Output ('powershell: ' + $Pwsh)

Run-Step 'node --check index.js' { & $node --check (Join-Path $Root 'index.js') }
Run-Step 'node --check client.js' { & $node --check (Join-Path $Root 'client.js') }
Run-Step 'client smoke test' { & $node (Join-Path $PSScriptRoot 'smoke-client.mjs') }
Run-Step 'overlay probe (streaming, opacity, font)' { & $Pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'overlay-probe.ps1') }
Run-Step 'two-key hotkey smoke test' { & $Pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'hotkey-shot-smoke.ps1') }
if (-not $SkipSlow) {
    Run-Step 'global hotkey smoke test (18 keys)' {
        & $Pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'hotkey-smoke.ps1') -SkipLiveness
    }
}

Write-Output ''
Write-Output ('RESULT: ' + $script:Passed + ' passed, ' + $script:Failed + ' failed')
if ($script:Failed -gt 0) {
    Write-Output ('failed: ' + ($script:Failures -join '; '))
    exit 1
}
Write-Output 'ALL TESTS PASSED'
exit 0
