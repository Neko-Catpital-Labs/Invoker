#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-pr-body-agent-edit.XXXXXX")"
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

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/5812"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
FIXED_BODY_PATH="$TMP/fixed-body.md"
export STATE_PATH
export FIXED_BODY_PATH

cat > "$FIXED_BODY_PATH" <<'EOF'
## Summary

Adds task routing for failed SSH recovery.

This keeps owner worker handling tied to the existing task lifecycle.

## Review Claim

Approve routing for failed SSH task handling.

## Review Lane

behavior

## Review Unit

routing

## Safety Invariant

The worker only acts on failed SSH task records and leaves unrelated workflows unchanged.

## Slice Rationale

This keeps runtime routing in its own review slice.

## Non-goals

- No validation policy change.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] pnpm --filter @invoker/execution-engine test -- infra-repair-worker

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: git revert <sha>
- Post-revert steps: None
- Data migration? No

</details>
EOF

cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$*" in
  *"update the pull request body on GitHub"* ) ;;
  * ) echo "repair prompt did not authorize a PR body edit" >&2; exit 65 ;;
esac

python3 - <<'PY'
import json
import os
from pathlib import Path

state_path = Path(os.environ["STATE_PATH"])
fixed_body = Path(os.environ["FIXED_BODY_PATH"]).read_text(encoding="utf-8")
state = json.loads(state_path.read_text(encoding="utf-8"))
for pr in state["prs"]:
    if int(pr["number"]) == 5812:
        pr["body"] = fixed_body
        break
else:
    raise SystemExit("missing fake PR #5812")
state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
EOF
chmod +x "$TMP/bin/claude"

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
head = os.environ['ORIGINAL_HEAD']
state = {
    'prs': [
        {
            'number': 5812,
            'title': 'PR Body agent edit repro',
            'body': '\n\nDepends-On: #5809',
            'url': 'https://github.com/fake/repo/pull/5812',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/5812',
            'headRefOid': head,
            'mergeStateStatus': 'UNSTABLE',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'PR Body': 'FAILURE'},
        }
    ],
    'issue_comments': {'5812': []},
    'job_logs': {'2': 'PR body validation failed: missing required sections\n'},
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5812 2>&1
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
  git switch -c stack/5812 master >/dev/null
  mkdir -p packages/execution-engine/src/workers
  printf 'export const prBodyAgentEditRoute = true;\n' > packages/execution-engine/src/workers/pr-body-agent-edit-route.ts
  git add packages/execution-engine/src/workers/pr-body-agent-edit-route.ts
  git commit -m 'route failed ssh repair task' >/dev/null
  git push publish stack/5812 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/5812)"
export ORIGINAL_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed on agent-updated PR body' "$out1"
fi
printf '%s\n' "$out1"

echo "$out1" | grep -q 'admin-bypass-pr-body-refreshed' \
  || fail 'tick 1: worker did not refresh the edited PR body' "$out1"
echo "$out1" | grep -q 'admin-bypass-repair-noop' \
  || fail 'tick 1: worker did not record the body-only repair as no-code-needed' "$out1"
grep -q '"kind": "repair-noop".*"pr": 5812' "$LEDGER_PATH" \
  || fail 'tick 1: repair noop was not recorded' "$(cat "$LEDGER_PATH")"
! grep -q '"kind": "repair-invalid".*"pr": 5812' "$LEDGER_PATH" \
  || fail 'tick 1: stale invalid snapshot was recorded after body edit' "$(cat "$LEDGER_PATH")"

if ! out2="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5812 2>&1)"; then
  fail 'tick 2: dry-run failed after agent body edit' "$out2"
fi
printf '%s\n' "$out2"

! echo "$out2" | grep -q 'DRY-RUN repair-check PR #5812 check="PR Body"' \
  || fail 'tick 2: worker retried the already-fixed PR Body failure' "$out2"
echo "$out2" | grep -q 'DRY-RUN requeue PR #5812' \
  || fail 'tick 2: worker did not advance after the body-only repair' "$out2"

echo '[repro] passed'
