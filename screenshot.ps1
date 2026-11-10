# screenshot.ps1 - on-demand screen capture helper for the DSH push-to-talk plugin.
#
# Runs under Windows PowerShell 5.1 (launched as):
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <dir>\screenshot.ps1
#
# Captures the whole virtual desktop (all monitors) into a temporary PNG, then
# reports the file so the Host can read and delete it.
#
# Commands on stdin, one per line (ASCII):
#   capture              capture the screen and answer with one "ok" line
#   quit                 exit (stdin EOF also exits)
#
# Environment:
#   DSH_SCREENSHOT_MAX_WIDTH   downscale wider captures to this width (default 1920, 0 = keep)
#
# Stdout protocol (one ASCII line per capture, flushed):
#   ready                              helper is up and waiting for commands
#   ok <path> <width> <height> <bytes> capture written to <path>
#   error <reason>                     capture failed; the helper keeps running
#
# The PNG is written under the user's TEMP directory; the Host deletes it after
# reading. Nothing leaves this machine except through the Host's loopback API.

$ErrorActionPreference = 'Stop'

function Write-Line {
    param([string]$Line)
    [Console]::Out.WriteLine($Line)
    [Console]::Out.Flush()
}

$MaxWidth = 1920
$raw = [Environment]::GetEnvironmentVariable('DSH_SCREENSHOT_MAX_WIDTH')
if (-not [string]::IsNullOrEmpty($raw)) {
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed)) { $MaxWidth = [Math]::Max(0, $parsed) }
}

$ScreenSource = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DshPtt
{
    public static class ScreenShot
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        public static void MakeDpiAware()
        {
            try { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
            catch { try { SetProcessDPIAware(); } catch { } }
        }

        /// <summary>Capture the virtual desktop to a PNG path. Returns "path|width|height".</summary>
        public static string Capture(string path, int maxWidth)
        {
            Rectangle bounds = SystemInformation.VirtualScreen;
            if (bounds.Width <= 0 || bounds.Height <= 0) throw new InvalidOperationException("no screen bounds");
            using (Bitmap full = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb))
            using (Graphics graphics = Graphics.FromImage(full))
            {
                graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, full.Size, CopyPixelOperation.SourceCopy);
                Bitmap output = full;
                if (maxWidth > 0 && full.Width > maxWidth)
                {
                    int height = (int)Math.Round(full.Height * (double)maxWidth / full.Width);
                    output = new Bitmap(maxWidth, height, PixelFormat.Format32bppArgb);
                    using (Graphics scaled = Graphics.FromImage(output))
                    {
                        scaled.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        scaled.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        scaled.DrawImage(full, 0, 0, output.Width, output.Height);
                    }
                }
                try
                {
                    output.Save(path, ImageFormat.Png);
                    return path + "|" + output.Width + "|" + output.Height;
                }
                finally
                {
                    if (!ReferenceEquals(output, full)) output.Dispose();
                }
            }
        }
    }
}
'@

try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -TypeDefinition $ScreenSource `
        -ReferencedAssemblies 'System.Drawing', 'System.Windows.Forms' `
        -ErrorAction Stop
}
catch {
    Write-Line 'error compile-failed'
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}

try { [DshPtt.ScreenShot]::MakeDpiAware() } catch { }

Write-Line 'ready'

$temp = [System.IO.Path]::GetTempPath()
try {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        $line = $line.Trim()
        if ($line -eq '') { continue }
        if ($line -eq 'quit') { break }
        if ($line -ne 'capture') {
            Write-Line 'error unknown-command'
            continue
        }
        $path = Join-Path $temp ('dsh-screenshot-' + [Guid]::NewGuid().ToString('N') + '.png')
        try {
            $result = [DshPtt.ScreenShot]::Capture($path, $MaxWidth)
            $parts = $result.Split('|')
            $size = (Get-Item -LiteralPath $path).Length
            Write-Line ('ok ' + $parts[0] + ' ' + $parts[1] + ' ' + $parts[2] + ' ' + $size)
        }
        catch {
            Write-Line ('error capture-failed ' + $_.Exception.Message)
        }
    }
}
catch {
    Write-Line 'error loop-failed'
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
