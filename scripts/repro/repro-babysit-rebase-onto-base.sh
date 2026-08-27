#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-rebase-onto-base.XXXXXX")"
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
WORK_ROOT="$WORK_PARENT/6201"

# PR #7727 incident, reproduced with real git: the branch's base pointer
# already points at master (a prior retarget), but the branch still carries
# a pre-squash duplicate of a commit that landed in master under a different
# SHA -- master is not an ancestor of the branch's real content.
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
  printf 'feature\n' > feature-6201.txt
  git add feature-6201.txt
  git commit -m 'feature work' >/dev/null
  git switch master >/dev/null
  git merge --squash feature >/dev/null
  git commit -m 'squash-merged feature' >/dev/null
  git push publish master >/dev/null
  git switch -c stack/rebase-onto-base feature >/dev/null
  printf 'only new\n' > only-new-6201.txt
  git add only-new-6201.txt
  git commit -m 'genuinely new work' >/dev/null
  git push publish stack/rebase-onto-base >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
STALE_HEAD="$(git -C "$SEED" rev-parse stack/rebase-onto-base)"
MASTER_HEAD="$(git -C "$SEED" rev-parse master)"
export STALE_HEAD MASTER_HEAD

git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )

python3 - <<'PY'
import json
import os
from pathlib import Path

state = {
    "prs": [
        {
            "number": 6201,
            "title": "Stale base content never rebased",
            "body": "## Summary\n\nStale base rebase repro.\n",
            "url": "https://github.com/fake/repo/pull/6201",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/rebase-onto-base",
            "headRefOid": os.environ["STALE_HEAD"],
            "mergeStateStatus": "CLEAN",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        },
    ],
    "issue_comments": {"6201": []},
    "job_logs": {},
    "compare_status": {
        f"master...{os.environ['STALE_HEAD']}": "diverged",
    },
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
: > "$LEDGER_PATH"

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6201 "$@" 2>&1
}

# Since #10337 ("Stop blind rebase; unify onto master"), a bottom PR whose
# base pointer already equals trunk is never locally force-pushed just for
# stale/diverged content -- see test_stale_base_content_requeues_without_rebase
# in scripts/test_mergify_admin_requeue_plan.py. The worker must requeue
# without touching the remote branch, even for this exact #7727 shape.
if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed' "$out1"
fi
printf '%s\n' "$out1"

echo "$out1" | grep -q "requeue PR #6201 head=$STALE_HEAD reason=eligible-when-ready" \
  || fail 'tick 1 did not requeue the stale-based PR without rebasing' "$out1"
! echo "$out1" | grep -q 'rebase-onto-base PR #6201' || fail 'tick 1 planned a legacy local rebase-onto-base force-push' "$out1"
! echo "$out1" | grep -q 'rebase-onto-master PR #6201' || fail 'tick 1 planned an Invoker rebase-onto-master job for stale-base-alone' "$out1"

NEW_REMOTE_HEAD="$(git --git-dir="$REMOTE" rev-parse stack/rebase-onto-base)"
if [ "$NEW_REMOTE_HEAD" != "$STALE_HEAD" ]; then
  fail 'requeue must never force-push; remote branch moved' "$NEW_REMOTE_HEAD"
fi

python3 - <<'PY' || fail 'expected a requeue ledger row, not a rebase' "$(cat "$LEDGER_PATH")"
import json
import os
from pathlib import Path

rows = [
    json.loads(line)
    for line in Path(os.environ["LEDGER_PATH"]).read_text(encoding="utf-8").splitlines()
    if line.strip()
]
matches = [
    row for row in rows
    if row.get("kind") == "requeue"
    and row.get("key") == "ready"
    and int(row.get("pr", 0)) == 6201
]
if len(matches) != 1:
    raise SystemExit(f"expected 1 requeue row, saw {len(matches)}")
if any(row.get("kind") in {"rebase-onto-base", "rebase-onto-master"} and int(row.get("pr", 0)) == 6201 for row in rows):
    raise SystemExit("a rebase must not be filed for stale-base-alone content")
PY

echo '[repro] passed'
