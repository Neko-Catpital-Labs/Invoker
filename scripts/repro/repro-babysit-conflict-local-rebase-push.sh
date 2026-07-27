#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-conflict-local-rebase-push.XXXXXX")"
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
git reset --hard origin/master >/dev/null
printf 'resolved by conflict repair\n' > conflict.txt
git add conflict.txt
git commit -m 'Resolve PR #5207 conflict' >/dev/null
EOF
chmod +x "$TMP/bin/claude"

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/5207"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH

git init "$SEED" >/dev/null
(
  cd "$SEED"
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
  printf 'base\n' > conflict.txt
  git add conflict.txt
  git commit -m 'base' >/dev/null
  git branch -M master
  git init --bare "$REMOTE" >/dev/null
  git remote add publish "$REMOTE"
  git push publish master >/dev/null
  git switch -c stack/5207 >/dev/null
  printf 'old PR change\n' > conflict.txt
  git commit -am 'original PR change' >/dev/null
  git push publish stack/5207 >/dev/null
  git switch master >/dev/null
  printf 'new master change\n' > conflict.txt
  git commit -am 'master conflicting change' >/dev/null
  git push publish master >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/stack/5207)"
MASTER_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/master)"
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

head = os.environ["ORIGINAL_HEAD"]
state = {
    "prs": [
        {
            "number": 5207,
            "title": "Conflict repair local rebase push repro",
            "body": "## Summary\n\nConflict repair local rebase push repro.\n",
            "url": "https://github.com/fake/repo/pull/5207",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/5207",
            "headRefOid": head,
            "mergeStateStatus": "DIRTY",
            "mergeable": "CONFLICTING",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {"5207": []},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY

if ! out="$(python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5207 2>&1)"; then
  fail 'worker failed to publish clean local conflict repair' "$out"
fi
printf '%s\n' "$out"

REMOTE_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/stack/5207)"
if [ "$REMOTE_HEAD" = "$ORIGINAL_HEAD" ]; then
  fail 'remote PR branch did not move after clean local conflict repair'
fi
if ! git --git-dir="$REMOTE" merge-base --is-ancestor "$MASTER_HEAD" "$REMOTE_HEAD"; then
  fail 'pushed conflict repair is not based on current master'
fi
if [ "$(git --git-dir="$REMOTE" show "$REMOTE_HEAD:conflict.txt")" != "resolved by conflict repair" ]; then
  fail 'pushed conflict repair did not contain the resolved content'
fi
if ! grep -q '"kind": "conflict-repair"' "$LEDGER_PATH"; then
  fail 'missing conflict-repair ledger row'
fi
if ! grep -q '"kind": "repair-evaluated"' "$LEDGER_PATH"; then
  fail 'missing conflict repair evaluation ledger row'
fi

echo '[repro] passed'
