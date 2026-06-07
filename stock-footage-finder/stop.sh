#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS_DIR="$ROOT_DIR/.pids"

stop_service() {
  local name="$1"
  local pid_file="$PIDS_DIR/${name}.pid"
  local log_file="$PIDS_DIR/${name}.log"

  if [ ! -f "$pid_file" ]; then
    echo "[stop] No PID file for $name; skipping."
    return
  fi

  local pid
  pid="$(cat "$pid_file")"

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "[stop] Process $name (PID $pid) not running; removing stale PID file."
    rm -f "$pid_file"
    return
  fi

  echo "[stop] Stopping $name (PID $pid)..."
  kill "$pid" 2>/dev/null || true

  for _ in {1..10}; do
    if kill -0 "$pid" 2>/dev/null; then
      sleep 0.5
    else
      break
    fi
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "[stop] PID $pid still running; forcing termination."
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$pid_file"
  echo "[stop] $name stopped."
}

stop_service "frontend"
stop_service "backend"

if [ -d "$PIDS_DIR" ] && [ -z "$(ls -A "$PIDS_DIR")" ]; then
  rmdir "$PIDS_DIR"
fi

echo "[stop] Done."