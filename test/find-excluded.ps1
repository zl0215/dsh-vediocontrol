# find-excluded.ps1 - list visible windows that are excluded from screen capture.
$ErrorActionPreference = 'Stop'
$Source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CaptureExclusionLister
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);

    public static string List()
    {
        var rows = new List<string>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr extra)
        {
            uint affinity;
            if (!GetWindowDisplayAffinity(hWnd, out affinity)) return true;
            if (affinity == 0) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            rows.Add(string.Format("pid={0} hwnd=0x{1:X} affinity=0x{2:X} visible={3}",
                pid, hWnd.ToInt64(), affinity, IsWindowVisible(hWnd)));
            return true;
        }, IntPtr.Zero);
        return rows.Count == 0 ? "none" : string.Join(Environment.NewLine, rows.ToArray());
    }
}
'@
Add-Type -TypeDefinition $Source -ErrorAction Stop
Write-Output ([CaptureExclusionLister]::List())
