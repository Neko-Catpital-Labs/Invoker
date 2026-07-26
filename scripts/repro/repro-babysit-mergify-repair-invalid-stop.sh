#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-mergify-repair-invalid-stop.XXXXXX")"
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
sys.path.insert(0, "scripts")
from mergify_admin_requeue_model import load_mergify_rules
_trunk, _labels, required = load_mergify_rules(Path(".mergify.yml"))
print("\n".join(sorted(required)))
PY
)"
export FAKE_GH_REQUIRED_CHECKS

HEAD_SHA="5a71947f46f2190a5a53bf2e4ff6e44688cc6aa2"
LEDGER_PATH="$TMP/ledger.jsonl"
export HEAD_SHA
export LEDGER_PATH

python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["HEAD_SHA"]
state = {
    "prs": [
        {
            "number": 5873,
            "title": "Route owner-serve through web surface startup",
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
                "id": "m5873",
                "user": {"login": "mergify[bot]"},
                "updated_at": "2026-07-26T10:20:52Z",
                "html_url": "https://github.com/fake/repo/pull/5873#m5873",
                "body": "\n".join([
                    "<!---",
                    "-*- Mergify Payload -*-",
                    "{\"version\":1,\"state\":\"dequeued\",\"queue_rule_name\":\"admin-bypass\"}",
                    "-*- Mergify Payload End -*-",
                    "-->",
                    "",
                    "# Merge Queue Status",
                    "",
                    f"- Left the queue at `{head}`",
                    "",
                    "## Reason",
                    "",
                    "The merge conditions cannot be satisfied due to failing checks",
                    "",
                    "- `UI Vitest`",
                    "",
                    "Failing checks:",
                    "- [UI Vitest](https://github.com/fake/repo/actions/runs/1/job/2)",
                ]),
            }
        ]
    },
    "job_logs": {"2": ""},
}
Path(os.environ["FAKE_GH_STATE_DIR"], "state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")

rows = [
    {
        "kind": "repair-invalid",
        "pr": 5873,
        "headSha": head,
        "key": "UI Vitest",
        "epoch": 1,
        "meta": {
            "errors": [
                "merge-queue run failed outside the PR head: `required-fast / Vitest Workspace`: `scripts/test-land-stack-skill.sh: line 24: rg: command not found`; `required-fast / Vitest Workspace`: `playwright install-deps chromium` tried to use sudo without a password. Current PR head `UI Vitest` is green; fix queue CI runner/tooling outside this PR and requeue."
            ]
        },
    },
    {
        "kind": "comment-blocked",
        "pr": 5873,
        "headSha": head,
        "key": f"repair-invalid:UI Vitest:{head}",
        "epoch": 1,
    },
]
Path(os.environ["LEDGER_PATH"]).write_text("\n".join(json.dumps(row, sort_keys=True) for row in rows) + "\n", encoding="utf-8")
PY

: > "$FAKE_GH_STATE_DIR/calls.log"
if ! out="$(python3 scripts/mergify_admin_requeue.py --once --dry-run --repo fake/repo --author fake-bot --state-file "$LEDGER_PATH" --pr 5873 2>&1)"; then
  fail "worker dry-run failed" "$out"
fi
printf '%s\n' "$out"

case "$out" in
  *'repair-check PR #5873'*) fail "worker retried terminal repair-invalid queue failure" "$out" ;;
esac
case "$out" in
  *'requeue PR #5873'*) fail "worker requeued terminal repair-invalid queue failure" "$out" ;;
esac
case "$out" in
  *'"reason": "blocked-needs-human"'*) ;;
  *) fail "worker did not surface blocked-needs-human wait state" "$out" ;;
esac
case "$out" in
  *'"kind": "human_decision"'*'fix queue CI runner/tooling outside this PR and requeue.'*) ;;
  *) fail "worker did not preserve the exact human-only blocker detail" "$out" ;;
esac

if grep -Eq "^gh (pr comment|api --method)" "$FAKE_GH_STATE_DIR/calls.log"; then
  fail "dry-run performed a mutating gh call" "$(cat "$FAKE_GH_STATE_DIR/calls.log")"
fi

echo "[repro] passed"
