#!/bin/bash
# Stop Video Combiner + Kokoro TTS API

ROOT="$(cd "$(dirname "$0")" && pwd)"
KOKORO_PID_FILE="$ROOT/.kokoro.pid"

echo "Stopping Video Combiner..."
pkill -f "node api/server.js" 2>/dev/null && echo "  ✓ Node server stopped" || echo "  · No Node server running"

echo "Stopping Kokoro TTS API..."
if [[ -f "$KOKORO_PID_FILE" ]]; then
    pid=$(cat "$KOKORO_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && echo "  ✓ Kokoro stopped (PID $pid)"
    fi
    rm -f "$KOKORO_PID_FILE"
fi

# Belt-and-suspenders: also kill anything holding port 8880
lsof -ti tcp:8880 | xargs kill 2>/dev/null && echo "  ✓ Port 8880 released" || true

echo "Done."
