#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-retarget-stale-bottom-base.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1"
  if [ -n "${2:-}" ]; then
    echo "----- detail -----"
    echo "$2"
  fi
  exit 1
}

export HOME="$TMP/home"
mkdir -p "$HOME" "$TMP/state"
export FAKE_GH_STATE_DIR="$TMP/state"
export PATH="$ROOT/scripts/repro/fixtures/fake-gh/bin:$PATH"

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
LEDGER_PATH="$TMP/ledger.jsonl"
CALLS_PATH="$FAKE_GH_STATE_DIR/calls.log"
export STATE_PATH LEDGER_PATH CALLS_PATH

python3 - <<'PY'
import json
import os
from pathlib import Path

stack_comment = {
    "id": "stack-comment-1",
    "user": {"login": "mergify[bot]"},
    "body": '<!-- mergify-stack-data: {"stack_id":"stack/slack-routing","pull_numbers_bottom_to_top":[5885,5886]} -->',
    "updated_at": "2026-07-20T00:00:00Z",
    "html_url": "https://github.com/fake/repo/pull/5885#stack",
}
state = {
    "prs": [
        {
            "number": 5885,
            "title": "Tighten Slack repo routing",
            "body": "## Summary\n\nStale base retarget repro.\n",
            "url": "https://github.com/fake/repo/pull/5885",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "pr/babysit-prereq-split",
            "headRefName": "stack/slack-routing-1",
            "headRefOid": "1111111111111111111111111111111111111111",
            "mergeStateStatus": "CLEAN",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        },
        {
            "number": 5886,
            "title": "Reject invalid literal repo URLs",
            "body": "## Summary\n\nUpper stack member.\n",
            "url": "https://github.com/fake/repo/pull/5886",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "stack/slack-routing-1",
            "headRefName": "stack/slack-routing-2",
            "headRefOid": "2222222222222222222222222222222222222222",
            "mergeStateStatus": "CLEAN",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        },
        {
            "number": 7002,
            "title": "Unrelated stack root",
            "body": "## Summary\n\nUnrelated stack should stay untouched.\n",
            "url": "https://github.com/fake/repo/pull/7002",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/unrelated-root",
            "headRefOid": "4444444444444444444444444444444444444444",
            "mergeStateStatus": "CLEAN",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        },
        {
            "number": 7003,
            "title": "Unrelated stack child",
            "body": "## Summary\n\nUnrelated stack child should stay untouched.\n",
            "url": "https://github.com/fake/repo/pull/7003",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "stack/unrelated-root",
            "headRefName": "stack/unrelated-top",
            "headRefOid": "5555555555555555555555555555555555555555",
            "mergeStateStatus": "CLEAN",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        },
    ],
    "issue_comments": {
        "5885": [stack_comment],
        "5886": [dict(stack_comment, html_url="https://github.com/fake/repo/pull/5886#stack")],
        "7002": [],
        "7003": [],
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
: > "$LEDGER_PATH"

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5886 "$@" 2>&1
}

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed' "$out1"
fi

echo "$out1" | grep -q 'retarget-base PR #5885 from=pr/babysit-prereq-split to=master' || fail 'tick 1 output did not show root retarget' "$out1"

python3 - <<'PY' || fail 'expected root-only base retarget on tick 1' "$(cat "$STATE_PATH")"
import json
import os
from pathlib import Path

state = json.loads(Path(os.environ["STATE_PATH"]).read_text(encoding="utf-8"))
prs = {pr["number"]: pr for pr in state["prs"]}
if prs[5885]["baseRefName"] != "master":
    raise SystemExit(f"expected #5885 baseRefName=master, saw {prs[5885]['baseRefName']}")
if prs[5886]["baseRefName"] != "stack/slack-routing-1":
    raise SystemExit("upper PR base changed unexpectedly")
if prs[7002]["baseRefName"] != "master" or prs[7003]["baseRefName"] != "stack/unrelated-root":
    raise SystemExit("unrelated stack changed unexpectedly")
for number in (5885, 5886, 7002, 7003):
    blocker_comments = [
        comment for comment in state.get("issue_comments", {}).get(str(number), [])
        if str(comment.get("body", "")).startswith("Mergify repair stopped:")
    ]
    if blocker_comments:
        raise SystemExit(f"unexpected blocker comment on #{number}")
PY

grep -q 'gh api --method PATCH repos/fake/repo/pulls/5885 -f base=master' "$CALLS_PATH" || fail 'tick 1 did not PATCH the root base' "$(cat "$CALLS_PATH")"

if ! out2="$(run_worker --dry-run)"; then
  fail 'tick 2: worker failed' "$out2"
fi

echo "$out2" | grep -q 'DRY-RUN requeue PR #5885' || fail 'tick 2 dry-run did not requeue the retargeted root' "$out2"
! echo "$out2" | grep -q 'retarget-base PR #5885' || fail 'tick 2 planned another retarget instead of re-reading state' "$out2"

python3 - <<'PY' || fail 'expected one retarget-base ledger row' "$(cat "$LEDGER_PATH")"
import json
import os
from pathlib import Path

rows = [
    json.loads(line)
    for line in Path(os.environ["LEDGER_PATH"]).read_text(encoding="utf-8").splitlines()
    if line.strip()
]
matches = [
    row for row in rows
    if row.get("kind") == "retarget-base"
    and row.get("key") == "pr/babysit-prereq-split->master"
    and int(row.get("pr", 0)) == 5885
]
if len(matches) != 1:
    raise SystemExit(f"expected 1 matching row, saw {len(matches)}")
PY

echo '[repro] passed'
