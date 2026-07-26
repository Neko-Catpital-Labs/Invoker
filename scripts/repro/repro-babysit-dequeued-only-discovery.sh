#!/usr/bin/env bash
# Battle-test: the admin-bypass landing brain must DISCOVER a standalone PR that
# carries only the `dequeued` label (Mergify strips `admin-bypass` when it
# dequeues), not just PRs still labelled `admin-bypass`. Models real PR #5810:
# a single-PR stack on master, dequeued for a queue-only check, with no
# admin-bypass stackmate to expand it in. Before the candidate scan seeds from
# the `dequeued` label, such a PR is invisible and stays stuck forever.
#
#   dequeued-only.json (empty ledger)        -> repair_check(queue-only check)
#   dequeued-only.json (queue-only-noop seed) -> restore_admin_bypass_label
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-dequeued-only.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/state"
export FAKE_GH_STATE_DIR="$TMP/state"
export PATH="$ROOT/scripts/repro/fixtures/fake-gh/bin:$PATH"

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
  local ledger="$1"
  cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/dequeued-only.json" "$FAKE_GH_STATE_DIR/state.json"
  : > "$FAKE_GH_STATE_DIR/calls.log"
  python3 scripts/mergify_admin_requeue.py --once --dry-run \
    --repo fake/repo --author fake-bot --state-file "$ledger" 2>&1
}

# 1) Fresh ledger: the worker must discover #810 and plan the queue-only repair.
out="$(run_land "$TMP/ledger-fresh.jsonl")"
echo "$out" | grep -q 'DRY-RUN repair-check PR #810 check="required-fast / Guardrails"' \
  || fail "fresh: expected the worker to discover dequeued-only #810 and plan repair_check" "$out"
echo "$out" | grep -q "admin-bypass-scan-empty" \
  && fail "fresh: worker treated the scan as empty; dequeued-only #810 was not discovered" "$out"

# 2) After a recorded queue-only noop, the discovered PR advances toward requeue
#    by restoring its stripped admin-bypass label (not a dead-end nudge).
seed="$TMP/ledger-noop.jsonl"
cat > "$seed" <<'JSONL'
{"epoch": 1784600000, "headSha": "8108108108108108108108108108108108108108", "key": "required-fast / Guardrails", "kind": "queue-only-noop", "pr": 810}
JSONL
out="$(run_land "$seed")"
echo "$out" | grep -q "DRY-RUN restore-admin-bypass-label PR #810" \
  || fail "noop-seed: expected restore-admin-bypass-label for discovered dequeued-only #810" "$out"

# Dry-run must not mutate the fake GitHub.
if grep -Eq "^gh (pr comment|api --method)" "$FAKE_GH_STATE_DIR/calls.log"; then
  fail "dry-run performed a mutating gh call" "$(cat "$FAKE_GH_STATE_DIR/calls.log")"
fi

echo "[repro] passed"
