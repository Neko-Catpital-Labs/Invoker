#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-upper-stack-needs-acceptance.XXXXXX")"
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
CALLS_PATH="$FAKE_GH_STATE_DIR/calls.log"
LEDGER_PATH="$TMP/ledger.jsonl"
BOTTOM_HEAD="d3620377b5b7b91690a68beee56130cf53c261c1"
UPPER_HEAD="a404cc402eb77d43f3779f3594c1ee604f7ec090"
export STATE_PATH BOTTOM_HEAD UPPER_HEAD

python3 - <<'PY'
import json
import os
from pathlib import Path

bottom = os.environ['BOTTOM_HEAD']
upper = os.environ['UPPER_HEAD']
state = {
    'prs': [
        {
            'number': 4362,
            'title': 'Route daemon GUI-only actions',
            'body': '## Summary\n\nBottom PR is otherwise green.\n',
            'url': 'https://github.com/fake/repo/pull/4362',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/off-main-ui-mutations-routing',
            'headRefOid': bottom,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass', 'dequeued'],
            'reviewThreads': [],
            'checks': {
                '*': 'SUCCESS',
                'required-fast / Guardrails': None,
            },
        },
        {
            'number': 4363,
            'title': 'Prefer daemon owner in auto mode',
            'body': '## Summary\n\nUpper PR has not been accepted into admin-bypass.\n',
            'url': 'https://github.com/fake/repo/pull/4363',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'stack/off-main-ui-mutations-routing',
            'headRefName': 'stack/off-main-ui-mutations-daemon-default',
            'headRefOid': upper,
            'mergeStateStatus': 'CLEAN',
            'mergeable': 'MERGEABLE',
            'labels': [],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS'},
        },
    ],
    'issue_comments': {
        '4362': [
            {
                'id': 'm4362',
                'user': {'login': 'mergify[bot]'},
                'updated_at': '2026-07-27T03:02:55Z',
                'html_url': 'https://github.com/fake/repo/pull/4362#m4362',
                'body': (
                    '-*- Mergify Payload -*-\n'
                    '{"state":"dequeued","queue_rule_name":"admin-bypass"}\n\n'
                    '- ❌ **Checks failed** · on draft #6065\n'
                    f'- 🚫 **Left the queue** — `2026-07-27 03:02 UTC` · at `{bottom}`\n\n'
                    '## Failing checks\n\n'
                    '- [required-fast / Guardrails](https://github.com/fake/repo/actions/runs/1/job/2)\n'
                ),
            }
        ],
        '4363': [],
    },
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 4362 2>&1
}

: > "$CALLS_PATH"
if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed' "$out1"
fi
printf '%s\n' "$out1"

echo "$out1" | grep -q 'BLOCK PR #4362 upper stack member(s) #4363 (`stack/off-main-ui-mutations-daemon-default`) are open above #4362 without `admin-bypass`' \
  || fail 'tick 1: worker did not print exact upper-stack blocker' "$out1"
comment_calls="$(grep -c '^gh pr comment 4362 ' "$CALLS_PATH" || true)"
[ "$comment_calls" = "1" ] || fail 'tick 1: expected one blocker comment' "$(cat "$CALLS_PATH")"
if ! grep -q '"kind": "comment-blocked"' "$LEDGER_PATH" \
  || ! grep -q '"key": "upper-stack-needs-acceptance"' "$LEDGER_PATH" \
  || ! grep -q '"pr": 4362' "$LEDGER_PATH"; then
  fail 'tick 1: blocker ledger row missing' "$(cat "$LEDGER_PATH")"
fi

: > "$CALLS_PATH"
if ! out2="$(run_worker)"; then
  fail 'tick 2: worker failed' "$out2"
fi
printf '%s\n' "$out2"

! echo "$out2" | grep -q 'BLOCK PR #4362' \
  || fail 'tick 2: worker repeated upper-stack blocker' "$out2"
! echo "$out2" | grep -q '@mergifyio queue' \
  || fail 'tick 2: worker tried to queue while upper stack needs acceptance' "$out2"
comment_calls="$(grep -c '^gh pr comment 4362 ' "$CALLS_PATH" || true)"
[ "$comment_calls" = "0" ] || fail 'tick 2: expected no repeated blocker comment' "$(cat "$CALLS_PATH")"
echo "$out2" | grep -q '"reason": "upper-stack-needs-acceptance"' \
  || fail 'tick 2: worker did not settle into upper-stack wait' "$out2"

echo '[repro] passed'
