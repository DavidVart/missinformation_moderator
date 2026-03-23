#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/.local-runtime/pids"

stop_detached() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"

  if [[ ! -f "$pid_file" ]]; then
    return 0
  fi

  local pid
  pid="$(cat "$pid_file")"

  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    echo "stopped $name ($pid)"
  else
    echo "not running $name ($pid)"
  fi

  rm -f "$pid_file"
}

bash "$ROOT_DIR/scripts/stop-local-backend.sh"
stop_detached "whisper-worker"
stop_detached "preview"

docker stop veritas-redis >/dev/null 2>&1 || true

if [[ "${STOP_DOCKER_DESKTOP:-false}" == "true" ]] && command -v osascript >/dev/null 2>&1; then
  osascript -e 'quit app "Docker"' >/dev/null 2>&1 || true
fi
