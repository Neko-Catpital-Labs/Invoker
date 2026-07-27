#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-push-race-rebase.XXXXXX")"
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
(
  cd "$RACE_CLONE"
  git fetch origin stack/6174 >/dev/null
  git checkout -B stack/6174 origin/stack/6174 >/dev/null
  printf 'export const remoteRace = true;\n' > packages/app/src/remote-race.ts
  git add packages/app/src/remote-race.ts
  git commit -m 'remote race advance' >/dev/null
  git push origin HEAD:stack/6174 >/dev/null
)
printf 'export const repaired = true;\n' > packages/app/src/main.ts
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
RACE_CLONE="$TMP/racer"
WORK_ROOT="$WORK_PARENT/6174"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
export RACE_CLONE STATE_PATH

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ['ORIGINAL_HEAD']
state = {
    'prs': [
        {
            'number': 6174,
            'title': 'Push race repair repro',
            'body': '## Summary\n\nPush race repair repro.\n',
            'url': 'https://github.com/fake/repo/pull/6174',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/6174',
            'headRefOid': head,
            'mergeStateStatus': 'UNSTABLE',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'quality / TypeScript Types': 'FAILURE'},
        }
    ],
    'issue_comments': {'6174': []},
    'job_logs': {
        '2': "packages/app/src/main.ts: type repair needed\n",
    },
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --author fake-bot --state-file "$LEDGER_PATH" --pr 6174 2>&1
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
  git switch -c stack/6174 master >/dev/null
  mkdir -p packages/app/src
  printf 'export const repaired = false;\n' > packages/app/src/main.ts
  git add packages/app/src/main.ts
  git commit -m 'push race target' >/dev/null
  git push publish stack/6174 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/6174)"
export ORIGINAL_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
git clone "$REMOTE" "$RACE_CLONE" >/dev/null
(
  cd "$WORK_ROOT"
  git checkout stack/6174 >/dev/null
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
)
(
  cd "$RACE_CLONE"
  git checkout stack/6174 >/dev/null
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
)
write_state

if ! out="$(run_worker)"; then
  fail 'worker failed to recover from remote-advanced push race' "$out"
fi
printf '%s\n' "$out"

if ! grep -q 'admin-bypass-repair-push-remote-advanced' <<<"$out"; then
  fail 'worker did not log remote-advanced push recovery' "$out"
fi

REMOTE_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/stack/6174)"
if [ "$REMOTE_HEAD" = "$ORIGINAL_HEAD" ]; then
  fail 'remote branch did not advance after push-race repair' "$out"
fi
if ! git --git-dir="$REMOTE" merge-base --is-ancestor "$ORIGINAL_HEAD" "$REMOTE_HEAD"; then
  fail 'push-race repair did not descend from original head'
fi
if [ "$(git --git-dir="$REMOTE" show "$REMOTE_HEAD:packages/app/src/main.ts")" != "export const repaired = true;" ]; then
  fail 'worker repair content was not pushed'
fi
if [ "$(git --git-dir="$REMOTE" show "$REMOTE_HEAD:packages/app/src/remote-race.ts")" != "export const remoteRace = true;" ]; then
  fail 'remote race commit was not preserved'
fi

echo '[repro] passed'
