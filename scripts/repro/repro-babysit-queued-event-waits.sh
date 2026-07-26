#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-queued-event-waits.XXXXXX")"
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

HEAD_SHA="93129761a0259c4a5f375ea4d14b1a062438ca7e"
export HEAD_SHA

python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["HEAD_SHA"]
state = {
    "prs": [
        {
            "number": 5885,
            "title": "Queued bottom PR",
            "url": "https://github.com/fake/repo/pull/5885",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/5885",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass", "queued"],
            "reviewThreads": [
                {
                    "id": "PRRT_kwDOSFkSDM6T5EJA",
                    "isResolved": False,
                    "comments": {
                        "nodes": [
                            {
                                "author": {"login": "github-advanced-security"},
                                "body": "CodeQL / Polynomial regular expression used on uncontrolled data",
                                "url": "https://github.com/fake/repo/pull/5885#discussion_r3653405560",
                            }
                        ]
                    },
                }
            ],
            "checks": {
                "*": "SUCCESS",
                "required-fast / Guardrails": None,
                "required-fast / Submit Workflow Chain": None,
            },
        }
    ],
    "issue_comments": {
        "5885": [
            {
                "id": "m5885",
                "user": {"login": "mergify[bot]"},
                "updated_at": "2026-07-26T20:51:15Z",
                "html_url": "https://github.com/fake/repo/pull/5885#m5885",
                "body": "\n".join([
                    "-*- Mergify Payload -*-",
                    "{\"version\":1,\"state\":\"queued\",\"queue_rule_name\":\"admin-bypass\"}",
                    "-*- Mergify Payload End -*-",
                    "",
                    "# Merge Queue Status",
                    "",
                    "- Queued and checks running on draft #5956",
                    "",
                    "<details>",
                    "<summary><strong>Waiting for</strong></summary>",
                    "",
                    "- [ ] `check-success = required-fast / Guardrails`",
                    "- [ ] `check-success = required-fast / Submit Workflow Chain`",
                    "",
                    "</details>",
                ]),
            }
        ]
    },
}
Path(os.environ["FAKE_GH_STATE_DIR"], "state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
PY

: > "$FAKE_GH_STATE_DIR/calls.log"
if ! out="$(python3 scripts/mergify_admin_requeue.py --once --dry-run --repo fake/repo --state-file "$TMP/ledger.jsonl" --pr 5885 2>&1)"; then
  fail "worker dry-run failed" "$out"
fi
printf '%s\n' "$out"

case "$out" in
  *'BLOCK PR #5885'*) fail "worker posted a blocker while Mergify queue was active" "$out" ;;
esac
case "$out" in
  *'repair-check PR #5885'*|*'requeue PR #5885'*) fail "worker acted while Mergify queue was active" "$out" ;;
esac
case "$out" in
  *'"reason": "bottom-already-queued"'*) ;;
  *) fail "worker did not wait on the active queue event" "$out" ;;
esac

if grep -Eq "^gh (pr comment|api --method)" "$FAKE_GH_STATE_DIR/calls.log"; then
  fail "dry-run performed a mutating gh call" "$(cat "$FAKE_GH_STATE_DIR/calls.log")"
fi

echo "[repro] passed"
