#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-bottom-human-decision-blocks-downstream.XXXXXX")"
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
BOTTOM_HEAD="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
UPPER_HEAD="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
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
            'number': 5967,
            'title': 'Bottom human split blocker',
            'body': '## Summary\n\nBottom needs a human split.\n',
            'url': 'https://github.com/fake/repo/pull/5967',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/5967',
            'headRefOid': bottom,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass', 'dequeued'],
            'reviewThreads': [],
            'checks': {
                '*': 'SUCCESS',
                'build-artifacts': 'SKIPPED',
                'quality / TypeScript Types': 'FAILURE',
            },
        },
        {
            'number': 5968,
            'title': 'Downstream repairable check',
            'body': '## Summary\n\nDownstream is repairable only after the bottom lands.\n',
            'url': 'https://github.com/fake/repo/pull/5968',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'stack/5967',
            'headRefName': 'stack/5968',
            'headRefOid': upper,
            'mergeStateStatus': 'UNSTABLE',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {
                '*': 'SUCCESS',
                'quality / TypeScript Types': 'FAILURE',
            },
        },
    ],
    'issue_comments': {
        '5967': [
            {
                'id': 'm5967',
                'user': {'login': 'mergify[bot]'},
                'updated_at': '2026-07-27T03:05:07Z',
                'html_url': 'https://github.com/fake/repo/pull/5967#m5967',
                'body': (
                    '-*- Mergify Payload -*-\n'
                    '{"state":"dequeued","queue_rule_name":"admin-bypass"}\n\n'
                    '- ❌ **Checks failed** · on draft #6067\n'
                    f'- 🚫 **Left the queue** — `2026-07-27 03:05 UTC` · at `{bottom}`\n\n'
                    '## Failing checks\n\n'
                    '- [build-artifacts](https://github.com/fake/repo/actions/runs/1/job/2)\n'
                    '- [quality / TypeScript Types](https://github.com/fake/repo/actions/runs/1/job/3)\n'
                ),
            },
            {
                'id': 'blocked5967',
                'user': {'login': 'invoker-bot'},
                'updated_at': '2026-07-27T03:31:00Z',
                'html_url': 'https://github.com/fake/repo/pull/5967#blocked5967',
                'body': 'Mergify repair stopped: PR body Review Unit "contract" cannot ship with routing files in the same PR. Split this into one Review Unit per PR.',
            },
        ],
        '5968': [],
    },
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY

python3 - <<'PY' > "$LEDGER_PATH"
import json
import os

row = {
    'kind': 'repair-invalid',
    'pr': 5967,
    'headSha': os.environ['BOTTOM_HEAD'],
    'key': 'build-artifacts',
    'epoch': 1785122674,
    'meta': {
        'errors': [
            'PR body Review Unit "contract" cannot ship with routing files in the same PR. Split this into one Review Unit per PR.'
        ]
    },
}
print(json.dumps(row, sort_keys=True))
PY

if ! out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5967 2>&1)"; then
  fail 'worker dry-run failed' "$out"
fi
printf '%s\n' "$out"

! echo "$out" | grep -q 'DRY-RUN repair-check PR #5968' \
  || fail 'worker retried downstream PR while bottom has a human-only blocker' "$out"
! echo "$out" | grep -q 'DRY-RUN repair-check PR #5967' \
  || fail 'worker retried the bottom human-only blocker' "$out"
echo "$out" | grep -q '"reason": "blocked-needs-human"' \
  || fail 'worker did not stop on the bottom human-only blocker' "$out"

echo '[repro] passed'
