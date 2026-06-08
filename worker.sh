#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Video Combiner — worker.sh
#  Run this on the T440p (or any secondary machine) to join the worker pool.
#
#  SETUP (one-time, on T440p):
#    1. Clone the repo:
#         git clone <your-repo-url> ~/video-combine && cd ~/video-combine
#    2. Install Node deps:
#         npm install
#    3. Install system deps:
#         sudo apt install ffmpeg curl -y
#    4. Copy and edit .env.worker:
#         cp .env.worker.example .env.worker
#         nano .env.worker          # set MAIN_SERVER_URL to your Mac's IP
#    5. Make this script executable:
#         chmod +x worker.sh
#    6. Run:
#         ./worker.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT/.env.worker"
PID_FILE="$ROOT/.worker.pid"
LOG_FILE="$ROOT/worker.log"

# ── Load worker env ───────────────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
    set -a; source "$ENV_FILE"; set +a
else
    echo ""
    echo "⚠️  No .env.worker file found."
    echo "   Create one from the example:"
    echo "     cp .env.worker.example .env.worker && nano .env.worker"
    echo ""
    # Fall back to defaults — will fail if MAIN_SERVER_URL not set
fi

MAIN_SERVER_URL="${MAIN_SERVER_URL:-}"
WORKER_ID="${WORKER_ID:-$(hostname)}"
WORKER_CAPACITY="${WORKER_CAPACITY:-2}"
SERVE_PORT="${SERVE_PORT:-8182}"

# ── Preflight ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Video Combiner — Worker Node       ║"
echo "╚══════════════════════════════════════════╝"
echo ""

if [[ -z "$MAIN_SERVER_URL" ]]; then
    echo "❌  MAIN_SERVER_URL is not set in $ENV_FILE"
    echo "    Example: MAIN_SERVER_URL=http://192.168.0.169:8080"
    exit 1
fi

if ! command -v node &>/dev/null; then
    echo "❌  node not found — install Node.js 18+"
    echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    echo "    sudo apt install nodejs -y"
    exit 1
fi

if ! command -v ffmpeg &>/dev/null; then
    echo "❌  ffmpeg not found"
    echo "    sudo apt install ffmpeg -y"
    exit 1
fi

echo "  Worker ID:  $WORKER_ID"
echo "  Capacity:   $WORKER_CAPACITY concurrent jobs"
echo "  Main:       $MAIN_SERVER_URL"
echo "  File port:  :$SERVE_PORT (main machine pulls outputs from here)"
echo "  Log:        $LOG_FILE"
echo ""

# Verify reachability
echo -n "  Checking main server… "
if curl -sf --max-time 5 "$MAIN_SERVER_URL/api/health" &>/dev/null; then
    echo "✓ reachable"
else
    echo "✗ UNREACHABLE"
    echo ""
    echo "  ⚠️  Cannot reach $MAIN_SERVER_URL"
    echo "  Make sure:"
    echo "    • Main machine is running (./start.sh)"
    echo "    • Firewall allows port 8080 from this machine"
    echo "    • The IP address is correct"
    echo ""
    echo "  Continuing anyway (will retry on each poll)…"
fi
echo ""

# ── Cleanup ───────────────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "🛑 Worker shutting down…"
    if [[ -f "$PID_FILE" ]]; then
        local pid; pid=$(cat "$PID_FILE")
        kill "$pid" 2>/dev/null || true
        rm -f "$PID_FILE"
    fi
    lsof -ti tcp:"$SERVE_PORT" | xargs kill 2>/dev/null || true
    echo "   Done."
}
trap cleanup EXIT INT TERM

# ── Start worker ──────────────────────────────────────────────────────────────
cd "$ROOT"

MAIN_SERVER_URL="$MAIN_SERVER_URL" \
WORKER_ID="$WORKER_ID" \
WORKER_CAPACITY="$WORKER_CAPACITY" \
SERVE_PORT="$SERVE_PORT" \
node api/worker-agent.js 2>&1 | tee "$LOG_FILE"
