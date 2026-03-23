#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.local-runtime"
LOG_DIR="$RUNTIME_DIR/logs"
PID_DIR="$RUNTIME_DIR/pids"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

mkdir -p "$LOG_DIR" "$PID_DIR"

REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
POSTGRES_URL="${POSTGRES_URL:-postgresql://${USER}@localhost:5432/veritas}"
WHISPER_WORKER_URL="${WHISPER_WORKER_URL:-http://127.0.0.1:8000}"
CORS_ORIGIN="${CORS_ORIGIN:-*}"
LOG_LEVEL="${LOG_LEVEL:-info}"

WHISPER_WORKER_URL="${WHISPER_WORKER_URL/whisper-worker/127.0.0.1}"
WHISPER_WORKER_URL="${WHISPER_WORKER_URL/host.docker.internal/127.0.0.1}"

stop_existing() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      sleep 1
      if kill -0 "$pid" >/dev/null 2>&1; then
        kill -9 "$pid" >/dev/null 2>&1 || true
      fi
    fi
    rm -f "$pid_file"
  fi
}

wait_for_health() {
  local name="$1"
  local port="$2"
  local log_file="$3"

  for _ in {1..30}; do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      echo "started ${name} on ${port}"
      return 0
    fi
    sleep 1
  done

  echo "failed to start ${name} on ${port}"
  tail -n 40 "$log_file" || true
  return 1
}

start_service() {
  local name="$1"
  local port="$2"
  local entry="$3"
  local log_file="$LOG_DIR/$name.log"
  local pid_file="$PID_DIR/$name.pid"

  stop_existing "$name"

  ROOT_DIR="$ROOT_DIR" \
  NODE_BIN="$NODE_BIN" \
  PORT_VALUE="$port" \
  REDIS_URL_VALUE="$REDIS_URL" \
  POSTGRES_URL_VALUE="$POSTGRES_URL" \
  WHISPER_WORKER_URL_VALUE="$WHISPER_WORKER_URL" \
  CORS_ORIGIN_VALUE="$CORS_ORIGIN" \
  LOG_LEVEL_VALUE="$LOG_LEVEL" \
  ENTRY_VALUE="$entry" \
  LOG_FILE_VALUE="$log_file" \
  PID_FILE_VALUE="$pid_file" \
  python3 - <<'PY'
import os
import subprocess

root_dir = os.environ["ROOT_DIR"]
node_bin = os.environ["NODE_BIN"]
log_file = os.environ["LOG_FILE_VALUE"]
pid_file = os.environ["PID_FILE_VALUE"]
entry = os.environ["ENTRY_VALUE"]

env = os.environ.copy()
env.update(
    {
        "PORT": os.environ["PORT_VALUE"],
        "REDIS_URL": os.environ["REDIS_URL_VALUE"],
        "POSTGRES_URL": os.environ["POSTGRES_URL_VALUE"],
        "WHISPER_WORKER_URL": os.environ["WHISPER_WORKER_URL_VALUE"],
        "CORS_ORIGIN": os.environ["CORS_ORIGIN_VALUE"],
        "LOG_LEVEL": os.environ["LOG_LEVEL_VALUE"],
    }
)

with open(log_file, "ab", buffering=0) as stream:
    process = subprocess.Popen(
        [node_bin, "--import", "tsx", entry],
        cwd=root_dir,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=stream,
        stderr=subprocess.STDOUT,
        start_new_session=True
    )

with open(pid_file, "w", encoding="utf-8") as stream:
    stream.write(str(process.pid))
PY

  wait_for_health "$name" "$port" "$log_file"
}

start_service "history" "4004" "services/history/src/index.ts"
start_service "notification" "4003" "services/notification/src/index.ts"
start_service "reasoning" "4002" "services/reasoning/src/index.ts"
start_service "transcription" "4001" "services/transcription/src/index.ts"
start_service "ingestion" "4000" "services/ingestion/src/index.ts"

echo "local backend ready"
echo "logs: $LOG_DIR"
