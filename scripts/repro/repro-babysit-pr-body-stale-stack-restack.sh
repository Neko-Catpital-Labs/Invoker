#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-pr-body-stale-stack-restack.XXXXXX")"
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
cat > "$TMP/bin/claude" <<EOF
#!/usr/bin/env bash
set -euo pipefail
echo "claude should not be needed for stale PR Body restack" > "$CLAUDE_CALLED"
exit 0
EOF
chmod +x "$TMP/bin/claude"

cat > "$TMP/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -ge 1 && "$1" == *"/scripts/validate-pr-body-local.mjs" ]]; then
  base="master"
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --base)
        base="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  changed="$(git diff --name-only "origin/${base}...HEAD")"
  if grep -q '^packages/app/src/headless.ts$' <<<"$changed"; then
    cat <<'JSON'
{"valid":false,"errors":["PR body Review Unit \"contract\" cannot ship with routing, activation-surface files in the same PR. Split this into one Review Unit per PR."],"reviewLane":"refactor","reviewUnit":"contract","reviewUnits":["routing","activation-surface"],"scopeKinds":["product","product-test"]}
JSON
    exit 1
  fi
  cat <<'JSON'
{"valid":true,"errors":[],"reviewLane":"refactor","reviewUnit":"contract","reviewUnits":["contract"],"scopeKinds":["product"]}
JSON
  exit 0
fi
exec /usr/bin/env node "$@"
EOF
chmod +x "$TMP/bin/node"

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/6325"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
BODY_PATH="$TMP/body.md"
export STATE_PATH LEDGER_PATH BODY_PATH

cat > "$BODY_PATH" <<'EOF'
## Summary

Adds shared failure-class taxonomy and classifier.

## Review Claim

The workflow graph exposes the failure-class contract used by repair workers.

## Review Lane

refactor

## Review Unit

contract

## Safety Invariant

Classification is additive and leaves existing workflow execution unchanged.

## Slice Rationale

The taxonomy lands before worker call sites consume it.

## Non-goals

- No worker routing changes.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] pnpm --filter @invoker/workflow-graph test -- failure-classifier

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

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
body = Path(os.environ['BODY_PATH']).read_text(encoding='utf-8')
head = os.environ['ORIGINAL_HEAD']
detail = 'PR body Review Unit "contract" cannot ship with routing, activation-surface files in the same PR. Split this into one Review Unit per PR.'
state = {
    'prs': [
        {
            'number': 6325,
            'title': '[Failure Class Unification](1) Add failure-class taxonomy and shared classifier',
            'body': body,
            'url': 'https://github.com/fake/repo/pull/6325',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/6325',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'PR Body': 'FAILURE'},
        }
    ],
    'issue_comments': {
        '6325': [
            {
                'id': 'fake-stop-1',
                'user': {'login': 'EdbertChan'},
                'body': f'Mergify repair stopped: {detail}',
                'updated_at': '2026-07-20T00:01:00Z',
                'html_url': 'https://github.com/fake/repo/pull/6325#fake-stop-1',
            }
        ]
    },
    'job_logs': {'2': 'PR Body failed because the base...head diff includes stale lower-stack files.\n'},
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

seed_ledger() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
head = os.environ['ORIGINAL_HEAD']
detail = 'PR body Review Unit "contract" cannot ship with routing, activation-surface files in the same PR. Split this into one Review Unit per PR.'
rows = [
    {'epoch': 1, 'kind': 'repair-invalid', 'pr': 6325, 'headSha': head, 'key': 'PR Body', 'meta': {'errors': [detail]}},
    {'epoch': 1, 'kind': 'comment-blocked', 'pr': 6325, 'headSha': head, 'key': f'repair-invalid:PR Body:{head}'},
]
Path(os.environ['LEDGER_PATH']).write_text('\n'.join(json.dumps(row) for row in rows) + '\n', encoding='utf-8')
PY
}

update_state_after_push() {
  new_head="$1" python3 - <<'PY'
import json
import os
from pathlib import Path
state = json.loads(Path(os.environ['STATE_PATH']).read_text(encoding='utf-8'))
pr = state['prs'][0]
pr['headRefOid'] = os.environ['new_head']
pr['mergeStateStatus'] = 'CLEAN'
pr['checks']['PR Body'] = 'SUCCESS'
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --author fake-bot --state-file "$LEDGER_PATH" "$@" 2>&1
}

git init "$SEED" >/dev/null
(
  cd "$SEED"
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
  git checkout -B master >/dev/null
  printf 'root\n' > README.md
  git add README.md
  git commit -m root >/dev/null
  git init --bare "$REMOTE" >/dev/null
  git remote add publish "$REMOTE"
  git push publish master >/dev/null
  git switch -c old-lower master >/dev/null
  mkdir -p packages/app/src
  printf 'lower stack work\n' > packages/app/src/headless.ts
  git add packages/app/src/headless.ts
  git commit -m 'lower stack commit' >/dev/null
  git switch master >/dev/null
  mkdir -p packages/app/src
  printf 'lower stack work\n' > packages/app/src/headless.ts
  git add packages/app/src/headless.ts
  git commit -m 'squash lower stack' >/dev/null
  git push publish master >/dev/null
  git switch -c stack/6325 old-lower >/dev/null
  mkdir -p packages/workflow-graph/src
  printf "export const failureClass = 'infra';\n" > packages/workflow-graph/src/failure-classifier.ts
  git add packages/workflow-graph/src/failure-classifier.ts
  git commit -m '[Failure Class Unification](1) Add failure-class taxonomy' >/dev/null
  git push publish stack/6325 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/stack/6325)"
export ORIGINAL_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
(
  cd "$WORK_ROOT"
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
)
write_state
seed_ledger

if ! dry="$(run_worker --dry-run)"; then
  fail 'dry-run failed before restack' "$dry"
fi
printf '%s\n' "$dry"
case "$dry" in
  *'DRY-RUN repair-check PR #6325 check="PR Body"'*) ;;
  *) fail 'dry-run did not retry stale PR Body blocker' "$dry" ;;
esac
case "$dry" in
  *'blocked-needs-human'*) fail 'dry-run treated stale PR Body blocker as terminal' "$dry" ;;
esac

if ! out="$(run_worker)"; then
  fail 'worker failed during stale PR Body restack' "$out"
fi
printf '%s\n' "$out"
case "$out" in
  *'repair-check PR #6325 check="PR Body"'*) ;;
  *) fail 'worker did not execute PR Body repair' "$out" ;;
esac
[ ! -f "$CLAUDE_CALLED" ] || fail 'worker invoked Claude instead of deterministic restack' "$(cat "$CLAUDE_CALLED")"

NEW_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/stack/6325)"
[ "$NEW_HEAD" != "$ORIGINAL_HEAD" ] || fail 'remote branch head did not change'
git -C "$WORK_ROOT" fetch origin master stack/6325 >/dev/null
git -C "$WORK_ROOT" merge-base --is-ancestor origin/master origin/stack/6325 \
  || fail 'restacked branch does not contain current master'
changed="$(git -C "$WORK_ROOT" diff --name-only origin/master...origin/stack/6325)"
[ "$changed" = 'packages/workflow-graph/src/failure-classifier.ts' ] \
  || fail 'restacked branch still contains stale lower-stack files' "$changed"

invalid_count="$(grep -c '"kind": "repair-invalid".*"pr": 6325' "$LEDGER_PATH" || true)"
[ "$invalid_count" = 1 ] || fail 'worker recorded a new repair-invalid after successful restack' "$(cat "$LEDGER_PATH")"

update_state_after_push "$NEW_HEAD"
if ! out2="$(run_worker --dry-run)"; then
  fail 'dry-run failed after restack' "$out2"
fi
printf '%s\n' "$out2"
case "$out2" in
  *'DRY-RUN requeue PR #6325'*) ;;
  *) fail 'worker did not advance to requeue after restack' "$out2" ;;
esac

echo '[repro] passed'
