#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-conflict-human-blocker.XXXXXX")"
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

EXACT_REASON="Conflict is human-only: PR #6118 is superseded by the already-merged workflow-base-ref-docs stack (#6159-#6162), and preserving #6118 would regress #6161's explicit-base-ref behavior. Human decision required: close #6118/#6119/#6120 as superseded/duplicate or explicitly choose to keep #6118."
REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/6118"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
CALLS_PATH="$FAKE_GH_STATE_DIR/calls.log"
LEDGER_PATH="$TMP/ledger.jsonl"
export EXACT_REASON STATE_PATH LEDGER_PATH

cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$EXACT_REASON" > .git/mergify-admin-requeue-human-blocker.txt
printf '%s\n' "$EXACT_REASON"
EOF
chmod +x "$TMP/bin/claude"

git init -q --bare "$REMOTE"
git init -q "$SEED"
(
  cd "$SEED"
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
  git checkout -q -b master
  printf 'master\n' > README.md
  git add README.md
  git commit -q -m master
  git remote add origin "$REMOTE"
  git push -q origin master
  git checkout -q -b stack/6118 master
  printf 'base branch docs\n' > workflow-base-branch.md
  git add workflow-base-branch.md
  git commit -q -m 'pin workflow base branch docs'
  git push -q origin stack/6118
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/6118)"
export ORIGINAL_HEAD

git clone -q "$REMOTE" "$WORK_ROOT"
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
            "number": 6118,
            "title": "[Workflow Base Branch](1) Pin persisted workflow base branch to master",
            "body": "## Summary\n\nPin persisted workflow base branch to master.\n",
            "url": "https://github.com/fake/repo/pull/6118",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/6118",
            "headRefOid": head,
            "mergeStateStatus": "DIRTY",
            "mergeable": "CONFLICTING",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {"6118": []},
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
: > "$LEDGER_PATH"
: > "$CALLS_PATH"

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --author fake-bot --state-file "$LEDGER_PATH" --pr 6118 2>&1
}

assert_comment_count() {
  expected="$1" python3 - <<'PY'
import json
import os
from pathlib import Path

expected = int(os.environ["expected"])
state = json.loads(Path(os.environ["STATE_PATH"]).read_text(encoding="utf-8"))
comments = state.get("issue_comments", {}).get("6118", [])
if len(comments) != expected:
    raise SystemExit(f"expected {expected} stop comment(s), saw {len(comments)}")
reason = os.environ["EXACT_REASON"]
for comment in comments:
    body = comment.get("body", "")
    if body != f"Mergify repair stopped: {reason}":
        raise SystemExit(f"unexpected stop comment body: {body!r}")
PY
}

assert_first_run_ledger() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["ORIGINAL_HEAD"]
reason = os.environ["EXACT_REASON"]
rows = [
    json.loads(line)
    for line in Path(os.environ["LEDGER_PATH"]).read_text(encoding="utf-8").splitlines()
    if line.strip()
]
if not any(row.get("kind") == "conflict-repair" and row.get("pr") == 6118 and row.get("headSha") == head and row.get("key") == "conflict:6118" for row in rows):
    raise SystemExit("missing conflict-repair ledger row")
invalid = next((row for row in rows if row.get("kind") == "repair-invalid" and row.get("pr") == 6118 and row.get("headSha") == head and row.get("key") == "conflict"), None)
if invalid is None:
    raise SystemExit("missing repair-invalid ledger row")
if (invalid.get("meta") or {}).get("errors") != [reason]:
    raise SystemExit(f"repair-invalid did not preserve exact reason: {invalid!r}")
blocked_key = f"repair-invalid:conflict:{head}"
if not any(row.get("kind") == "comment-blocked" and row.get("pr") == 6118 and row.get("headSha") == head and row.get("key") == blocked_key for row in rows):
    raise SystemExit("missing comment-blocked ledger row")
PY
}

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed' "$out1"
fi
printf '%s\n' "$out1"
case "$out1" in
  *'repair-conflict PR #6118 GitHub reports merge conflict'*) ;;
  *) fail 'tick 1: expected conflict repair action' "$out1" ;;
esac
assert_first_run_ledger
assert_comment_count 1

REMOTE_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/stack/6118)"
if [ "$REMOTE_HEAD" != "$ORIGINAL_HEAD" ]; then
  fail 'worker advanced remote branch for a human-only conflict'
fi

if ! grep -Fq "gh pr comment 6118 --repo fake/repo --body Mergify repair stopped: $EXACT_REASON" "$CALLS_PATH"; then
  fail 'missing exact stop-comment gh call' "$(cat "$CALLS_PATH")"
fi

if ! out2="$(run_worker)"; then
  fail 'tick 2: worker failed' "$out2"
fi
printf '%s\n' "$out2"
case "$out2" in
  *'repair-conflict PR #6118'*) fail 'tick 2: conflict repair retried after human-only blocker' "$out2" ;;
esac
case "$out2" in
  *'"reason": "blocked-needs-human"'*) ;;
  *) fail 'tick 2: worker did not report blocked-needs-human wait state' "$out2" ;;
esac
assert_comment_count 1

echo '[repro] passed'
