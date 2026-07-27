#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-stack-human-blocker-suppresses-repairs.XXXXXX")"
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
BOTTOM_HEAD="fa0ad02f916d680ee8a2ba819408ea2b1cec828a"
TOP_HEAD="d6c8ef581dd3e757c1864c6eefbedb0d08c1233e"
BOTTOM_REASON='PR body Review Unit "routing" cannot ship with activation-surface files in the same PR. Split this into one Review Unit per PR.'
TOP_REASON='Review lane docs cannot ship with product-test files in the same PR. Keep docs and skill updates in their own slice.'
export STATE_PATH LEDGER_PATH BOTTOM_HEAD TOP_HEAD BOTTOM_REASON TOP_REASON

python3 - <<'PY'
import json
import os
from pathlib import Path

bottom_head = os.environ["BOTTOM_HEAD"]
top_head = os.environ["TOP_HEAD"]
bottom_reason = os.environ["BOTTOM_REASON"]
top_reason = os.environ["TOP_REASON"]
state = {
    "prs": [
        {
            "number": 6158,
            "title": "[Workflow Base Branch](1) Pin persisted workflow base branch to master",
            "body": "## Summary\n\nPin persisted workflow base branch to master.\n",
            "url": "https://github.com/fake/repo/pull/6158",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/workflow-base-branch-1",
            "headRefOid": bottom_head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [
                {
                    "id": "PRRT_kwDOSFkSDM6T97v9",
                    "isResolved": False,
                    "comments": {
                        "nodes": [
                            {
                                "author": {"login": "coderabbitai[bot]"},
                                "body": "Please split the mixed review unit.",
                                "url": "https://github.com/fake/repo/pull/6158#discussion_r1",
                            }
                        ]
                    },
                }
            ],
            "checks": {"*": "SUCCESS"},
        },
        {
            "number": 6163,
            "title": "[Workflow Base Branch](6) Document remote-aware workflow base refs",
            "body": "## Summary\n\nDocument remote-aware workflow base refs.\n",
            "url": "https://github.com/fake/repo/pull/6163",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "stack/workflow-base-branch-1",
            "headRefName": "stack/workflow-base-branch-6",
            "headRefOid": top_head,
            "mergeStateStatus": "UNSTABLE",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {
                "*": "SUCCESS",
                "UI Vitest": "FAILURE",
                "quality / TypeScript Types": "FAILURE",
            },
        },
    ],
    "issue_comments": {
        "6158": [
            {
                "id": "fake-comment-bottom",
                "user": {"login": "EdbertChan"},
                "updated_at": "2026-07-27T10:05:03Z",
                "html_url": "https://github.com/fake/repo/pull/6158#issuecomment-1",
                "body": f"Mergify repair stopped: {bottom_reason}",
            }
        ],
        "6163": [
            {
                "id": "fake-comment-top",
                "user": {"login": "EdbertChan"},
                "updated_at": "2026-07-27T09:31:08Z",
                "html_url": "https://github.com/fake/repo/pull/6163#issuecomment-1",
                "body": f"Mergify repair stopped: {top_reason}",
            }
        ],
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
rows = [
    {
        "epoch": 1785145266,
        "headSha": bottom_head,
        "key": "PRRT_kwDOSFkSDM6T97v9",
        "kind": "repair-bot-thread",
        "pr": 6158,
    },
    {
        "epoch": 1785145266,
        "headSha": bottom_head,
        "key": "PRRT_kwDOSFkSDM6T97v9",
        "kind": "repair-invalid",
        "meta": {"errors": [bottom_reason]},
        "pr": 6158,
    },
    {
        "epoch": 1785145266,
        "headSha": bottom_head,
        "key": f"repair-invalid:PRRT_kwDOSFkSDM6T97v9:{bottom_head}",
        "kind": "comment-blocked",
        "pr": 6158,
    },
    {
        "epoch": 1785144350,
        "headSha": top_head,
        "key": "UI Vitest",
        "kind": "repair-invalid",
        "meta": {"errors": [top_reason]},
        "pr": 6163,
    },
    {
        "epoch": 1785144350,
        "headSha": top_head,
        "key": f"repair-invalid:UI Vitest:{top_head}",
        "kind": "comment-blocked",
        "pr": 6163,
    },
]
Path(os.environ["LEDGER_PATH"]).write_text(
    "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
    encoding="utf-8",
)
PY

if ! out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6158 2>&1)"; then
  fail 'targeted worker dry-run failed' "$out"
fi

! echo "$out" | grep -q 'repair-check PR #6158' || fail 'bottom repair-invalid bot thread retried repair' "$out"
! echo "$out" | grep -q 'repair-check PR #6163' || fail 'upper human-decision PR retried a separate failed check' "$out"
echo "$out" | grep -q '"reason": "blocked-needs-human"' || fail 'stack did not settle into blocked-needs-human wait state' "$out"
echo "$out" | grep -q "$TOP_REASON" || fail 'top exact human-only reason was not preserved' "$out"
echo "$out" | grep -q 'activation-surface files in the same PR' || fail 'bottom exact human-only reason was not preserved' "$out"

echo '[repro] passed'
