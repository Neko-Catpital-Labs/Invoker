#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-conflict-repair-push.XXXXXX")"
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
echo called > "$CLAUDE_CALLED"
printf 'resolved by worker\n' > conflict-resolution.txt
git add conflict-resolution.txt
git commit -m 'resolve fake conflict' >/dev/null
EOF
chmod +x "$TMP/bin/claude"

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/5207"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH
export LEDGER_PATH

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
head = os.environ['ORIGINAL_HEAD']
state = {
    'prs': [
        {
            'number': 5207,
            'title': '[Tmux Summary Bridge Step 2 Planning](1) Wire Planning Tmux Summary Bridge',
            'body': '## Summary\n\nConflict repair repro.\n',
            'url': 'https://github.com/fake/repo/pull/5207',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/5207',
            'headRefOid': head,
            'mergeStateStatus': 'DIRTY',
            'mergeable': 'CONFLICTING',
            'labels': ['admin-bypass'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS'},
        }
    ],
    'issue_comments': {'5207': []},
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
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
  git switch -c stack/5207 master >/dev/null
  printf 'original\n' > feature.txt
  git add feature.txt
  git commit -m 'conflicting feature' >/dev/null
  git push publish stack/5207 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/5207)"
export ORIGINAL_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state

if ! out="$(run_worker)"; then
  fail 'worker failed' "$out"
fi
printf '%s\n' "$out"
[ -f "$CLAUDE_CALLED" ] || fail 'worker did not invoke conflict repair'
echo "$out" | grep -q 'repair-conflict PR #5207' || fail 'missing conflict action output' "$out"
echo "$out" | grep -q 'admin-bypass-repair-conflict-pushed' || fail 'missing conflict pushed trace' "$out"

local_head="$(git -C "$WORK_ROOT" rev-parse HEAD)"
remote_head="$(git --git-dir="$REMOTE" rev-parse refs/heads/stack/5207)"
[ "$remote_head" != "$ORIGINAL_HEAD" ] || fail 'remote branch was not advanced by worker'
[ "$remote_head" = "$local_head" ] || fail "remote head $remote_head does not match local repair $local_head"

python3 - <<'PY'
import json
import os
from pathlib import Path
rows = [json.loads(line) for line in Path(os.environ['LEDGER_PATH']).read_text(encoding='utf-8').splitlines() if line.strip()]
if not any(row.get('kind') == 'conflict-repair' and row.get('pr') == 5207 and row.get('key') == 'conflict:5207' for row in rows):
    raise SystemExit('missing conflict-repair ledger row for PR #5207')
PY

echo '[repro] passed'
