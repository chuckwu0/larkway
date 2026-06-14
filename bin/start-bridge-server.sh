#!/usr/bin/env bash
# Server-side supervisor wrapper for the larkway user.
# Pins node v20.20.2 from larkway's nvm and runs the bridge under a restart loop.
set -uo pipefail

LARKWAY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="${LARKWAY_HOME:-${HOME}/.larkway}/logs/bridge.log"

export NVM_DIR="${HOME}/.nvm"
# shellcheck disable=SC1091
. "${NVM_DIR}/nvm.sh"
nvm use 20 >/dev/null

# Ensure git / glab / system tools are reachable from spawned subprocesses.
export PATH="${HOME}/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin:${PATH:-}"

cd "$LARKWAY_DIR"

mkdir -p "$(dirname "$LOG_FILE")"

while true; do
  echo "[supervisor $(date '+%Y-%m-%dT%H:%M:%S')] starting bridge…" >> "$LOG_FILE"
  EXIT_CODE=0
  pnpm start >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?
  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "[supervisor $(date '+%Y-%m-%dT%H:%M:%S')] bridge exited cleanly (SIGTERM/SIGINT) — stopping" >> "$LOG_FILE"
    break
  fi
  echo "[supervisor $(date '+%Y-%m-%dT%H:%M:%S')] bridge crashed (exit=$EXIT_CODE) — restarting in 5 s…" >> "$LOG_FILE"
  ORPHANS=$(pgrep -f "lark-cli event \+subscribe" 2>/dev/null || true)
  if [ -n "${ORPHANS:-}" ]; then
    echo "[supervisor $(date '+%Y-%m-%dT%H:%M:%S')] killing orphan lark-cli subscriber(s): ${ORPHANS}" >> "$LOG_FILE"
    kill ${ORPHANS} 2>/dev/null || true
    sleep 1
    STILL=$(pgrep -f "lark-cli event \+subscribe" 2>/dev/null || true)
    if [ -n "${STILL:-}" ]; then
      kill -9 ${STILL} 2>/dev/null || true
    fi
  fi
  sleep 5
done
