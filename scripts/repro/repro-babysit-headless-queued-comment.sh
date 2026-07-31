#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-headless-queued-comment.XXXXXX")"
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

head = "1605586282a7bccef5c1ea34419a7176ca755dc1"
state = {
    "prs": [
        {
            "number": 5805,
            "title": "Already queued with headless Mergify status and no queued label",
            "body": "## Summary\n\nQueued PR repro.\n",
            "url": "https://github.com/fake/repo/pull/5805",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/5805",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {
        "5805": [
            {
                "id": "m5805-checking",
                "user": {"login": "mergify"},
                "updated_at": "2026-07-26T06:11:39Z",
                "html_url": "https://github.com/fake/repo/pull/5805#m5805-checking",
                "body": (
                    "<!---\n"
                    "DO NOT EDIT\n"
                    "-*- Mergify Payload -*-\n"
                    '{"version":1,"state":"checking","queue_rule_name":"admin-bypass","queued_at":"2026-07-26T06:11:35Z","speculative_check_pr":5862}\n'
                    "-*- Mergify Payload End -*-\n"
                    "-->\n\n"
                    "# Merge Queue Status\n\n"
                    "- ✅ **Entered queue** — `2026-07-26 06:11 UTC` · Rule: `admin-bypass`\n"
                    "- 🟠 **Checks running** · on draft #5862\n\n"
                    "<details>\n<summary><strong>Waiting for</strong></summary>\n\n"
                    "- [ ] `check-success = required-fast / Guardrails`\n\n"
                    "</details>\n"
                ),
            }
        ]
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY

if ! out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5805 2>&1)"; then
  fail "worker dry-run failed" "$out"
fi
printf '%s\n' "$out"

! echo "$out" | grep -q 'DRY-RUN requeue PR #5805' \
  || fail "worker tried to requeue a PR already in Mergify queue" "$out"
echo "$out" | grep -q '"reason": "bottom-already-queued"' \
  || fail "worker did not wait on the active queue state" "$out"

echo "[repro] passed"
