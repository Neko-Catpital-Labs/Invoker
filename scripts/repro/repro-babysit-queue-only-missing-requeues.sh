#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-queue-only-missing-requeues.XXXXXX")"
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
CURRENT_HEAD="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
OLD_QUEUE_HEAD="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
export STATE_PATH CURRENT_HEAD OLD_QUEUE_HEAD

python3 - <<'PY'
import json
import os
from pathlib import Path
head = os.environ['CURRENT_HEAD']
old = os.environ['OLD_QUEUE_HEAD']
state = {
    'prs': [
        {
            'number': 5801,
            'title': 'Queue-only missing check requeue',
            'body': '## Summary\n\nQueue-only missing checks are merge-queue checks.\n',
            'url': 'https://github.com/fake/repo/pull/5801',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/5801',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {
                '*': 'SUCCESS',
                'required-fast / Guardrails': None,
                'required-fast / Submit Workflow Chain': None,
                'required-fast / Vitest Workspace': None,
            },
        },
        {
            'number': 5803,
            'title': 'Upper human-only split blocker',
            'body': '## Summary\n\nUpper PR needs a human split.\n',
            'url': 'https://github.com/fake/repo/pull/5803',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'stack/5801',
            'headRefName': 'stack/5803',
            'headRefOid': 'cccccccccccccccccccccccccccccccccccccccc',
            'mergeStateStatus': 'UNSTABLE',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'PR Body': 'FAILURE'},
        }
    ],
    'issue_comments': {
        '5801': [
            {
                'id': 'm5801-old',
                'user': {'login': 'mergify[bot]'},
                'updated_at': '2026-07-20T00:00:00Z',
                'html_url': 'https://github.com/fake/repo/pull/5801#m5801-old',
                'body': (
                    '-*- Mergify Payload -*-\n'
                    '{"state":"dequeued","queue_rule_name":"admin-bypass"}\n\n'
                    f'- 🚫 **Left the queue** — `2026-07-20 00:00 UTC` · at `{old}`\n\n'
                    '## Reason\n\nThe pull request conflicts with the base branch\n'
                ),
            }
        ],
        '5803': [
            {
                'id': 'stop-5803',
                'user': {'login': 'EdbertChan'},
                'updated_at': '2026-07-20T00:01:00Z',
                'html_url': 'https://github.com/fake/repo/pull/5803#stop-5803',
                'body': 'Mergify repair stopped: worker cannot auto-split this PR on a non-trunk base; human stack split required',
            }
        ],
    },
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY

if ! out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5801 2>&1)"; then
  fail 'worker dry-run failed' "$out"
fi
printf '%s\n' "$out"

case "$out" in
  *'BLOCK PR #5801 missing-check'*) fail 'worker blocked on queue-only missing check' "$out" ;;
esac
case "$out" in
  *'DRY-RUN requeue PR #5801'*) ;;
  *) fail 'worker did not requeue clean bottom PR with only queue-only checks missing' "$out" ;;
esac

echo '[repro] passed'
