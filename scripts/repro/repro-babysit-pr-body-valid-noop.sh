#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-pr-body-valid-noop.XXXXXX")"
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
export INVOKER_HEADLESS_IPC_HELPER="$ROOT/scripts/repro/fixtures/fake-headless-ipc.js"
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
echo "claude was called for a locally valid PR Body failure" > "$CLAUDE_CALLED"
exit 42
EOF
chmod +x "$TMP/bin/claude"

# Without this, resolve_workflow_for_pr (mergify_admin_requeue_workflow_fastpath.py)
# shells out to a live Invoker owner over IPC to look up a review-gate workflow
# mapping for PR #5810, which this hermetic repro never provides -- the lookup
# subprocess fails to connect and admin-bypass-dispatch-degraded fires before
# the worker ever reaches the PR Body valid-noop path this repro is meant to
# test. Mocked the same way its sibling repros already do (e.g.
# repro-babysit-pr-body-human-split.sh, repro-babysit-pr-body-prereq-split.sh).
cat > "$TMP/review-gate.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '{}\n'
EOF
chmod +x "$TMP/review-gate.sh"
export INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh"

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/5810"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ['ORIGINAL_HEAD']
body = """## Summary

Routes owner build identity through the owner ping handshake.

## Review Claim

Owner routing refuses mismatched owners before forwarding requests.

## Review Lane

behavior

## Review Unit

routing

## Safety Invariant

The new field is optional and does not change the common owner response shape.

## Slice Rationale

This is one behavior change in the owner message-bus route.

## Non-goals

Does not change the rendered application UI.

## Architecture

### Before

```mermaid
graph TD
    A["process pings owner"] --> B["owner answers without build identity"]
```

### After

```mermaid
graph TD
    A["process pings owner"] --> B["owner answers with build identity"]
```

## Visual Proof

Not applicable. This only changes internal owner-routing behavior.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] pnpm --filter @invoker/app test -- owner-build-mismatch

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: git revert <sha>
- Post-revert steps: None
- Data migration? No

</details>
"""
state = {
    'prs': [
        {
            'number': 5810,
            'title': 'Stale PR Body failure with valid local body',
            'body': body,
            'url': 'https://github.com/fake/repo/pull/5810',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/5810',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'PR Body': 'FAILURE'},
        }
    ],
    'issue_comments': {'5810': []},
    'job_logs': {'2': ''},
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5810 2>&1
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
  git switch -c stack/5810 master >/dev/null
  printf '\n// stale PR Body noop repro\n' >> packages/app/src/owner-endpoint.ts
  git add packages/app/src/owner-endpoint.ts
  git commit -m 'owner build route repro' >/dev/null
  git push publish stack/5810 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/5810)"
export ORIGINAL_HEAD
git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed on locally valid PR Body' "$out1"
fi
printf '%s\n' "$out1"

[ ! -f "$CLAUDE_CALLED" ] || fail 'tick 1: worker invoked Claude for locally valid PR Body' "$(cat "$CLAUDE_CALLED")"
echo "$out1" | grep -q 'admin-bypass-pr-body-valid-noop' || fail 'tick 1: missing PR Body valid-noop trace' "$out1"
echo "$out1" | grep -q 'admin-bypass-repair-noop' || fail 'tick 1: missing repair-noop trace' "$out1"
grep -q '"kind": "repair-noop".*"pr": 5810' "$LEDGER_PATH" \
  || fail 'tick 1: repair noop was not recorded' "$(cat "$LEDGER_PATH")"

if ! out2="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5810 2>&1)"; then
  fail 'tick 2: dry-run failed after PR Body noop' "$out2"
fi
printf '%s\n' "$out2"

! echo "$out2" | grep -q 'DRY-RUN repair-check PR #5810 check="PR Body"' \
  || fail 'tick 2: worker retried suppressed PR Body failure' "$out2"
echo "$out2" | grep -q 'DRY-RUN requeue PR #5810' \
  || fail 'tick 2: worker did not advance to requeue after PR Body noop' "$out2"

echo '[repro] passed'
