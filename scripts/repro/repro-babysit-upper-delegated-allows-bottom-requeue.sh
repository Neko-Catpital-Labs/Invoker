#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-upper-delegated-allows-bottom-requeue.XXXXXX")"
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
BOTTOM_HEAD="9c2b39e95bc46874c5d3d53441f79e9d773315c6"
STALE_QUEUE_HEAD="bde6dce5851af9d99d7752d033c1e3d52d1aa36c"
UPPER_HEAD="b6a340bf61b861a2a8eab7502789cc9486296cea"
BOTTOM_BRANCH="stack/EdbertChan/pr/ui-task-state-reconciliation-v2/add-authoritative-task-gap-recovery--24f0fbd0"
UPPER_BRANCH="stack/EdbertChan/pr/ui-task-state-reconciliation-v2/keep-detached-task-feed-gaps-visible--e92d6d64"
export STATE_PATH LEDGER_PATH BOTTOM_HEAD STALE_QUEUE_HEAD UPPER_HEAD BOTTOM_BRANCH UPPER_BRANCH

python3 - <<'PY'
import json
import os
from pathlib import Path

bottom_head = os.environ["BOTTOM_HEAD"]
stale_queue_head = os.environ["STALE_QUEUE_HEAD"]
upper_head = os.environ["UPPER_HEAD"]
bottom_branch = os.environ["BOTTOM_BRANCH"]
upper_branch = os.environ["UPPER_BRANCH"]
state = {
    "prs": [
        {
            "number": 6825,
            "title": "[UI Task State](3) Add authoritative task gap recovery",
            "body": "## Summary\n\nReady bottom PR.\n",
            "url": "https://github.com/fake/repo/pull/6825",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": bottom_branch,
            "headRefOid": bottom_head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        },
        {
            "number": 6826,
            "title": "[UI Task State](4) Keep detached task feed gaps visible",
            "body": "## Summary\n\nUpper PR has an in-flight conflict repair.\n",
            "url": "https://github.com/fake/repo/pull/6826",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": bottom_branch,
            "headRefName": upper_branch,
            "headRefOid": upper_head,
            "mergeStateStatus": "DIRTY",
            "mergeable": "CONFLICTING",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        },
    ],
    "issue_comments": {
        "6825": [
            {
                "id": "m6825",
                "user": {"login": "mergify"},
                "updated_at": "2026-07-31T05:00:43Z",
                "html_url": "https://github.com/fake/repo/pull/6825#issuecomment-1",
                "body": (
                    "<!---\nDO NOT EDIT\n-*- Mergify Payload -*-\n"
                    "{\"version\":1,\"state\":\"dequeued\",\"queue_rule_name\":\"admin-bypass\","
                    "\"queued_at\":\"2026-07-31T05:00:23.808579+00:00\"}\n"
                    "-*- Mergify Payload End -*-\n-->\n\n"
                    "Left the queue at `" + stale_queue_head + "`.\n\n"
                    "Reason: The merge conditions cannot be satisfied due to failing checks\n"
                ),
            }
        ],
        "6826": [],
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
Path(os.environ["LEDGER_PATH"]).write_text(
    json.dumps(
        {
            "epoch": 1785475984,
            "headSha": upper_head,
            "key": "conflict:6826",
            "kind": "repair-delegated",
            "pr": 6826,
        },
        sort_keys=True,
    )
    + "\n",
    encoding="utf-8",
)
PY

if ! out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6825 2>&1)"; then
  fail 'targeted worker dry-run failed' "$out"
fi

echo "$out" | grep -q 'DRY-RUN requeue PR #6825' \
  || fail 'ready bottom PR was not requeued while upper repair was delegated' "$out"
! echo "$out" | grep -q '"reason": "repair-delegated"' \
  || fail 'upper delegated repair still vetoed bottom progress' "$out"
! echo "$out" | grep -q 'DRY-RUN repair-conflict PR #6826' \
  || fail 'upper delegated conflict repair was retried' "$out"

echo '[repro] passed'
