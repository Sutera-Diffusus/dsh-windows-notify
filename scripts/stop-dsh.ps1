# stop-dsh.ps1 - thorough DSH shutdown used by the tray icon Exit action.
# 1. Finds every listener on the target ports and kills its process tree.
# 2. Kills known DSH wrapper processes (launcher, bin-guard, dsh bin.js, balance-proxy).
# 3. Waits until the ports are actually released, then force-kills any straggler.
# 4. Clears tray lock/state leftovers and writes a result line to D:\ai-temp\dsh-stop.log.
# ASCII-only comments and log text on purpose: this script may be read as ANSI by Windows PowerShell 5.1.
param(
    [int[]]$Ports = @(),
    [string]$InstallRoot = "",
    [int]$WaitSeconds = 8,
    [string]$LogFile = "D:\ai-temp\dsh-stop.log"
)

$ErrorActionPreference = "SilentlyContinue"

function Write-StopLog {
    param([string]$Message)
    try {
        $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"), $Message
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch { }
}

if ($null -eq $Ports -or @($Ports).Count -eq 0) {
    $Ports = @(3080, 3181, 3182)
}
$Ports = @($Ports | Where-Object { $_ -gt 0 } | Select-Object -Unique)
if (@($Ports).Count -eq 0) {
    $Ports = @(3080, 3181, 3182)
}

$rootLabel = "<all>"
if ($InstallRoot -ne "") { $rootLabel = $InstallRoot }
Write-StopLog ("stop-dsh start ports=" + ($Ports -join ",") + " installRoot=" + $rootLabel)

$selfPid = [int]$PID
$scoped = ($InstallRoot -ne "")

# Patterns that identify DSH host/wrapper processes. These are intentionally
# narrow so unrelated node/cmd/powershell processes are never touched.
$dshPatterns = @(
    'bin-guard\.cjs',
    'node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js',
    'node_modules[\\/]\.bin[\\/]dsh',
    'dsh\.cmd[^"]*web',
    'balance-proxy\.js',
    'start-test\.bat',
    'dsh-windows-notify[\\/]scripts[\\/]tray\.ps1'
)

function Test-IsDshProcess {
    param($Process)
    $procId = [int]$Process.ProcessId
    if ($procId -eq $selfPid) { return $false }

    $name = [string]$Process.Name
    $cmdline = [string]$Process.CommandLine
    $executable = [string]$Process.ExecutablePath

    if ($scoped) {
        $inRoot = ($cmdline -like "*$InstallRoot*") -or ($executable -like "*$InstallRoot*")
        if (-not $inRoot) { return $false }
    }

    if ($name -eq "DeepSeekHarness-Launcher.exe") { return $true }
    if ($name -ne "node.exe" -and $name -ne "cmd.exe" -and $name -ne "powershell.exe" -and $name -ne "pwsh.exe") { return $false }

    foreach ($pattern in $dshPatterns) {
        if ($cmdline -match $pattern) { return $true }
    }
    return $false
}

# 1. Root set: port owners plus every matched DSH process.
$roots = New-Object 'System.Collections.Generic.HashSet[int]'
function Add-RootId {
    param([int]$ProcessId)
    if ($ProcessId -gt 0) { [void]$roots.Add($ProcessId) }
}

foreach ($port in $Ports) {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    foreach ($conn in $listeners) {
        Add-RootId ([int]$conn.OwningProcess)
        Write-StopLog ("port listener port=" + $port + " pid=" + [int]$conn.OwningProcess)
    }
}

$allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
foreach ($proc in $allProcesses) {
    if (Test-IsDshProcess $proc) {
        Add-RootId ([int]$proc.ProcessId)
        Write-StopLog ("ds process name=" + [string]$proc.Name + " pid=" + [int]$proc.ProcessId)
    }
}

# 2. Collect each root's whole descendant tree, children before parents.
$procById = @{}
foreach ($proc in $allProcesses) {
    $procId = [int]$proc.ProcessId
    if (-not $procById.ContainsKey($procId)) { $procById[$procId] = $proc }
}

$visited = New-Object 'System.Collections.Generic.HashSet[int]'
$killOrder = New-Object 'System.Collections.Generic.List[int]'
function Add-KillTree {
    param([int]$ProcessId)
    if ($ProcessId -le 0 -or $ProcessId -eq $selfPid -or -not $visited.Add($ProcessId)) { return }
    foreach ($proc in $allProcesses) {
        if ([int]$proc.ParentProcessId -eq $ProcessId) {
            Add-KillTree ([int]$proc.ProcessId)
        }
    }
    $killOrder.Add($ProcessId)
}

foreach ($root in $roots) {
    Add-KillTree $root
}

$killedCount = 0
foreach ($procId in $killOrder) {
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        $killedCount++
    } catch { }
}
Write-StopLog ("killed " + $killedCount + " process(es)")

# 3. Wait for the ports to actually release.
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$remaining = @()
do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {
        $_.State -eq "Listen" -and ($Ports -contains [int]$_.LocalPort)
    })
} while (@($remaining).Count -gt 0 -and (Get-Date) -lt $deadline)

foreach ($conn in $remaining) {
    Write-StopLog ("port still held port=" + [int]$conn.LocalPort + " pid=" + [int]$conn.OwningProcess)
    try { Stop-Process -Id ([int]$conn.OwningProcess) -Force -ErrorAction Stop } catch { }
}

# 4. Final sweep: kill any DSH wrapper that appeared or survived.
$stillAlive = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { Test-IsDshProcess $_ })
foreach ($proc in $stillAlive) {
    try { Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction Stop } catch { }
}

# 5. Clean tray lock files and reset tray badge state (never touches session data).
$stateFiles = @(
    "D:\DeepseekHarness_WorkSpace\dsh-windows-notify-extension\tray-state.json",
    "D:\DeepseekHarness_Data\.dsh\dsh-windows-notify\tray-state.json",
    "D:\DeepseekHarness_Test_Data\.dsh\dsh-windows-notify\tray-state.json"
)
foreach ($file in $stateFiles) {
    try {
        if (Test-Path $file) {
            [IO.File]::WriteAllText($file, '{"pending":0,"completed":[]}', (New-Object Text.UTF8Encoding($false)))
        }
    } catch { }
}
try {
    Get-ChildItem -Path "D:\ai-temp" -Filter "dshnotify-tray*.lock" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
} catch { }

# 6. Report and exit nonzero when a port is still occupied.
Start-Sleep -Milliseconds 400
$left = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {
    $_.State -eq "Listen" -and ($Ports -contains [int]$_.LocalPort)
})
if (@($left).Count -eq 0) {
    Write-StopLog ("OK ports cleared: " + ($Ports -join ","))
    exit 0
} else {
    $held = ($left | ForEach-Object { [string]$_.LocalPort + ":" + [int]$_.OwningProcess }) -join ","
    Write-StopLog ("WARN ports still listening: " + $held)
    exit 1
}
