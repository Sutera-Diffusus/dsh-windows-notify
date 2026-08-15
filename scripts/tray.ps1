# DSH tray badge (plugin form): taskbar tray icon with a red count badge.
# Count = pending decisions + completed-but-unviewed tasks.
# Click the icon: opens the DSH GUI and marks completed items as read.
# Payload (Base64 JSON, -PayloadB64): { stateFile, port, url, lockFile }
#   - stateFile: tray-state.json path under $DSH_HOME/dsh-windows-notify
#   - port:      the DSH webServer port (watchdog + open URL)
#   - url:       the GUI URL the icon opens
#   - lockFile:  per-port single-instance lock (instances do not fight)
# The tray exits by itself when the DSH host stops listening on port.
# Pure ASCII comments; user-facing strings are Chinese literals (file must be UTF-8 BOM).
param([string]$PayloadB64 = "")
$ErrorActionPreference = "SilentlyContinue"

$payload = $null
if ($PayloadB64 -ne "") {
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64))
    $payload = $json | ConvertFrom-Json
  } catch { }
}
if ($null -eq $payload) { exit 0 }

$stateFile = [string]$payload.stateFile
$port      = [int]$payload.port
$url       = [string]$payload.url
$lockFile  = [string]$payload.lockFile
if ($stateFile -eq "" -or $port -le 0) { exit 0 }
if ($url -eq "") { $url = "http://127.0.0.1:$port" }
if ($lockFile -eq "") { $lockFile = Join-Path $env:TEMP "dshnotify-tray.lock" }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class TrayIconCleanup { [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle); }'

# single instance guard (per port)
if (Test-Path $lockFile) {
  $existingPid = 0
  try { $existingPid = [int](Get-Content $lockFile -Raw) } catch { }
  if ($existingPid -gt 0 -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) { exit 0 }
}
try { [IO.File]::WriteAllText($lockFile, [string]$PID) } catch { }

# icon cache per count (0..99+); HICONs are destroyed once on exit (GDI leak prevention)
$script:iconCache = @{}
function New-TrayIcon([int]$Count) {
  if ($script:iconCache.ContainsKey($Count)) { return $script:iconCache[$Count] }
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 43, 92, 230))
  $g.FillEllipse($blue, 3, 3, 26, 26)
  $white = [System.Drawing.Brushes]::White
  $g.FillEllipse($white, 12, 12, 8, 8)
  if ($Count -gt 0) {
    $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 230, 60, 60))
    $g.FillEllipse($red, 17, 1, 14, 14)
    $text = if ($Count -gt 99) { "99+" } else { [string]$Count }
    $font = New-Object System.Drawing.Font "Segoe UI", 8, ([System.Drawing.FontStyle]::Bold)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF 17, 1, 14, 14
    $g.DrawString($text, $font, $white, $rect, $sf)
    $font.Dispose()
    $sf.Dispose()
  }
  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $script:iconCache[$Count] = $icon
  return $icon
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Visible = $true
$notify.Icon = (New-TrayIcon 0)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = "Open DSH"
$openItem.Add_Click({ Start-Process $url })
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "Exit tray"
$exitItem.Add_Click({ $notify.Visible = $false; [System.Windows.Forms.Application]::Exit() })
[void]$menu.Items.Add($openItem)
[void]$menu.Items.Add($exitItem)
$notify.ContextMenuStrip = $menu

$script:lastCount = -1
$script:UpdateIcon = {
  try {
    $raw = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8)
    $state = $raw | ConvertFrom-Json
    $pending = 0
    if ($state.pending) { $pending = [int]$state.pending }
    $completed = @($state.completed)
    $total = $pending + $completed.Count
    if ($total -ne $script:lastCount) {
      $script:lastCount = $total
      $notify.Icon = (New-TrayIcon $total)
      $tip = "DSH - $pending pending, $($completed.Count) unread"
      $titles = ($completed | ForEach-Object { $_.title } | Where-Object { $_ }) -join ", "
      if ($titles) { $tip = $tip + "`n" + $titles }
      if ($tip.Length -gt 120) { $tip = $tip.Substring(0, 120) }
      $notify.Text = $tip
    }
  } catch { }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.Add_Tick($script:UpdateIcon)
$timer.Start()
& $script:UpdateIcon

# single click = primary action (open GUI + mark read); ignore the duplicate click
# that a double-click always raises first (community convention: double-click is redundant).
$script:lastClick = [DateTime]::MinValue
$notify.Add_Click({
  $now = Get-Date
  if (($now - $script:lastClick).TotalMilliseconds -lt 400) { return }
  $script:lastClick = $now
  try {
    $raw = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8)
    $state = $raw | ConvertFrom-Json
    $state.completed = @()
    $json = $state | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($stateFile, $json, (New-Object Text.UTF8Encoding($false)))
  } catch { }
  Start-Process $url
})

# watchdog: exit when the DSH host stops listening
$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 5000
$watch.Add_Tick({
  $alive = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if (-not $alive) {
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$watch.Start()

[System.Windows.Forms.Application]::Run()

# cleanup: destroy cached HICONs (GDI leak prevention), remove lock, dispose
foreach ($icon in $script:iconCache.Values) {
  try { [TrayIconCleanup]::DestroyIcon($icon.Handle) | Out-Null; $icon.Dispose() } catch { }
}
try { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue } catch { }
if ($notify) { $notify.Dispose() }
