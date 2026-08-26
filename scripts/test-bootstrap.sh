#!/usr/bin/env bash
# Contract checks for scripts/bootstrap.sh (Node ensure → CLI install).
# Run from repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$BOOTSTRAP" ]] || fail "missing $BOOTSTRAP"
[[ -x "$BOOTSTRAP" ]] || fail "bootstrap.sh must be executable"

bash -n "$BOOTSTRAP" || fail "bash -n failed"

must_contain() {
  local needle="$1"
  local hint="$2"
  if ! grep -qF -- "$needle" "$BOOTSTRAP"; then
    fail "$hint — missing: $needle"
  fi
}

must_contain '</dev/null' 'curl|bash-safe CLI calls must redirect stdin from /dev/null'
must_contain 'npx --yes @neko-catpital-labs/invoker-cli@latest install' 'bootstrap must delegate to invoker-cli install'
must_not_contain() {
  local needle="$1"
  local hint="$2"
  if grep -qF -- "$needle" "$BOOTSTRAP"; then
    fail "$hint — unexpected: $needle"
  fi
}

must_not_contain 'invoker-cli doctor --fix' 'bootstrap must not reimplement doctor'
must_not_contain 'invoker-cli setup --yes' 'bootstrap must not reimplement setup'

help_out="$("$BOOTSTRAP" --help)"
printf '%s\n' "$help_out" | grep -qF 'npx @neko-catpital-labs/invoker-cli@latest install' \
  || fail '--help must mention npx install one-liner'

echo "OK: bootstrap contract"
