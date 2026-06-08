#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Video Combiner — start.sh
#  Starts OmniVoice TTS (port 8881) then the Node.js backend (port 8080).
#  Both processes are managed; Ctrl-C / EXIT cleans everything up.
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Config (override via env) ─────────────────────────────────────────────────
NODE_PORT="${NODE_PORT:-8080}"
OMNIVOICE_PORT="${OMNIVOICE_PORT:-8881}"
OMNIVOICE_VENV="$ROOT/omnivoice-venv"
OMNIVOICE_LOG="$ROOT/omnivoice.log"
OMNIVOICE_PID_FILE="$ROOT/.omnivoice.pid"
NODE_LOG="$ROOT/server.log"
NODE_PID_FILE="$ROOT/.server.pid"

# ── Helpers ───────────────────────────────────────────────────────────────────
port_pids() { lsof -ti tcp:"$1" 2>/dev/null || true; }

free_port() {
    local port=$1 pids
    pids=$(port_pids "$port")
    if [[ -n "$pids" ]]; then
        echo "   ⚠️  Port $port busy — killing stale process(es): $pids"
        echo "$pids" | xargs kill -9 2>/dev/null || true
        sleep 0.6
    fi
}

kill_pid_file() {
    local file=$1 label=$2
    if [[ -f "$file" ]]; then
        local pid
        pid=$(cat "$file")
        if kill -0 "$pid" 2>/dev/null; then
            echo "   Stopping $label (PID $pid)…"
            kill "$pid" 2>/dev/null || true
            sleep 0.5
        fi
        rm -f "$file"
    fi
}

# ── OmniVoice TTS ─────────────────────────────────────────────────────────────
omnivoice_alive() {
    curl -sf --max-time 2 "http://localhost:${OMNIVOICE_PORT}/v1/models" &>/dev/null
}

start_omnivoice() {
    if omnivoice_alive; then
        echo "✅ OmniVoice already running on :${OMNIVOICE_PORT}"
        return 0
    fi

    local bin="$OMNIVOICE_VENV/bin/omnivoice-server"
    if [[ ! -f "$bin" ]]; then
        echo "❌ OmniVoice not found at $OMNIVOICE_VENV"
        echo "   Run: python3 -m venv omnivoice-venv && omnivoice-venv/bin/pip install omnivoice-server"
        exit 1
    fi

    free_port "$OMNIVOICE_PORT"

    # MPS on Apple Silicon, CPU everywhere else
    local device="cpu"
    [[ "$(uname)" == "Darwin" ]] && device="mps"

    echo "🎤 Starting OmniVoice TTS on :${OMNIVOICE_PORT} (device=${device})…"
    echo "   Log → $OMNIVOICE_LOG"
    echo "   Note: first run downloads the model (~1 GB) — may take a few minutes."

    # Run from /tmp so pydantic-settings does NOT load this project's .env
    (
        cd /tmp
        "$bin" \
            --host 0.0.0.0 \
            --port "$OMNIVOICE_PORT" \
            --device "$device" \
            --log-level info
    ) >"$OMNIVOICE_LOG" 2>&1 &
    echo $! >"$OMNIVOICE_PID_FILE"

    echo -n "   Waiting for OmniVoice (up to 120 s) "
    local attempts=0
    while (( attempts < 120 )); do
        if omnivoice_alive; then
            echo " ✓"
            echo "✅ OmniVoice TTS ready → http://localhost:${OMNIVOICE_PORT}"
            return 0
        fi
        echo -n "."
        sleep 1
        (( attempts++ )) || true
    done
    echo ""
    echo "⚠️  OmniVoice did not respond within 120 s — model download may still be"
    echo "   in progress. Check $OMNIVOICE_LOG for details."
}

# ── Node.js server ────────────────────────────────────────────────────────────
start_node() {
    free_port "$NODE_PORT"

    echo ""
    echo "🎥 Starting Video Combiner server on :${NODE_PORT}…"
    echo "   Log  → $NODE_LOG"
    echo "   Open → http://localhost:${NODE_PORT}"
    echo ""

    node "$ROOT/api/server.js" >"$NODE_LOG" 2>&1 &
    echo $! >"$NODE_PID_FILE"

    # Wait briefly to catch immediate crashes
    sleep 1
    if ! kill -0 "$(cat "$NODE_PID_FILE")" 2>/dev/null; then
        echo "❌ Node server crashed on startup. Check $NODE_LOG"
        tail -20 "$NODE_LOG"
        exit 1
    fi

    echo "✅ Node server running (PID $(cat "$NODE_PID_FILE"))"
    echo "   Tailing logs — press Ctrl-C to stop everything."
    echo ""
    tail -f "$NODE_LOG"
}

# ── Cleanup on exit ───────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "🛑 Shutting down…"
    kill_pid_file "$NODE_PID_FILE"      "Node server"
    kill_pid_file "$OMNIVOICE_PID_FILE" "OmniVoice TTS"
    # Belt-and-suspenders: release ports
    port_pids "$NODE_PORT"      | xargs kill 2>/dev/null || true
    port_pids "$OMNIVOICE_PORT" | xargs kill 2>/dev/null || true
    echo "   Done."
}
trap cleanup EXIT INT TERM

# ── Preflight checks ──────────────────────────────────────────────────────────
cd "$ROOT"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         Video Combiner Pipeline          ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Node.js
if ! command -v node &>/dev/null; then
    echo "❌ node not found — install Node.js 18+"
    exit 1
fi
echo "  Node $(node --version)"

# ffmpeg
if ! command -v ffmpeg &>/dev/null; then
    echo "❌ ffmpeg not found — brew install ffmpeg"
    exit 1
fi
echo "  ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"

# .env
if [[ ! -f "$ROOT/.env" ]]; then
    echo ""
    echo "⚠️  No .env file found. Copy .env.example and fill in your keys."
    echo "   Required : GROQ_API_KEY (or _2 / _3 for round-robin)"
    echo "   Required : PEXELS_API_KEY"
    echo "   Optional : YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN"
    echo "   Optional : TIKTOK_ACCESS_TOKEN"
    echo "   Optional : INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_USER_ID"
fi

# Ensure runtime directories exist
mkdir -p "$ROOT/scripts"   # #22 Script Archive
mkdir -p "$ROOT/output"    # rendered videos / thumbnails

echo ""

# ── Start services ────────────────────────────────────────────────────────────
start_omnivoice
start_node
