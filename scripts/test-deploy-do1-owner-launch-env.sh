#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCRIPT="scripts/deploy-do1.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }

bash -n "$SCRIPT" || fail "$SCRIPT is not valid bash"

LAUNCH_LINES="$(grep -n -- '--headless owner-serve' "$SCRIPT" | grep -E 'setsid|nohup' || true)"
[ -n "$LAUNCH_LINES" ] || fail "could not find the direct owner-serve launch in $SCRIPT"

while IFS= read -r line; do
  case "$line" in
    *"INVOKER_PRODUCTION_OWNER_SERVICE=1"*) ;;
    *) fail "direct owner launch must set INVOKER_PRODUCTION_OWNER_SERVICE=1 so worker IPC resolves the production socket: ${line%%--no-sandbox*}" ;;
  esac
done <<< "$LAUNCH_LINES"

if grep -q 'systemctl --user stop slack-manager' "$SCRIPT"; then
  fail "owner restart must not stop slack-manager; an explicit stop stays down if the script dies"
fi
if grep -q 'systemctl --user restart slack-manager' "$SCRIPT"; then
  fail "owner restart must not restart slack-manager"
fi

echo "PASS: every direct owner-serve launch in $SCRIPT sets INVOKER_PRODUCTION_OWNER_SERVICE=1"
echo "PASS: owner restart does not stop or restart slack-manager"
