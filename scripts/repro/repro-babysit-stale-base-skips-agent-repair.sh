#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-stale-base-skips-agent-repair.XXXXXX")"
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
mkdir -p "$WORK_PARENT" "$TMP/state"
export FAKE_GH_STATE_DIR="$TMP/state"
export PATH="$ROOT/scripts/repro/fixtures/fake-gh/bin:$PATH"
export INVOKER_HEADLESS_IPC_HELPER="$ROOT/scripts/repro/fixtures/fake-headless-ipc.js"

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
CALLS_PATH="$FAKE_GH_STATE_DIR/calls.log"
export STATE_PATH LEDGER_PATH CALLS_PATH

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/7727"

# PR #7727 incident shape, with real git history: a required check ("PR
# Body") is failing because the branch carries a pre-squash duplicate of
# already-landed content, not because of anything a code change could fix.
# Before this fix, the worker spent all of its repair-check attempts on it.
git clone . "$SEED" >/dev/null
(
  cd "$SEED"
  # This repository is disposable and removed by the EXIT trap. Keep Git from
  # racing that cleanup with a background auto-gc process.
  git config gc.auto 0
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
  git checkout -B master >/dev/null
  git init --bare "$REMOTE" >/dev/null
  git remote add publish "$REMOTE"
  git push publish master >/dev/null
  git switch -c feature master >/dev/null
  printf 'feature\n' > feature-7727.txt
  git add feature-7727.txt
  git commit -m 'feature work' >/dev/null
  git switch master >/dev/null
  git merge --squash feature >/dev/null
  git commit -m 'squash-merged feature' >/dev/null
  git push publish master >/dev/null
  git switch -c stack/7727 feature >/dev/null
  printf 'only new\n' > only-new-7727.txt
  git add only-new-7727.txt
  git commit -m 'genuinely new work' >/dev/null
  git push publish stack/7727 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
STALE_HEAD="$(git -C "$SEED" rev-parse stack/7727)"
export STALE_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )

python3 - <<'PY'
import json
import os
from pathlib import Path

state = {
    "prs": [
        {
            "number": 7727,
            "title": "Stale-based PR with an unfixable failing check",
            "body": "## Summary\n\nStale base skips agent repair repro.\n",
            "url": "https://github.com/fake/repo/pull/7727",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/7727",
            "headRefOid": os.environ["STALE_HEAD"],
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS", "PR Body": "FAILURE"},
        },
    ],
    "issue_comments": {"7727": []},
    "job_logs": {},
    "compare_status": {
        f"master...{os.environ['STALE_HEAD']}": "diverged",
    },
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
: > "$LEDGER_PATH"

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 7727 2>&1
}

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed' "$out1"
fi
printf '%s\n' "$out1"

echo "$out1" | grep -q 'rebase-onto-base PR #7727 onto=master' || fail 'tick 1 did not route the failing check to rebase-onto-base' "$out1"
! echo "$out1" | grep -q 'repair-check PR #7727' || fail 'tick 1 spent an agent-repair attempt on a structural stale-base failure' "$out1"

python3 - <<PY || fail 'expected a rebase-onto-base ledger row and zero repair-check rows' "$(cat "$LEDGER_PATH")"
import json
from pathlib import Path

rows = [
    json.loads(line)
    for line in Path("$LEDGER_PATH").read_text(encoding="utf-8").splitlines()
    if line.strip()
]
if not any(row.get("kind") == "rebase-onto-base" and int(row.get("pr", 0)) == 7727 for row in rows):
    raise SystemExit("missing rebase-onto-base ledger row for PR #7727")
if any(row.get("kind") == "repair-check" and int(row.get("pr", 0)) == 7727 for row in rows):
    raise SystemExit("repair-check must never be attempted for a structural stale-base failure")
PY

echo '[repro] passed'
