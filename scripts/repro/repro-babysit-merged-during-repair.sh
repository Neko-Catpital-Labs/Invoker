#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-merged-during-repair.XXXXXX")"
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
export INVOKER_HEADLESS_IPC_HELPER="$ROOT/scripts/repro/fixtures/fake-headless-ipc.js"

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
WORK_ROOT="$HOME/.invoker/mergify-admin-requeue-work/6111"
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
git -C "$TMP/seed" checkout -q --orphan stack/6111
git -C "$TMP/seed" rm -qrf .
printf 'head\n' > "$TMP/seed/head.txt"
git -C "$TMP/seed" add head.txt
git -C "$TMP/seed" commit -q -m head
HEAD_SHA="$(git -C "$TMP/seed" rev-parse HEAD)"
export HEAD_SHA
git -C "$TMP/seed" push -q origin HEAD:refs/heads/stack/6111
mkdir -p "$(dirname "$WORK_ROOT")"
git clone -q "$ORIGIN" "$WORK_ROOT"
# $ORIGIN's bare HEAD is never set to a real branch (only master and
# stack/6111 exist, pushed as two disconnected roots), so the clone above
# leaves $WORK_ROOT in a headless state -- check out the PR's own branch
# explicitly, matching what a real async repair task's checkout would do.
git -C "$WORK_ROOT" fetch -q origin stack/6111
git -C "$WORK_ROOT" checkout -q stack/6111

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
    if int(pr["number"]) == 6111:
        pr["state"] = "MERGED"
        pr["mergeStateStatus"] = "UNKNOWN"
path.write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
echo "fake repair: PR merged during repair"
SH
chmod +x "$TMP/bin/claude"

# resolve_workflow_for_pr defaults to a live Invoker owner over IPC when this
# is unset; mock it to report a genuine miss (no local workflow), so this
# repro is fully hermetic instead of depending on real local Invoker state.
cat > "$TMP/review-gate.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '{}\n'
EOF
chmod +x "$TMP/review-gate.sh"
export INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh"

python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["HEAD_SHA"]
state = {
    "prs": [
        {
            "number": 6111,
            "title": "Merged during repair",
            "body": "## Summary\n\nMerged during repair repro.\n",
            "url": "https://github.com/fake/repo/pull/6111",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/6111",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass", "queued"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS", "PR Body": "FAILURE"},
        }
    ],
    "issue_comments": {
        "6111": [
            {
                "id": "m6111",
                "user": {"login": "mergify"},
                "updated_at": "2026-07-27T06:23:56Z",
                "html_url": "https://github.com/fake/repo/pull/6111#m6111",
                "body": "-*- Mergify Payload -*-\n{\"state\":\"queued\",\"queue_rule_name\":\"admin-bypass\"}\n-*- Mergify Payload End -*-\n# Merge Queue Status\n\n- Checks running",
            }
        ]
    },
    "job_logs": {"2": "Review Unit validation failed before merge."},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
: > "$LEDGER_PATH"
: > "$CALLS_PATH"

# Incident 2026-08-12: submit_async_repair_plan's default path shells out to a
# live Invoker owner over IPC, which this hermetic repro never provides.
# Mock it (same pattern as repro-babysit-pr-body-human-split.sh): run the
# claude wrapper above (marks the PR merged mid-repair, makes no commit),
# then the real normalize step against that no-op outcome.
cat > "$TMP/bin/submit-async.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
plan_path="\${1:?plan path required}"
test -f "\$plan_path"
cd "$WORK_ROOT"
"$TMP/bin/claude"
python3 "$ROOT/scripts/mergify_admin_requeue_repair_normalize.py" \\
  --repo fake/repo --pr 6111 --check "PR Body" \\
  --start-head "$HEAD_SHA" --base master --trunk master \\
  --state-file "$LEDGER_PATH"
EOF
chmod +x "$TMP/bin/submit-async.sh"
export INVOKER_ADMIN_BYPASS_ASYNC_REPAIR_SUBMIT_CMD="$TMP/bin/submit-async.sh"

if ! out="$(python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6111 2>&1)"; then
  fail 'worker failed after PR merged during repair' "$out"
fi
case "$out" in
  *'no merge base'*) fail 'worker retried local PR-body validation after terminal merge' "$out" ;;
  *'Traceback'*) fail 'worker produced traceback after terminal merge' "$out" ;;
esac
grep -q 'repair-check PR #6111 check="PR Body"' <<<"$out" \
  || fail 'expected repair-check action' "$out"
grep -q '"kind": "repair-check"' "$LEDGER_PATH" \
  || fail 'expected repair-check ledger row' "$(cat "$LEDGER_PATH")"
grep -q '"kind": "repair-noop"' "$LEDGER_PATH" \
  || fail 'expected repair-noop ledger row' "$(cat "$LEDGER_PATH")"

echo '[repro] passed'
