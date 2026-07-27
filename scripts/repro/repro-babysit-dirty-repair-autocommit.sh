#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-dirty-repair-autocommit.XXXXXX")"
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
printf 'export const repaired = true;\n' > packages/app/src/main.ts
printf 'export const resetHook = true;\n' > packages/workflow-core/src/orchestrator.ts
EOF
chmod +x "$TMP/bin/claude"

cat > "$TMP/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -ge 1 && "$1" == *"/scripts/validate-pr-body-local.mjs" ]]; then
  cat <<'JSON'
{"valid":true,"errors":[],"reviewLane":"behavior","reviewUnit":"routing","reviewUnits":["routing"],"scopeKinds":["product"]}
JSON
  exit 0
fi
exec /usr/bin/env node "$@"
EOF
chmod +x "$TMP/bin/node"

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/6146"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH LEDGER_PATH

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ['ORIGINAL_HEAD']
state = {
    'prs': [
        {
            'number': 6146,
            'title': 'Spawn sibling repair workflows for review-gate CI',
            'body': '## Summary\n\nDirty repair autocommit repro.\n',
            'url': 'https://github.com/fake/repo/pull/6146',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/6146',
            'headRefOid': head,
            'mergeStateStatus': 'UNSTABLE',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'quality / TypeScript Types': 'FAILURE'},
        }
    ],
    'issue_comments': {'6146': []},
    'job_logs': {
        '2': "packages/app/src/main.ts: Module '@invoker/execution-engine' has no exported member.\n",
    },
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

write_capped_dirty_ledger() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ['ORIGINAL_HEAD']
path = Path(os.environ['LEDGER_PATH'])
rows = []
for epoch in range(3):
    rows.append({
        'epoch': epoch,
        'headSha': head,
        'key': 'quality / TypeScript Types',
        'kind': 'repair-check',
        'pr': 6146,
    })
    rows.append({
        'epoch': epoch,
        'headSha': head,
        'key': 'quality / TypeScript Types',
        'kind': 'repair-evaluated',
        'pr': 6146,
    })
rows.append({
    'epoch': 3,
    'headSha': head,
    'key': f'repair-dirty:quality / TypeScript Types:{head}',
    'kind': 'comment-blocked',
    'pr': 6146,
})
path.write_text(''.join(json.dumps(row, sort_keys=True) + '\n' for row in rows), encoding='utf-8')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --author fake-bot --state-file "$LEDGER_PATH" --pr 6146 2>&1
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
  git switch -c stack/6146 master >/dev/null
  mkdir -p packages/app/src packages/workflow-core/src
  printf 'export const repaired = false;\n' > packages/app/src/main.ts
  printf 'export const resetHook = false;\n' > packages/workflow-core/src/orchestrator.ts
  git add packages/app/src/main.ts packages/workflow-core/src/orchestrator.ts
  git commit -m 'dirty repair target' >/dev/null
  git push publish stack/6146 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/6146)"
export ORIGINAL_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state
write_capped_dirty_ledger

if ! out="$(run_worker)"; then
  fail 'worker failed to repair dirty worktree' "$out"
fi
printf '%s\n' "$out"

REMOTE_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/stack/6146)"
if [ "$REMOTE_HEAD" = "$ORIGINAL_HEAD" ]; then
  fail 'remote branch did not advance after dirty repair' "$out"
fi
if ! git --git-dir="$REMOTE" merge-base --is-ancestor "$ORIGINAL_HEAD" "$REMOTE_HEAD"; then
  fail 'dirty repair push did not descend from original head'
fi
if [ "$(git --git-dir="$REMOTE" show "$REMOTE_HEAD:packages/app/src/main.ts")" != "export const repaired = true;" ]; then
  fail 'app repair content was not pushed'
fi
if grep -q 'repair left uncommitted changes' "$FAKE_GH_STATE_DIR/state.json"; then
  fail 'worker posted dirty-block comment instead of committing repair'
fi
if ! grep -q '"kind": "repair-dirty-retry"' "$LEDGER_PATH"; then
  fail 'worker did not record the one-shot dirty repair retry'
fi

echo '[repro] passed'
