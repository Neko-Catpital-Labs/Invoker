#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-requeue-command-inflight.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- detail -----" >&2
    echo "$2" >&2
  fi
  exit 1
}

mkdir -p "$TMP/state"
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
export STATE_PATH

python3 - <<'PY'
import json
import os
from pathlib import Path

head = "4447a3cc6630fef86af07b1e355eced862ca96a3"
state = {
    "prs": [
        {
            "number": 6315,
            "title": "Dequeued bottom PR awaiting Mergify acknowledgement",
            "body": "## Summary\n\nQueued command delay repro.\n",
            "url": "https://github.com/fake/repo/pull/6315",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/6315",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {
        "6315": [
            {
                "id": "m6315-dequeued",
                "user": {"login": "mergify"},
                "updated_at": "2026-07-19T00:00:00Z",
                "html_url": "https://github.com/fake/repo/pull/6315#m6315-dequeued",
                "body": (
                    "<!---\n"
                    "DO NOT EDIT\n"
                    "-*- Mergify Payload -*-\n"
                    '{"version":1,"state":"dequeued","queue_rule_name":"admin-bypass"}\n'
                    "-*- Mergify Payload End -*-\n"
                    "-->\n\n"
                    "# Merge Queue Status\n\n"
                    "- ✅ **Entered queue** — `2026-07-19 00:00 UTC` · Rule: `admin-bypass`\n"
                    f"- 🚫 **Left the queue** — `2026-07-19 00:01 UTC` · at `{head}`\n\n"
                    "## Reason\n\n"
                    "The pull request conflicts with the base branch\n"
                ),
            }
        ]
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY

if ! first="$(python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6315 2>&1)"; then
  fail "first worker run failed" "$first"
fi
printf '%s\n' "$first"
echo "$first" | grep -q 'requeue PR #6315 head=4447a3cc6630fef86af07b1e355eced862ca96a3 reason=eligible-after-dequeue' \
  || fail "first worker run did not post the expected requeue" "$first"

if ! second="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6315 2>&1)"; then
  fail "second worker dry-run failed" "$second"
fi
printf '%s\n' "$second"

! echo "$second" | grep -q 'DRY-RUN requeue PR #6315' \
  || fail "worker planned a duplicate requeue while its queue command was in flight" "$second"
echo "$second" | grep -q '"reason": "bottom-already-queued"' \
  || fail "worker did not wait on the in-flight queue command" "$second"

comment_count="$(grep -c '^gh pr comment 6315 ' "$FAKE_GH_STATE_DIR/calls.log" || true)"
[ "$comment_count" = "1" ] \
  || fail "expected exactly one queue command, got $comment_count" "$(cat "$FAKE_GH_STATE_DIR/calls.log")"

echo "[repro] passed"
