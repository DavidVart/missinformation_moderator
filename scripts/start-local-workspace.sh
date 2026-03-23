#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.local-runtime"
LOG_DIR="$RUNTIME_DIR/logs"
PID_DIR="$RUNTIME_DIR/pids"
PYTHON_BIN="${PYTHON_BIN:-python3}"
WHISPER_VENV="${WHISPER_VENV:-$HOME/.cache/project-veritas-whisper}"
WHISPER_PYTHON="$WHISPER_VENV/bin/python"

mkdir -p "$LOG_DIR" "$PID_DIR"

load_whisper_env() {
  local env_file="$ROOT_DIR/.env"
  [[ -f "$env_file" ]] || return 0

  while IFS='=' read -r key raw_value; do
    [[ -n "$key" ]] || continue
    [[ "$key" =~ ^WHISPER_[A-Z0-9_]+$ ]] || continue

    local value="$raw_value"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    export "${key}=${value}"
  done < <(grep -E '^WHISPER_[A-Z0-9_]+=' "$env_file")
}

normalize_local_whisper_url() {
  local current_url="${WHISPER_WORKER_URL:-http://127.0.0.1:8000}"
  current_url="${current_url/whisper-worker/127.0.0.1}"
  current_url="${current_url/host.docker.internal/127.0.0.1}"
  export WHISPER_WORKER_URL="$current_url"
}

wait_for_url() {
  local name="$1"
  local url="$2"

  for _ in {1..45}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "started $name"
      return 0
    fi
    sleep 1
  done

  echo "failed to start $name ($url)"
  return 1
}

wait_for_port() {
  local name="$1"
  local host="$2"
  local port="$3"

  for _ in {1..45}; do
    if "$PYTHON_BIN" - <<PY >/dev/null 2>&1
import socket

with socket.create_connection(("$host", $port), timeout=1):
    pass
PY
    then
      echo "started $name"
      return 0
    fi
    sleep 1
  done

  echo "failed to start $name on $host:$port"
  return 1
}

stop_detached() {
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

start_detached() {
  local name="$1"
  local log_file="$2"
  shift 2
  local pid_file="$PID_DIR/$name.pid"

  stop_detached "$name"

  ROOT_DIR="$ROOT_DIR" \
  LOG_FILE_VALUE="$log_file" \
  PID_FILE_VALUE="$pid_file" \
  COMMAND_JSON="$("$PYTHON_BIN" -c 'import json, sys; print(json.dumps(sys.argv[1:]))' "$@")" \
  "$PYTHON_BIN" - <<'PY'
import json
import os
import subprocess

root_dir = os.environ["ROOT_DIR"]
log_file = os.environ["LOG_FILE_VALUE"]
pid_file = os.environ["PID_FILE_VALUE"]
command = json.loads(os.environ["COMMAND_JSON"])

with open(log_file, "ab", buffering=0) as stream:
    process = subprocess.Popen(
        command,
        cwd=root_dir,
        stdin=subprocess.DEVNULL,
        stdout=stream,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

with open(pid_file, "w", encoding="utf-8") as stream:
    stream.write(str(process.pid))
PY
}

ensure_docker() {
  if "$PYTHON_BIN" - <<'PY' >/dev/null 2>&1
import subprocess
import sys

try:
    proc = subprocess.run(["docker", "version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
    sys.exit(proc.returncode)
except Exception:
    sys.exit(1)
PY
  then
    return 0
  fi

  if command -v open >/dev/null 2>&1; then
    open -a Docker >/dev/null 2>&1 || true
  fi

  for _ in {1..90}; do
    if "$PYTHON_BIN" - <<'PY' >/dev/null 2>&1
import subprocess
import sys

try:
    proc = subprocess.run(["docker", "version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
    sys.exit(proc.returncode)
except Exception:
    sys.exit(1)
PY
    then
      echo "docker ready"
      return 0
    fi
    sleep 1
  done

  echo "docker did not become ready"
  return 1
}

start_redis() {
  if docker ps --format '{{.Names}}' | grep -Fxq 'veritas-redis'; then
    echo "redis already running"
    return 0
  fi

  if docker ps -a --format '{{.Names}}' | grep -Fxq 'veritas-redis'; then
    docker start veritas-redis >/dev/null
  else
    docker run -d --name veritas-redis -p 6379:6379 redis:7.4-alpine >/dev/null
  fi

  wait_for_port "redis" "127.0.0.1" "6379"
}

bootstrap_whisper_env() {
  if [[ -x "$WHISPER_PYTHON" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$WHISPER_VENV")"
  "$PYTHON_BIN" -m venv "$WHISPER_VENV"
  "$WHISPER_PYTHON" -m pip install --upgrade pip >/dev/null
  "$WHISPER_PYTHON" -m pip install -r "$ROOT_DIR/infra/faster-whisper-worker/requirements.txt" >/dev/null
}

start_whisper() {
  bootstrap_whisper_env

  start_detached \
    "whisper-worker" \
    "$LOG_DIR/whisper-worker.log" \
    "$WHISPER_PYTHON" \
    "-m" \
    "uvicorn" \
    "app:app" \
    "--app-dir" \
    "infra/faster-whisper-worker" \
    "--host" \
    "0.0.0.0" \
    "--port" \
    "8000"

  wait_for_url "whisper-worker" "http://127.0.0.1:8000/health"
}

start_preview() {
  npm run build -w @project-veritas/mobile -- --configuration development >/dev/null

  start_detached \
    "preview" \
    "$LOG_DIR/preview.log" \
    "$PYTHON_BIN" \
    "-m" \
    "http.server" \
    "4200" \
    "--bind" \
    "0.0.0.0" \
    "--directory" \
    "apps/mobile/dist/mobile/browser"

  wait_for_url "preview" "http://127.0.0.1:4200"
}

ensure_docker
load_whisper_env
normalize_local_whisper_url
start_redis
start_whisper
bash "$ROOT_DIR/scripts/start-local-backend.sh"
start_preview

HOST_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)"

echo "workspace ready"
echo "laptop: http://127.0.0.1:4200"
echo "lan: http://${HOST_IP}:4200"
