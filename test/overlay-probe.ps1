# overlay-probe.ps1 - objective test harness for overlay.ps1.
#
# Starts overlay.ps1 with redirected stdin/stdout, sends show/hide/quit
# commands, and inspects the real Win32 top-level window: extended styles,
# visibility, rect and foreground-window changes. No screenshots.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\overlay-probe.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$overlay = Join-Path $root 'overlay.ps1'
if (-not (Test-Path $overlay)) { throw "missing overlay script: $overlay" }

$ProbeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DshOverlayProbe
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public static string Describe(int processId)
    {
        var rows = new List<string>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr extra)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid != (uint)processId) return true;
            int ex = GetWindowLong(hWnd, -20);
            uint affinity = 0;
            GetWindowDisplayAffinity(hWnd, out affinity);
            RECT rect;
            GetWindowRect(hWnd, out rect);
            rows.Add(string.Format(
                "hwnd=0x{0:X} exstyle=0x{1:X8} affinity=0x{2:X} visible={3} rect=({4},{5})-({6},{7})",
                hWnd.ToInt64(), ex, affinity, IsWindowVisible(hWnd),
                rect.Left, rect.Top, rect.Right, rect.Bottom));
            return true;
        }, IntPtr.Zero);
        return rows.Count == 0 ? "no top-level window" : string.Join(" | ", rows.ToArray());
    }

    public static string Foreground()
    {
        IntPtr handle = GetForegroundWindow();
        return "0x" + handle.ToInt64().ToString("X");
    }
}
'@

Add-Type -TypeDefinition $ProbeSource -ErrorAction Stop

function Start-Overlay {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = 'powershell.exe'
    $info.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $overlay + '"'
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    $info.EnvironmentVariables['DSH_OVERLAY_SECONDS'] = '3'
    return [System.Diagnostics.Process]::Start($info)
}

function Send-Line {
    param([System.Diagnostics.Process]$Process, [string]$Line)
    $Process.StandardInput.WriteLine($Line)
    $Process.StandardInput.Flush()
}

function Read-Ready {
    param([System.Diagnostics.Process]$Process, [int]$TimeoutMs = 15000)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
        if ($Process.HasExited) { throw ('overlay exited before ready: ' + $Process.StandardError.ReadToEnd()) }
        $line = $Process.StandardOutput.ReadLine()
        if ($null -eq $line) { throw 'stdout closed before ready' }
        if ($line -eq 'ready') { return $sw.ElapsedMilliseconds }
        if ($line -like 'error*') { throw ('overlay reported: ' + $line + ' :: ' + $Process.StandardError.ReadToEnd()) }
        Write-Output ('ignored stdout: ' + $line)
    }
    throw 'timeout waiting for ready'
}

$sampleB64 = '5rWL6K+V5Zue5aSN77ya6L+Z5piv5Yqp5omL57uZ5L2g55qE562U5aSN44CCCuesrOS6jOihjOaWh+Wtl++8jOeUqOadpemqjOivgeaNouihjOS4juS4reaWh+a4suafk+OAggrnrKzkuInooYzjgII='
$sample = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sampleB64))
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($sample))

$proc = Start-Overlay
try {
    $readyMs = Read-Ready -Process $proc
    Write-Output ('ready after {0} ms' -f $readyMs)
    Write-Output ('foreground before show: ' + [DshOverlayProbe]::Foreground())

    Send-Line -Process $proc -Line ('show ' + $b64)
    Start-Sleep -Milliseconds 900
    Write-Output ('after show: ' + [DshOverlayProbe]::Describe($proc.Id))
    Write-Output ('foreground after show: ' + [DshOverlayProbe]::Foreground())

    $shown = [DshOverlayProbe]::Describe($proc.Id)
    if ($shown -notmatch 'visible=True') { throw 'window is not visible after show' }
    if ($shown -notmatch 'exstyle=0x08000088') { throw ('unexpected exstyle: ' + $shown) }
    if ($shown -notmatch 'affinity=0x11') { throw ('capture exclusion not applied (expected affinity=0x11): ' + $shown) }
    Write-Output 'capture exclusion active (WDA_EXCLUDEFROMCAPTURE=0x11)'

    Start-Sleep -Milliseconds 3500
    $hidden = [DshOverlayProbe]::Describe($proc.Id)
    Write-Output ('after auto-hide: ' + $hidden)
    if ($hidden -match 'visible=True' -and $hidden -notmatch 'no top-level window') { throw 'window did not auto-hide' }

    Send-Line -Process $proc -Line ('show ' + $b64)
    Start-Sleep -Milliseconds 600
    $again = [DshOverlayProbe]::Describe($proc.Id)
    Write-Output ('re-show: ' + $again)
    if ($again -notmatch 'visible=True') { throw 'window did not re-show' }

    Send-Line -Process $proc -Line 'hide'
    Start-Sleep -Milliseconds 400
    $afterHide = [DshOverlayProbe]::Describe($proc.Id)
    Write-Output ('after hide: ' + $afterHide)

    Send-Line -Process $proc -Line 'quit'
    if (-not $proc.WaitForExit(8000)) { throw 'overlay did not exit after quit' }
    Write-Output ('exit code: ' + $proc.ExitCode)
    $stderr = $proc.StandardError.ReadToEnd()
    if ($stderr.Trim().Length -gt 0) { Write-Output ('stderr: ' + $stderr) }
    Write-Output 'PROBE OK'
}
finally {
    if (-not $proc.HasExited) {
        try { $proc.Kill() } catch {}
    }
}
