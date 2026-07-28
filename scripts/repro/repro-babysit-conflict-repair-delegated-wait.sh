#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-conflict-repair-delegated-wait.XXXXXX")"
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
HEAD="c1ae3d7b5826c62bdf00af9a5443aa8676f9152a"
UPPER_HEAD="48a8cf4a2d1ba2f7c1c0f233408980ecce46e5ca"
BOTTOM_BRANCH="experiment/wf-1785055720707-2/fix-planning-session-persistence-hot-path/g13.t22.a-aafe2ee02-c9d0cbac"
UPPER_BRANCH="experiment/wf-1785055720707-2/gate-planning-send-responsiveness/g13.t22.a-a5074fabe-858826b7"
export STATE_PATH LEDGER_PATH HEAD UPPER_HEAD BOTTOM_BRANCH UPPER_BRANCH

python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["HEAD"]
upper_head = os.environ["UPPER_HEAD"]
bottom_branch = os.environ["BOTTOM_BRANCH"]
upper_branch = os.environ["UPPER_BRANCH"]
state = {
    "prs": [
        {
            "number": 6435,
            "title": "[Planning Chat Beachball](2) Remove full planning transcript rewrites from send",
            "body": "## Summary\n\nRemove full planning transcript rewrites from send.\n",
            "url": "https://github.com/fake/repo/pull/6435",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": bottom_branch,
            "headRefOid": head,
            "mergeStateStatus": "DIRTY",
            "mergeable": "CONFLICTING",
            "labels": ["admin-bypass", "dequeued"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS", "PR Body": "FAILURE"},
        },
        {
            "number": 6439,
            "title": "[Planning Chat Beachball](3) Gate planning send responsiveness",
            "body": "## Summary\n\nGate planning send responsiveness.\n",
            "url": "https://github.com/fake/repo/pull/6439",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": bottom_branch,
            "headRefName": upper_branch,
            "headRefOid": upper_head,
            "mergeStateStatus": "UNSTABLE",
            "mergeable": "MERGEABLE",
            "labels": [],
            "reviewThreads": [],
            "checks": {"UI Vitest": "PENDING"},
        },
    ],
    "issue_comments": {
        "6435": [
            {
                "id": "mergify-dequeue",
                "user": {"login": "mergify"},
                "updated_at": "2026-07-28T17:46:11Z",
                "html_url": "https://github.com/fake/repo/pull/6435#issuecomment-1",
                "body": (
                    "<!---\nDO NOT EDIT\n-*- Mergify Payload -*-\n"
                    "{\"version\":1,\"state\":\"dequeued\",\"queue_rule_name\":\"admin-bypass\","
                    "\"queued_at\":\"2026-07-28T17:45:51.602557+00:00\"}\n"
                    "-*- Mergify Payload End -*-\n-->\n\n"
                    "Left the queue at `" + head + "`.\n\n"
                    "Reason: The pull request conflicts with the base branch\n"
                ),
            }
        ],
        "6439": [],
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
rows = [
    {"epoch": 1785260977, "headSha": head, "key": "conflict:6435", "kind": "conflict-repair", "pr": 6435},
    {"epoch": 1785261284, "headSha": head, "key": "conflict:6435", "kind": "conflict-repair", "pr": 6435},
    {"epoch": 1785267037, "headSha": head, "key": "conflict:6435", "kind": "conflict-repair", "pr": 6435},
    {"epoch": 1785267037, "headSha": head, "key": "conflict:6435", "kind": "repair-delegated", "pr": 6435},
]
Path(os.environ["LEDGER_PATH"]).write_text(
    "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
    encoding="utf-8",
)
PY

if ! out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6435 2>&1)"; then
  fail 'targeted worker dry-run failed' "$out"
fi

! echo "$out" | grep -q 'repair-conflict PR #6435' || fail 'delegated conflict repair retried repair' "$out"
! echo "$out" | grep -q 'repair-check PR #6435' || fail 'delegated conflict repair fell through to failed-check repair' "$out"
! echo "$out" | grep -q 'BLOCK PR #6435' || fail 'delegated conflict repair emitted a blocker comment' "$out"
! echo "$out" | grep -q 'retry cap was reached' || fail 'delegated conflict repair emitted generic cap' "$out"
echo "$out" | grep -q '"reason": "repair-delegated"' || fail 'delegated conflict repair did not wait' "$out"
echo "$out" | grep -q 'repair already delegated for current head' || fail 'delegated repair evidence was not preserved in summary' "$out"

echo '[repro] passed'
