# DSH taskbar bubble badge v3: no extra tray icon.
# Spawned by notify-core with -PayloadB64 (JSON: stateFile, port, url, lockFile, installRoot).
# Draws a crisp red bubble with a white number as the native taskbar overlay on
# the DSH desktop window button (ITaskbarList3, 4x supersampled for high-DPI).
# Hidden when count = 0; exits by itself when the DSH host port stops listening.
# Unread items are auto-cleared when the DSH window becomes the foreground window.
# User-facing strings are Chinese; file must be UTF-8 with BOM.
param([string]$PayloadB64 = "")
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TrayNative {
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pfwi);
}
[ComImport, Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITaskbarList3 {
  void HrInit();
  void AddTab(IntPtr hwnd);
  void DeleteTab(IntPtr hwnd);
  void ActivateTab(IntPtr hwnd);
  void SetActiveAlt(IntPtr hwnd);
  void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fFullscreen);
  void SetProgressValue(IntPtr hwnd, ulong ullCompleted, ulong ullTotal);
  void SetProgressState(IntPtr hwnd, int tbpFlags);
  void RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
  void UnregisterTab(IntPtr hwndTab);
  void SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
  void SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, uint dwReserved);
  void ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
  void ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
  void ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
  void SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
  void SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string pszTip);
  void SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
  void SetTabProperties(IntPtr hwndTab, int stpFlags);
  void SetJumpList(IntPtr hwnd, IntPtr pJumpList);
}
public static class TrayOverlay {
  private static ITaskbarList3 _tlb;
  private static bool _ready;
  [DllImport("ole32.dll")] public static extern int CoCreateInstance(ref Guid clsid, IntPtr pUnkOuter, uint dwClsContext, ref Guid iid, out IntPtr ppv);
  public static void Init() {
    if (_ready) return;
    Guid clsid = new Guid("56FDF344-FD6D-11d0-958A-006097C9A090");
    Guid iid = typeof(ITaskbarList3).GUID;
    IntPtr ppv;
    int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out ppv);
    if (hr < 0) throw new Exception("CoCreateInstance failed 0x" + hr.ToString("X8"));
    _tlb = (ITaskbarList3)Marshal.GetObjectForIUnknown(ppv);
    _tlb.HrInit();
    _ready = true;
  }
  public static bool Available() { return _ready; }
  public static void SetOverlay(long hwnd, long hIcon, string desc) {
    if (!_ready) return;
    _tlb.SetOverlayIcon(new IntPtr(hwnd), new IntPtr(hIcon), desc);
  }
}
'@

$payload = @{}
if ($PayloadB64 -ne "") {
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64))
    $payload = $json | ConvertFrom-Json
  } catch { }
}
$stateFile = [string]$payload.stateFile
$dsPort = 3080
try { $p = [int]$payload.port; if ($p -gt 0 -and $p -lt 65536) { $dsPort = $p } } catch { }
$lockFile = [string]$payload.lockFile
if ($stateFile -eq "") { exit 0 }
if ($lockFile -eq "") { $lockFile = Join-Path $env:TEMP "dshnotify-tray.lock" }
$logFile = Join-Path $env:TEMP "dsh-tray-badge.log"

function Log-Badge([string]$msg) {
  try { Add-Content -Path $logFile -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $msg) -Encoding UTF8 } catch { }
}

# single instance guard
if (Test-Path $lockFile) {
  $existingPid = 0
  try { $existingPid = [int](Get-Content $lockFile -Raw) } catch { }
  if ($existingPid -gt 0 -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) { exit 0 }
}
try { [IO.File]::WriteAllText($lockFile, [string]$PID) } catch { }

# taskbar overlay (all COM calls wrapped in C#)
$script:overlayReady = $false
try {
  [TrayOverlay]::Init()
  $script:overlayReady = [TrayOverlay]::Available()
  Log-Badge ("overlay COM " + $(if ($script:overlayReady) { "ready" } else { "unavailable" }))
} catch {
  Log-Badge ("overlay COM failed: " + $_.Exception.Message)
}

# red bubble with white number: rendered at 4x supersample (64px) so the
# taskbar's 16px logical overlay stays crisp on high-DPI displays.
$script:bubbleCache = @{}
function New-BubbleIcon([string]$Text, [int]$Size) {
  $key = "$Size-$Text"
  if ($script:bubbleCache.ContainsKey($key)) { return $script:bubbleCache[$key] }
  $S = $Size * 4
  $bmp = New-Object System.Drawing.Bitmap($S, $S)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $m = [int][Math]::Max(2, $S * 0.05)
  $d = $S - 2 * $m
  $rect = New-Object System.Drawing.RectangleF $m, $m, $d, $d
  $lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
    ([System.Drawing.Color]::FromArgb(255, 255, 107, 94)),
    ([System.Drawing.Color]::FromArgb(255, 240, 45, 34)),
    90)
  $g.FillEllipse($lg, $rect)
  $lg.Dispose()
  $fs = [float]($d * 0.62)
  if ($Text.Length -ge 3) { $fs = [float]($d * 0.42) }   # "99+"
  elseif ($Text.Length -eq 2) { $fs = [float]($d * 0.5) }
  $font = New-Object System.Drawing.Font "Segoe UI", $fs, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  # 精确居中(数字字形有侧边距偏差:整体向右上微调补偿)
  $szf = $g.MeasureString($Text, $font)
  $tx = [float](($S - $szf.Width) / 2) + [float]($S * 0.03)
  $ty = [float](($S - $szf.Height) / 2) - [float]($S * 0.02)
  $g.DrawString($Text, $font, [System.Drawing.Brushes]::White, $tx, $ty)
  $font.Dispose()
  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $bmp.Dispose()
  $script:bubbleCache[$key] = $icon
  return $icon
}

function Get-DshWindow() {
  try {
    $p = Get-Process DeepSeekHarness-Launcher -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { return $p.MainWindowHandle }
  } catch { }
  return [IntPtr]::Zero
}

$script:lastOverlay = -99
$script:wasZero = $true
$script:Update = {
  try {
    $pending = 0
    $unread = 0
    try {
      $raw = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8)
      $state = $raw | ConvertFrom-Json
      if ($state.pending) { $pending = [int]$state.pending }
      $unread = @($state.completed).Count
    } catch { }
    $total = $pending + $unread

    $hwnd = Get-DshWindow

    # DSH 窗口在前台 = 已读:自动清掉未读计数
    if ($hwnd -ne [IntPtr]::Zero -and $unread -gt 0) {
      try {
        $fg = [TrayNative]::GetForegroundWindow()
        if ($fg -eq $hwnd) {
          $raw = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8)
          $state = $raw | ConvertFrom-Json
          if (@($state.completed).Count -gt 0) {
            $state.completed = @()
            $json = $state | ConvertTo-Json -Depth 5
            [IO.File]::WriteAllText($stateFile, $json, (New-Object Text.UTF8Encoding($false)))
            Log-Badge "unread auto-cleared (window focused)"
            $unread = 0
            $total = $pending
          }
        }
      } catch { }
    }

    if ($hwnd -ne [IntPtr]::Zero) {
      if ($total -ne $script:lastOverlay) {
        $script:lastOverlay = $total
        if ($script:overlayReady) {
          if ($total -gt 0) {
            $text = if ($total -gt 99) { "99+" } else { [string]$total }
            $ico = New-BubbleIcon $text 16
            [TrayOverlay]::SetOverlay($hwnd.ToInt64(), $ico.Handle.ToInt64(), "$pending 待处理 / $unread 未读")
            Log-Badge "bubble set count=$total hwnd=$hwnd"
          } else {
            [TrayOverlay]::SetOverlay($hwnd.ToInt64(), 0, "")
            Log-Badge "bubble cleared"
          }
        }
      }
      if ($script:wasZero -and $total -gt 0) {
        $fi = New-Object TrayNative+FLASHWINFO
        $fi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($fi)
        $fi.hwnd = $hwnd
        $fi.dwFlags = 3
        $fi.uCount = 3
        $fi.dwTimeout = 0
        [TrayNative]::FlashWindowEx([ref]$fi) | Out-Null
        Log-Badge "taskbar flashed"
      }
    } else {
      $script:lastOverlay = -99
    }
    $script:wasZero = ($total -eq 0)

    # watchdog: exit when the DSH host stops listening
    $alive = Get-NetTCPConnection -LocalPort $dsPort -State Listen -ErrorAction SilentlyContinue
    if (-not $alive) {
      Log-Badge "host port $dsPort down, exiting"
      $script:stop = $true
    }
  } catch {
    Log-Badge "update error: $($_.Exception.Message)"
  }
}

& $script:Update
Log-Badge "bubble badge v3 started pid=$PID port=$dsPort"

$script:stop = $false
while (-not $script:stop) {
  Start-Sleep -Milliseconds 1500
  & $script:Update
}

# cleanup: clear overlay, destroy HICONs, remove lock
try {
  if ($script:overlayReady) {
    $hwnd = Get-DshWindow
    if ($hwnd -ne [IntPtr]::Zero) { [TrayOverlay]::SetOverlay($hwnd.ToInt64(), 0, "") }
  }
} catch { }
foreach ($icon in $script:bubbleCache.Values) {
  try { [TrayNative]::DestroyIcon($icon.Handle) | Out-Null; $icon.Dispose() } catch { }
}
try { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue } catch { }
Log-Badge "bubble badge exited"
