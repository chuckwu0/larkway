#!/usr/bin/env bash
# Supervisor wrapper — restarts bridge on exit (exit code 1 from WS watchdog,
# or any other crash). Bridge exits cleanly (code 0) only on SIGTERM/SIGINT,
# so only restart on non-zero exit.
#
# Usage: bash start-bridge.sh [LARKWAY_HOME_DIR]
#   $1 (optional) — explicit larkway home directory.
#   Home resolution priority: $1 (non-empty) > $LARKWAY_HOME env var > $HOME/.larkway
set -euo pipefail

LARKWAY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Resolve LARKWAY_HOME: $1 arg takes priority, then env var, then default.
if [ -n "${1:-}" ]; then
  LARKWAY_HOME="$1"
else
  LARKWAY_HOME="${LARKWAY_HOME:-${HOME}/.larkway}"
fi
export LARKWAY_HOME
LOG_FILE="${LARKWAY_HOME}/logs/bridge.log"
mkdir -p "${LARKWAY_HOME}/logs"

# lark-cli is installed under nvm node v20 globals. APPEND that bin (do NOT
# prepend) so the bridge can find lark-cli WITHOUT hijacking `node`/`pnpm`/`tsx`
# to v20. The v20.13.1 nvm install on this machine is an x64 (Rosetta) build, so
# running tsx/esbuild under it crashes with "@esbuild/darwin-arm64 present but
# needs darwin-x64" (platform mismatch). Appending keeps the parent shell's
# native (arm64) node for pnpm start — esbuild's arm64 binary then matches —
# while lark-cli stays resolvable for the bridge to spawn.
LARK_CLI_BIN="${HOME}/.nvm/versions/node/v20.13.1/bin"
if [ -x "${LARK_CLI_BIN}/lark-cli" ]; then
  export PATH="${PATH}:${LARK_CLI_BIN}"
else
  echo "[supervisor $(date '+%Y-%m-%dT%H:%M:%S')] WARN: lark-cli not found at ${LARK_CLI_BIN}" >> "$LOG_FILE"
fi

cd "$LARKWAY_DIR"

# Single-instance guard (Bug① defense-in-depth). If another supervisor for the
# SAME LARKWAY_HOME is already running, exit immediately so orphans can never
# accumulate. Guards are scoped to LARKWAY_HOME so multiple independent instances
# (e.g. production + local test) do NOT block each other.
#
# Detection: when TS layer spawns us it passes LARKWAY_HOME as the last argv
# ("bash start-bridge.sh <home>"), so we look for that exact token at end-of-line.
# When launched without $1 (legacy/manual/systemd), we fall back to env-var match
# or the plain script-path search (original behaviour).
#
# PGID guard: pgrep -f "$0" matches every subprocess of THIS invocation (the while
# loop body, ps, grep sub-shells all share the same argv string "bash <script> <home>").
# Those sub-processes have pid≠$$ but still belong to our own process-group (PGID=$$
# for a detached shell, or the parent PGID for a non-detached one). We compute our
# own PGID once and skip any candidate whose PGID matches ours — that filters out
# the pipeline sub-shells without risking a real peer supervisor (which is detached
# with an independent PGID).
#
# -ww disables argv truncation so long home paths still match.
SELF_PGID=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)
OTHERS=$(pgrep -f "$0" 2>/dev/null | grep -v "^$$\$" | while read -r _pid; do
  # Skip if this PID belongs to our own process group (pipeline sub-shells).
  if [ -n "${SELF_PGID:-}" ]; then
    _pgid=$(ps -o pgid= -p "$_pid" 2>/dev/null | tr -d ' ' || true)
    if [ "${_pgid}" = "${SELF_PGID}" ]; then
      continue
    fi
  fi
  _argv=$(ps -ww -o args= -p "$_pid" 2>/dev/null || true)
  if echo "$_argv" | grep -qF "${LARKWAY_HOME}"; then
    echo "$_pid"
  fi
done || true)
if [ -n "${OTHERS:-}" ]; then
  echo "[supervisor $(date '+%Y-%m-%dT%H:%M:%S')] another supervisor for ${LARKWAY_HOME} already running (${OTHERS}) — exiting" >> "$LOG_FILE"
  exit 0
fi

while true; do
  echo "[supervisor $(date '+%Y-%m-%dT%H:%M:%S')] starting bridge…" >> "$LOG_FILE"
  # `set -e` would otherwise terminate the supervisor as soon as pnpm exits non-zero
  # (before we read $?), bypassing the crash log + orphan cleanup below. Force
  # capture exit code without tripping set -e.
  EXIT_CODE=0
  pnpm start >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?
  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "[supervisor $(date '+%Y-%m-%dT%H:%M:%S')] bridge exited cleanly (SIGTERM/SIGINT) — stopping" >> "$LOG_FILE"
    break
  fi
  echo "[supervisor $(date '+%Y-%m-%dT%H:%M:%S')] bridge crashed (exit=$EXIT_CODE) — restarting in 5 s…" >> "$LOG_FILE"
  # Clean up orphan lark-cli WS subscribers from the dead bridge — they
  # get reparented to PID 1 on watchdog exit(1) and would otherwise hold
  # the feishu subscription, forcing the new bridge into a retry loop
  # (Only one subscriber per app is allowed). Match the exact subscribe
  # command to avoid killing unrelated lark-cli invocations (api/im/etc).
  ORPHANS=$(pgrep -f "lark-cli event \+subscribe" 2>/dev/null || true)
  if [ -n "${ORPHANS:-}" ]; then
    echo "[supervisor $(date '+%Y-%m-%dT%H:%M:%S')] killing orphan lark-cli subscriber(s): ${ORPHANS}" >> "$LOG_FILE"
    kill ${ORPHANS} 2>/dev/null || true
    sleep 1
    # If still alive after SIGTERM, SIGKILL
    STILL=$(pgrep -f "lark-cli event \+subscribe" 2>/dev/null || true)
    if [ -n "${STILL:-}" ]; then
      kill -9 ${STILL} 2>/dev/null || true
    fi
  fi
  sleep 5
done
