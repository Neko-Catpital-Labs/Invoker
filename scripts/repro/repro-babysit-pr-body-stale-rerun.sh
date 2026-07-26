#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-pr-body-stale-rerun.XXXXXX")"
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

cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 0
EOF
chmod +x "$TMP/bin/claude"

BODY_PATH="$TMP/body.md"
cat > "$BODY_PATH" <<'EOF'
## Summary

The PR maintenance worker can rerun a stale PR Body check after local validation proves the current body and diff are already valid.

## Review Claim

A stale failed PR Body context should not cause repeated repair attempts when the current PR body validates.

## Review Lane

behavior

## Review Unit

validation-policy

## Safety Invariant

Only the failed GitHub Actions job is rerun; the PR branch and body are unchanged.

## Slice Rationale

This is the worker check-retry recovery policy for a stale check result.

## Non-goals

- No manual PR body edits.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] `bash scripts/repro/repro-babysit-pr-body-stale-rerun.sh`

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
WORK_ROOT="$WORK_PARENT/5810"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH
export LEDGER_PATH

git clone . "$SEED" >/dev/null
(
  cd "$SEED"
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
  git checkout -B master >/dev/null
  git init --bare "$REMOTE" >/dev/null
  git remote add publish "$REMOTE"
  git push publish master >/dev/null
  git switch -c stack/5810 master >/dev/null
  printf 'export const stalePrBodyRerunPolicy = true;\n' > packages/app/src/check-rerun-policy.ts
  git add packages/app/src/check-rerun-policy.ts
  git commit -m 'stale pr body rerun target' >/dev/null
  git push publish stack/5810 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/5810)"
export ORIGINAL_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
(
  cd "$WORK_ROOT"
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
)

python3 - <<'PY'
import json
import os
from pathlib import Path
body = Path(os.environ['BODY_PATH']).read_text(encoding='utf-8')
head = os.environ['ORIGINAL_HEAD']
state = {
    'prs': [
        {
            'number': 5810,
            'title': '[Owner Build Guard] Refuse to delegate to a build-mismatched owner',
            'body': body,
            'url': 'https://github.com/fake/repo/pull/5810',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/5810',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass', 'queued'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'PR Body': 'FAILURE'},
        }
    ],
    'issue_comments': {'5810': []},
    'job_logs': {'2': 'PR body validation failed: Missing review metadata.'},
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --author fake-bot --state-file "$LEDGER_PATH" --pr 5810 2>&1
}

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed' "$out1"
fi
printf '%s\n' "$out1"

case "$out1" in
  *'repair-check PR #5810 check="PR Body"'*) ;;
  *) fail 'tick 1: missing stale PR Body repair action' "$out1" ;;
esac
if ! grep -q 'gh run rerun 1 --repo fake/repo --job 2' "$FAKE_GH_STATE_DIR/calls.log"; then
  fail 'tick 1: worker did not rerun the stale PR Body job' "$(cat "$FAKE_GH_STATE_DIR/calls.log")"
fi

python3 - <<'PY'
import json
import os
from pathlib import Path
rows = [json.loads(line) for line in Path(os.environ['LEDGER_PATH']).read_text(encoding='utf-8').splitlines() if line.strip()]
row = next((item for item in rows if item.get('kind') == 'rerun-check' and item.get('pr') == 5810 and item.get('key') == 'PR Body'), None)
if row is None:
    raise SystemExit('missing rerun-check ledger row')
meta = row.get('meta') or {}
if meta.get('detailsUrl') != 'https://github.com/fake/repo/actions/runs/1/job/2':
    raise SystemExit('rerun-check row missing stale job URL')
if meta.get('completedAt') != '2026-07-20T00:00:00Z':
    raise SystemExit('rerun-check row missing stale completedAt')
PY

if ! out2="$(run_worker)"; then
  fail 'tick 2: worker failed' "$out2"
fi
printf '%s\n' "$out2"

case "$out2" in
  *'repair-check PR #5810'*) fail 'tick 2: worker retried a rerun-pending stale check' "$out2" ;;
esac
case "$out2" in
  *'"reason": "pending-check"'*) ;;
  *) fail 'tick 2: worker did not wait on the rerun-pending check' "$out2" ;;
esac
rerun_count="$(grep -c 'gh run rerun 1 --repo fake/repo --job 2' "$FAKE_GH_STATE_DIR/calls.log")"
if [ "$rerun_count" -ne 1 ]; then
  fail "expected exactly one rerun, saw $rerun_count" "$(cat "$FAKE_GH_STATE_DIR/calls.log")"
fi

echo '[repro] passed'
