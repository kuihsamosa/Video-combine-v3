#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS_DIR="$ROOT_DIR/.pids"

mkdir -p "$PIDS_DIR"

check_prerequisites() {
  if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
    echo "[start] Warning: frontend dependencies not found (frontend/node_modules). Run 'npm run install:all' first." >&2
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    echo "[start] Error: python3 is not available on PATH." >&2
    exit 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "[start] Error: npm is not available on PATH." >&2
    exit 1
  fi
}

start_service() {
  local name="$1"
  local workdir="$2"
  shift 2

  local pid_file="$PIDS_DIR/${name}.pid"
  local log_file="$PIDS_DIR/${name}.log"

  if [ -f "$pid_file" ]; then
    local existing_pid
    existing_pid="$(cat "$pid_file")"
    if kill -0 "$existing_pid" 2>/dev/null; then
      echo "[start] $name already running (PID $existing_pid)."
      return
    else
      echo "[start] Removing stale PID file for $name."
      rm -f "$pid_file"
    fi
  fi

  (
    cd "$workdir"
    nohup "$@" >"$log_file" 2>&1 &
    echo $! >"$pid_file"
  )

  local new_pid
  new_pid="$(cat "$pid_file")"
  echo "[start] Started $name (PID $new_pid). Logs: $log_file"
}

check_prerequisites

start_service "backend" "$ROOT_DIR/backend" python3 -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
start_service "frontend" "$ROOT_DIR/frontend" npm run dev -- --host

echo "[start] All services launched. Use ./stop.sh to stop them."