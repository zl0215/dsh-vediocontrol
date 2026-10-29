# hotkey-inject.ps1 - ad-hoc test helper for hotkey.ps1.
#
# Sends synthetic keyboard input for one push-to-talk target key with
# user32!SendInput. Run it as a separate process while hotkey.ps1 is listening:
# the low-level keyboard hook is global, so it receives this injected input
# (hotkey.ps1 deliberately does not filter LLKHF_INJECTED).
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File hotkey-inject.ps1 -Key F2 -Mode tap
#   ... -Key ControlRight -Mode down        # press and keep it down
#   ... -Key ControlRight -Mode up          # release it
#   ... -Key F2 -Mode repeat                # down xN (auto-repeat simulation), then up
#
# Exit code 0 only if every SendInput call reported success.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
        'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight'
    )]
    [string]$Key,

    [ValidateSet('down', 'up', 'tap', 'repeat')]
    [string]$Mode = 'tap',

    [int]$HoldMilliseconds = 250,
    [int]$Repeats = 4,
    [int]$RepeatIntervalMilliseconds = 40,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$Source = @'
using System;
using System.Runtime.InteropServices;

public static class DshPttInjector
{
    public const uint ExtendedKey = 0x0001;
    public const uint KeyUp = 0x0002;
    public const uint ScanCode = 0x0008;

    private const uint INPUT_KEYBOARD = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    // vk == 0 means "derive the virtual key from the scan code".
    public static uint SendKey(ushort vk, ushort scan, uint flags, out int lastError)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = vk;
        input.U.ki.wScan = scan;
        input.U.ki.dwFlags = flags;
        input.U.ki.time = 0;
        input.U.ki.dwExtraInfo = IntPtr.Zero;

        INPUT[] inputs = new INPUT[] { input };
        uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        lastError = (sent == 1) ? 0 : Marshal.GetLastWin32Error();
        return sent;
    }
}
'@

Add-Type -TypeDefinition $Source -ErrorAction Stop

# name -> vk / scan / flags base
# F-keys go through wVk (the system derives the scan code); right-hand modifiers
# need KEYEVENTF_EXTENDEDKEY; shift has no extended flag and is told apart by
# scan code (0x2A left, 0x36 right), so it is injected by scan code.
$Keys = @{
    'F1'           = @{ Vk = 0x70; Scan = 0x00; Extended = $false }
    'F2'           = @{ Vk = 0x71; Scan = 0x00; Extended = $false }
    'F3'           = @{ Vk = 0x72; Scan = 0x00; Extended = $false }
    'F4'           = @{ Vk = 0x73; Scan = 0x00; Extended = $false }
    'F5'           = @{ Vk = 0x74; Scan = 0x00; Extended = $false }
    'F6'           = @{ Vk = 0x75; Scan = 0x00; Extended = $false }
    'F7'           = @{ Vk = 0x76; Scan = 0x00; Extended = $false }
    'F8'           = @{ Vk = 0x77; Scan = 0x00; Extended = $false }
    'F9'           = @{ Vk = 0x78; Scan = 0x00; Extended = $false }
    'F10'          = @{ Vk = 0x79; Scan = 0x00; Extended = $false }
    'F11'          = @{ Vk = 0x7A; Scan = 0x00; Extended = $false }
    'F12'          = @{ Vk = 0x7B; Scan = 0x00; Extended = $false }
    'ControlLeft'  = @{ Vk = 0x11; Scan = 0x00; Extended = $false }
    'ControlRight' = @{ Vk = 0x11; Scan = 0x00; Extended = $true }
    'AltLeft'      = @{ Vk = 0x12; Scan = 0x00; Extended = $false }
    'AltRight'     = @{ Vk = 0x12; Scan = 0x00; Extended = $true }
    'ShiftLeft'    = @{ Vk = 0x10; Scan = 0x2A; Extended = $false }
    'ShiftRight'   = @{ Vk = 0x10; Scan = 0x36; Extended = $false }
}

$Spec = $Keys[$Key]
$Vk = [uint16]$Spec.Vk
$Scan = [uint16]$Spec.Scan
$Flags = [uint32]0
if ($Spec.Scan -ne 0) { $Flags = $Flags -bor [uint32]0x0008 }   # KEYEVENTF_SCANCODE
if ($Spec.Extended) { $Flags = $Flags -bor [uint32]0x0001 }     # KEYEVENTF_EXTENDEDKEY

function Send-One {
    param([bool]$KeyUp)
    $f = $Flags
    if ($KeyUp) { $f = $f -bor [uint32]0x0002 }
    $lastError = 0
    $sent = [DshPttInjector]::SendKey($Vk, $Scan, $f, [ref]$lastError)
    if ($sent -ne 1) {
        [Console]::Error.WriteLine(('SendInput failed for {0} (keyUp={1}): sent={2} win32Error={3}' -f $Key, $KeyUp, $sent, $lastError))
        return $false
    }
    return $true
}

$ok = $true
switch ($Mode) {
    'down' {
        $ok = Send-One $false
        if (-not $Quiet) { Write-Output ('injected {0} down' -f $Key) }
    }
    'up' {
        $ok = Send-One $true
        if (-not $Quiet) { Write-Output ('injected {0} up' -f $Key) }
    }
    'tap' {
        $ok = Send-One $false
        if ($ok) { Start-Sleep -Milliseconds $HoldMilliseconds }
        if ($ok) { $ok = Send-One $true }
        if (-not $Quiet) { Write-Output ('injected {0} down, held {1} ms, up' -f $Key, $HoldMilliseconds) }
    }
    'repeat' {
        for ($i = 0; $i -lt $Repeats; $i++) {
            if (-not (Send-One $false)) { $ok = $false; break }
            if ($i -lt ($Repeats - 1)) { Start-Sleep -Milliseconds $RepeatIntervalMilliseconds }
        }
        if ($ok) {
            Start-Sleep -Milliseconds $HoldMilliseconds
            $ok = Send-One $true
        }
        if (-not $Quiet) { Write-Output ('injected {0} down x{1}, held {2} ms, up' -f $Key, $Repeats, $HoldMilliseconds) }
    }
}

if ($ok) { exit 0 } else { exit 1 }
