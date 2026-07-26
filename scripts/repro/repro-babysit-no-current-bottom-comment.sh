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
sys.path.insert(0, 'scripts')
from mergify_admin_requeue_model import load_mergify_rules
_trunk, _labels, required = load_mergify_rules(Path('.mergify.yml'))
print('\n'.join(sorted(required)))
PY
)"
export FAKE_GH_REQUIRED_CHECKS

STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH LEDGER_PATH

python3 - <<'PY'
import json
import os
from pathlib import Path

state = {
    "prs": [
        {
            "number": 5885,
            "title": "Tighten Slack repo routing",
            "body": "## Summary\n\nNo current bottom repro.\n",
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
    ],
    "issue_comments": {"5885": [], "5886": []},
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

python3 - <<'PY' || fail 'expected one exact no-current-bottom comment' "$(cat "$STATE_PATH")"
import json
import os
from pathlib import Path

state = json.loads(Path(os.environ["STATE_PATH"]).read_text(encoding="utf-8"))
comments = state.get("issue_comments", {}).get("5885", [])
if len(comments) != 1:
    raise SystemExit(f"expected 1 comment on #5885, saw {len(comments)}")
body = comments[0].get("body", "")
expected = "lowest open stack PR #5885 is based on `pr/babysit-prereq-split`, not `master`; land or retarget that base before babysitting can queue this stack"
if expected not in body:
    raise SystemExit(body)
if state.get("issue_comments", {}).get("5886"):
    raise SystemExit("upper PR received the blocker comment")
PY

python3 - <<'PY' || fail 'expected one no-current-bottom ledger row' "$(cat "$LEDGER_PATH")"
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
    and row.get("key") == "no-current-bottom"
    and int(row.get("pr", 0)) == 5885
]
if len(matches) != 1:
    raise SystemExit(f"expected 1 matching row, saw {len(matches)}")
PY
echo "$out1$out2" | grep -q 'no current bottom on master' || fail 'worker output did not name the blocker' "$out1$out2"

echo '[repro] passed'
