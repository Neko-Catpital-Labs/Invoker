#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-queue-only-skipped-check.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- detail -----" >&2
    echo "$2" >&2
  fi
  exit 1
}

export HOME="$TMP/home"
WORK_PARENT="$HOME/.invoker/mergify-admin-requeue-work"
mkdir -p "$WORK_PARENT" "$TMP/state" "$TMP/bin"
export FAKE_GH_STATE_DIR="$TMP/state"
export PATH="$TMP/bin:$ROOT/scripts/repro/fixtures/fake-gh/bin:$PATH"
export CLAUDE_CALLED="$TMP/claude-called"

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

cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude was called for a skipped queue-only PR-head check" > "$CLAUDE_CALLED"
exit 42
EOF
chmod +x "$TMP/bin/claude"

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/5967"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ['ORIGINAL_HEAD']
state = {
    'prs': [
        {
            'number': 5967,
            'title': 'Queue-only build artifact skipped on PR head',
            'body': '## Summary\n\nQueue-only build-artifacts repro with a real PR-head failure.\n',
            'url': 'https://github.com/fake/repo/pull/5967',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/5967',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass', 'dequeued'],
            'reviewThreads': [],
            'checks': {
                '*': 'SUCCESS',
                'build-artifacts': 'SKIPPED',
                'PR Body': 'FAILURE',
            },
        }
    ],
    'issue_comments': {
        '5967': [
            {
                'id': 'm5967',
                'user': {'login': 'mergify[bot]'},
                'updated_at': '2026-07-26T21:13:00Z',
                'html_url': 'https://github.com/fake/repo/pull/5967#m5967',
                'body': (
                    '-*- Mergify Payload -*-\n'
                    '{"state":"dequeued","queue_rule_name":"admin-bypass"}\n\n'
                    '- ❌ **Checks failed** · on draft #5968\n'
                    f'- 🚫 **Left the queue** — `2026-07-26 21:13 UTC` · at `{head}`\n\n'
                    '## Failing checks\n\n'
                    '- [build-artifacts](https://github.com/fake/repo/actions/runs/1/job/2)\n'
                ),
            }
        ]
    },
    'job_logs': {
        '2': '',
    },
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5967 2>&1
}

git clone . "$SEED" >/dev/null
(
  cd "$SEED"
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
  git checkout -B master >/dev/null
  git init --bare "$REMOTE" >/dev/null
  git remote add publish "$REMOTE"
  git push publish master >/dev/null
  git switch -c stack/5967 master >/dev/null
  echo queue-only-skipped-check > queue-only-skipped-check.txt
  git add queue-only-skipped-check.txt
  git commit -m 'queue only skipped check slice' >/dev/null
  git push publish stack/5967 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/5967)"
export ORIGINAL_HEAD
git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed on skipped queue-only check' "$out1"
fi
printf '%s\n' "$out1"

[ ! -f "$CLAUDE_CALLED" ] || fail 'tick 1: worker invoked Claude for skipped queue-only check' "$(cat "$CLAUDE_CALLED")"
echo "$out1" | grep -q 'admin-bypass-queue-only-empty-log-noop' || fail 'tick 1: missing empty-log noop trace' "$out1"
echo "$out1" | grep -q 'admin-bypass-queue-only-noop' || fail 'tick 1: missing queue-only noop trace' "$out1"

if ! grep -q '"kind": "queue-only-noop"' "$LEDGER_PATH" \
  || ! grep -q '"key": "build-artifacts"' "$LEDGER_PATH" \
  || ! grep -q '"pr": 5967' "$LEDGER_PATH"; then
  fail 'tick 1: build-artifacts queue-only noop was not recorded' "$(cat "$LEDGER_PATH")"
fi

if ! out2="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5967 2>&1)"; then
  fail 'tick 2: dry-run failed after skipped queue-only noop' "$out2"
fi
printf '%s\n' "$out2"

! echo "$out2" | grep -q 'DRY-RUN repair-check PR #5967 check="build-artifacts"' \
  || fail 'tick 2: worker retried suppressed queue-only build-artifacts failure' "$out2"
echo "$out2" | grep -q 'DRY-RUN repair-check PR #5967 check="PR Body"' \
  || fail 'tick 2: worker did not move on to the remaining PR-head blocker' "$out2"

echo '[repro] passed'
