#!/usr/bin/env bash
# Contract checks for scripts/bootstrap.sh. Run from repo root.
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
must_contain 'invoker-cli doctor --fix' 'bootstrap must run doctor --fix'
must_contain 'invoker-cli setup --yes' 'bootstrap must run setup --yes'
must_contain '@neko-catpital-labs/invoker-cli' 'bootstrap must install invoker-cli'
must_contain '@neko-catpital-labs/invoker-ui' 'bootstrap must install invoker-ui'
must_contain 'Default Invoker owner: local' 'bootstrap must document local default owner'
must_contain 'Name a host or IP' 'bootstrap must document conversational remote retarget'

help_out="$("$BOOTSTRAP" --help)"
printf '%s\n' "$help_out" | grep -qF 'invoker-cli setup --yes' || fail '--help must mention setup --yes'

echo "OK: bootstrap contract"
