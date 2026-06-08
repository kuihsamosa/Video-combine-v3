#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Video Combiner — stop.sh
#  Gracefully stops the Node.js backend (port 8080) and OmniVoice TTS (port 8881).
#  Safe to run even if one or both services are already down.
# ═══════════════════════════════════════════════════════════════════════════════

ROOT="$(cd "$(dirname "$0")" && pwd)"

NODE_PORT="${NODE_PORT:-8080}"
OMNIVOICE_PORT="${OMNIVOICE_PORT:-8881}"
NODE_PID_FILE="$ROOT/.server.pid"
OMNIVOICE_PID_FILE="$ROOT/.omnivoice.pid"

# ── Helper ────────────────────────────────────────────────────────────────────
stop_pid_file() {
    local file=$1 label=$2
    if [[ -f "$file" ]]; then
        local pid
        pid=$(cat "$file")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null
            echo "  ✓ $label stopped (PID $pid)"
        else
            echo "  · $label not running (stale PID $pid)"
        fi
        rm -f "$file"
    else
        echo "  · $label — no PID file found"
    fi
}

release_port() {
    local port=$1 label=$2
    local pids
    pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
        echo "$pids" | xargs kill 2>/dev/null || true
        echo "  ✓ Port $port ($label) released"
    fi
}

# ── Stop services ─────────────────────────────────────────────────────────────
echo ""
echo "🛑 Stopping Video Combiner…"
echo ""

stop_pid_file "$NODE_PID_FILE"      "Node server"
stop_pid_file "$OMNIVOICE_PID_FILE" "OmniVoice TTS"

# Belt-and-suspenders: release ports regardless of PID files
release_port "$NODE_PORT"      "Node server"
release_port "$OMNIVOICE_PORT" "OmniVoice TTS"

# Also catch any orphaned node process pointing at this project
pkill -f "$ROOT/api/server.js" 2>/dev/null && echo "  ✓ Orphaned Node process killed" || true

echo ""
echo "✅ Done."
