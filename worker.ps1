# ═══════════════════════════════════════════════════════════════════════════════
#  Video Combiner - worker.ps1  (compatible with Windows PowerShell 5.1+)
#  Run this on the T440p to join the worker pool.
#
#  SETUP (one-time):
#    1. Install Node.js LTS:  https://nodejs.org
#    2. Install ffmpeg:       winget install ffmpeg
#       OR download from https://www.gyan.dev/ffmpeg/builds/ and add to PATH
#    3. Install npm deps:     npm install
#    4. Copy env file:        copy .env.worker.example .env.worker
#    5. Edit .env.worker and set MAIN_SERVER_URL to your Mac's IP
#    6. Run:                  .\worker.ps1
#
#  If you get "cannot be loaded" error, run once:
#    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# ═══════════════════════════════════════════════════════════════════════════════

$ROOT     = Split-Path -Parent $MyInvocation.MyCommand.Path
$ENV_FILE = Join-Path $ROOT ".env.worker"
$LOG_FILE = Join-Path $ROOT "worker.log"

# Helper: return $val if non-empty, else $default
function Coalesce($val, $default) {
    if ($val) { return $val } else { return $default }
}

# ── Load .env.worker ──────────────────────────────────────────────────────────
if (Test-Path $ENV_FILE) {
    Get-Content $ENV_FILE | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line -match '=') {
            $idx = $line.IndexOf('=')
            $key = $line.Substring(0, $idx).Trim()
            $val = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
            if ($key -and $val) {
                [System.Environment]::SetEnvironmentVariable($key, $val, 'Process')
            }
        }
    }
} else {
    Write-Host ""
    Write-Host "WARNING: No .env.worker file found." -ForegroundColor Yellow
    Write-Host "  Create one: copy .env.worker.example .env.worker"
    Write-Host "  Then set MAIN_SERVER_URL to your Mac's IP address."
    Write-Host ""
}

# ── Banner ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "      Video Combiner - Worker Node        " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ── Check MAIN_SERVER_URL ─────────────────────────────────────────────────────
$MAIN_URL = $env:MAIN_SERVER_URL
if (-not $MAIN_URL) {
    Write-Host "ERROR: MAIN_SERVER_URL is not set in .env.worker" -ForegroundColor Red
    Write-Host "  Example: MAIN_SERVER_URL=http://192.168.0.169:8080"
    exit 1
}

# ── Check Node.js ─────────────────────────────────────────────────────────────
$nodePath = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodePath) {
    Write-Host "ERROR: node not found." -ForegroundColor Red
    Write-Host "  Download from https://nodejs.org (LTS version)"
    exit 1
}
$nodeVer = (& node --version 2>&1) | Out-String
Write-Host "  OK  Node $($nodeVer.Trim())" -ForegroundColor Green

# ── Check ffmpeg ──────────────────────────────────────────────────────────────
$ffmpegPath = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($null -eq $ffmpegPath) {
    Write-Host "ERROR: ffmpeg not found." -ForegroundColor Red
    Write-Host "  Install:  winget install ffmpeg"
    Write-Host "  OR download from https://www.gyan.dev/ffmpeg/builds/"
    Write-Host "  Then add the bin folder to your PATH."
    exit 1
}
Write-Host "  OK  ffmpeg found" -ForegroundColor Green

# ── Install npm dependencies if needed ───────────────────────────────────────
$nodeModules = Join-Path $ROOT "node_modules"
if (-not (Test-Path $nodeModules)) {
    Write-Host "  Installing npm dependencies..." -ForegroundColor Yellow
    Set-Location $ROOT
    & npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: npm install failed" -ForegroundColor Red
        exit 1
    }
}

# ── Test reachability of main server ─────────────────────────────────────────
Write-Host ""
Write-Host "  Checking main server ($MAIN_URL)..." -NoNewline
$reachable = $false
$healthUrl = "$MAIN_URL/api/health"
$wr = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 5 -UseBasicParsing -ErrorAction SilentlyContinue
if ($null -ne $wr -and $wr.StatusCode -eq 200) {
    $reachable = $true
}

if ($reachable) {
    Write-Host " OK - reachable" -ForegroundColor Green
} else {
    Write-Host " UNREACHABLE" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  WARNING: Cannot reach $MAIN_URL" -ForegroundColor Yellow
    Write-Host "  Make sure:"
    Write-Host "    - Mac is running ./start.sh"
    Write-Host "    - Both machines are on the same Wi-Fi/LAN"
    Write-Host "    - The IP in .env.worker is correct (check with: ipconfig getifaddr en0 on Mac)"
    Write-Host "    - Mac firewall is not blocking port 8080"
    Write-Host ""
    Write-Host "  Continuing anyway - will retry on each poll..." -ForegroundColor Yellow
}

# ── Show resolved config ──────────────────────────────────────────────────────
$workerId  = Coalesce $env:WORKER_ID  (hostname)
$capacity  = Coalesce $env:WORKER_CAPACITY '2'
$servePort = Coalesce $env:SERVE_PORT '8182'

Write-Host ""
Write-Host "  Worker ID : $workerId"
Write-Host "  Capacity  : $capacity concurrent jobs"
Write-Host "  Main      : $MAIN_URL"
Write-Host "  Log       : $LOG_FILE"
Write-Host ""
Write-Host "  Starting worker... (Ctrl-C to stop)" -ForegroundColor Green
Write-Host ""

# ── Run worker agent ──────────────────────────────────────────────────────────
Set-Location $ROOT
& node api/worker-agent.js 2>&1 | Tee-Object -FilePath $LOG_FILE

Write-Host ""
Write-Host "Worker stopped." -ForegroundColor Yellow
