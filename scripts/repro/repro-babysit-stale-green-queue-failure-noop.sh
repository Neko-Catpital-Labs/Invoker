#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-stale-green-queue-failure-noop.XXXXXX")"
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
export CLAUDE_CALLED="$TMP/claude-called"

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
echo "claude was called for a stale queue failure whose current PR-head check is green" > "$CLAUDE_CALLED"
exit 42
EOF
chmod +x "$TMP/bin/claude"

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/6163"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
CALLS_PATH="$FAKE_GH_STATE_DIR/calls.log"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH LEDGER_PATH

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ['ORIGINAL_HEAD']
body = """## Summary

Documents remote-aware workflow base references.

## Review Claim

The docs describe how workflow base refs are displayed and edited.

## Review Lane

docs

## Review Unit

docs

## Safety Invariant

Documentation-only change. It does not change runtime behavior.

## Slice Rationale

Keeps the remote-aware base-ref user docs in their own slice.

## Non-goals

- No product behavior change.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] docs-only update

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: git revert <sha>
- Post-revert steps: None
- Data migration? No

</details>
"""
state = {
    'prs': [
        {
            'number': 6163,
            'title': 'Document remote-aware workflow base refs',
            'body': body,
            'url': 'https://github.com/fake/repo/pull/6163',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/6163',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass', 'dequeued'],
            'reviewThreads': [],
            'checks': {
                '*': 'SUCCESS',
                'required-fast / Guardrails': None,
                'required-fast / Submit Workflow Chain': None,
                'required-fast / Vitest Workspace': None,
            },
        }
    ],
    'issue_comments': {
        '6163': [
            {
                'id': 'm6163',
                'user': {'login': 'mergify[bot]'},
                'updated_at': '2026-07-28T08:11:36Z',
                'html_url': 'https://github.com/fake/repo/pull/6163#m6163',
                'body': (
                    '-*- Mergify Payload -*-\n'
                    '{"state":"dequeued","queue_rule_name":"admin-bypass"}\n\n'
                    '- ❌ **Checks failed** · on draft #6395\n'
                    f'- 🚫 **Left the queue** — `2026-07-28 08:11 UTC` · at `{head}`\n\n'
                    '## Failing checks\n\n'
                    '- [PR Body](https://github.com/fake/repo/actions/runs/30/job/3)\n'
                    '- [UI Vitest](https://github.com/fake/repo/actions/runs/30/job/4)\n'
                ),
            }
        ]
    },
    'job_logs': {
        '2': 'current PR-head success log; stale queue repairs must not use this URL\n',
        '3': '',
        '4': '',
    },
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6163 2>&1
}

assert_repair_noop() {
  local check_name="$1"
  CHECK_NAME="$check_name" python3 - <<'PY'
import json
import os
from pathlib import Path

ledger = Path(os.environ["LEDGER_PATH"])
check_name = os.environ["CHECK_NAME"]
for line in ledger.read_text(encoding="utf-8").splitlines():
    row = json.loads(line)
    if row.get("kind") == "repair-noop" and row.get("pr") == 6163 and row.get("key") == check_name:
        raise SystemExit(0)
raise SystemExit(f"missing repair-noop for {check_name}")
PY
}

git init "$SEED" >/dev/null
(
  cd "$SEED"
  git config user.email repro@example.test
  git config user.name 'Repro Bot'
  git checkout -B master >/dev/null
  echo baseline > README.md
  git add README.md
  git commit -m 'baseline' >/dev/null
  git init --bare "$REMOTE" >/dev/null
  git remote add origin "$REMOTE"
  git push origin master >/dev/null
  git switch -c stack/6163 master >/dev/null
  echo docs > docs.txt
  git add docs.txt
  git commit -m 'docs repro' >/dev/null
  git push origin stack/6163 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/6163)"
export ORIGINAL_HEAD
git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state
: > "$CALLS_PATH"

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed on stale PR Body queue failure' "$out1"
fi
printf '%s\n' "$out1"

[ ! -f "$CLAUDE_CALLED" ] || fail 'tick 1: worker invoked Claude for stale PR Body queue failure' "$(cat "$CLAUDE_CALLED")"
echo "$out1" | grep -q 'admin-bypass-stale-queue-check-noop' || fail 'tick 1: missing stale queue noop trace' "$out1"
assert_repair_noop "PR Body" || fail 'tick 1: PR Body noop was not recorded' "$(cat "$LEDGER_PATH")"
grep -q '^gh run view --repo fake/repo --job 3 --log$' "$CALLS_PATH" \
  || fail 'tick 1: worker did not use the Mergify PR Body job URL' "$(cat "$CALLS_PATH")"

: > "$CALLS_PATH"
if ! out2="$(run_worker)"; then
  fail 'tick 2: worker failed on stale UI Vitest queue failure' "$out2"
fi
printf '%s\n' "$out2"

[ ! -f "$CLAUDE_CALLED" ] || fail 'tick 2: worker invoked Claude for stale UI Vitest queue failure' "$(cat "$CLAUDE_CALLED")"
assert_repair_noop "UI Vitest" || fail 'tick 2: UI Vitest noop was not recorded' "$(cat "$LEDGER_PATH")"
grep -q '^gh run view --repo fake/repo --job 4 --log$' "$CALLS_PATH" \
  || fail 'tick 2: worker did not use the Mergify UI Vitest job URL' "$(cat "$CALLS_PATH")"

if ! out3="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6163 2>&1)"; then
  fail 'tick 3: dry-run failed after stale queue noops' "$out3"
fi
printf '%s\n' "$out3"

! echo "$out3" | grep -q 'repair-check PR #6163' \
  || fail 'tick 3: worker retried stale queue failures after noops' "$out3"
echo "$out3" | grep -q 'DRY-RUN requeue PR #6163' \
  || fail 'tick 3: worker did not advance to requeue after stale queue noops' "$out3"

echo '[repro] passed'
