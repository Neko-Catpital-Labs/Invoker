#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-dequeued-restores-admin-bypass-label.XXXXXX")"
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
HEAD_SHA="f4818fdc2cf260a096d50c8021ae5e1f004bff24"
export STATE_PATH HEAD_SHA

python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["HEAD_SHA"]
state = {
    "prs": [
        {
            "number": 6412,
            "title": "[Planning terminal continuity repair](1) Preserve planning chat continuity",
            "body": "## Summary\n\nDequeued missing-label repro.\n",
            "url": "https://github.com/fake/repo/pull/6412",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/6412",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["dequeued"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {
        "6412": [
            {
                "id": "m6412",
                "user": {"login": "mergify[bot]"},
                "updated_at": "2026-07-31T05:00:00Z",
                "html_url": "https://github.com/fake/repo/pull/6412#m6412",
                "body": (
                    "-*- Mergify Payload -*-\n"
                    "{\"state\":\"dequeued\",\"queue_rule_name\":\"admin-bypass\"}\n\n"
                    "- ❌ **Checks failed** · on draft #6419\n"
                    f"- 🚫 **Left the queue** — `2026-07-31 05:00 UTC` · at `{head}`\n\n"
                    "## Waiting for\n\n"
                    "- PR Body\n"
                    "- UI Vitest\n"
                ),
            }
        ]
    },
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY

if ! out="$(python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6412 2>&1)"; then
  fail "worker failed" "$out"
fi
printf '%s\n' "$out"

echo "$out" | grep -q "restore-admin-bypass-label PR #6412" \
  || fail "worker did not restore admin-bypass label" "$out"
! echo "$out" | grep -q "comment-admin-bypass-nudge PR #6412" \
  || fail "worker still asked a human to restore the label" "$out"
grep -q '"kind": "restore-admin-bypass-label".*"pr": 6412' "$LEDGER_PATH" \
  || fail "restore label ledger row missing" "$(cat "$LEDGER_PATH")"

python3 - <<'PY'
import json
import os
from pathlib import Path

state = json.loads(Path(os.environ["STATE_PATH"]).read_text(encoding="utf-8"))
labels = set(state["prs"][0]["labels"])
if "admin-bypass" not in labels:
    raise SystemExit("admin-bypass label was not restored")
comments = state.get("issue_comments", {}).get("6412", [])
if any("babysitting is paused" in str(comment.get("body", "")) for comment in comments):
    raise SystemExit("unexpected human nudge comment")
PY

echo "[repro] passed"
