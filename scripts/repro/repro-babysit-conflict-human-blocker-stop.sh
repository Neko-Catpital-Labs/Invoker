#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-conflict-human-blocker-stop.XXXXXX")"
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
HEAD="fed0e18de54f02b3ebd006a12ca3f2046dede28d"
EXACT_REASON='PR #6118 ("[Workflow Base Branch](1) Pin persisted workflow base branch to master") is a duplicate bottom PR of an earlier, already-partially-merged stack, and already-merged PR #6161 deliberately preserves explicit workflow base refs instead of pinning every base branch to master. Resolving this requires a human to decide whether to keep #6118 or treat it as superseded, not a mechanical rebase.'
export STATE_PATH LEDGER_PATH HEAD EXACT_REASON

python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["HEAD"]
reason = os.environ["EXACT_REASON"]
state = {
    "prs": [
        {
            "number": 6118,
            "title": "[Workflow Base Branch](1) Pin persisted workflow base branch to master",
            "body": "## Summary\n\nPin persisted workflow base branch to master.\n",
            "url": "https://github.com/fake/repo/pull/6118",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/base-branch-master-docs-1",
            "headRefOid": head,
            "mergeStateStatus": "DIRTY",
            "mergeable": "CONFLICTING",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {
        "6118": [
            {
                "id": "exact-human-blocker",
                "user": {"login": "EdbertChan"},
                "updated_at": "2026-07-28T09:43:27Z",
                "html_url": "https://github.com/fake/repo/pull/6118#issuecomment-1",
                "body": f"Mergify repair stopped: {reason}",
            },
            {
                "id": "generic-cap",
                "user": {"login": "EdbertChan"},
                "updated_at": "2026-07-28T10:18:14Z",
                "html_url": "https://github.com/fake/repo/pull/6118#issuecomment-2",
                "body": f"Mergify repair stopped: GitHub reports merge conflict. The retry cap was reached for current head {head}.",
            },
        ],
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
rows = []
for epoch in (1785230434, 1785231704, 1785233030):
    rows.append({
        "epoch": epoch,
        "headSha": head,
        "key": "conflict:6118",
        "kind": "conflict-repair",
        "pr": 6118,
    })
rows.extend([
    {
        "epoch": 1785231704,
        "headSha": head,
        "key": "conflict",
        "kind": "repair-evaluated",
        "pr": 6118,
    },
    {
        "epoch": 1785231704,
        "headSha": head,
        "key": "conflict",
        "kind": "repair-invalid",
        "meta": {"errors": [reason]},
        "pr": 6118,
    },
    {
        "epoch": 1785231704,
        "headSha": head,
        "key": f"repair-invalid:conflict:{head}",
        "kind": "comment-blocked",
        "pr": 6118,
    },
])
Path(os.environ["LEDGER_PATH"]).write_text(
    "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
    encoding="utf-8",
)
PY

if ! out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6118 2>&1)"; then
  fail 'targeted worker dry-run failed' "$out"
fi

! echo "$out" | grep -q 'repair-conflict PR #6118' || fail 'conflict human blocker retried conflict repair' "$out"
! echo "$out" | grep -q 'retry cap was reached' || fail 'conflict human blocker fell back to generic retry cap' "$out"
echo "$out" | grep -q '"reason": "blocked-needs-human"' || fail 'dirty conflict did not settle into blocked-needs-human wait state' "$out"
echo "$out" | grep -q 'already-merged PR #6161 deliberately preserves explicit workflow base refs' || fail 'exact human-only reason was not preserved' "$out"

echo '[repro] passed'
