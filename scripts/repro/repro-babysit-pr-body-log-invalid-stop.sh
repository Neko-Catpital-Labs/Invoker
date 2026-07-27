#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-pr-body-log-invalid-stop.XXXXXX")"
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

CLAUDE_CALLED="$TMP/claude-called"
export CLAUDE_CALLED
cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "claude was called for PR Body log-invalid blocker" > "$CLAUDE_CALLED"
exit 42
EOF
chmod +x "$TMP/bin/claude"

BODY_PATH="$TMP/body.md"
cat > "$BODY_PATH" <<'EOF'
## Summary

This slice adds shell assertions to the checked-in handoff-check script.

## Review Claim

The checked-in handoff checks now fail if the handoff-only wording drifts.

## Review Lane

policy

## Review Unit

tooling-policy

## Safety Invariant

The change stays in the checked-in handoff check only; runtime code stays untouched.

## Slice Rationale

One check slice locks the new wording so the handoff bug cannot drift back silently.

## Non-goals

No planning-skill edits here, no handoff-entry edits here, no fixture edits here, no runtime code changes, no unrelated docs cleanup.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] `bash scripts/test-plan-to-invoker-skill.sh`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: `git revert <sha>`
- Post-revert steps: None
- Data migration? No

</details>
EOF
export BODY_PATH

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/6048"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH
export LEDGER_PATH

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
body = Path(os.environ['BODY_PATH']).read_text(encoding='utf-8')
head = os.environ['ORIGINAL_HEAD']
job_log = '\n'.join([
    'PR Body\tValidate PR body\t2026-07-27T17:18:35.1841482Z PR body validation failed:',
    'PR Body\tValidate PR body\t2026-07-27T17:18:35.1852714Z - Review lane policy cannot ship with product files in the same PR. Keep tooling/runtime policy separate from behavior and proof changes.',
    'PR Body\tValidate PR body\t2026-07-27T17:18:35.1857321Z - PR body Review Unit "tooling-policy" cannot ship with routing, docs files in the same PR. Split this into one Review Unit per PR.',
    'PR Body\tValidate PR body\t2026-07-27T17:18:35.2062176Z ##[error]Process completed with exit code 1.',
])
state = {
    'prs': [
        {
            'number': 6048,
            'title': '[Bugfix: planning submit-only contract](4) Refresh handoff checks',
            'body': body,
            'url': 'https://github.com/fake/repo/pull/6048',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/6048',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass', 'queued'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'PR Body': 'FAILURE'},
        }
    ],
    'issue_comments': {'6048': []},
    'job_logs': {'2': job_log},
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

assert_first_run_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
expected_errors = [
    'Review lane policy cannot ship with product files in the same PR. Keep tooling/runtime policy separate from behavior and proof changes.',
    'PR body Review Unit "tooling-policy" cannot ship with routing, docs files in the same PR. Split this into one Review Unit per PR.',
]
rows = [json.loads(line) for line in Path(os.environ['LEDGER_PATH']).read_text(encoding='utf-8').splitlines() if line.strip()]
if not any(row.get('kind') == 'repair-check' and row.get('pr') == 6048 and row.get('key') == 'PR Body' for row in rows):
    raise SystemExit('missing repair-check ledger row for PR #6048')
invalid = next((row for row in rows if row.get('kind') == 'repair-invalid' and row.get('pr') == 6048 and row.get('key') == 'PR Body'), None)
if invalid is None:
    raise SystemExit('missing repair-invalid ledger row for PR #6048')
errors = (invalid.get('meta') or {}).get('errors') or []
if errors != expected_errors:
    raise SystemExit(f'repair-invalid row has wrong errors: {errors!r}')
state = json.loads(Path(os.environ['STATE_PATH']).read_text(encoding='utf-8'))
comments = state.get('issue_comments', {}).get('6048', [])
if len(comments) != 1:
    raise SystemExit(f'expected exactly one stop comment, saw {len(comments)}')
body = comments[0].get('body', '')
expected_body = 'Mergify repair stopped: ' + '\n'.join(expected_errors)
if body != expected_body:
    raise SystemExit(f'stop comment mismatch: {body!r}')
PY
}

assert_stop_comment_count() {
  expected="$1" python3 - <<'PY'
import json
import os
from pathlib import Path
state = json.loads(Path(os.environ['STATE_PATH']).read_text(encoding='utf-8'))
comments = state.get('issue_comments', {}).get('6048', [])
expected = int(os.environ['expected'])
actual = len(comments)
if actual != expected:
    raise SystemExit(f'expected {expected} stop comments, saw {actual}')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --author fake-bot --state-file "$LEDGER_PATH" 2>&1
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
  git switch -c stack/6048 master >/dev/null
  mkdir -p scripts
  printf '#!/usr/bin/env bash\n' > scripts/test-plan-to-invoker-skill.sh
  git add scripts/test-plan-to-invoker-skill.sh
  git commit -m 'policy check drift guard' >/dev/null
  git push publish stack/6048 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/6048)"
export ORIGINAL_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed' "$out1"
fi
printf '%s\n' "$out1"
[ ! -f "$CLAUDE_CALLED" ] || fail 'tick 1: worker invoked Claude for log-invalid PR Body' "$(cat "$CLAUDE_CALLED")"
echo "$out1" | grep -q 'admin-bypass-pr-body-log-invalid' || fail 'tick 1: missing log-invalid trace' "$out1"
assert_first_run_state

if ! out2="$(run_worker)"; then
  fail 'tick 2: worker failed' "$out2"
fi
printf '%s\n' "$out2"
case "$out2" in
  *'repair-check PR #6048'*) fail 'tick 2: worker retried the same PR Body blocker' "$out2" ;;
esac
case "$out2" in
  *'"reason": "blocked-needs-human"'*) ;;
  *) fail 'tick 2: worker did not surface blocked-needs-human wait state' "$out2" ;;
esac
assert_stop_comment_count 1

: > "$LEDGER_PATH"
if ! out3="$(run_worker)"; then
  fail 'tick 3: worker failed after ledger loss' "$out3"
fi
printf '%s\n' "$out3"
case "$out3" in
  *'repair-check PR #6048'*) fail 'tick 3: worker retried existing exact stop after ledger loss' "$out3" ;;
esac
case "$out3" in
  *'"reason": "blocked-needs-human"'*) ;;
  *) fail 'tick 3: worker did not keep blocked-needs-human wait state after ledger loss' "$out3" ;;
esac
assert_stop_comment_count 1

echo '[repro] passed'
