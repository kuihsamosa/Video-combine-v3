#!/bin/bash
# Start Video Combiner + Kokoro TTS API

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
KOKORO_DIR="$ROOT/Kokoro-FastAPI copy/Kokoro-FastAPI"
KOKORO_LOG="$ROOT/kokoro.log"
KOKORO_PID_FILE="$ROOT/.kokoro.pid"

# ── Detect OS / hardware and pick the right Kokoro launch command ─────────────
detect_kokoro_cmd() {
    # macOS with Apple Silicon → MPS (GPU-accelerated)
    if [[ "$(uname)" == "Darwin" ]]; then
        echo "start-gpu_mac.sh"
    else
        echo "start-cpu.sh"
    fi
}

# ── Check if Kokoro is already running ───────────────────────────────────────
kokoro_running() {
    if [[ -f "$KOKORO_PID_FILE" ]]; then
        local pid
        pid=$(cat "$KOKORO_PID_FILE")
        kill -0 "$pid" 2>/dev/null && return 0
    fi
    # Also check by port
    lsof -ti tcp:8880 &>/dev/null && return 0
    return 1
}

# ── Start Kokoro in background ───────────────────────────────────────────────
start_kokoro() {
    if kokoro_running; then
        echo "✅ Kokoro already running on :8880"
        return 0
    fi

    if [[ ! -d "$KOKORO_DIR" ]]; then
        echo "⚠️  Kokoro-FastAPI not found at:"
        echo "     $KOKORO_DIR"
        echo "   TTS will be unavailable. Continuing without it."
        return 0
    fi

    local script
    script=$(detect_kokoro_cmd)

    if [[ ! -f "$KOKORO_DIR/$script" ]]; then
        echo "⚠️  Kokoro launch script '$script' not found inside the Kokoro directory."
        echo "   TTS will be unavailable. Continuing without it."
        return 0
    fi

    echo "🎤 Starting Kokoro TTS API ($(uname -m))..."
    echo "   Script : $script"
    echo "   Log    : $KOKORO_LOG"

    (
        cd "$KOKORO_DIR"
        # source the script in a subshell so its env vars are set correctly,
        # but run the final uvicorn command detached from our terminal
        bash "$script" &>"$KOKORO_LOG" &
        echo $! > "$KOKORO_PID_FILE"
        wait
    ) &

    # Capture the PID of the backgrounded subshell group
    local group_pid=$!
    echo "$group_pid" > "$KOKORO_PID_FILE"

    # Wait up to 30 s for Kokoro to become reachable
    echo -n "   Waiting for Kokoro on :8880 "
    local attempts=0
    while (( attempts < 30 )); do
        if curl -sf http://localhost:8880/v1/models &>/dev/null; then
            echo " ✓"
            echo "✅ Kokoro TTS API ready at http://localhost:8880"
            return 0
        fi
        echo -n "."
        sleep 1
        (( attempts++ )) || true
    done
    echo ""
    echo "⚠️  Kokoro did not respond within 30 s — it may still be downloading the model."
    echo "   Check $KOKORO_LOG for details. The app will keep polling."
}

# ── Cleanup on exit ───────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "🛑 Shutting down..."

    # Kill Kokoro
    if [[ -f "$KOKORO_PID_FILE" ]]; then
        local pid
        pid=$(cat "$KOKORO_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "   Stopping Kokoro (PID $pid)..."
            kill "$pid" 2>/dev/null || true
        fi
        rm -f "$KOKORO_PID_FILE"
    fi
    # Belt-and-suspenders: kill anything on 8880
    lsof -ti tcp:8880 | xargs kill 2>/dev/null || true

    echo "   Done."
}
trap cleanup EXIT INT TERM

# ── Main ──────────────────────────────────────────────────────────────────────
cd "$ROOT"

echo "============================================"
echo "  Video Combiner"
echo "============================================"

start_kokoro

echo ""
echo "🎥 Starting Video Combiner server on :8080..."
echo "   Open: http://localhost:8080"
echo ""

node api/server.js
