#!/bin/bash
# Start Video Combiner + Kokoro TTS API

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
KOKORO_DIR="$ROOT/Kokoro-FastAPI copy/Kokoro-FastAPI"
KOKORO_LOG="$ROOT/kokoro.log"
KOKORO_PID_FILE="$ROOT/.kokoro.pid"

# ── Detect OS / hardware ──────────────────────────────────────────────────────
detect_kokoro_script() {
    if [[ "$(uname)" == "Darwin" ]]; then
        echo "start-gpu_mac.sh"
    else
        echo "start-cpu.sh"
    fi
}

# ── Port helpers ──────────────────────────────────────────────────────────────
port_pids() { lsof -ti tcp:"$1" 2>/dev/null || true; }

free_port() {
    local port=$1 pids
    pids=$(port_pids "$port")
    if [[ -n "$pids" ]]; then
        echo "   ⚠️  Port $port busy — killing stale process(es): $pids"
        echo "$pids" | xargs kill -9 2>/dev/null || true
        sleep 0.5
    fi
}

# ── Kokoro ────────────────────────────────────────────────────────────────────
kokoro_alive() { curl -sf --max-time 2 http://localhost:8880/v1/models &>/dev/null; }

start_kokoro() {
    if kokoro_alive; then
        echo "✅ Kokoro already running on :8880"
        return 0
    fi

    if [[ ! -d "$KOKORO_DIR" ]]; then
        echo "⚠️  Kokoro-FastAPI not found at: $KOKORO_DIR"
        echo "   TTS will be unavailable. Continuing without it."
        return 0
    fi

    local script
    script=$(detect_kokoro_script)

    if [[ ! -f "$KOKORO_DIR/$script" ]]; then
        echo "⚠️  Kokoro script '$script' not found. TTS unavailable."
        return 0
    fi

    echo "🎤 Starting Kokoro TTS API ($(uname -m)) via $script..."
    echo "   Log: $KOKORO_LOG"

    # Launch Kokoro's own script inside its directory; capture the uvicorn PID
    (
        cd "$KOKORO_DIR"
        bash "$script" &>"$KOKORO_LOG"
    ) &
    local launcher_pid=$!

    # Give the launcher a moment to start uvicorn, then record the port owner
    sleep 2
    local uvicorn_pid
    uvicorn_pid=$(port_pids 8880 | head -1)
    if [[ -n "$uvicorn_pid" ]]; then
        echo "$uvicorn_pid" > "$KOKORO_PID_FILE"
    else
        # Fall back to the launcher subshell PID if uvicorn isn't up yet
        echo "$launcher_pid" > "$KOKORO_PID_FILE"
    fi

    # Wait up to 60 s for Kokoro to respond (model download can take a while)
    echo -n "   Waiting for Kokoro on :8880 "
    local attempts=0
    while (( attempts < 60 )); do
        if kokoro_alive; then
            echo " ✓"
            echo "✅ Kokoro TTS API ready at http://localhost:8880"
            return 0
        fi
        echo -n "."
        sleep 1
        (( attempts++ )) || true
    done
    echo ""
    echo "⚠️  Kokoro did not respond within 60 s (model may still be downloading)."
    echo "   Check $KOKORO_LOG for details. The app will keep retrying."
}

# ── Cleanup on exit ───────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "🛑 Shutting down..."

    if [[ -f "$KOKORO_PID_FILE" ]]; then
        local pid
        pid=$(cat "$KOKORO_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "   Stopping Kokoro (PID $pid)..."
            kill "$pid" 2>/dev/null || true
        fi
        rm -f "$KOKORO_PID_FILE"
    fi

    # Belt-and-suspenders: clear both ports
    port_pids 8880 | xargs kill 2>/dev/null || true
    port_pids 8080 | xargs kill 2>/dev/null || true

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

# Kill any stale process on 8080 before binding
free_port 8080

echo "   Open: http://localhost:8080"
echo ""

node api/server.js
