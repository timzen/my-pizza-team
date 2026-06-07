<#
.SYNOPSIS
    My Pizza Team — Windows system tray app for managing the mpt daemon.

.DESCRIPTION
    Creates a system tray icon with:
    - Start/Stop daemon controls
    - Team directory picker
    - Open UI in browser
    - Status display (running/stopped)

.NOTES
    Place mpt.exe in the same directory as this script, or ensure it's in PATH.
    Run: powershell -ExecutionPolicy Bypass -File tray.ps1
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- Configuration ---
$script:Port = if ($env:MPT_PORT) { $env:MPT_PORT } else { 7437 }
$script:TeamDir = if ($env:TEAM_DIR) { $env:TEAM_DIR } else { "" }
$script:DaemonProcess = $null
$script:IsRunning = $false

# --- Find mpt.exe ---
function Find-MptBinary {
    # Same directory as script
    $local = Join-Path $PSScriptRoot "mpt.exe"
    if (Test-Path $local) { return $local }

    # In PATH
    $inPath = Get-Command "mpt.exe" -ErrorAction SilentlyContinue
    if ($inPath) { return $inPath.Source }

    return $null
}

# --- Daemon management ---
function Start-Daemon {
    $binary = Find-MptBinary
    if (-not $binary) {
        [System.Windows.Forms.MessageBox]::Show(
            "mpt.exe not found. Place it next to this script or add to PATH.",
            "My Pizza Team", "OK", "Error")
        return
    }

    $env:PORT = $script:Port
    if ($script:TeamDir) { $env:TEAM_DIR = $script:TeamDir }

    $script:DaemonProcess = Start-Process -FilePath $binary -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 1000
    Update-Status
}

function Stop-Daemon {
    if ($script:DaemonProcess -and -not $script:DaemonProcess.HasExited) {
        Stop-Process -Id $script:DaemonProcess.Id -Force -ErrorAction SilentlyContinue
        $script:DaemonProcess = $null
    }

    # Also try PID file
    if ($script:TeamDir) {
        $pidFile = Join-Path $script:TeamDir "daemon.pid"
        if (Test-Path $pidFile) {
            $pid = Get-Content $pidFile -ErrorAction SilentlyContinue
            if ($pid) {
                Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue
            }
        }
    }

    $script:IsRunning = $false
    Update-TrayIcon
}

function Update-Status {
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$($script:Port)/health" -TimeoutSec 2
        $script:IsRunning = ($response.status -eq "ok")
    } catch {
        $script:IsRunning = $false
    }
    Update-TrayIcon
}

function Update-TrayIcon {
    if ($script:IsRunning) {
        $script:TrayIcon.Text = "My Pizza Team - Running (port $($script:Port))"
        $script:TrayIcon.Icon = $script:IconRunning
        $script:StartItem.Enabled = $false
        $script:StopItem.Enabled = $true
        $script:OpenItem.Enabled = $true
    } else {
        $script:TrayIcon.Text = "My Pizza Team - Stopped"
        $script:TrayIcon.Icon = $script:IconStopped
        $script:StartItem.Enabled = $true
        $script:StopItem.Enabled = $false
        $script:OpenItem.Enabled = $false
    }
}

function Choose-TeamDir {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Choose Team Directory"
    $dialog.ShowNewFolderButton = $true
    if ($script:TeamDir) { $dialog.SelectedPath = $script:TeamDir }

    if ($dialog.ShowDialog() -eq "OK") {
        $script:TeamDir = $dialog.SelectedPath
        $env:TEAM_DIR = $script:TeamDir
    }
}

function Open-UI {
    Start-Process "http://localhost:$($script:Port)"
}

# --- Create pizza slice icon ---
function New-PizzaIcon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap(16, 16)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = "AntiAlias"

    $pen = New-Object System.Drawing.Pen($color, 1.2)
    $brush = New-Object System.Drawing.SolidBrush($color)

    # Pizza slice triangle
    $points = @(
        [System.Drawing.PointF]::new(8, 1),   # tip
        [System.Drawing.PointF]::new(2, 13),  # bottom-left
        [System.Drawing.PointF]::new(14, 13)  # bottom-right
    )
    $g.DrawPolygon($pen, $points)

    # Crust arc at bottom
    $g.DrawArc($pen, 2, 10, 12, 6, 0, 180)

    # Pepperoni
    $g.FillEllipse($brush, 6, 5, 3, 3)
    $g.FillEllipse($brush, 4, 9, 2.5, 2.5)
    $g.FillEllipse($brush, 9, 8.5, 2.5, 2.5)

    $g.Dispose()
    $pen.Dispose()
    $brush.Dispose()

    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

# --- Build tray icon and menu ---
$script:IconRunning = New-PizzaIcon ([System.Drawing.Color]::Black)
$script:IconStopped = New-PizzaIcon ([System.Drawing.Color]::Gray)

$script:TrayIcon = New-Object System.Windows.Forms.NotifyIcon
$script:TrayIcon.Visible = $true
$script:TrayIcon.Text = "My Pizza Team"

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

$script:StartItem = $contextMenu.Items.Add("Start Daemon")
$script:StartItem.Add_Click({ Start-Daemon })

$script:StopItem = $contextMenu.Items.Add("Stop Daemon")
$script:StopItem.Add_Click({ Stop-Daemon })

$contextMenu.Items.Add("-")  # separator

$script:OpenItem = $contextMenu.Items.Add("Open UI in Browser")
$script:OpenItem.Add_Click({ Open-UI })

$contextMenu.Items.Add("-")

$teamDirItem = $contextMenu.Items.Add("Choose Team Directory...")
$teamDirItem.Add_Click({ Choose-TeamDir })

$contextMenu.Items.Add("-")

$quitItem = $contextMenu.Items.Add("Quit")
$quitItem.Add_Click({
    Stop-Daemon
    $script:TrayIcon.Visible = $false
    $script:TrayIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$script:TrayIcon.ContextMenuStrip = $contextMenu

# Double-click opens UI
$script:TrayIcon.Add_DoubleClick({ Open-UI })

# --- Status polling timer ---
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Update-Status })
$timer.Start()

# Initial status check
Update-Status

# --- Run ---
[System.Windows.Forms.Application]::Run()
