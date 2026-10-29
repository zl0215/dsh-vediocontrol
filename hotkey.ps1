# hotkey.ps1 - global single-key push-to-talk listener for the DSH push-to-talk plugin.
#
# Runs under Windows PowerShell 5.1 (launched as):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File <dir>\hotkey.ps1
#
# Stdout protocol (one ASCII line per event, each line flushed immediately):
#   ready              hook installed and message pump running; at most one per process
#   down               target key went down (auto-repeat is suppressed)
#   up                 target key came up (paired after a reported "down")
#   error <reason>     fatal setup/runtime failure; process exits with code 1
#
# Target key: environment variable DSH_PTT_KEY, one of
#   F1..F12, ControlLeft, ControlRight, AltLeft, AltRight, ShiftLeft, ShiftRight
# Missing/unknown value -> "error invalid-key" and exit 1.
#
# The key is never swallowed: CallNextHookEx is always invoked.
# Injected input (SendInput / keybd_event) is NOT filtered, so the listener also
# works for synthetic events (this is required by the plugin's automated tests).
#
# Single self-contained file: the C# hook/pump source is embedded and compiled at
# run time with Add-Type. No helper files, no admin rights, no writes to disk.

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Small output helpers: stdout is the machine protocol, stderr is diagnostics.
# ---------------------------------------------------------------------------
function Write-ProtocolLine {
    param([Parameter(Mandatory = $true)][string]$Line)
    [Console]::Out.WriteLine($Line)
    [Console]::Out.Flush()
}

function Stop-WithError {
    param(
        [Parameter(Mandatory = $true)][string]$Reason,
        [string]$Detail = ''
    )
    Write-ProtocolLine ('error ' + $Reason)
    if (-not [string]::IsNullOrEmpty($Detail)) {
        [Console]::Error.WriteLine($Detail)
        [Console]::Error.Flush()
    }
    exit 1
}

# ---------------------------------------------------------------------------
# 1. Validate the target key before doing any expensive work.
# ---------------------------------------------------------------------------
$Key = $env:DSH_PTT_KEY
if ([string]::IsNullOrEmpty($Key)) {
    Stop-WithError 'invalid-key' 'DSH_PTT_KEY is not set'
}
$Key = $Key.Trim()

$ValidKeys = @(
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight'
)
if ($ValidKeys -cnotcontains $Key) {
    Stop-WithError 'invalid-key' ('unsupported DSH_PTT_KEY value: "' + $Key + '"')
}

# ---------------------------------------------------------------------------
# 2. Embedded C#: low-level keyboard hook (WH_KEYBOARD_LL) + WinForms pump.
#
#    The callback always forwards with CallNextHookEx. It runs on the thread
#    that owns the message pump, so plain static state is safe (no locking
#    needed for the down/up state machine; stdout writes are still serialized).
# ---------------------------------------------------------------------------
$HotkeySource = @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DshPtt
{
    public static class Hotkey
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_KEYUP = 0x0101;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_SYSKEYUP = 0x0105;
        private const uint LLKHF_EXTENDED = 0x01;
        private const uint MAPVK_VK_TO_VSC_EX = 4;
        private const int ERROR_INVALID_PARAMETER = 87;

        private enum Kind
        {
            Function,
            Control,
            Alt,
            Shift
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint uCode, uint uMapType);

        private static readonly object OutputLock = new object();
        private static LowLevelKeyboardProc _hookProc;
        private static IntPtr _hook = IntPtr.Zero;
        private static Kind _kind = Kind.Function;
        private static int _vk;
        private static bool _right;
        private static bool _isDown;

        // Installs the global hook. Returns 0 on success, otherwise a Win32
        // error code (or -1 when no error code is available).
        public static int Install(string keyName)
        {
            if (string.IsNullOrEmpty(keyName))
            {
                return ERROR_INVALID_PARAMETER;
            }

            switch (keyName)
            {
                case "ControlLeft":
                    _kind = Kind.Control; _vk = 0x11; _right = false; break;
                case "ControlRight":
                    _kind = Kind.Control; _vk = 0x11; _right = true; break;
                case "AltLeft":
                    _kind = Kind.Alt; _vk = 0x12; _right = false; break;
                case "AltRight":
                    _kind = Kind.Alt; _vk = 0x12; _right = true; break;
                case "ShiftLeft":
                    _kind = Kind.Shift; _vk = 0x10; _right = false; break;
                case "ShiftRight":
                    _kind = Kind.Shift; _vk = 0x10; _right = true; break;
                default:
                    {
                        int number;
                        if (keyName.Length < 2 || keyName.Length > 3 || keyName[0] != 'F')
                        {
                            return ERROR_INVALID_PARAMETER;
                        }
                        if (!int.TryParse(keyName.Substring(1), out number))
                        {
                            return ERROR_INVALID_PARAMETER;
                        }
                        if (number < 1 || number > 12)
                        {
                            return ERROR_INVALID_PARAMETER;
                        }
                        _kind = Kind.Function;
                        _vk = 0x70 + (number - 1);
                        _right = false;
                        break;
                    }
            }

            _isDown = false;
            _hookProc = HookCallback;
            IntPtr module = GetModuleHandle(null);
            _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _hookProc, module, 0);
            if (_hook == IntPtr.Zero)
            {
                int error = Marshal.GetLastWin32Error();
                _hookProc = null;
                return error == 0 ? -1 : error;
            }
            return 0;
        }

        // Blocks forever on the WinForms message loop. Low-level keyboard hooks
        // only fire while the installing thread pumps messages.
        public static void Pump()
        {
            Application.Run();
        }

        public static void Uninstall()
        {
            if (_hook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(_hook);
                _hook = IntPtr.Zero;
            }
            _hookProc = null;
        }

        private static void Emit(string line)
        {
            lock (OutputLock)
            {
                try
                {
                    Console.Out.WriteLine(line);
                    Console.Out.Flush();
                }
                catch
                {
                    // A closed stdout must never take the hook down.
                }
            }
        }

        private static bool IsTarget(ref KBDLLHOOKSTRUCT info)
        {
            int vk = (int)info.vkCode;
            switch (_kind)
            {
                case Kind.Function:
                    return vk == _vk;
                case Kind.Control:
                    // Some sources (notably SendInput) report the side-specific
                    // virtual key; hardware keyboards usually report the generic
                    // VK_CONTROL plus the LLKHF_EXTENDED flag.
                    if (vk == 0xA2) { return !_right; }
                    if (vk == 0xA3) { return _right; }
                    return vk == 0x11 && (((info.flags & LLKHF_EXTENDED) != 0) == _right);
                case Kind.Alt:
                    if (vk == 0xA4) { return !_right; }
                    if (vk == 0xA5) { return _right; }
                    return vk == 0x12 && (((info.flags & LLKHF_EXTENDED) != 0) == _right);
                case Kind.Shift:
                    if (vk == 0xA0) { return !_right; }
                    if (vk == 0xA1) { return _right; }
                    return vk == 0x10 && (ShiftIsRight(ref info) == _right);
            }
            return false;
        }

        private static bool ShiftIsRight(ref KBDLLHOOKSTRUCT info)
        {
            int scan = (int)(info.scanCode & 0xFF);
            if (scan == 0x36)
            {
                return true;
            }
            if (scan == 0x2A)
            {
                return false;
            }
            // Fallback for odd drivers: MAPVK_VK_TO_VSC_EX returns the left-hand
            // scan code for keys that do not distinguish sides, but some
            // layouts/drivers report the right-hand one.
            uint mapped = MapVirtualKey((uint)_vk, MAPVK_VK_TO_VSC_EX);
            return ((int)(mapped & 0xFF) == 0x36);
        }

        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0)
                {
                    int message = wParam.ToInt32();
                    bool isDown = (message == WM_KEYDOWN || message == WM_SYSKEYDOWN);
                    bool isUp = (message == WM_KEYUP || message == WM_SYSKEYUP);
                    if (isDown || isUp)
                    {
                        KBDLLHOOKSTRUCT info =
                            (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                        if (IsTarget(ref info))
                        {
                            if (isDown)
                            {
                                // Repeat guard: only the first down after the last up.
                                if (!_isDown)
                                {
                                    _isDown = true;
                                    Emit("down");
                                }
                            }
                            else if (_isDown)
                            {
                                _isDown = false;
                                Emit("up");
                            }
                        }
                    }
                }
            }
            catch
            {
                // Never let a callback exception break the hook chain.
            }
            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }
    }
}
'@

# ---------------------------------------------------------------------------
# 3. Compile, install the hook, then announce readiness.
# ---------------------------------------------------------------------------
try {
    Add-Type -TypeDefinition $HotkeySource -ReferencedAssemblies 'System.Windows.Forms' -ErrorAction Stop
}
catch {
    Stop-WithError 'compile-failed' $_.Exception.Message
}

try {
    $installError = [DshPtt.Hotkey]::Install($Key)
}
catch {
    Stop-WithError 'hook-install-failed' $_.Exception.Message
}
if ($installError -ne 0) {
    Stop-WithError 'hook-install-failed' ('SetWindowsHookEx failed, Win32 error ' + $installError)
}

# The hook is installed. No callback can run before Pump() starts, so "ready"
# is guaranteed to be the first protocol line.
Write-ProtocolLine 'ready'

# ---------------------------------------------------------------------------
# 4. Keep the hook alive. This call does not return until the process is
#    terminated (or the message loop is ended externally).
# ---------------------------------------------------------------------------
try {
    [DshPtt.Hotkey]::Pump()
}
catch {
    Stop-WithError 'pump-failed' $_.Exception.Message
}

try { [DshPtt.Hotkey]::Uninstall() } catch { }
Stop-WithError 'pump-stopped' 'message loop returned unexpectedly'
