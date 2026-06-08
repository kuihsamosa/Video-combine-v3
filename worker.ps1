# ═══════════════════════════════════════════════════════════════════════════════
#  Video Combiner — worker.ps1
#  Run this on the T440p (Windows) to join the worker pool.
#
#  SETUP (one-time):
#    1. Install Node.js 22:     https://nodejs.org  (LTS)
#    2. Install ffmpeg:         winget install ffmpeg
#       OR: choco install ffmpeg  (if Chocolatey installed)
#       OR: download from https://www.gyan.dev/ffmpeg/builds/ and add to PATH
#    3. Install npm deps:       npm install   (in this folder)
#    4. Copy env example:       copy .env.worker.example .env.worker
#    5. Edit .env.worker with your Mac's IP address
#    6. Run this script:        .\worker.ps1
# ═══════════════════════════════════════════════════════════════════════════════

# Allow running scripts if needed:
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$ENV_FILE = Join-Path $ROOT ".env.worker"
$LOG_FILE = Join-Path $ROOT "worker.log"

# ── Load .env.worker ──────────────────────────────────────────────────────────
if (Test-Path $ENV_FILE) {
    Get-Content $ENV_FILE | Where-Object { $_ -match '^\s*[^#]' -and $_ -match '=' } | ForEach-Object {
        $parts = $_ -split '=', 2
        $key   = $parts[0].Trim()
        $val   = $parts[1].Trim().Trim('"').Trim("'")
        if ($key -and $val) {
            [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
        }
    }
} else {
    Write-Host ""
    Write-Host "⚠️  No .env.worker file found." -ForegroundColor Yellow
    Write-Host "   Create one from the example:"
    Write-Host "     copy .env.worker.example .env.worker"
    Write-Host "   Then edit it and set MAIN_SERVER_URL to your Mac's IP."
    Write-Host ""
}

# ── Banner ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║       Video Combiner — Worker Node       ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Preflight checks ──────────────────────────────────────────────────────────
$MAIN_URL = $env:MAIN_SERVER_URL
if (-not $MAIN_URL) {
    Write-Host "❌  MAIN_SERVER_URL is not set in .env.worker" -ForegroundColor Red
    Write-Host "    Example: MAIN_SERVER_URL=http://192.168.0.169:8080"
    exit 1
}

# Check node
try {
    $nodeVer = & node --version 2>&1
    Write-Host "  ✓ Node $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "❌  node not found — download from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# Check ffmpeg
try {
    $ffVer = & ffmpeg -version 2>&1 | Select-Object -First 1
    Write-Host "  ✓ ffmpeg found" -ForegroundColor Green
} catch {
    Write-Host "❌  ffmpeg not found." -ForegroundColor Red
    Write-Host "    Install with:  winget install ffmpeg"
    Write-Host "    OR download:   https://www.gyan.dev/ffmpeg/builds/"
    Write-Host "    Then add ffmpeg\bin to your PATH."
    exit 1
}

# Check npm deps
if (-not (Test-Path (Join-Path $ROOT "node_modules"))) {
    Write-Host "  📦 Installing npm dependencies..." -ForegroundColor Yellow
    Set-Location $ROOT
    & npm install
}

# Test reachability
Write-Host ""
Write-Host "  Checking main server ($MAIN_URL)..." -NoNewline
try {
    $response = Invoke-WebRequest -Uri "$MAIN_URL/api/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    Write-Host " ✓ reachable" -ForegroundColor Green
} catch {
    Write-Host " ✗ unreachable" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  ⚠️  Cannot reach $MAIN_URL" -ForegroundColor Yellow
    Write-Host "  Make sure:"
    Write-Host "    • Mac is running ./start.sh"
    Write-Host "    • Mac firewall allows port 8080 from this PC"
    Write-Host "    • The IP in .env.worker is correct"
    Write-Host ""
    Write-Host "  Continuing anyway (will retry on each poll)..." -ForegroundColor Yellow
}

# Show config
Write-Host ""
Write-Host "  Worker ID:  $($env:WORKER_ID ?? (hostname))"
Write-Host "  Capacity:   $($env:WORKER_CAPACITY ?? '2') concurrent jobs"
Write-Host "  Main:       $MAIN_URL"
Write-Host "  File port:  :$($env:SERVE_PORT ?? '8182')"
Write-Host "  Log:        $LOG_FILE"
Write-Host ""
Write-Host "  Starting worker... (Ctrl-C to stop)" -ForegroundColor Green
Write-Host ""

# ── Run worker agent ──────────────────────────────────────────────────────────
Set-Location $ROOT
try {
    & node api/worker-agent.js 2>&1 | Tee-Object -FilePath $LOG_FILE
} finally {
    Write-Host ""
    Write-Host "Worker stopped." -ForegroundColor Yellow
}
