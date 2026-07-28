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
if ! git rebase origin/master >/tmp/repro-conflict-rebase.log 2>&1; then
  cat > packages/app/src/main.ts <<'TS'
export const ownerConfig = {
  enabled: true,
  source: 'registry',
};
TS
  git add packages/app/src/main.ts
  GIT_EDITOR=true git rebase --continue >/dev/null
fi
printf '%s\n' 'local conflict rebase finished; parent worker must push'
EOF
chmod +x "$TMP/bin/claude"

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/6315"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
CALLS_PATH="$FAKE_GH_STATE_DIR/calls.log"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH LEDGER_PATH

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["ORIGINAL_HEAD"]
state = {
    "prs": [
        {
            "number": 6315,
            "title": "[Infra Repair Worker](2) Wire owner config in main process",
            "body": "## Summary\n\nWire owner config in main process.\n",
            "url": "https://github.com/fake/repo/pull/6315",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/6315",
            "headRefOid": head,
            "mergeStateStatus": "DIRTY",
            "mergeable": "CONFLICTING",
            "labels": ["admin-bypass", "dequeued"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS", "PR Body": "SUCCESS"},
        }
    ],
    "issue_comments": {
        "6315": [
            {
                "id": "m6315",
                "user": {"login": "mergify"},
                "updated_at": "2026-07-28T10:15:28Z",
                "html_url": "https://github.com/fake/repo/pull/6315#m6315",
                "body": (
                    "<!---\n"
                    "DO NOT EDIT\n"
                    "-*- Mergify Payload -*-\n"
                    "{\"version\":1,\"state\":\"dequeued\",\"queue_rule_name\":\"admin-bypass\"}\n"
                    "-*- Mergify Payload End -*-\n"
                    "-->\n\n"
                    "# Merge Queue Status\n\n"
                    "## Reason\n\n"
                    "The pull request conflicts with the base branch\n"
                ),
            }
        ]
    },
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --author fake-bot --state-file "$LEDGER_PATH" --pr 6315 2>&1
}

git init -q --bare "$REMOTE"
git init -q "$SEED"
(
  cd "$SEED"
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
  git checkout -q -b master
  mkdir -p packages/app/src
  cat > packages/app/src/main.ts <<'TS'
export const ownerConfig = {
  enabled: false,
  source: 'base',
};
TS
  git add packages/app/src/main.ts
  git commit -q -m base
  git remote add origin "$REMOTE"
  git push -q origin master
  git checkout -q -b stack/6315 master
  cat > packages/app/src/main.ts <<'TS'
export const ownerConfig = {
  enabled: true,
  source: 'owner',
};
TS
  git add packages/app/src/main.ts
  git commit -q -m 'wire owner config'
  git push -q origin stack/6315
  git checkout -q master
  cat > packages/app/src/main.ts <<'TS'
export const ownerConfig = {
  enabled: false,
  source: 'registry',
};
TS
  git add packages/app/src/main.ts
  git commit -q -m 'register infra repair worker'
  git push -q origin master
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/6315)"
MASTER_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/master)"
export ORIGINAL_HEAD MASTER_HEAD

git clone -q "$REMOTE" "$WORK_ROOT"
(
  cd "$WORK_ROOT"
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
)
write_state
: > "$LEDGER_PATH"
: > "$CALLS_PATH"

if ! out="$(run_worker)"; then
  fail 'worker failed to push clean local conflict rebase' "$out"
fi
printf '%s\n' "$out"

case "$out" in
  *'repair-conflict PR #6315 GitHub reports merge conflict'*) ;;
  *) fail 'worker did not select conflict repair' "$out" ;;
esac

REMOTE_HEAD="$(git --git-dir="$REMOTE" rev-parse refs/heads/stack/6315)"
if [ "$REMOTE_HEAD" = "$ORIGINAL_HEAD" ]; then
  fail 'remote branch did not advance after local conflict rebase'
fi
if ! git --git-dir="$REMOTE" merge-base --is-ancestor "$MASTER_HEAD" "$REMOTE_HEAD"; then
  fail 'pushed conflict repair is not rebased onto current master'
fi
if git --git-dir="$REMOTE" merge-base --is-ancestor "$ORIGINAL_HEAD" "$REMOTE_HEAD"; then
  fail 'conflict repair was not force-pushed over the stale head'
fi

RESOLVED_CONTENT="$(git --git-dir="$REMOTE" show "$REMOTE_HEAD:packages/app/src/main.ts")"
if ! printf '%s\n' "$RESOLVED_CONTENT" | grep -Fq "enabled: true"; then
  fail 'pushed branch does not enable owner config' "$RESOLVED_CONTENT"
fi
if ! printf '%s\n' "$RESOLVED_CONTENT" | grep -Fq "source: 'registry'"; then
  fail 'pushed branch does not preserve merged registry source' "$RESOLVED_CONTENT"
fi

python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["ORIGINAL_HEAD"]
rows = [
    json.loads(line)
    for line in Path(os.environ["LEDGER_PATH"]).read_text(encoding="utf-8").splitlines()
    if line.strip()
]
if not any(row.get("kind") == "conflict-repair" and row.get("pr") == 6315 and row.get("headSha") == head for row in rows):
    raise SystemExit("missing conflict-repair ledger row")
if not any(row.get("kind") == "repair-evaluated" and row.get("pr") == 6315 and row.get("key") == "conflict" for row in rows):
    raise SystemExit("missing conflict repair-evaluated ledger row")
PY

if grep -Fq 'gh pr comment 6315' "$CALLS_PATH"; then
  fail 'worker posted a stop comment for a worker-fixable conflict' "$(cat "$CALLS_PATH")"
fi

echo '[repro] passed'
