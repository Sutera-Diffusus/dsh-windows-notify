param(
  [Parameter(Mandatory = $true)][string]$PayloadB64
)
# dsh-windows-notify toast script v5.
# 载荷经 Base64 传递（规避 Windows 命令行对 & 等的解析问题），解码为 JSON：
#   { line1, line2, line3, sound, actions: [{ label, url }] }
# - Sound: WAV 文件经 SoundPlayer.PlaySync 播放（进程活到旋律播完）；
#   Toast 自带音频静音，避免混入系统默认音。
# - Actions: 每个选项一个按钮（http 答案路由）。
$ErrorActionPreference = "Continue"

function T-Log([string]$Message) {
  try {
    $logPath = $env:TEMP
    if ($payload -and $payload.PSObject.Properties["logFile"] -and $payload.logFile) { $logPath = [string]$payload.logFile }
    else { $logPath = Join-Path $logPath "dshnotify-hook.log" }
    Add-Content -Path $logPath -Value ("{0} toast.ps1 {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"), $Message) -Encoding UTF8
  } catch { }
}

function To-XmlText([string]$Value) {
  if ($null -eq $Value) { return "" }
  return $Value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;").Replace("'", "&apos;")
}

T-Log ("start b64len=" + $PayloadB64.Length)
$payload = $null
try {
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64)) | ConvertFrom-Json
  T-Log "payload decoded"
} catch {
  T-Log ("payload decode FAILED: " + $_.Exception.Message)
  exit 0
}

$Line1 = [string]$payload.line1
$Line2 = [string]$payload.line2
$Line3 = [string]$payload.line3
$Sound = [string]$payload.sound
$Mute = $false
if ($payload.PSObject.Properties["mute"] -and $payload.mute -eq $true) { $Mute = $true }
$Quiet = "none"
if ($payload.PSObject.Properties["quiet"] -and $payload.quiet) { $Quiet = [string]$payload.quiet }
$RespectDnd = $false
if ($payload.PSObject.Properties["respectSystemDnd"] -and $payload.respectSystemDnd -eq $true) { $RespectDnd = $true }
T-Log ("decoded L1=" + $Line1.Substring(0, [Math]::Min(60, $Line1.Length)) + " mute=" + $Mute + " quiet=" + $Quiet)

# 免打扰时段（badge-only）：完全静默退出（角标已由主机侧登记）
if ($Quiet -eq "badge-only") {
  T-Log "quiet hours: badge-only, skip toast and sound"
  exit 0
}

# 跟随系统勿扰（专注助手）：检测到系统 DND 激活时降级为 silent（横幅由系统收纳，我们只静音）
if ($RespectDnd -and $Quiet -eq "none") {
  try {
    function Test-FocusAssistData {
      # 主路径（多数 Win10/11 构建）
      $direct = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current\default`$Windows.Data.Notifications.FocusAssist`$\Current"
      if (Test-Path $direct) {
        $v = (Get-ItemProperty -Path $direct -Name "Data" -ErrorAction SilentlyContinue).Data
        if ($null -ne $v) { return $v }
      }
      # 备用扫描：DefaultAccount/Cache 下任意含 focusassist 的键
      foreach ($base in @(
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CloudStore\Store\Cache\DefaultAccount"
      )) {
        if (-not (Test-Path $base)) { continue }
        Get-ChildItem $base -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match "focusassist" } | ForEach-Object {
          $cur = Join-Path $_.PSPath "Current"
          if (Test-Path $cur) {
            $v = (Get-ItemProperty -Path $cur -Name "Data" -ErrorAction SilentlyContinue).Data
            if ($null -ne $v) { return $v }
          }
        }
      }
      return $null
    }
    $dndData = Test-FocusAssistData
    if ($null -ne $dndData -and [int]$dndData -ne 0) {
      $Quiet = "silent"
      T-Log ("system DND active (data=" + [int]$dndData + "): silent mode")
    }
  } catch { T-Log "DND check threw (ignored)" }
}

try { T-Log ("soundExists=" + (Test-Path -LiteralPath $Sound) + " sound=" + $Sound) } catch { T-Log "sound check threw" }

$L1 = To-XmlText $Line1
$L2 = To-XmlText $Line2
$L3 = To-XmlText $Line3

$Audio = ""
if ($Mute -or ($Sound -and (Test-Path -LiteralPath $Sound))) {
  # Silence the toast audio; our melody is played by SoundPlayer below (or muted entirely).
  $Audio = "<audio silent='true' />"
}

$Line3Xml = ""
if ($L3.Length -gt 0) { $Line3Xml = "<text>$L3</text>" }

$ActionsXml = ""
$actionPairs = @()
if ($payload.actions) {
  foreach ($a in $payload.actions) {
    $actionPairs += ([string]$a.label + "|" + [string]$a.url)
  }
}
foreach ($pair in $actionPairs) {
  $kv = $pair -split "\|", 2
  if ($kv.Length -eq 2 -and $kv[0].Length -gt 0) {
    $content = To-XmlText $kv[0]
    $arguments = To-XmlText $kv[1]
    $ActionsXml += ('<action activationType="protocol" content="{0}" arguments="{1}" />' -f $content, $arguments)
  }
}
if ($ActionsXml.Length -gt 0) { $ActionsXml = "<actions>" + $ActionsXml + "</actions>" }
T-Log ("actionsXml len=" + $ActionsXml.Length)

$XmlString = "<toast duration='short'><visual><binding template='ToastGeneric'><text>$L1</text><text>$L2</text>$Line3Xml</binding></visual>$Audio$ActionsXml</toast>"

$Shown = $false
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $Xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $Xml.LoadXml($XmlString)
  T-Log "xml loaded"
  $Toast = [Windows.UI.Notifications.ToastNotification]::new($Xml)

  # Prefer the extension's registered AUMID; fall back to the well-known PowerShell AUMID.
  $AppIds = @(
    "DeepSeekHarness.Notify",
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
  )
  foreach ($AppId in $AppIds) {
    try {
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($Toast)
      $Shown = $true
      T-Log ("shown via " + $AppId)
      break
    } catch {
      T-Log ("show FAILED via " + $AppId + " : " + $_.Exception.Message)
    }
  }
} catch {
  T-Log ("toast stage threw: " + $_.Exception.Message)
}

# Play OUR melody regardless of the toast outcome (small delay keeps it in sync
# with the banner appearing). SoundPlayer works even when the toast is suppressed.
# PlaySync() blocks until the melody finishes, so the process cannot exit and
# cut the playback short (Play() is async and dies with the process).
if (-not $Mute -and $Quiet -eq "none" -and $Sound -and (Test-Path -LiteralPath $Sound)) {
  try {
    Start-Sleep -Milliseconds 120
    (New-Object System.Media.SoundPlayer $Sound).PlaySync()
    T-Log "sound played"
  } catch {
    T-Log ("sound FAILED: " + $_.Exception.Message)
    try { (New-Object System.Media.SoundPlayer $Sound).Play() } catch { }
  }
} elseif ($Mute) {
  T-Log "muted (sound disabled by config)"
} elseif ($Quiet -eq "silent") {
  T-Log "silent (system DND respected)"
}
T-Log "done"
