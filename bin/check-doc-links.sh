#!/usr/bin/env bash
# check-doc-links.sh — thin wrapper delegating to cross-platform Node script.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/check-doc-links.mjs" "$@"
