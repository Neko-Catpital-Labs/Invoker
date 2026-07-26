#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-queue-only-check.XXXXXX")"
export TMP
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
WORK_PARENT="$HOME/.invoker/mergify-admin-requeue-work"
mkdir -p "$WORK_PARENT" "$TMP/state" "$TMP/bin"
export FAKE_GH_STATE_DIR="$TMP/state"
export PATH="$TMP/bin:$ROOT/scripts/repro/fixtures/fake-gh/bin:$PATH"

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
set -euo pipefail
prompt=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-p" ] && [ "$#" -ge 2 ]; then
    prompt="$2"
    break
  fi
  shift
 done
log_path="$(printf '%s\n' "$prompt" | awk -F': ' '/^Job log path: / { print $2; exit }')"
[ -n "$log_path" ] || exit 1
if grep -q 'sudo: a terminal is required to read the password' "$log_path" \
  && grep -q "Cannot find module '.../@invoker/surfaces/dist/index.js'" "$log_path"; then
  exit 0
fi
echo "unexpected queue log contents" >&2
exit 1
EOF
chmod +x "$TMP/bin/claude"

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/5811"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
CALLS_PATH="$FAKE_GH_STATE_DIR/calls.log"
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
            'number': 5811,
            'title': 'Queue-only guardrails failure',
            'body': '## Summary\n\nQueue-only repro.\n',
            'url': 'https://github.com/fake/repo/pull/5811',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/5811',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['dequeued'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'required-fast / Guardrails': None},
        }
    ],
    'issue_comments': {
        '5811': [
            {
                'id': 'm5811',
                'user': {'login': 'mergify[bot]'},
                'updated_at': '2026-07-20T00:00:00Z',
                'html_url': 'https://github.com/fake/repo/pull/5811#m5811',
                'body': (
                    '-*- Mergify Payload -*-\n'
                    '{"state":"dequeued","queue_rule_name":"admin-bypass"}\n\n'
                    '- ❌ **Checks failed** · on draft #5854\n'
                    f'- 🚫 **Left the queue** — `2026-07-20 00:00 UTC` · at `{head}`\n\n'
                    '## Failing checks\n\n'
                    '- [required-fast / Guardrails](https://github.com/fake/repo/actions/runs/1/job/2)\n'
                ),
            }
        ]
    },
    'job_logs': {
        '2': "sudo: a terminal is required to read the password\nCannot find module '.../@invoker/surfaces/dist/index.js'\n",
    },
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

assert_tick1_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
state = json.loads(Path(os.environ['STATE_PATH']).read_text(encoding='utf-8'))
original = next((pr for pr in state.get('prs', []) if int(pr.get('number', 0)) == 5811), None)
if original is None:
    raise SystemExit('original PR missing after tick 1')
labels = set(original.get('labels', []))
if labels != {'admin-bypass', 'dequeued'}:
    raise SystemExit(f'original PR labels after tick 1 were {sorted(labels)}')
if original.get('headRefOid') != os.environ['ORIGINAL_HEAD']:
    raise SystemExit('original PR head changed during queue-only noop flow')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5811 2>&1
}

git clone . "$SEED" >/dev/null
(
  cd "$SEED"
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
  git checkout -B master >/dev/null
  rm -rf scripts
  cp -R "$ROOT/scripts" "$SEED/scripts"
  git add scripts
  if ! git diff --cached --quiet; then
    git commit -m 'baseline' >/dev/null
  fi
  git init --bare "$REMOTE" >/dev/null
  git remote add publish "$REMOTE"
  git push publish master >/dev/null
  git switch -c stack/5811 master >/dev/null
  echo queue-only > queue-only.txt
  git add queue-only.txt
  git commit -m 'queue only slice' >/dev/null
  git push publish stack/5811 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/5811)"
export ORIGINAL_HEAD
git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state
: > "$CALLS_PATH"

if ! out1a="$(run_worker)"; then
  fail 'tick 1a: worker failed' "$out1a"
fi
if ! out1b="$(run_worker)"; then
  fail 'tick 1b: worker failed' "$out1b"
fi
out1="$out1a
$out1b"
echo "$out1" | grep -q 'admin-bypass-repair-check-start' || fail 'tick 1: missing queue-only repair trace' "$out1"
! echo "$out1" | grep -q 'BLOCK PR #5811 missing-check' || fail 'tick 1: worker incorrectly blocked on missing-check' "$out1"
assert_tick1_state

: > "$CALLS_PATH"
if ! out2="$(run_worker)"; then
  fail 'tick 2: worker failed' "$out2"
fi
queue_calls="$(grep -c '^gh pr comment 5811 --repo fake/repo --body @mergifyio queue$' "$CALLS_PATH" || true)"
[ "$queue_calls" = "1" ] || fail 'tick 2: expected exactly one queue comment on the original PR' "$(cat "$CALLS_PATH")"

echo '[repro] passed'
