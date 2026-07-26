#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-queue-invalid-stop.XXXXXX")"
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
print("\n".join(sorted(required | {"UI Vitest"})))
PY
)"
export FAKE_GH_REQUIRED_CHECKS

cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/pr-queue-invalid-stop.json" "$FAKE_GH_STATE_DIR/state.json"
: > "$FAKE_GH_STATE_DIR/calls.log"
LEDGER="$TMP/ledger.jsonl"
python3 - <<'PY' > "$LEDGER"
import json
head = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
rows = [
    {
        "kind": "repair-check",
        "pr": 873,
        "headSha": head,
        "key": "UI Vitest",
        "epoch": 1785062162,
    },
    {
        "kind": "repair-evaluated",
        "pr": 873,
        "headSha": head,
        "key": "UI Vitest",
        "epoch": 1785062162,
    },
    {
        "kind": "repair-invalid",
        "pr": 873,
        "headSha": head,
        "key": "UI Vitest",
        "epoch": 1785062162,
        "meta": {
            "errors": [
                "merge-queue run failed outside the PR head: `required-fast / Vitest Workspace`: `scripts/test-land-stack-skill.sh: line 24: rg: command not found`; `required-fast / Vitest Workspace`: `playwright install-deps chromium` tried to use sudo without a password. Current PR head `UI Vitest` is green; fix queue CI runner/tooling outside this PR and requeue."
            ]
        },
    },
    {
        "kind": "comment-blocked",
        "pr": 873,
        "headSha": head,
        "key": "repair-invalid:UI Vitest:" + head,
        "epoch": 1785062162,
    },
]
for row in rows:
    print(json.dumps(row, sort_keys=True))
PY

out="$(python3 scripts/mergify_admin_requeue.py --once --dry-run --repo fake/repo --author fake-bot --state-file "$LEDGER" 2>&1)"
printf '%s\n' "$out"

case "$out" in
  *'repair-check PR #873'*) fail 'worker retried a queue failure already marked repair-invalid' "$out" ;;
esac
case "$out" in
  *'requeue PR #873'*) fail 'worker requeued after a current-head human-only stop reason' "$out" ;;
esac
echo "$out" | grep -q '"kind": "human_decision"' \
  || fail 'worker did not surface repair-invalid as a human decision blocker' "$out"
echo "$out" | grep -q '"reason": "blocked-needs-human"' \
  || fail 'worker did not wait with blocked-needs-human' "$out"

if grep -Eq "^gh (pr comment|api --method)" "$FAKE_GH_STATE_DIR/calls.log"; then
  fail "dry-run performed a mutating gh call" "$(cat "$FAKE_GH_STATE_DIR/calls.log")"
fi

echo "[repro] passed"
