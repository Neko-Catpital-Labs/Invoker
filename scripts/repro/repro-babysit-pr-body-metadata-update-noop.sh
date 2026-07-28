#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-pr-body-metadata-update-noop.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- detail -----" >&2
    echo "$2" >&2
  fi
  exit 1
}

REAL_NODE="$(command -v node)"
export REAL_NODE
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

BODY_PATH="$TMP/body.md"
cat > "$BODY_PATH" <<'EOF'
## Summary

Register the infra repair worker kind.

## Review Claim

Approve the no-op infra repair worker registration and config surface.

## Review Lane

behavior

## Review Unit

routing

## Safety Invariant

The worker tick handler remains a no-op until a later slice wires repair behavior.

## Slice Rationale

This keeps worker registration reviewable before any SSH repair behavior lands.

## Non-goals

No SSH repair logic is implemented in this slice.

## Test Plan

<details>
<summary>Test Plan</summary>

- [x] pnpm --filter @invoker/execution-engine test -- worker-registry

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: git revert <sha>
- Post-revert steps: None
- Data migration? No

</details>
EOF
export BODY_PATH

cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import json
import os
from pathlib import Path

state_path = Path(os.environ["STATE_PATH"])
body = Path(os.environ["BODY_PATH"]).read_text(encoding="utf-8")
state = json.loads(state_path.read_text(encoding="utf-8"))
for pr in state.get("prs", []):
    if int(pr.get("number", 0)) == 6314:
        pr["body"] = body
state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
echo "updated PR body metadata without changing git head"
EOF
chmod +x "$TMP/bin/claude"

cat > "$TMP/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -ge 1 && "$1" == *"/scripts/validate-pr-body-local.mjs" ]]; then
  body_file=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --body-file)
        body_file="${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  if [[ -n "$body_file" ]] && grep -q '^## Summary' "$body_file" && grep -q '^## Review Claim' "$body_file"; then
    printf '%s\n' '{"valid":true,"errors":[],"reviewLane":"behavior","reviewUnit":"routing","reviewUnits":["routing"],"scopeKinds":["product"]}'
    exit 0
  fi
  printf '%s\n' '{"valid":false,"errors":["PR body is empty."],"reviewLane":"","reviewUnit":"","reviewUnits":[],"scopeKinds":[]}'
  exit 1
fi
exec "$REAL_NODE" "$@"
EOF
chmod +x "$TMP/bin/node"

REMOTE="$TMP/origin.git"
SEED="$TMP/seed"
WORK_ROOT="$WORK_PARENT/6314"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
LEDGER_PATH="$TMP/ledger.jsonl"
export STATE_PATH
export LEDGER_PATH

write_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

head = os.environ["ORIGINAL_HEAD"]
state = {
    "prs": [
        {
            "number": 6314,
            "title": "[Infra Repair Worker](1) Add contract and registry seam",
            "body": "",
            "url": "https://github.com/fake/repo/pull/6314",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/6314",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [],
            "checks": {"*": "SUCCESS", "PR Body": "FAILURE"},
        }
    ],
    "issue_comments": {"6314": []},
    "job_logs": {"2": "PR body validation failed: PR body is empty.\n"},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
}

assert_metadata_repair_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

ledger_path = Path(os.environ["LEDGER_PATH"])
rows = [json.loads(line) for line in ledger_path.read_text(encoding="utf-8").splitlines() if line.strip()]
if not any(row.get("kind") == "repair-check" and row.get("pr") == 6314 and row.get("key") == "PR Body" for row in rows):
    raise SystemExit("missing repair-check ledger row")
if not any(row.get("kind") == "repair-noop" and row.get("pr") == 6314 and row.get("key") == "PR Body" for row in rows):
    raise SystemExit("missing repair-noop ledger row")
if any(row.get("kind") == "repair-invalid" for row in rows):
    raise SystemExit("metadata-only PR Body repair was recorded as repair-invalid")
if any(row.get("kind") == "comment-blocked" for row in rows):
    raise SystemExit("metadata-only PR Body repair posted a stop comment")

state = json.loads(Path(os.environ["STATE_PATH"]).read_text(encoding="utf-8"))
pr = state["prs"][0]
if not pr.get("body", "").startswith("## Summary"):
    raise SystemExit("fake PR body was not updated")
comments = state.get("issue_comments", {}).get("6314", [])
if comments:
    raise SystemExit(f"expected no stop comments, saw {len(comments)}")
PY
}

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6314 2>&1
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
  git switch -c stack/6314 master >/dev/null
  mkdir -p packages/execution-engine/src/workers
  printf 'export const infraRepairWorker = true;\n' > packages/execution-engine/src/workers/infra-repair-worker.ts
  git add packages/execution-engine/src/workers/infra-repair-worker.ts
  git commit -m 'infra repair worker registration' >/dev/null
  git push publish stack/6314 >/dev/null
)
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/master
ORIGINAL_HEAD="$(git -C "$SEED" rev-parse stack/6314)"
export ORIGINAL_HEAD
git clone "$REMOTE" "$WORK_ROOT" >/dev/null
( cd "$WORK_ROOT" && git config user.email repro@example.test && git config user.name 'Repro Bot' )
write_state

if ! out1="$(run_worker)"; then
  fail 'tick 1: worker failed on metadata-only PR Body repair' "$out1"
fi
printf '%s\n' "$out1"
echo "$out1" | grep -q 'repair-check PR #6314 check="PR Body"' \
  || fail 'tick 1: missing PR Body repair action' "$out1"
echo "$out1" | grep -q 'admin-bypass-repair-noop' \
  || fail 'tick 1: missing repair-noop trace' "$out1"
assert_metadata_repair_state

if ! out2="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 6314 2>&1)"; then
  fail 'tick 2: dry-run failed after metadata-only PR Body repair' "$out2"
fi
printf '%s\n' "$out2"
! echo "$out2" | grep -q 'DRY-RUN repair-check PR #6314 check="PR Body"' \
  || fail 'tick 2: worker retried fixed metadata-only PR Body failure' "$out2"
echo "$out2" | grep -q 'DRY-RUN requeue PR #6314' \
  || fail 'tick 2: worker did not advance to requeue after metadata-only repair' "$out2"

echo '[repro] passed'
