# overlay-probe.ps1 - objective test harness for overlay.ps1.
#
# Starts overlay.ps1 with redirected stdin/stdout twice:
#   A) opaque mode (opacity 100): stream -> final show -> auto hide; expects the
#      window to be excluded from screen capture (affinity 0x11).
#   B) translucent mode (opacity 60, custom font/size): stream updates while the
#      window stays visible; no capture exclusion expected.
# Inspects the real Win32 top-level window (extended styles, affinity,
# visibility, rect, foreground window). No screenshots.
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
    param([int]$Opacity, [string]$Font, [int]$FontSize, [int]$Seconds)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = 'powershell.exe'
    $info.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $overlay + '"'
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    $info.EnvironmentVariables['DSH_OVERLAY_SECONDS'] = [string]$Seconds
    $info.EnvironmentVariables['DSH_OVERLAY_OPACITY'] = [string]$Opacity
    $info.EnvironmentVariables['DSH_OVERLAY_FONT'] = $Font
    $info.EnvironmentVariables['DSH_OVERLAY_FONT_SIZE'] = [string]$FontSize
    return [System.Diagnostics.Process]::Start($info)
}

function Send-Line {
    param([System.Diagnostics.Process]$Process, [string]$Line)
    $Process.StandardInput.WriteLine($Line)
    $Process.StandardInput.Flush()
}

function Read-Ready {
    param([System.Diagnostics.Process]$Process, [int]$TimeoutMs = 20000)
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

function Encode-Text {
    param([string]$Text)
    return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Text))
}

$sampleStream = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5q2j5Zyo5rWB5byP6L6T5Ye677ya6L+Z5piv5rWB5byP5Lit55qE5paH5a2X'))
$sampleFinal = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5rWB5byP57uT5p2f77ya6L+Z5piv5pyA57uI55qE5paH5a2X5YaF5a65'))

Write-Output '==== scenario A: opaque (opacity 100) ===='
$proc = Start-Overlay -Opacity 100 -Font 'Microsoft YaHei UI' -FontSize 20 -Seconds 3
try {
    $readyMs = Read-Ready -Process $proc
    Write-Output ('ready after {0} ms' -f $readyMs)
    $before = [DshOverlayProbe]::Foreground()

    Send-Line -Process $proc -Line ('stream ' + (Encode-Text $sampleStream))
    Start-Sleep -Milliseconds 700
    $streaming = [DshOverlayProbe]::Describe($proc.Id)
    Write-Output ('streaming: ' + $streaming)
    if ($streaming -notmatch 'visible=True') { throw 'window not visible during streaming' }
    if ($streaming -notmatch 'affinity=0x11') { throw 'opaque window is not capture-excluded' }

    Send-Line -Process $proc -Line ('show ' + (Encode-Text $sampleFinal))
    Start-Sleep -Milliseconds 500
    $shown = [DshOverlayProbe]::Describe($proc.Id)
    Write-Output ('final show: ' + $shown)
    if ($shown -notmatch 'visible=True') { throw 'window not visible after final show' }
    if ([DshOverlayProbe]::Foreground() -ne $before) { throw 'overlay stole the foreground window' }

    Start-Sleep -Milliseconds 3500
    $hidden = [DshOverlayProbe]::Describe($proc.Id)
    Write-Output ('after auto-hide: ' + $hidden)
    if ($hidden -match 'visible=True') { throw 'window did not auto-hide' }

    Send-Line -Process $proc -Line 'quit'
    if (-not $proc.WaitForExit(8000)) { throw 'overlay did not exit after quit' }
    Write-Output ('scenario A exit code: ' + $proc.ExitCode)
}
finally {
    if (-not $proc.HasExited) { try { $proc.Kill() } catch {} }
}

Write-Output '==== scenario B: translucent (opacity 60, SimSun 22) ===='
$proc = Start-Overlay -Opacity 60 -Font 'SimSun' -FontSize 22 -Seconds 3
try {
    $readyMs = Read-Ready -Process $proc
    Write-Output ('ready after {0} ms' -f $readyMs)

    Send-Line -Process $proc -Line ('stream ' + (Encode-Text $sampleStream))
    Start-Sleep -Milliseconds 700
    $streaming = [DshOverlayProbe]::Describe($proc.Id)
    Write-Output ('streaming: ' + $streaming)
    if ($streaming -notmatch 'visible=True') { throw 'translucent window not visible during streaming' }
    if ($streaming -match 'affinity=0x[1-9A-F]') { Write-Output 'info: translucent window reports capture exclusion' }

    Send-Line -Process $proc -Line ('show ' + (Encode-Text $sampleFinal))
    Start-Sleep -Milliseconds 500
    $shown = [DshOverlayProbe]::Describe($proc.Id)
    Write-Output ('final show: ' + $shown)
    if ($shown -notmatch 'visible=True') { throw 'translucent window not visible after final show' }

    Start-Sleep -Milliseconds 3500
    $hidden = [DshOverlayProbe]::Describe($proc.Id)
    Write-Output ('after auto-hide: ' + $hidden)
    if ($hidden -match 'visible=True') { throw 'translucent window did not auto-hide' }

    Send-Line -Process $proc -Line 'quit'
    if (-not $proc.WaitForExit(8000)) { throw 'translucent overlay did not exit after quit' }
    Write-Output ('scenario B exit code: ' + $proc.ExitCode)
}
finally {
    if (-not $proc.HasExited) { try { $proc.Kill() } catch {} }
}

Write-Output 'PROBE OK'
