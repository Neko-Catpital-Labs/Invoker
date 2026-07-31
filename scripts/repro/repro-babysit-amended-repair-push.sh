#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-amended-repair-push.XXXXXX")"
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
rm -f scripts/repro/proof-wrapper.sh
git add -A
git commit --amend --no-edit
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
WORK_ROOT="$WORK_PARENT/5806"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
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
            'number': 5806,
            'title': 'Amended repair push repro',
            'body': '## Summary\n\nAmended repair push repro.\n',
            'url': 'https://github.com/fake/repo/pull/5806',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/5806',
            'headRefOid': head,
            'mergeStateStatus': 'UNSTABLE',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'PR Body': 'FAILURE'},
        }
    ],
    'issue_comments': {'5806': []},
    'job_logs': {'2': 'PR body validation failed: proof wrappers are not lane-compatible\n'},
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --author fake-bot --state-file "$LEDGER_PATH" --pr 5806 2>&1
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
  git switch -c stack/5806 master >/dev/null
  mkdir -p packages/surfaces/src/slack scripts/repro
  printf 'planning\n' > packages/surfaces/src/slack/plan-conversation.ts
  printf '# proof wrapper\n' > scripts/repro/proof-wrapper.sh
  git add packages/surfaces/src/slack/plan-conversation.ts scripts/repro/proof-wrapper.sh
  git commit -m 'mixed behavior proof wrapper' >/dev/null
  git push publish stack/5806 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/5806)"
export ORIGINAL_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state

if ! out="$(run_worker)"; then
  fail 'worker failed to delegate amended repair' "$out"
fi
printf '%s\n' "$out"

REMOTE_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/stack/5806)"
if [ "$REMOTE_HEAD" != "$ORIGINAL_HEAD" ]; then
  fail 'land worker pushed directly instead of delegating repair'
fi
if ! grep -q '"kind": "repair-delegated".*"pr": 5806' "$LEDGER_PATH"; then
  fail 'repair delegation was not recorded' "$(cat "$LEDGER_PATH")"
fi

if ! out2="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5806 2>&1)"; then
  fail 'dry-run failed after amended repair delegation' "$out2"
fi
printf '%s\n' "$out2"
! echo "$out2" | grep -q 'DRY-RUN repair-check PR #5806 check="PR Body"' \
  || fail 'worker retried delegated amended repair' "$out2"
echo "$out2" | grep -q '"reason": "repair-delegated"' \
  || fail 'worker did not wait on delegated amended repair' "$out2"

echo '[repro] passed'
