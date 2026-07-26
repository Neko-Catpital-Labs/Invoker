#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-targeted-scan-light.XXXXXX")"
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
CALLS_PATH="$FAKE_GH_STATE_DIR/calls.log"
LEDGER_PATH="$TMP/ledger.jsonl"
export HEAD STATE_PATH

python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["HEAD"]
state = {
    "prs": [
        {
            "number": 5873,
            "title": "Route owner-serve through web surface startup",
            "body": "## Summary\n\nTargeted scan repro.\n",
            "url": "https://github.com/fake/repo/pull/5873",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "pr/owner-serve-web-surface",
            "headRefOid": head,
            "mergeStateStatus": "CLEAN",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {"5873": []},
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
: > "$CALLS_PATH"

if ! out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5873 2>&1)"; then
  fail 'targeted worker dry-run failed' "$out"
fi

echo "$out" | grep -q 'DRY-RUN requeue PR #5873' || fail 'targeted run did not reach a worker decision' "$out"
if grep '^gh pr list ' "$CALLS_PATH" | grep -q 'statusCheckRollup'; then
  fail 'targeted scan used heavy all-open statusCheckRollup list' "$(cat "$CALLS_PATH")"
fi
grep '^gh api graphql ' "$CALLS_PATH" | grep -q 'number=5873' || fail 'targeted run did not fetch the requested PR detail' "$(cat "$CALLS_PATH")"

echo '[repro] passed'
