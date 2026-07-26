#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-pr-body-prereq-split.XXXXXX")"
export TMP
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1"
  if [ -n "${2:-}" ]; then
    echo "----- detail -----"
    echo "$2"
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
NODE_MODULES_DIR="$(node -p "require.resolve('jsdom/package.json').split('/node_modules/')[0] + '/node_modules'")"
export NODE_MODULES_DIR

BODY_PATH="$TMP/body.md"
cat > "$BODY_PATH" <<'EOF'
## Summary

Worker proof slice.

## Review Claim

Show the proof-only PR body.

## Review Lane

- proof

## Review Unit

- proof

## Safety Invariant

Proof-only body.

## Slice Rationale

Keep proof separate.

## Non-goals

- No product behavior change.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] `pnpm test`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Data migration? No

</details>
EOF
export BODY_PATH

cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p .github/workflows scripts/test-suites/required
printf 'name: ci\n' > .github/workflows/ci.yml
printf '#!/usr/bin/env bash\n' > scripts/test-suites/required/guardrails.sh
git add .github/workflows/ci.yml scripts/test-suites/required/guardrails.sh
git commit -m "worker tooling-policy repair" >/dev/null
EOF
chmod +x "$TMP/bin/claude"
REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/5800"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
CALLS_PATH="$FAKE_GH_STATE_DIR/calls.log"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
body = Path(os.environ['BODY_PATH']).read_text(encoding='utf-8')
head = os.environ['ORIGINAL_HEAD']
state = {
    'prs': [
        {
            'number': 5800,
            'title': 'Proof PR',
            'body': body,
            'url': 'https://github.com/fake/repo/pull/5800',
            'state': 'OPEN',
            'isDraft': False,
            'baseRefName': 'master',
            'headRefName': 'stack/5800',
            'headRefOid': head,
            'mergeStateStatus': 'BLOCKED',
            'mergeable': 'MERGEABLE',
            'labels': ['admin-bypass', 'dequeued'],
            'reviewThreads': [],
            'checks': {'*': 'SUCCESS', 'required-fast / Guardrails': 'FAILURE'},
        }
    ],
    'issue_comments': {
        '5800': [
            {
                'id': 'm5800',
                'user': {'login': 'mergify[bot]'},
                'updated_at': '2026-07-20T00:00:00Z',
                'html_url': 'https://github.com/fake/repo/pull/5800#m5800',
                'body': 'Left the queue `admin-bypass` at `' + head + '`.\n-*- Mergify Payload -*-\n{"state":"dequeued","queue_rule_name":"admin-bypass"}\n',
            }
        ]
    },
}
Path(os.environ['STATE_PATH']).write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

remove_prereq() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
path = Path(os.environ['STATE_PATH'])
state = json.loads(path.read_text(encoding='utf-8'))
state['prs'] = [pr for pr in state.get('prs', []) if int(pr.get('number', 0)) != 5801]
state.get('issue_comments', {}).pop('5801', None)
path.write_text(json.dumps(state, indent=2), encoding='utf-8')
PY
}

assert_tick1_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
state = json.loads(Path(os.environ['STATE_PATH']).read_text(encoding='utf-8'))
prs = state.get('prs', [])
original = next((pr for pr in prs if int(pr.get('number', 0)) == 5800), None)
prereq = next((pr for pr in prs if int(pr.get('number', 0)) == 5801), None)
if original is None:
    raise SystemExit('original PR missing after tick 1')
if prereq is None:
    raise SystemExit('prerequisite PR missing after tick 1')
if original.get('headRefOid') != os.environ['ORIGINAL_HEAD']:
    raise SystemExit('original PR head changed in fake state')
if prereq.get('labels') != ['admin-bypass']:
    raise SystemExit('prerequisite PR missing admin-bypass label')
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
  rm -rf scripts
  cp -R "$ROOT/scripts" "$SEED/scripts"
  git add scripts
  if ! git diff --cached --quiet; then
    git commit -m 'baseline' >/dev/null
  fi
  git init --bare "$REMOTE" >/dev/null
  git remote add publish "$REMOTE"
  git push publish master >/dev/null
  git switch -c stack/5800 master >/dev/null
  echo proof > proof.txt
  git add proof.txt
  git commit -m 'proof slice' >/dev/null
  git push publish stack/5800 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/5800)"
export ORIGINAL_HEAD
git clone "$REMOTE" "$WORK_ROOT" >/dev/null
if [ -d "$NODE_MODULES_DIR" ] && [ ! -e "$WORK_PARENT/node_modules" ]; then
  ln -s "$NODE_MODULES_DIR" "$WORK_PARENT/node_modules"
fi
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state
: > "$CALLS_PATH"

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed' "$out1"
fi
echo "$out1" | grep -q 'admin-bypass-repair-prereq-created' || fail 'tick 1: missing prerequisite creation trace' "$out1"
assert_tick1_state

remove_prereq
: > "$CALLS_PATH"
if ! out2="$(run_worker)"; then
  fail 'tick 2: worker failed' "$out2"
fi
echo "$out2" | grep -q 'admin-bypass-repair-prereq-requeue' || fail 'tick 2: missing prerequisite requeue trace' "$out2"
queue_calls="$(grep -c '^gh pr comment 5800 --repo fake/repo --body @mergifyio queue$' "$CALLS_PATH" || true)"
[ "$queue_calls" = "1" ] || fail 'tick 2: expected exactly one queue comment on the original PR' "$(cat "$CALLS_PATH")"

echo '[repro] passed'
