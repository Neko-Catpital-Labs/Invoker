#!/usr/bin/env bash
# Battle-test: the mergify admin-bypass landing brain plans the right action
# per scenario against a fake GitHub, in dry-run (no mutations):
#   pr-dirty.json       -> rebase_recreate (merge conflict)
#   pr-ci-failed.json   -> repair_check (failed required check after dequeue)
#   stack-landable.json -> requeue (clean dequeued bottom PR)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-land.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/state"
export FAKE_GH_STATE_DIR="$TMP/state"
export PATH="$ROOT/scripts/repro/fixtures/fake-gh/bin:$PATH"

# The fake gh expands the "*" checks default to the repo's real required-check
# names, so the landing brain sees every .mergify.yml-required check green.
FAKE_GH_REQUIRED_CHECKS="$(python3 - <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, "scripts")
from mergify_admin_requeue_model import load_mergify_rules
_trunk, _labels, required = load_mergify_rules(Path(".mergify.yml"))
print("\n".join(sorted(required)))
PY
)"
export FAKE_GH_REQUIRED_CHECKS

run_land() {
  local scenario="$1"
  cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/$scenario" "$FAKE_GH_STATE_DIR/state.json"
  : > "$FAKE_GH_STATE_DIR/calls.log"
  python3 scripts/mergify_admin_requeue.py --once --dry-run \
    --repo fake/repo --author fake-bot --state-file "$TMP/ledger.jsonl" 2>&1
}

out="$(run_land pr-dirty.json)"
echo "$out" | grep -q "DRY-RUN rebase-recreate PR #501" \
  || fail "pr-dirty: expected rebase_recreate plan" "$out"

out="$(run_land pr-ci-failed.json)"
echo "$out" | grep -q 'DRY-RUN repair-check PR #601 check="PR Body"' \
  || fail "pr-ci-failed: expected repair_check plan" "$out"

out="$(run_land stack-landable.json)"
echo "$out" | grep -q "DRY-RUN requeue PR #701 head=dddddddddddddddddddddddddddddddddddddddd reason=eligible-after-dequeue" \
  || fail "stack-landable: expected requeue plan for the bottom PR" "$out"
echo "$out" | grep -q "PR #702" && fail "stack top must not be actioned before the bottom lands" "$out"

# Dry-run must not mutate the fake GitHub: no comments, no label edits.
if grep -Eq "^gh (pr comment|api --method)" "$FAKE_GH_STATE_DIR/calls.log"; then
  fail "dry-run performed a mutating gh call" "$(cat "$FAKE_GH_STATE_DIR/calls.log")"
fi

echo "[repro] passed"
