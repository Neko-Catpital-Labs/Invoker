#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-conflict-repair-must-push.XXXXXX")"
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
mkdir -p "$HOME" "$TMP/bin" "$TMP/state"
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

STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
ORIGIN="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$HOME/.invoker/mergify-admin-requeue-work/6327"
PROMPT_PATH="$TMP/conflict-prompt.txt"
export STATE_PATH PROMPT_PATH

git init -q --bare "$ORIGIN"
git init -q "$SEED"
git -C "$SEED" config user.email repro@example.invalid
git -C "$SEED" config user.name Repro
printf 'base\n' > "$SEED/base.txt"
git -C "$SEED" add base.txt
git -C "$SEED" commit -q -m base
git -C "$SEED" branch -M master
git -C "$SEED" remote add origin "$ORIGIN"
git -C "$SEED" push -q origin master
git -C "$SEED" switch -q -c stack/6327
printf 'head\n' > "$SEED/head.txt"
git -C "$SEED" add head.txt
git -C "$SEED" commit -q -m head
HEAD_SHA="$(git -C "$SEED" rev-parse HEAD)"
export HEAD_SHA
git -C "$SEED" push -q origin stack/6327
mkdir -p "$(dirname "$WORK_ROOT")"
git clone -q "$ORIGIN" "$WORK_ROOT"
git -C "$WORK_ROOT" config user.email repro@example.invalid
git -C "$WORK_ROOT" config user.name Repro

python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["HEAD_SHA"]
state = {
    "prs": [
        {
            "number": 6327,
            "title": "Conflict repair must push",
            "body": "## Summary\n\nConflict repair must push repro.\n",
            "url": "https://github.com/fake/repo/pull/6327",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/6327",
            "headRefOid": head,
            "mergeStateStatus": "DIRTY",
            "mergeable": "CONFLICTING",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {"6327": []},
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY

cat > "$TMP/bin/claude" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
prompt=""
if [ "${1:-}" = "-p" ]; then
  prompt="${2:-}"
fi
printf '%s' "$prompt" > "$PROMPT_PATH"
grep -q 'Do not use background tasks' "$PROMPT_PATH"
grep -q 'do not exit until the proof has finished and the push has completed' "$PROMPT_PATH"
printf 'local-only conflict repair\n' > conflict-repair.txt
git add conflict-repair.txt
git commit -q -m 'local unpushed conflict repair'
echo 'fake conflict repair left local commit unpushed'
SH
chmod +x "$TMP/bin/claude"

set +e
out="$(python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6327 2>&1)"
status=$?
set -e
printf '%s\n' "$out"

prompt="$(cat "$PROMPT_PATH" 2>/dev/null || true)"
echo "$prompt" | grep -q 'Do not use background tasks' || fail 'conflict prompt allows deferred repair completion' "$prompt"
echo "$prompt" | grep -q 'do not exit until the proof has finished and the push has completed' || fail 'conflict prompt does not require finished proof and push' "$prompt"
if [ "$status" -eq 0 ]; then
  fail 'worker silently accepted a local-only conflict repair' "$out"
fi
echo "$out" | grep -q 'admin-bypass-repair-conflict-incomplete' || fail 'worker did not trace incomplete conflict repair' "$out"

remote_head="$(git --git-dir="$ORIGIN" rev-parse refs/heads/stack/6327)"
if [ "$remote_head" != "$HEAD_SHA" ]; then
  fail 'fake repair unexpectedly changed the remote head'
fi
local_head="$(git -C "$WORK_ROOT" rev-parse HEAD)"
if [ "$local_head" != "$HEAD_SHA" ]; then
  fail 'worker did not reset the incomplete local repair' "$local_head"
fi

echo '[repro] passed'
