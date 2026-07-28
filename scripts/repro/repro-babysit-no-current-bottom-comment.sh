#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-no-current-bottom-comment.XXXXXX")"
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
sys.path.insert(0, 'packages/mergify-admin-requeue')
from mergify_admin_requeue.model import load_mergify_rules
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
            "body": "## Summary\n\nExternal dependency blocker repro.\n",
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
            "number": 7001,
            "title": "Prerequisite split still open",
            "body": "## Summary\n\nExternal owner of the stale base branch.\n",
            "url": "https://github.com/fake/repo/pull/7001",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "pr/babysit-prereq-split",
            "headRefOid": "3333333333333333333333333333333333333333",
            "mergeStateStatus": "CLEAN",
            "mergeable": "MERGEABLE",
            "labels": [],
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
            "labels": [],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        },
    ],
    "issue_comments": {
        "5885": [stack_comment],
        "5886": [dict(stack_comment, html_url="https://github.com/fake/repo/pull/5886#stack")],
        "7001": [],
        "7002": [],
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
: > "$LEDGER_PATH"

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5886 2>&1
}

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed' "$out1"
fi
if ! out2="$(run_worker)"; then
  fail 'tick 2: worker failed' "$out2"
fi

python3 - <<'PY' || fail 'expected one external-open-base comment on root only' "$(cat "$STATE_PATH")"
import json
import os
from pathlib import Path

state = json.loads(Path(os.environ["STATE_PATH"]).read_text(encoding="utf-8"))
comments = [
    comment for comment in state.get("issue_comments", {}).get("5885", [])
    if str(comment.get("body", "")).startswith("Mergify repair stopped:")
]
if len(comments) != 1:
    raise SystemExit(f"expected 1 blocker comment on #5885, saw {len(comments)}")
body = comments[0].get("body", "")
expected = "lowest open stack PR #5885 is based on `pr/babysit-prereq-split`, which still belongs to open PR(s) #7001 outside this stack"
if expected not in body:
    raise SystemExit(body)
for number in (5886, 7001, 7002):
    blocker_comments = [
        comment for comment in state.get("issue_comments", {}).get(str(number), [])
        if str(comment.get("body", "")).startswith("Mergify repair stopped:")
    ]
    if blocker_comments:
        raise SystemExit(f"unexpected blocker comment on #{number}")
if next(pr for pr in state["prs"] if pr["number"] == 5885)["baseRefName"] != "pr/babysit-prereq-split":
    raise SystemExit("root base changed unexpectedly")
PY

python3 - <<'PY' || fail 'expected one external-open-base ledger row' "$(cat "$LEDGER_PATH")"
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
    if row.get("kind") == "comment-blocked"
    and row.get("key") == "external-open-base-pr"
    and int(row.get("pr", 0)) == 5885
]
if len(matches) != 1:
    raise SystemExit(f"expected 1 matching row, saw {len(matches)}")
PY

! grep -q 'gh api --method PATCH repos/fake/repo/pulls/5885 -f base=master' "$CALLS_PATH" || fail 'saw unexpected base retarget PATCH' "$(cat "$CALLS_PATH")"
echo "$out1$out2" | grep -q 'external-open-base-pr' || fail 'worker output did not name the external dependency blocker' "$out1$out2"
echo "$out1$out2" | grep -q '#7001' || fail 'worker output did not name the external owner PR' "$out1$out2"

echo '[repro] passed'
