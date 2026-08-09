#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-pr-body-proof-human-split.XXXXXX")"
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
export REAL_NODE="$(command -v node)"
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
exit 0
EOF
chmod +x "$TMP/bin/claude"

cat > "$TMP/bin/review-gate" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '{}\n'
EOF
chmod +x "$TMP/bin/review-gate"
export INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/bin/review-gate"

cat > "$TMP/bin/submit-async-repair" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test -s "${1:?plan path required}"
EOF
chmod +x "$TMP/bin/submit-async-repair"
export INVOKER_ADMIN_BYPASS_ASYNC_REPAIR_SUBMIT_CMD="$TMP/bin/submit-async-repair"

cat > "$TMP/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -ge 1 && "$1" == *"/scripts/validate-pr-body-local.mjs" ]]; then
  cat <<'JSON'
{"valid":false,"errors":["Review lane behavior cannot ship with proof files in the same PR. Split behavior or cleanup from docs, policy, repro, and benchmark slices.","PR body Review Unit \"routing\" cannot ship with proof files in the same PR. Split this into one Review Unit per PR."],"reviewLane":"behavior","reviewUnit":"routing","reviewUnits":["routing","proof"],"scopeKinds":["product","proof"]}
JSON
  exit 1
fi
exec "$REAL_NODE" "$@"
EOF
chmod +x "$TMP/bin/node"

BODY_PATH="$TMP/body.md"
cat > "$BODY_PATH" <<'EOF'
## Summary

Makes Slack planning drafts, approval buttons, and thinking placeholders recoverable.

## Review Claim

Slack planning state remains actionable after restarts and reconnects.

## Review Lane

behavior

## Review Unit

routing

## Safety Invariant

A draft remains separate from execution until its existing approval action runs.

## Slice Rationale

Recovery mechanics precede the new planning-intent entry gate.

## Non-goals

Does not change the final workflow execution API.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] pnpm --filter @invoker/surfaces test
</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: git revert bef53b9
- Post-revert steps: None
- Data migration? No
</details>
EOF
export BODY_PATH

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/5804"
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
state = {
    'prs': [
        {
            'number': 5804,
            'title': '[Slack planning](15) Make plan submission and confirmation recoverable',
            'body': body,
            'url': 'https://github.com/fake/repo/pull/5804',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'stack/base',
            'headRefName': 'stack/5804',
            'headRefOid': head,
            'mergeStateStatus': 'UNSTABLE',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'PR Body': 'FAILURE'},
        }
    ],
    'issue_comments': {'5804': []},
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

assert_first_run_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
rows = [json.loads(line) for line in Path(os.environ['LEDGER_PATH']).read_text(encoding='utf-8').splitlines() if line.strip()]
invalid = next((row for row in rows if row.get('kind') == 'repair-invalid' and row.get('pr') == 5804 and row.get('key') == 'PR Body'), None)
if invalid is None:
    raise SystemExit('missing repair-invalid row for PR #5804')
errors = (invalid.get('meta') or {}).get('errors') or []
if not any('cannot ship with proof files' in str(item) for item in errors):
    raise SystemExit('repair-invalid row missing proof-file split reason')
if not any('human stack split required' in str(item) for item in errors):
    raise SystemExit('repair-invalid row missing manual split note')
state = json.loads(Path(os.environ['STATE_PATH']).read_text(encoding='utf-8'))
comments = state.get('issue_comments', {}).get('5804', [])
if len(comments) != 1:
    raise SystemExit(f'expected exactly one stop comment, saw {len(comments)}')
body = comments[0].get('body', '')
if 'cannot ship with proof files' not in body:
    raise SystemExit('stop comment missing proof-file split reason')
if 'human stack split required' not in body:
    raise SystemExit('stop comment missing manual split note')
PY
}

assert_stop_comment_count() {
  expected="$1" python3 - <<'PY'
import json
import os
from pathlib import Path
state = json.loads(Path(os.environ['STATE_PATH']).read_text(encoding='utf-8'))
comments = state.get('issue_comments', {}).get('5804', [])
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
  git switch -c stack/base master >/dev/null
  printf 'base\n' > base.txt
  git add base.txt
  git commit -m 'base branch' >/dev/null
  git push publish stack/base >/dev/null
  git switch -c stack/5804 stack/base >/dev/null
  mkdir -p packages/surfaces/src/slack scripts/repro
  printf 'planning\n' > packages/surfaces/src/slack/plan-conversation.ts
  printf '# repro\n' > scripts/repro/repro-slack-plan-intent-confirm.sh
  git add packages/surfaces/src/slack/plan-conversation.ts scripts/repro/repro-slack-plan-intent-confirm.sh
  git commit -m 'mixed behavior and proof slice' >/dev/null
  git push publish stack/5804 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/5804)"
export ORIGINAL_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed' "$out1"
fi
printf '%s\n' "$out1"
assert_first_run_state

: > "$LEDGER_PATH"
if ! out2="$(run_worker)"; then
  fail 'tick 2: worker failed after ledger loss' "$out2"
fi
printf '%s\n' "$out2"
case "$out2" in
  *'repair-check PR #5804'*) fail 'tick 2: worker retried existing proof split stop after ledger loss' "$out2" ;;
esac
case "$out2" in
  *'"reason": "blocked-needs-human"'*) ;;
  *) fail 'tick 2: worker did not keep blocked-needs-human wait state after ledger loss' "$out2" ;;
esac
assert_stop_comment_count 1

echo '[repro] passed'
