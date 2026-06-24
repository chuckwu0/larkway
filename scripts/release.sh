#!/usr/bin/env bash
# scripts/release.sh — cut a Larkway release end-to-end.
#
# Bumps the version, updates the version references in README.md / README.zh.md /
# docs/versioning.md, commits `chore: release vX`, tags, publishes to npm, pushes,
# and creates a GitHub Release. Deterministic; refuses to run if the tag exists.
#
# Usage:
#   scripts/release.sh <version> "<one-line changelog>"
#   scripts/release.sh 0.3.14 "harden profile bootstrap; fix gap-fill race"
#   scripts/release.sh 0.3.14 "..." --dry-run   # show the diff, change nothing
#
# Preconditions:
#   - clean working tree, on `main`
#   - tag v<version> does not already exist
#   - logged in to npm (`npm whoami`) or NPM_TOKEN configured in ~/.npmrc
#   - pnpm + node available
#
# npm auth is read from your environment (~/.npmrc / NPM_TOKEN) — never stored here.
set -euo pipefail

die() { echo "✗ $*" >&2; exit 1; }

# ── args ─────────────────────────────────────────────────────────────────────
VERSION=""; NOTES=""; DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    -*) die "unknown flag: $a" ;;
    *) if [ -z "$VERSION" ]; then VERSION="$a"; elif [ -z "$NOTES" ]; then NOTES="$a"; else die "unexpected arg: $a"; fi ;;
  esac
done
[ -n "$VERSION" ] || die "usage: scripts/release.sh <version> \"<one-line changelog>\" [--dry-run]"
[ -n "$NOTES" ]   || die "missing changelog note (2nd arg) — it goes into docs/versioning.md"
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "version must be semver X.Y.Z (got: $VERSION)"

# ── locate repo root ─────────────────────────────────────────────────────────
ROOT="$(git rev-parse --show-toplevel)" || die "not in a git repo"
cd "$ROOT"
[ "$(node -p "require('./package.json').name")" = "larkway" ] || die "package.json name != larkway (wrong repo?)"
PREV="$(node -p "require('./package.json').version")"

# ── preflight ────────────────────────────────────────────────────────────────
[ -z "$(git status --porcelain)" ]          || die "working tree not clean — commit/stash first"
[ "$(git branch --show-current)" = "main" ] || die "not on main (on $(git branch --show-current))"
git rev-parse "v$VERSION" >/dev/null 2>&1   && die "tag v$VERSION already exists"
[ "$PREV" != "$VERSION" ]                   || die "version unchanged ($PREV)"

echo "→ releasing larkway: $PREV → $VERSION"
[ "$DRY_RUN" = 1 ] && echo "  (dry-run: no commit / tag / publish / push)"

# ── gates: typecheck + npm packaging sanity (prepack builds dist) ─────────────
echo "→ pnpm typecheck"; pnpm -s typecheck
echo "→ npm publish --dry-run (validates build + package contents)"; npm publish --dry-run >/dev/null
if [ "$DRY_RUN" != 1 ]; then
  npm whoami >/dev/null 2>&1 || die "not logged in to npm (run \`npm login\` or set NPM_TOKEN in ~/.npmrc)"
fi

# ── edits (the 4 files a release touches) ─────────────────────────────────────
# 1) package.json version (the single source of truth; version.ts reads it)
node -e "const fs=require('fs'),p=require('./package.json');p.version='$VERSION';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
# 2) README banners — match the ASCII version token, guarded to the banner line.
#    -Mutf8 so the Chinese guard literal is a char-string (matches -CSD-decoded input).
perl -CSD -Mutf8 -i -pe "s/v[0-9]+\.[0-9]+\.[0-9]+\*\*/v$VERSION**/ if /Current release/" README.md
perl -CSD -Mutf8 -i -pe "s/v[0-9]+\.[0-9]+\.[0-9]+\*\*/v$VERSION**/ if /当前版本/"        README.zh.md
# 3) docs/versioning.md — demote the previous "当前" row, append the new current
#    row in the table and a line in the "当前主线" code block.
awk -v prev="$PREV" -v ver="$VERSION" -v notes="$NOTES" '
  $0 ~ "^\\| v" prev " \\|" { sub(/当前 /, ""); print; print "| v" ver " | v" ver " | 当前 patch / 已发布 | " notes " |"; next }
  $0 ~ "^v" prev "[ \t]"    { print; printf "%-14s= %s\n", "v" ver, notes; next }
  { print }
' docs/versioning.md > docs/versioning.md.tmp && mv docs/versioning.md.tmp docs/versioning.md

echo "→ changes:"; git --no-pager diff -- package.json README.md README.zh.md docs/versioning.md

if [ "$DRY_RUN" = 1 ]; then
  git checkout -- package.json README.md README.zh.md docs/versioning.md
  echo "✓ dry-run complete — reverted, nothing committed."
  exit 0
fi

# guard: every target file must actually mention the new version after editing
for f in package.json README.md README.zh.md docs/versioning.md; do
  grep -q "$VERSION" "$f" || die "$f does not mention $VERSION after edit — aborting (check the file format)"
done

# ── commit + tag + publish + push ─────────────────────────────────────────────
git add package.json README.md README.zh.md docs/versioning.md
git commit -q -m "chore: release v$VERSION"
git tag "v$VERSION"
echo "→ npm publish"; npm publish --access public   # prepack builds dist
echo "→ git push"; git push origin main && git push origin "v$VERSION"

# ── GitHub Release (non-fatal — the tag + npm publish are the source of truth) ─
# Without this, pushed tags never appear on the repo's Releases page (the "Latest"
# badge goes stale). Uses the origin repo (fork-friendly; no hardcoded slug).
if command -v gh >/dev/null 2>&1; then
  echo "→ gh release create"
  if gh release create "v$VERSION" --title "larkway v$VERSION" --notes "$NOTES" --latest; then
    echo "  ✓ GitHub Release v$VERSION created"
  else
    echo "  ⚠ gh release create failed — tag is pushed; create the Release manually if you want it on the Releases page."
  fi
else
  echo "  ⚠ gh CLI not found — skipped GitHub Release (tag pushed, npm published). Install gh to auto-create Releases."
fi

echo
echo "✓ released larkway v$VERSION"
echo "  npm   : npm i -g larkway@$VERSION   (or latest: npm i -g larkway)"
echo "  github: npm i -g github:chuckwu0/larkway#v$VERSION"
