#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-outdated-human-thread-queued.XXXXXX")"
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

head = "931e895dd343de2646a6d9aec1b83543710a7e5e"
state = {
    "prs": [
        {
            "number": 5885,
            "title": "Tighten Slack repo routing",
            "body": "## Summary\n\nOutdated human review thread while queued.\n",
            "url": "https://github.com/fake/repo/pull/5885",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/slack-routing-1",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass", "queued"],
            "reviewThreads": [
                {
                    "id": "PRRT_kwDOSFkSDM6T5EJA",
                    "isResolved": False,
                    "isOutdated": True,
                    "comments": {
                        "nodes": [
                            {
                                "author": {"login": "github-advanced-security"},
                                "body": "CodeQL warning on an old diff.",
                                "url": "https://github.com/fake/repo/pull/5885#discussion_r3653405560",
                            }
                        ]
                    },
                }
            ],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {
        "5885": [
            {
                "id": "m5885-checking",
                "user": {"login": "mergify"},
                "updated_at": "2026-07-26T23:12:57Z",
                "html_url": "https://github.com/fake/repo/pull/5885#m5885-checking",
                "body": (
                    "<!---\n"
                    "DO NOT EDIT\n"
                    "-*- Mergify Payload -*-\n"
                    '{"version":1,"state":"checking","queue_rule_name":"admin-bypass","queued_at":"2026-07-26T23:12:56Z","speculative_check_pr":5997}\n'
                    "-*- Mergify Payload End -*-\n"
                    "-->\n\n"
                    "# Merge Queue Status\n\n"
                    "- Entered queue -- `2026-07-26 23:12 UTC` Rule: `admin-bypass`\n"
                    "- Checks running -- on draft #5997\n\n"
                    "<details>\n<summary>All merge conditions</summary>\n\n"
                    "- [ ] `check-success = PR Body`\n"
                    "- `#review-threads-unresolved = 0`\n"
                    "  - [X] #5885\n"
                    "- [X] `check-success = UI Vitest`\n"
                    "- [X] `check-success = build-artifacts`\n"
                    "- [X] `check-success = quality / Dependency Cruise`\n"
                    "- [X] `check-success = quality / TypeScript Types`\n"
                    "- [X] `check-success = required-fast / Guardrails`\n"
                    "- [X] `check-success = required-fast / Submit Workflow Chain`\n"
                    "</details>\n"
                ),
            }
        ]
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY

if ! out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5885 2>&1)"; then
  fail "worker dry-run failed" "$out"
fi
printf '%s\n' "$out"

! echo "$out" | grep -q 'human-review-thread' \
  || fail "worker treated an outdated human review thread as a live blocker" "$out"
echo "$out" | grep -q '"reason": "bottom-already-queued"' \
  || fail "worker did not wait on the active queue state" "$out"

echo "[repro] passed"
