#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-stale-repair-outcome-no-comment.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- detail -----" >&2
    echo "$2" >&2
  fi
  exit 1
}

export HOME="$TMP/home"
mkdir -p "$HOME" "$TMP/state" "$TMP/bin"
export FAKE_GH_STATE_DIR="$TMP/state"
export PATH="$TMP/bin:$ROOT/scripts/repro/fixtures/fake-gh/bin:$PATH"

FAKE_GH_REQUIRED_CHECKS="$(python3 - <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, 'scripts')
from mergify_admin_requeue_model import load_mergify_rules
_trunk, _labels, required = load_mergify_rules(Path('.mergify.yml'))
print('\n'.join(sorted(required)))
PY
)"
export FAKE_GH_REQUIRED_CHECKS

STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
CALLS_PATH="$FAKE_GH_STATE_DIR/calls.log"
LEDGER_PATH="$TMP/ledger.jsonl"
ORIGIN="$TMP/origin.git"
WORK_ROOT="$HOME/.invoker/mergify-admin-requeue-work/6326"
export STATE_PATH LEDGER_PATH

git init -q --bare "$ORIGIN"
git init -q "$TMP/seed"
git -C "$TMP/seed" config user.email repro@example.invalid
git -C "$TMP/seed" config user.name Repro
printf 'master\n' > "$TMP/seed/master.txt"
git -C "$TMP/seed" add master.txt
git -C "$TMP/seed" commit -q -m master
git -C "$TMP/seed" branch -M master
git -C "$TMP/seed" remote add origin "$ORIGIN"
git -C "$TMP/seed" push -q origin master
git -C "$TMP/seed" checkout -q -b stack/6326
printf 'head\n' > "$TMP/seed/head.txt"
git -C "$TMP/seed" add head.txt
git -C "$TMP/seed" commit -q -m head
HEAD_SHA="$(git -C "$TMP/seed" rev-parse HEAD)"
export HEAD_SHA
git -C "$TMP/seed" push -q origin stack/6326
mkdir -p "$(dirname "$WORK_ROOT")"
git clone -q "$ORIGIN" "$WORK_ROOT"

cat > "$TMP/bin/claude" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["STATE_PATH"])
state = json.loads(path.read_text(encoding="utf-8"))
for pr in state["prs"]:
    if int(pr["number"]) == 6326:
        pr["headRefOid"] = "b" * 40
path.write_text(json.dumps(state, indent=2), encoding="utf-8")
Path("dirty-after-stale-repair.txt").write_text("local repair output after another worker pushed\n", encoding="utf-8")
PY
SH
chmod +x "$TMP/bin/claude"

python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["HEAD_SHA"]
state = {
    "prs": [
        {
            "number": 6326,
            "title": "Stale repair outcome repro",
            "body": "## Summary\n\nStale repair outcome repro.\n",
            "url": "https://github.com/fake/repo/pull/6326",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/6326",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS", "UI Vitest": "FAILURE"},
        }
    ],
    "issue_comments": {"6326": []},
    "job_logs": {"2": "UI Vitest failed before a concurrent worker advanced the PR head.\n"},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
: > "$LEDGER_PATH"
: > "$CALLS_PATH"

if ! out="$(python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6326 2>&1)"; then
  fail 'worker failed during stale repair outcome repro' "$out"
fi
printf '%s\n' "$out"
grep -q 'repair-check PR #6326 check="UI Vitest"' <<<"$out" \
  || fail 'expected repair-check action' "$out"

if grep -q '^gh pr comment 6326 ' "$CALLS_PATH"; then
  fail 'worker posted a stale blocker comment after live head moved' "$(cat "$CALLS_PATH")"
fi
grep -q '"kind": "repair-stale".*"pr": 6326' "$LEDGER_PATH" \
  || fail 'missing repair-stale ledger row' "$(cat "$LEDGER_PATH")"
! grep -q '"kind": "comment-blocked".*"pr": 6326' "$LEDGER_PATH" \
  || fail 'stale repair outcome recorded comment-blocked' "$(cat "$LEDGER_PATH")"

echo '[repro] passed'
