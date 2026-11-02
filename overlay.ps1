# overlay.ps1 - streaming reply overlay for the DSH push-to-talk plugin.
#
# Runs under Windows PowerShell 5.1 (launched as):
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <dir>\overlay.ps1
#
# Shows the assistant's answer as an always-on-top panel while another
# application has focus. Text can be updated while the answer streams in.
#
# Commands on stdin, one per line (ASCII):
#   stream <base64-of-utf8-text>  update the streaming text (window stays visible)
#   show <base64-of-utf8-text>    final text, restart the auto-hide timer
#   hide                          hide the window
#   quit                          exit (stdin EOF also exits)
#
# Environment:
#   DSH_OVERLAY_SECONDS      auto-hide delay after the final text (default 10, min 3)
#   DSH_OVERLAY_OPACITY      background opacity 0-100 (default 92; 100 = opaque panel)
#   DSH_OVERLAY_FONT         font family name (default "Microsoft YaHei UI")
#   DSH_OVERLAY_FONT_SIZE    text size in px (default 20, clamped 10-40)
#
# Opaque (100%) windows are excluded from screen capture where Windows supports
# it; translucent windows use per-pixel transparency, which cannot be excluded.
#
# Stdout protocol (one ASCII line, flushed):
#   ready                 window created and dispatcher running
#   info ...              diagnostics
#   error <reason>        fatal setup/runtime failure; exits 1

$ErrorActionPreference = 'Stop'

function Write-Line {
    param([string]$Line)
    [Console]::Out.WriteLine($Line)
    [Console]::Out.Flush()
}

function Read-IntEnv {
    param([string]$Name, [int]$Default, [int]$Min, [int]$Max)
    $raw = [Environment]::GetEnvironmentVariable($Name)
    $value = $Default
    if (-not [string]::IsNullOrEmpty($raw)) {
        $parsed = 0
        if ([int]::TryParse($raw, [ref]$parsed)) { $value = $parsed }
    }
    if ($value -lt $Min) { $value = $Min }
    if ($value -gt $Max) { $value = $Max }
    return $value
}

$Seconds = Read-IntEnv 'DSH_OVERLAY_SECONDS' 10 3 600
$Opacity = Read-IntEnv 'DSH_OVERLAY_OPACITY' 92 0 100
$FontSize = Read-IntEnv 'DSH_OVERLAY_FONT_SIZE' 20 10 40
$Font = $env:DSH_OVERLAY_FONT
if ([string]::IsNullOrEmpty($Font)) { $Font = 'Microsoft YaHei UI' }

$OverlaySource = @'
using System;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using System.Runtime.InteropServices;

namespace DshPtt
{
    public static class ReplyOverlay
    {
        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TOPMOST = 0x00000008;
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
        private static DispatcherTimer _timer;
        private static DispatcherTimer _safety;
        private static Dispatcher _dispatcher;
        private static int _seconds = 10;
        private static bool _opaque = true;

        public static void Run(int seconds, int opacity, string fontName, int fontSize)
        {
            _seconds = seconds < 3 ? 3 : seconds;
            _opaque = opacity >= 99;
            _dispatcher = Dispatcher.CurrentDispatcher;

            var family = new FontFamily(fontName);
            double size = fontSize;
            double maxWidth = Math.Max(320, SystemParameters.WorkArea.Width * 0.55);

            var foreground = new SolidColorBrush(Color.FromRgb(24, 24, 28));
            var background = _opaque
                ? (Brush)Brushes.White
                : (Brush)new SolidColorBrush(Color.FromArgb((byte)Math.Round(opacity * 255.0 / 100.0), 255, 255, 255));
            var borderBrush = _opaque
                ? (Brush)new SolidColorBrush(Color.FromRgb(210, 210, 216))
                : new SolidColorBrush(Color.FromArgb((byte)Math.Round(opacity * 255.0 / 100.0), 120, 120, 132));

            _window = new Window();
            _window.WindowStyle = WindowStyle.None;
            _window.Topmost = true;
            _window.ShowInTaskbar = false;
            _window.ShowActivated = false;
            _window.ResizeMode = ResizeMode.NoResize;
            _window.SizeToContent = SizeToContent.WidthAndHeight;
            _window.WindowStartupLocation = WindowStartupLocation.Manual;
            _window.Focusable = false;
            _window.IsHitTestVisible = true;
            // Per-pixel transparency supports the adjustable background; opaque
            // windows can additionally be excluded from screen capture.
            _window.AllowsTransparency = !_opaque;
            _window.Background = _opaque ? (Brush)Brushes.White : Brushes.Transparent;

            _text = new TextBlock();
            _text.FontFamily = family;
            _text.FontSize = size;
            _text.Foreground = foreground;
            _text.TextWrapping = TextWrapping.Wrap;
            _text.TextAlignment = TextAlignment.Left;
            _text.MaxWidth = maxWidth;
            _text.Margin = new Thickness(0, 0, 26, 0);

            var grid = new Grid();
            grid.Children.Add(_text);

            var close = new Button();
            close.Content = "×";
            close.Width = 22;
            close.Height = 22;
            close.Padding = new Thickness(0);
            close.FontSize = 15;
            close.FontWeight = FontWeights.Bold;
            close.HorizontalAlignment = HorizontalAlignment.Right;
            close.VerticalAlignment = VerticalAlignment.Top;
            close.Foreground = new SolidColorBrush(Color.FromRgb(90, 90, 100));
            close.Background = Brushes.Transparent;
            close.BorderThickness = new Thickness(0);
            close.Cursor = System.Windows.Input.Cursors.Hand;
            close.Focusable = false;
            close.ToolTip = "取消";
            close.Click += delegate { HideText(); };
            grid.Children.Add(close);

            var border = new Border();
            border.Background = background;
            border.BorderBrush = borderBrush;
            border.BorderThickness = new Thickness(1);
            border.CornerRadius = new CornerRadius(_opaque ? 0 : 10);
            border.Padding = new Thickness(14, 10, 12, 12);
            border.Child = grid;
            _window.Content = border;

            _window.SizeChanged += delegate { Position(); };
            _window.SourceInitialized += delegate { ApplyWindowStyles(); };

            _timer = new DispatcherTimer();
            _timer.Interval = TimeSpan.FromSeconds(_seconds);
            _timer.Tick += delegate
            {
                _timer.Stop();
                if (_window != null) _window.Hide();
            };

            _safety = new DispatcherTimer();
            _safety.Interval = TimeSpan.FromSeconds(120);
            _safety.Tick += delegate
            {
                _safety.Stop();
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
                if (next != style) SetWindowLong(handle, GWL_EXSTYLE, next);
            }
            catch { }
            ApplyCaptureExclusion();
        }

        /// <summary>
        /// Exclusion from screen capture is only possible for the opaque panel;
        /// translucent windows use per-pixel transparency and remain capturable.
        /// </summary>
        private static void ApplyCaptureExclusion()
        {
            if (!_opaque) return;
            try
            {
                IntPtr handle = new WindowInteropHelper(_window).Handle;
                if (handle == IntPtr.Zero) return;
                uint current;
                if (GetWindowDisplayAffinity(handle, out current) && current == WDA_EXCLUDEFROMCAPTURE) return;
                if (SetWindowDisplayAffinity(handle, WDA_EXCLUDEFROMCAPTURE)) return;
                int excludeError = Marshal.GetLastWin32Error();
                if (SetWindowDisplayAffinity(handle, WDA_MONITOR)) return;
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

        private static void Present(string text)
        {
            _text.Text = text;
            _window.Show();
            _window.UpdateLayout();
            ApplyCaptureExclusion();
            Position();
        }

        private static void ShowText(string text)
        {
            try
            {
                if (string.IsNullOrEmpty(text)) return;
                Present(text);
                _safety.Stop();
                _timer.Stop();
                _timer.Start();
            }
            catch (Exception error)
            {
                WriteLine("error show-failed " + error.Message);
            }
        }

        private static void StreamText(string text)
        {
            try
            {
                if (string.IsNullOrEmpty(text)) return;
                Present(text);
                // While the answer streams the panel stays on screen; the final
                // "show" starts the auto-hide countdown.
                _timer.Stop();
                _safety.Stop();
                _safety.Start();
            }
            catch (Exception error)
            {
                WriteLine("error stream-failed " + error.Message);
            }
        }

        private static void HideText()
        {
            try
            {
                _timer.Stop();
                _safety.Stop();
                if (_window != null) _window.Hide();
            }
            catch { }
        }

        private static void Shutdown()
        {
            try
            {
                _timer.Stop();
                _safety.Stop();
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
                    bool streaming = line.StartsWith("stream ", StringComparison.Ordinal);
                    bool final = line.StartsWith("show ", StringComparison.Ordinal);
                    if (streaming || final)
                    {
                        try
                        {
                            string payload = line.Substring(streaming ? 7 : 5);
                            string text = Encoding.UTF8.GetString(Convert.FromBase64String(payload));
                            Post(delegate
                            {
                                if (streaming) StreamText(text);
                                else ShowText(text);
                            });
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
    [DshPtt.ReplyOverlay]::Run($Seconds, $Opacity, $Font, $FontSize)
}
catch {
    Write-Line 'error run-failed'
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
