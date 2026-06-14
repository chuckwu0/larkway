#!/usr/bin/env bash
# One-command local acceptance for v0.3 Phase 1.
#
# This is the last local gate before real Feishu dogfood. It intentionally does
# not use production Feishu credentials and does not touch the real ~/.larkway.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

step() {
  echo
  echo "=== $* ==="
}

step "1. unit tests"
pnpm test

step "2. typecheck"
pnpm typecheck

step "3. doc links"
pnpm check:links

step "4. normal dogfood creation path"
./bin/v0.3-dogfood-normal-path-smoke.sh

step "5. startup preconditions and permission audit"
./bin/v0.3-dogfood-startup-smoke.sh

step "6. dogfood verify helper"
./bin/v0.3-dogfood-e2e-verify-smoke.sh

step "7. Claude backend smoke"
./bin/v0.3-claude-backend-smoke.sh

echo
echo "✓ v0.3 local acceptance passed"
