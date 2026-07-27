#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-merged-pr-terminal.XXXXXX")"
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
CALLS_PATH="$FAKE_GH_STATE_DIR/calls.log"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH LEDGER_PATH

python3 - <<'PY'
import json
import os
from pathlib import Path

head = "d01530d99b371fe79180cb9481007243bd808f93"
state = {
    "prs": [
        {
            "number": 6108,
            "title": "Merged admin-bypass target",
            "body": "## Summary\n\nMerged PR repro.\n",
            "url": "https://github.com/fake/repo/pull/6108",
            "state": "MERGED",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/6108",
            "headRefOid": head,
            "mergeStateStatus": "UNKNOWN",
            "mergeable": "UNKNOWN",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {
        "6108": [
            {
                "id": "m6108",
                "user": {"login": "mergify"},
                "updated_at": "2026-07-27T06:05:00Z",
                "html_url": "https://github.com/fake/repo/pull/6108#m6108",
                "body": "-*- Mergify Payload -*-\n{\"state\":\"merged\",\"queue_rule_name\":\"admin-bypass\"}\n-*- Mergify Payload End -*-\nMerged at `" + head + "`.",
            }
        ]
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
: > "$LEDGER_PATH"
: > "$CALLS_PATH"

if ! out="$(python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6108 2>&1)"; then
  fail 'worker failed' "$out"
fi
case "$out" in
  *'BLOCK PR #6108 state=MERGED'*) fail 'worker blocked an already merged PR' "$out" ;;
esac
if grep -q '^gh pr comment 6108 ' "$CALLS_PATH"; then
  fail 'worker commented on an already merged PR' "$(cat "$CALLS_PATH")"
fi
if [ -s "$LEDGER_PATH" ]; then
  fail 'worker recorded a retry/blocker row for an already merged PR' "$(cat "$LEDGER_PATH")"
fi

echo '[repro] passed'
