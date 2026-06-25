#!/usr/bin/env bash
# One-command local readiness gate for v0.3 Phase 0.
#
# This gate is intentionally local-only. It must not start a bridge, subscribe
# to Feishu events, send messages/cards, upload images, or require private
# app/chat credentials. Real Feishu E2E is a separate owner-authorized smoke
# path; see docs/phase0-readiness.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

step() {
  echo
  echo "=== $* ==="
}

run_local() {
  (
    unset LARKWAY_HOME
    unset LARKWAY_BOTS_DIR
    "$@"
  )
}

step "1. unit tests"
run_local pnpm test

step "2. typecheck"
run_local pnpm typecheck

step "3. doc links"
run_local pnpm check:links

step "4. Claude backend dry-run smoke"
run_local ./bin/v0.3-claude-backend-smoke.sh

echo
echo "✓ v0.3 Phase 0 local readiness passed"
echo "  Real Feishu E2E remains gated on an owner-authorized test app, test chat,"
echo "  isolated LARKWAY_HOME, and controlled bridge lifecycle."
