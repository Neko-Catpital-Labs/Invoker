#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-pr-body-stale-base-rebase-push.XXXXXX")"
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
git fetch origin master >/dev/null
git rebase origin/master >/dev/null
EOF
chmod +x "$TMP/bin/claude"

cat > "$TMP/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -ge 1 && "$1" == *"/scripts/validate-pr-body-local.mjs" ]]; then
  if git merge-base --is-ancestor origin/master HEAD; then
    cat <<'JSON'
{"valid":true,"errors":[],"reviewLane":"behavior","reviewUnit":"routing","reviewUnits":["routing"],"scopeKinds":["product"]}
JSON
    exit 0
  fi
  cat <<'JSON'
{"valid":false,"errors":["Review lane behavior cannot ship with policy files in the same PR. Split behavior or cleanup from docs, policy, repro, and benchmark slices.","PR body Review Unit \"routing\" cannot ship with activation-surface, tooling-policy files in the same PR. Split this into one Review Unit per PR."],"reviewLane":"behavior","reviewUnit":"routing","reviewUnits":["routing","activation-surface","tooling-policy"],"scopeKinds":["product","policy"]}
JSON
  exit 1
fi
exec /usr/bin/env node "$@"
EOF
chmod +x "$TMP/bin/node"

BODY_PATH="$TMP/body.md"
cat > "$BODY_PATH" <<'EOF'
## Summary

Routes standalone repair spawn execution.

## Review Claim

The app dispatcher invokes the repair workflow route for the new command.

## Review Lane

behavior

## Review Unit

routing

## Safety Invariant

Existing repair and review-gate commands keep their current dispatch paths.

## Slice Rationale

This slice only wires the standalone command through one routing point.

## Non-goals

- No policy or proof changes.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] pnpm --filter @invoker/app build

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
export BODY_PATH

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/6099"
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
            'number': 6099,
            'title': 'Stale-base PR Body rebase push repro',
            'body': body,
            'url': 'https://github.com/fake/repo/pull/6099',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/6099',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'PR Body': 'FAILURE'},
        }
    ],
    'issue_comments': {'6099': []},
    'job_logs': {
        '2': 'PR body validation failed: activation-surface and tooling-policy files appear in the stale-base diff\n',
    },
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

seed_bad_ledger() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
head = os.environ['ORIGINAL_HEAD']
rows = [
    {'epoch': 1, 'kind': 'repair-check', 'pr': 6099, 'headSha': head, 'key': 'PR Body'},
    {'epoch': 1, 'kind': 'repair-evaluated', 'pr': 6099, 'headSha': head, 'key': 'PR Body'},
    {
        'epoch': 1,
        'kind': 'repair-invalid',
        'pr': 6099,
        'headSha': head,
        'key': 'PR Body',
        'meta': {
            'errors': [
                'Review lane behavior cannot ship with policy files in the same PR. Split behavior or cleanup from docs, policy, repro, and benchmark slices.',
                'PR body Review Unit "routing" cannot ship with activation-surface, tooling-policy files in the same PR. Split this into one Review Unit per PR.',
            ],
        },
    },
    {
        'epoch': 1,
        'kind': 'comment-blocked',
        'pr': 6099,
        'headSha': head,
        'key': f'repair-invalid:PR Body:{head}',
    },
]
Path(os.environ['LEDGER_PATH']).write_text('\n'.join(json.dumps(row) for row in rows) + '\n', encoding='utf-8')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --author fake-bot --state-file "$LEDGER_PATH" --pr 6099 2>&1
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
  git switch -c stack/6099 master >/dev/null
  mkdir -p packages/app/src
  printf 'route repair workflow\n' > packages/app/src/main.ts
  git add packages/app/src/main.ts
  git commit -m 'route repair workflow command' >/dev/null
  git push publish stack/6099 >/dev/null
  git switch master >/dev/null
  mkdir -p docs scripts
  printf 'new base docs\n' > docs/rebased-base.md
  printf 'new base policy\n' > scripts/base-policy.sh
  git add docs/rebased-base.md scripts/base-policy.sh
  git commit -m 'advance base with policy files' >/dev/null
  git push publish master >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/6099)"
export ORIGINAL_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state
seed_bad_ledger

if ! out="$(run_worker)"; then
  fail 'worker failed to recover stale-base PR Body invalid marker' "$out"
fi
printf '%s\n' "$out"

case "$out" in
  *'repair-check PR #6099 check="PR Body"'*) ;;
  *) fail 'worker did not retry the stale-base PR Body marker' "$out" ;;
esac

REMOTE_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/stack/6099)"
MASTER_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/master)"
if [ "$REMOTE_HEAD" = "$ORIGINAL_HEAD" ]; then
  fail 'remote branch did not advance'
fi
if ! git --git-dir="$REMOTE" merge-base --is-ancestor "$MASTER_HEAD" "$REMOTE_HEAD"; then
  fail 'remote repair did not preserve the rebase ancestry'
fi
if git --git-dir="$REMOTE" merge-base --is-ancestor "$ORIGINAL_HEAD" "$REMOTE_HEAD"; then
  fail 'remote repair was normalized onto the stale head instead of pushing the rebase'
fi

grep -q -- '--force-with-lease=refs/heads/stack/6099' "$WORK_ROOT/.git/config" 2>/dev/null \
  && fail 'force-with-lease should not be persisted in git config'

echo '[repro] passed'
