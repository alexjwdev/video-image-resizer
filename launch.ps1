# Image Resizer — local launcher
# Starts the Node server hidden, opens your browser, then lives in the system tray.
# Right-click the tray icon → "Stop and Exit" to shut everything down.

param()
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── Read PORT from .env (falls back to 3210) ──────────────────────────────────
$port = 3210
$envFile = Join-Path $dir ".env"
if (Test-Path $envFile) {
    $content = Get-Content $envFile -Raw
    if ($content -match "(?m)^PORT\s*=\s*(\d+)") { $port = [int]$Matches[1] }
}
$url = "http://localhost:$port"

# ── Start server hidden ────────────────────────────────────────────────────────
$serverProc = Start-Process -FilePath "node" -ArgumentList "server.js" `
    -WorkingDirectory $dir -WindowStyle Hidden -PassThru
$script:serverId = $serverProc.Id

# Poll TCP port until server is ready (up to 6 s)
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 200
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient("localhost", $port)
        $tcp.Close(); $ready = $true; break
    } catch {}
}

if (-not $ready) {
    [System.Windows.Forms.MessageBox]::Show(
        "Server failed to start on port $port.`n`nMake sure Node.js is installed and run:`n  npm install`nfrom the image-resizer folder.",
        "Image Resizer — Startup Error",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    Stop-Process -Id $script:serverId -Force
    exit 1
}

# ── Open browser ───────────────────────────────────────────────────────────────
Start-Process $url

# ── System tray icon ───────────────────────────────────────────────────────────
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon  = [System.Drawing.SystemIcons]::Application
$tray.Text  = "Image Resizer — $url"
$tray.Visible = $true

# Balloon tip on startup
$tray.BalloonTipTitle = "Image Resizer"
$tray.BalloonTipText  = "Running at $url"
$tray.BalloonTipIcon  = "Info"
$tray.ShowBalloonTip(4000)

# Clicking the balloon or double-clicking the icon reopens the browser
$tray.add_BalloonTipClicked({ Start-Process $url })
$tray.add_DoubleClick({ Start-Process $url })

# ── Context menu ───────────────────────────────────────────────────────────────
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = $menu.Items.Add("Open in Browser")
$openItem.Font = New-Object System.Drawing.Font(
    [System.Drawing.SystemFonts]::DefaultFont,
    [System.Drawing.FontStyle]::Bold
)
$openItem.Add_Click({ Start-Process $url })

[void]$menu.Items.Add("-")

$stopItem = $menu.Items.Add("Stop and Exit")
$stopItem.Add_Click({
    $tray.Visible = $false
    $tray.Dispose()
    Stop-Process -Id $script:serverId -Force -ErrorAction SilentlyContinue
    [System.Windows.Forms.Application]::Exit()
})

$tray.ContextMenuStrip = $menu

# ── Run message loop (blocks until Exit is called) ────────────────────────────
[System.Windows.Forms.Application]::Run()

# Safety net — clean up if Application::Run exits by other means
Stop-Process -Id $script:serverId -Force -ErrorAction SilentlyContinue
