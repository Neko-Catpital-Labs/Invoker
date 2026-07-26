#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-human-review-thread-block.XXXXXX")"
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
export STATE_PATH
export LEDGER_PATH

python3 - <<'PY'
import json
import os
from pathlib import Path

head = '931e895dd343de2646a6d9aec1b83543710a7e5e'
state = {
    'prs': [
        {
            'number': 5885,
            'title': '[Bugfix: Slack repo URL classification rejects website URLs](1) Tighten Slack repo routing',
            'body': '## Summary\n\nTighten Slack repo routing.\n',
            'url': 'https://github.com/fake/repo/pull/5885',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/slack-routing',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [
                {
                    'id': 'PRRT_kwDOSFkSDM6T5EJA',
                    'isResolved': False,
                    'comments': {
                        'nodes': [
                            {
                                'author': {'login': 'human-reviewer'},
                                'body': 'Please address this before landing.',
                                'url': 'https://github.com/fake/repo/pull/5885#discussion_r1',
                            },
                        ],
                    },
                },
            ],
            'checks': {'*': 'SUCCESS'},
        },
    ],
    'issue_comments': {'5885': []},
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
: > "$CALLS_PATH"

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --author fake-bot --state-file "$LEDGER_PATH" 2>&1
}

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed' "$out1"
fi
printf '%s\n' "$out1"
case "$out1" in
  *'BLOCK PR #5885 unresolved human review thread PRRT_kwDOSFkSDM6T5EJA'*) ;;
  *) fail 'tick 1: missing exact human review thread block' "$out1" ;;
esac

python3 - <<'PY'
import json
import os
from pathlib import Path

state = json.loads(Path(os.environ['STATE_PATH']).read_text(encoding='utf-8'))
comments = state.get('issue_comments', {}).get('5885', [])
if len(comments) != 1:
    raise SystemExit(f'expected exactly one blocker comment, saw {len(comments)}')
body = comments[0].get('body', '')
needle = 'Mergify repair stopped: unresolved human review thread PRRT_kwDOSFkSDM6T5EJA'
if needle not in body:
    raise SystemExit('blocker comment did not include exact review thread id')
rows = [
    json.loads(line)
    for line in Path(os.environ['LEDGER_PATH']).read_text(encoding='utf-8').splitlines()
    if line.strip()
]
if not any(
    row.get('kind') == 'comment-blocked'
    and row.get('pr') == 5885
    and row.get('key') == 'PRRT_kwDOSFkSDM6T5EJA'
    for row in rows
):
    raise SystemExit('missing comment-blocked ledger row for review thread')
PY

if ! out2="$(run_worker)"; then
  fail 'tick 2: worker failed' "$out2"
fi
printf '%s\n' "$out2"
case "$out2" in
  *'BLOCK PR #5885'*) fail 'tick 2: worker repeated the human-only blocker comment' "$out2" ;;
esac
case "$out2" in
  *'"reason": "blocked-needs-human"'*) ;;
  *) fail 'tick 2: worker did not settle into blocked-needs-human wait state' "$out2" ;;
esac

comment_calls="$(grep -c '^gh pr comment 5885 --repo fake/repo --body Mergify repair stopped: unresolved human review thread PRRT_kwDOSFkSDM6T5EJA$' "$CALLS_PATH" || true)"
[ "$comment_calls" = "1" ] || fail 'expected exactly one GitHub blocker comment call' "$(cat "$CALLS_PATH")"

echo '[repro] passed'
