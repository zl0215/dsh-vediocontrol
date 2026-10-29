# overlay.ps1 - reply overlay for the DSH push-to-talk plugin.
#
# Runs under Windows PowerShell 5.1 (launched as):
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <dir>\overlay.ps1
#
# Shows the assistant's answer as an always-on-top panel while another
# application has focus. The panel has a white background, a cancel button and
# auto-hides after DSH_OVERLAY_SECONDS (default 10).
#
# Screen-share privacy: the window is excluded from screen capture with
# SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE), so screen sharing/recording
# tools (for example Tencent Meeting sharing the whole screen) do not see it
# while the local user still does. Windows only supports that exclusion for
# windows without per-pixel transparency, hence the solid white panel by
# default. Set DSH_OVERLAY_TRANSPARENT=1 for the old transparent look
# (capturable by screen shares).
#
# Commands on stdin, one per line (ASCII):
#   show <base64-of-utf8-text>   display the text, restart the auto-hide timer
#   hide                         hide the window
#   quit                         exit (stdin EOF also exits)
#
# Stdout protocol (one ASCII line, flushed):
#   ready                 window created and dispatcher running
#   info ...              best-effort diagnostics
#   error <reason>        fatal setup/runtime failure; exits 1

$ErrorActionPreference = 'Stop'

function Write-Line {
    param([string]$Line)
    [Console]::Out.WriteLine($Line)
    [Console]::Out.Flush()
}

$Seconds = 10
if (-not [string]::IsNullOrEmpty($env:DSH_OVERLAY_SECONDS)) {
    $parsed = 0
    if ([int]::TryParse($env:DSH_OVERLAY_SECONDS, [ref]$parsed)) { $Seconds = $parsed }
}
if ($Seconds -lt 3) { $Seconds = 3 }

$Transparent = ($env:DSH_OVERLAY_TRANSPARENT -eq '1')

$OverlaySource = @'
using System;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using System.Runtime.InteropServices;

namespace DshPtt
{
    public static class ReplyOverlay
    {
        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TOPMOST = 0x00000008;
        private const int WS_EX_TRANSPARENT = 0x00000020;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int WS_EX_NOACTIVATE = 0x08000000;

        private const uint WDA_MONITOR = 0x00000001;
        private const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;

        [DllImport("user32.dll")]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);

        private static Window _window;
        private static TextBlock _text;
        private static TextBlock _outline;
        private static Button _close;
        private static DispatcherTimer _timer;
        private static Dispatcher _dispatcher;
        private static int _seconds = 10;
        private static bool _transparent = false;

        public static void Run(int seconds, bool transparent)
        {
            _seconds = seconds < 3 ? 3 : seconds;
            _transparent = transparent;
            _dispatcher = Dispatcher.CurrentDispatcher;

            _window = new Window();
            _window.WindowStyle = WindowStyle.None;
            _window.Topmost = true;
            _window.ShowInTaskbar = false;
            _window.ShowActivated = false;
            _window.ResizeMode = ResizeMode.NoResize;
            _window.SizeToContent = SizeToContent.WidthAndHeight;
            _window.WindowStartupLocation = WindowStartupLocation.Manual;
            _window.Focusable = false;
            // Per-pixel transparency blocks SetWindowDisplayAffinity on Windows.
            // Opaque mode keeps the white panel excluded from screen capture.
            _window.AllowsTransparency = transparent;
            // Transparent mode stays click-through; the opaque panel is
            // interactive so its cancel button can be pressed.
            _window.IsHitTestVisible = !transparent;
            _window.Background = transparent ? Brushes.Transparent : Brushes.White;

            var fontFamily = new FontFamily("Microsoft YaHei UI");
            double fontSize = 20;
            double maxWidth = Math.Max(320, SystemParameters.WorkArea.Width * 0.55);

            _outline = new TextBlock();
            _outline.FontFamily = fontFamily;
            _outline.FontSize = fontSize;
            _outline.Foreground = Brushes.Black;
            _outline.TextWrapping = TextWrapping.Wrap;
            _outline.TextAlignment = TextAlignment.Left;
            _outline.MaxWidth = maxWidth;
            _outline.Visibility = transparent ? Visibility.Visible : Visibility.Collapsed;
            if (transparent)
            {
                _outline.Effect = new DropShadowEffect
                {
                    Color = Colors.Black,
                    BlurRadius = 9,
                    ShadowDepth = 0,
                    Opacity = 1.0
                };
            }

            _text = new TextBlock();
            _text.FontFamily = fontFamily;
            _text.FontSize = fontSize;
            _text.Foreground = transparent ? Brushes.White : new SolidColorBrush(Color.FromRgb(24, 24, 28));
            _text.TextWrapping = TextWrapping.Wrap;
            _text.TextAlignment = TextAlignment.Left;
            _text.MaxWidth = maxWidth;
            _text.Margin = new Thickness(0, 0, 26, 0);

            var grid = new Grid();
            grid.Children.Add(_outline);
            grid.Children.Add(_text);

            _close = new Button();
            _close.Content = "×";
            _close.Width = 22;
            _close.Height = 22;
            _close.Padding = new Thickness(0);
            _close.FontSize = 15;
            _close.FontWeight = FontWeights.Bold;
            _close.HorizontalAlignment = HorizontalAlignment.Right;
            _close.VerticalAlignment = VerticalAlignment.Top;
            _close.Foreground = transparent ? Brushes.White : new SolidColorBrush(Color.FromRgb(90, 90, 100));
            _close.Background = Brushes.Transparent;
            _close.BorderThickness = new Thickness(0);
            _close.Cursor = System.Windows.Input.Cursors.Hand;
            _close.Focusable = false;
            _close.ToolTip = "取消";
            _close.Click += delegate { HideText(); };
            _close.Visibility = transparent ? Visibility.Collapsed : Visibility.Visible;
            grid.Children.Add(_close);

            if (transparent)
            {
                _window.Content = grid;
            }
            else
            {
                var border = new Border();
                border.Background = Brushes.White;
                border.BorderBrush = new SolidColorBrush(Color.FromRgb(210, 210, 216));
                border.BorderThickness = new Thickness(1);
                border.Padding = new Thickness(14, 10, 12, 12);
                border.Child = grid;
                _window.Content = border;
            }

            _window.SizeChanged += delegate { Position(); };
            _window.SourceInitialized += delegate { ApplyWindowStyles(); };

            _timer = new DispatcherTimer();
            _timer.Interval = TimeSpan.FromSeconds(_seconds);
            _timer.Tick += delegate
            {
                _timer.Stop();
                if (_window != null) _window.Hide();
            };

            var reader = new Thread(ReadLoop);
            reader.IsBackground = true;
            reader.Start();

            WriteLine("ready");
            Dispatcher.Run();
        }

        private static void WriteLine(string line)
        {
            try
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
            catch { }
        }

        private static void ApplyWindowStyles()
        {
            try
            {
                IntPtr handle = new WindowInteropHelper(_window).Handle;
                if (handle == IntPtr.Zero) return;
                int style = GetWindowLong(handle, GWL_EXSTYLE);
                int next = style | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
                // Click-through only in the transparent mode; the white panel
                // must receive clicks for its cancel button.
                if (_transparent) next |= WS_EX_TRANSPARENT;
                if (next != style) SetWindowLong(handle, GWL_EXSTYLE, next);
            }
            catch { }
            ApplyCaptureExclusion();
        }

        /// <summary>
        /// Keep the panel out of screen shares and recordings. WDA_EXCLUDEFROMCAPTURE
        /// needs Windows 10 2004+ and a window without per-pixel transparency; the
        /// older WDA_MONITOR is the fallback (capture shows a black hole instead).
        /// </summary>
        private static void ApplyCaptureExclusion()
        {
            try
            {
                IntPtr handle = new WindowInteropHelper(_window).Handle;
                if (handle == IntPtr.Zero) return;
                uint current;
                if (GetWindowDisplayAffinity(handle, out current) && current == WDA_EXCLUDEFROMCAPTURE) return;
                if (SetWindowDisplayAffinity(handle, WDA_EXCLUDEFROMCAPTURE))
                {
                    WriteLine("info capture-exclusion excluded");
                    return;
                }
                int excludeError = Marshal.GetLastWin32Error();
                if (SetWindowDisplayAffinity(handle, WDA_MONITOR))
                {
                    WriteLine("info capture-exclusion monitor-fallback " + excludeError);
                    return;
                }
                int monitorError = Marshal.GetLastWin32Error();
                WriteLine("info capture-exclusion failed " + excludeError + "," + monitorError);
            }
            catch { }
        }

        private static void Position()
        {
            try
            {
                if (_window == null || _window.ActualWidth <= 0) return;
                Rect area = SystemParameters.WorkArea;
                _window.Left = area.Left + Math.Max(0, (area.Width - _window.ActualWidth) / 2);
                _window.Top = area.Top + Math.Max(0, area.Height * 0.08);
            }
            catch { }
        }

        private static void ShowText(string text)
        {
            try
            {
                if (string.IsNullOrEmpty(text)) return;
                _text.Text = text;
                _outline.Text = text;
                _window.Show();
                _window.UpdateLayout();
                ApplyCaptureExclusion();
                Position();
                _timer.Stop();
                _timer.Start();
            }
            catch (Exception error)
            {
                WriteLine("error show-failed " + error.Message);
            }
        }

        private static void HideText()
        {
            try
            {
                _timer.Stop();
                if (_window != null) _window.Hide();
            }
            catch { }
        }

        private static void Shutdown()
        {
            try
            {
                _timer.Stop();
                if (_window != null) _window.Close();
            }
            catch { }
            try { Dispatcher.CurrentDispatcher.InvokeShutdown(); } catch { }
        }

        private static void Post(Action action)
        {
            try { _dispatcher.BeginInvoke(action); } catch { }
        }

        private static void ReadLoop()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (line.Length == 0) continue;
                    if (line == "hide")
                    {
                        Post(HideText);
                        continue;
                    }
                    if (line == "quit")
                    {
                        Post(Shutdown);
                        return;
                    }
                    if (line.StartsWith("show ", StringComparison.Ordinal))
                    {
                        try
                        {
                            string payload = line.Substring(5);
                            string text = Encoding.UTF8.GetString(Convert.FromBase64String(payload));
                            Post(delegate { ShowText(text); });
                        }
                        catch
                        {
                            WriteLine("error bad-payload");
                        }
                        continue;
                    }
                    WriteLine("error unknown-command");
                }
            }
            catch { }
            Post(Shutdown);
        }
    }
}
'@

try {
    Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
    Add-Type -AssemblyName PresentationCore -ErrorAction Stop
    Add-Type -AssemblyName WindowsBase -ErrorAction Stop
    Add-Type -TypeDefinition $OverlaySource `
        -ReferencedAssemblies 'PresentationFramework', 'PresentationCore', 'WindowsBase', 'System.Xaml' `
        -ErrorAction Stop
}
catch {
    Write-Line 'error compile-failed'
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}

try {
    [DshPtt.ReplyOverlay]::Run($Seconds, $Transparent)
}
catch {
    Write-Line 'error run-failed'
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
