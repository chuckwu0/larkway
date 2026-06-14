#!/usr/bin/env bash
# v0.3 Claude backend smoke for agent_workspace bots.
#
# Proves a non-default agent_workspace bot can use backend=claude without
# touching real Feishu, real ~/.larkway, or real Claude credentials.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d /tmp/larkway-v03-claude-backend.XXXXXX)"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

HOME_DIR="$TMP_ROOT/home"
BOTS_DIR="$HOME_DIR/bots"
WORKSPACE="$HOME_DIR/agents/claude-devops/workspace"
FAKE_BIN="$TMP_ROOT/bin"

mkdir -p "$BOTS_DIR" "$WORKSPACE" "$FAKE_BIN"

cat > "$FAKE_BIN/claude" <<'SH'
#!/usr/bin/env sh
echo 'claude 0.0.0-test'
SH
chmod +x "$FAKE_BIN/claude"

cat > "$BOTS_DIR/claude-devops.yaml" <<'YAML'
id: claude-devops
name: Claude DevOps
description: Smoke-test Claude Code backend in an Agent Workspace
app_id: cli_test_claude
app_secret_env: CLAUDE_DEVOPS_APP_SECRET
bot_open_id: ou_claude
chats: [oc_test]
runtime: agent_workspace
backend: claude
gitlab_token_env: CLAUDE_DEVOPS_GITLAB_TOKEN
repos:
  - slug: chuckwu0/larkway
    branch: main
    url: https://gitlab.example.com/chuckwu0/larkway.git
YAML

cat > "$HOME_DIR/.env" <<'ENV'
CLAUDE_DEVOPS_APP_SECRET=app-secret-value
CLAUDE_DEVOPS_GITLAB_TOKEN=glpat-secret-value
ENV
chmod 600 "$HOME_DIR/.env"

cat > "$WORKSPACE/AGENTS.md" <<'MD'
# Claude DevOps

Smoke-test Claude Code backend in an Agent Workspace.
MD

ln -s AGENTS.md "$WORKSPACE/CLAUDE.md"

cat > "$WORKSPACE/permissions-request.md" <<'MD'
- type=write Feishu IM: receive mentions and reply in allowed chats
- type=read Feishu chat allowlist: oc_test
- type=read GitLab repo pointer: chuckwu0/larkway (main)
- type=read GitLab token env name: CLAUDE_DEVOPS_GITLAB_TOKEN
- type=write Local shell inside the Agent Workspace for task execution and verification
- type=write GitLab write/MR env=CLAUDE_DEVOPS_GITLAB_TOKEN
- type=deploy deploy/restart gate=explicit-human-confirmation
- type=external-message external message to Feishu gate=explicit-human-confirmation
- type=production-impact production-impact operations gate=explicit-human-confirmation
MD

cat > "$WORKSPACE/permissions-granted.md" <<'MD'
- type=write Feishu IM: receive mentions and reply in allowed chats confirmed by host
- type=read Feishu chat allowlist: oc_test confirmed by host
- type=read GitLab repo pointer: chuckwu0/larkway (main) confirmed by host
- type=read GitLab token env name: CLAUDE_DEVOPS_GITLAB_TOKEN confirmed by host
- type=write Local shell inside the Agent Workspace for task execution and verification confirmed by host
- type=write GitLab write/MR env=CLAUDE_DEVOPS_GITLAB_TOKEN confirmed by host
- type=deploy deploy/restart gate=explicit-human-confirmation confirmed by host
- type=external-message external message to Feishu gate=explicit-human-confirmation confirmed by host
- type=production-impact production-impact operations gate=explicit-human-confirmation confirmed by host
MD

run_cli() {
  (cd "$REPO" && \
    PATH="$FAKE_BIN:$PATH" \
    HOME="$TMP_ROOT/fake-home" \
    ANTHROPIC_AUTH_TOKEN="anthropic-auth-token-for-smoke" \
    LARKWAY_HOME="$HOME_DIR" \
    LARKWAY_BOTS_DIR="$BOTS_DIR" \
    pnpm exec tsx src/cli/index.ts --non-interactive "$@")
}

run_start() {
  (cd "$REPO" && \
    PATH="$FAKE_BIN:$PATH" \
    HOME="$TMP_ROOT/fake-home" \
    ANTHROPIC_AUTH_TOKEN="anthropic-auth-token-for-smoke" \
    LARKWAY_HOME="$HOME_DIR" \
    LARKWAY_BOTS_DIR="$BOTS_DIR" \
    LARKWAY_DRY_RUN=1 \
    GITLAB_TOKEN="glpat-global-should-not-be-used" \
    pnpm start 2>&1)
}

echo "=== v0.3 Claude backend smoke: preflight passes ==="
out="$(run_cli dogfood preflight claude-devops 2>&1)"
echo "$out" | grep -q "backend is configured.*claude" || {
  echo "$out"
  echo "expected preflight to report backend=claude" >&2
  exit 1
}
echo "$out" | grep -q "Claude Code CLI is runnable" || {
  echo "$out"
  echo "expected preflight to check Claude Code CLI binary" >&2
  exit 1
}
echo "$out" | grep -q "Claude Code CLI is logged in" || {
  echo "$out"
  echo "expected preflight to check Claude login state" >&2
  exit 1
}
if grep -R "app-secret-value\|glpat-secret-value\|anthropic-auth-token-for-smoke" "$BOTS_DIR" "$WORKSPACE" >/dev/null 2>&1; then
  echo "secret value leaked into bot config or workspace artifacts" >&2
  exit 1
fi

echo "=== v0.3 Claude backend smoke: dry-run start wires bot ==="
out="$(run_start)"
echo "$out" | grep -q '\[dry-run\] V2 mode' || {
  echo "$out"
  echo "expected dry-run start to wire Claude backend workspace bot" >&2
  exit 1
}
echo "$out" | grep -q "claude-devops" || {
  echo "$out"
  echo "expected dry-run output to mention claude-devops" >&2
  exit 1
}

echo "✓ v0.3 Claude backend smoke passed"
