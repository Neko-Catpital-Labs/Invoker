#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-queue-repair-invalid-stop.XXXXXX")"
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

HEAD="5a71947f46f2190a5a53bf2e4ff6e44688cc6aa2"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
EXACT_REASON='merge-queue run failed outside the PR head: `required-fast / Vitest Workspace`: `scripts/test-land-stack-skill.sh: line 24: rg: command not found`; `required-fast / Vitest Workspace`: `playwright install-deps chromium` tried to use sudo without a password. Current PR head `UI Vitest` is green; fix queue CI runner/tooling outside this PR and requeue.'
export HEAD STATE_PATH LEDGER_PATH EXACT_REASON

python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["HEAD"]
reason = os.environ["EXACT_REASON"]
state = {
    "prs": [
        {
            "number": 5873,
            "title": "Route owner-serve through web surface startup",
            "body": "## Summary\n\nQueue repair-invalid repro.\n",
            "url": "https://github.com/fake/repo/pull/5873",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "pr/owner-serve-web-surface",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass", "dequeued"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS", "UI Vitest": "SUCCESS"},
        }
    ],
    "issue_comments": {
        "5873": [
            {
                "id": "5083062006",
                "user": {"login": "mergify[bot]"},
                "updated_at": "2026-07-26T10:30:00Z",
                "html_url": "https://github.com/fake/repo/pull/5873#issuecomment-5083062006",
                "body": (
                    "-*- Mergify Payload -*-\n"
                    "{\"state\":\"dequeued\",\"queue_rule_name\":\"admin-bypass\"}\n\n"
                    f"- Left the queue at `{head}`\n\n"
                    "## Waiting for\n\n"
                    "- UI Vitest\n\n"
                    "## Failing checks\n\n"
                    "- [UI Vitest](https://github.com/fake/repo/actions/runs/1/job/2)\n"
                ),
            }
        ]
    },
    "job_logs": {"2": "merge queue failed elsewhere\n"},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
rows = [
    {
        "epoch": 1785062162,
        "headSha": head,
        "key": "UI Vitest",
        "kind": "repair-invalid",
        "meta": {"errors": [reason]},
        "pr": 5873,
    },
    {
        "epoch": 1785062162,
        "headSha": head,
        "key": f"repair-invalid:UI Vitest:{head}",
        "kind": "comment-blocked",
        "pr": 5873,
    },
]
Path(os.environ["LEDGER_PATH"]).write_text(
    "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
    encoding="utf-8",
)
PY

if ! out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5873 2>&1)"; then
  fail 'targeted worker dry-run failed' "$out"
fi

! echo "$out" | grep -q 'repair-check PR #5873' || fail 'repair-invalid queue failure retried repair' "$out"
! echo "$out" | grep -q 'requeue PR #5873' || fail 'repair-invalid queue failure was blindly requeued' "$out"
echo "$out" | grep -q 'blocked-needs-human' || fail 'repair-invalid queue failure did not become terminal human blocker' "$out"
echo "$out" | grep -q 'fix queue CI runner/tooling outside this PR and requeue' || fail 'exact human-only reason was not preserved' "$out"

echo '[repro] passed'
