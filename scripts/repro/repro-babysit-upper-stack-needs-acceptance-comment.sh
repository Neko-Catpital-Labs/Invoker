#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-upper-stack-needs-acceptance-comment.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- detail -----" >&2
    echo "$2" >&2
  fi
  exit 1
}

contains_output() {
  local needle="$1"
  local haystack="$2"
  grep -Fq -- "$needle" <<<"$haystack"
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
BOTTOM_HEAD="64f62b48b0d4cda7d96e41a15bde509db4940b2a"
UPPER_HEAD="09014c13dd772ceb22fd4f5e7771ea7ac8c83c78"
OLD_QUEUE_HEAD="c1ae3d7b5826c62bdf00af9a5443aa8676f9152a"
BOTTOM_BRANCH="experiment/wf-1785055720707-2/fix-planning-session-persistence-hot-path/g13.t22.a-aafe2ee02-c9d0cbac"
UPPER_BRANCH="experiment/wf-1785055720707-2/gate-planning-send-responsiveness/g13.t22.a-a5074fabe-858826b7"
BLOCKER_COMMENT="Mergify repair stopped: PR #6435 is ready to land, but upper stack PR(s) #6439 are open without \`admin-bypass\`; a human must decide whether to include them in the admin-bypass landing stack or land them separately."
export STATE_PATH LEDGER_PATH BOTTOM_HEAD UPPER_HEAD OLD_QUEUE_HEAD BOTTOM_BRANCH UPPER_BRANCH BLOCKER_COMMENT

python3 - <<'PY'
import json
import os
from pathlib import Path

bottom_head = os.environ["BOTTOM_HEAD"]
upper_head = os.environ["UPPER_HEAD"]
old_queue_head = os.environ["OLD_QUEUE_HEAD"]
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
            "headRefOid": bottom_head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
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
            "mergeStateStatus": "CLEAN",
            "mergeable": "MERGEABLE",
            "labels": [],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        },
    ],
    "issue_comments": {
        "6435": [
            {
                "id": "old-dequeue",
                "user": {"login": "mergify"},
                "updated_at": "2026-07-28T17:46:11Z",
                "html_url": "https://github.com/fake/repo/pull/6435#issuecomment-1",
                "body": (
                    "-*- Mergify Payload -*-\n"
                    "{\"version\":1,\"state\":\"dequeued\",\"queue_rule_name\":\"admin-bypass\"}\n\n"
                    f"Left the queue at `{old_queue_head}`.\n"
                ),
            }
        ],
        "6439": [],
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
Path(os.environ["LEDGER_PATH"]).write_text("", encoding="utf-8")
PY

blocker_comment_count() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
state = json.loads(Path(os.environ["STATE_PATH"]).read_text(encoding="utf-8"))
needle = os.environ["BLOCKER_COMMENT"]
print(sum(1 for comment in state["issue_comments"]["6435"] if comment.get("body") == needle))
PY
}

if ! dry_out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6435 2>&1)"; then
  fail 'worker dry-run failed' "$dry_out"
fi

contains_output 'BLOCK PR #6435' "$dry_out" || fail 'worker did not surface upper-stack blocker' "$dry_out"
contains_output '#6439 are open without `admin-bypass`' "$dry_out" || fail 'exact upper-stack blocker reason missing' "$dry_out"
if contains_output 'DRY-RUN requeue PR #6435' "$dry_out"; then
  fail 'worker requeued despite unaccepted upper PR' "$dry_out"
fi

if ! real_out="$(python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6435 2>&1)"; then
  fail 'worker comment run failed' "$real_out"
fi

comment_count="$(blocker_comment_count)"
[ "$comment_count" = "1" ] || fail "expected one exact blocker comment, got $comment_count" "$(cat "$STATE_PATH")"
state_after_first="$(cat "$STATE_PATH")"
ledger_after_first="$(cat "$LEDGER_PATH")"

if ! repeat_real_out="$(python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6435 2>&1)"; then
  fail 'repeat comment run failed' "$repeat_real_out"
fi

repeat_comment_count="$(blocker_comment_count)"
[ "$repeat_comment_count" = "1" ] || fail "expected repeat real run to keep one exact blocker comment, got $repeat_comment_count" "$(cat "$STATE_PATH")"
[ "$(cat "$STATE_PATH")" = "$state_after_first" ] || fail 'repeat real run changed fake GitHub state' "$(cat "$STATE_PATH")"
[ "$(cat "$LEDGER_PATH")" = "$ledger_after_first" ] || fail 'repeat real run changed ledger state' "$(cat "$LEDGER_PATH")"

if ! repeat_out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6435 2>&1)"; then
  fail 'repeat dry-run failed' "$repeat_out"
fi

if contains_output 'BLOCK PR #6435' "$repeat_out"; then
  fail 'worker repeated upper-stack blocker after ledger record' "$repeat_out"
fi
if contains_output 'DRY-RUN requeue PR #6435' "$repeat_out"; then
  fail 'worker requeued after upper-stack blocker' "$repeat_out"
fi
contains_output '"reason": "upper-stack-needs-acceptance"' "$repeat_out" || fail 'worker did not settle into upper-stack wait' "$repeat_out"

echo '[repro] passed'
