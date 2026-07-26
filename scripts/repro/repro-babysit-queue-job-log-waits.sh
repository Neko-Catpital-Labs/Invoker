#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-queue-job-log-waits.XXXXXX")"
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
grep -q 'queue draft UI Vitest was cancelled after the queue started' "$log_path" || {
  echo "unexpected queue log contents" >&2
  exit 1
}
grep -q 'Queue draft PR: #5956' <<<"$prompt" || {
  echo "missing queue draft context" >&2
  exit 1
}
exit 0
EOF
chmod +x "$TMP/bin/claude"

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/5885"
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
mode = os.environ['JOB_LOG_MODE']
if mode == 'unavailable':
    job_log = {
        'exit_code': 1,
        'stderr': 'run 30219860322 is still in progress; logs will be available when it is complete\n',
    }
else:
    job_log = 'queue draft UI Vitest was cancelled after the queue started\n'
state = {
    'prs': [
        {
            'number': 5885,
            'title': '[Bugfix: Slack repo URL classification rejects website URLs](1) Tighten Slack repo routing',
            'body': '## Summary\n\nQueue log wait repro.\n',
            'url': 'https://github.com/fake/repo/pull/5885',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/5885',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass', 'dequeued'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'UI Vitest': 'SUCCESS'},
        }
    ],
    'issue_comments': {
        '5885': [
            {
                'id': 'm5885',
                'user': {'login': 'mergify'},
                'updated_at': '2026-07-26T20:57:49Z',
                'html_url': 'https://github.com/fake/repo/pull/5885#m5885',
                'body': (
                    '-*- Mergify Payload -*-\n'
                    '{"state":"dequeued","queue_rule_name":"admin-bypass"}\n\n'
                    '- ❌ **Checks failed** · on draft #5956\n'
                    f'- 🚫 **Left the queue** — `2026-07-26 20:57 UTC` · at `{head}`\n\n'
                    '<details>\n<summary><strong>Waiting for</strong></summary>\n\n'
                    '- [ ] `check-success = UI Vitest`\n\n'
                    '</details>\n'
                    '<details>\n<summary>All conditions</summary>\n\n'
                    '- [ ] `check-success = UI Vitest`\n'
                    '- [X] `check-success = PR Body`\n'
                    '- [X] `check-success = build-artifacts`\n'
                    '- [X] `check-success = quality / Dependency Cruise`\n'
                    '- [X] `check-success = quality / TypeScript Types`\n'
                    '- [X] `check-success = required-fast / Guardrails`\n'
                    '- [X] `check-success = required-fast / Submit Workflow Chain`\n\n'
                    '</details>\n\n'
                    '## Reason\n\n'
                    'The merge conditions cannot be satisfied due to failing checks\n\n'
                    '- `UI Vitest`\n\n'
                    'Failing checks:\n'
                    '- 🛑 [UI Vitest](https://github.com/fake/repo/actions/runs/1/job/2) '
                    '([job log](https://github.com/fake/repo/actions/runs/1/job/2))\n'
                ),
            }
        ]
    },
    'job_logs': {'2': job_log},
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5885 2>&1
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
  git switch -c stack/5885 master >/dev/null
  echo ui-vitest > ui-vitest.txt
  git add ui-vitest.txt
  git commit -m 'ui vitest slice' >/dev/null
  git push publish stack/5885 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/5885)"
export ORIGINAL_HEAD
git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )

JOB_LOG_MODE=unavailable
export JOB_LOG_MODE
write_state
: > "$CALLS_PATH"
if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed while queue job log was unavailable' "$out1"
fi
echo "$out1" | grep -q 'admin-bypass-repair-log-unavailable' || fail 'tick 1: missing log-unavailable trace' "$out1"
! grep -q '^gh pr comment 5885 ' "$CALLS_PATH" || fail 'tick 1: worker should not comment while logs are unavailable' "$(cat "$CALLS_PATH")"
python3 - "$LEDGER_PATH" <<'PY'
import json
import sys
from pathlib import Path
rows = [json.loads(line) for line in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines() if line.strip()]
if sum(row.get('kind') == 'repair-log-unavailable' for row in rows) != 1:
    raise SystemExit('missing repair-log-unavailable row')
if any(row.get('kind') in {'repair-check', 'repair-evaluated'} for row in rows):
    raise SystemExit('log-unavailable consumed a repair attempt')
PY

JOB_LOG_MODE=available
export JOB_LOG_MODE
write_state
: > "$CALLS_PATH"
if ! out2="$(run_worker)"; then
  fail 'tick 2: worker failed after queue job log became available' "$out2"
fi
echo "$out2" | grep -q 'admin-bypass-queue-noop' || fail 'tick 2: missing queue-noop trace' "$out2"
! grep -q '^gh pr comment 5885 ' "$CALLS_PATH" || fail 'tick 2: queue no-op should not comment until follow-up tick' "$(cat "$CALLS_PATH")"

: > "$CALLS_PATH"
if ! out3="$(run_worker)"; then
  fail 'tick 3: worker failed during queue-noop follow-up' "$out3"
fi
queue_calls="$(grep -c '^gh pr comment 5885 --repo fake/repo --body @mergifyio queue$' "$CALLS_PATH" || true)"
[ "$queue_calls" = "1" ] || fail 'tick 3: expected exactly one worker requeue comment' "$(cat "$CALLS_PATH")"
echo "$out3" | grep -q 'admin-bypass-queue-requeue' || fail 'tick 3: missing queue-requeue trace' "$out3"

echo '[repro] passed'
