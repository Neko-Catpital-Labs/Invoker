#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-outdated-bot-thread.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- detail -----" >&2
    echo "$2" >&2
  fi
  exit 1
}

mkdir -p "$TMP/state" "$TMP/bin"
export HOME="$TMP/home"
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
echo "claude was called for an outdated bot review thread" > "$CLAUDE_CALLED"
exit 42
EOF
chmod +x "$TMP/bin/claude"

LEDGER_PATH="$TMP/ledger.jsonl"
STATE_PATH="$FAKE_GH_STATE_DIR/state.json"
export STATE_PATH

python3 - <<'PY'
import json
import os
from pathlib import Path

head = "1605586282a7bccef5c1ea34419a7176ca755dc1"
state = {
    "prs": [
        {
            "number": 5805,
            "title": "Outdated CodeRabbit thread",
            "body": "## Summary\n\nOutdated bot thread repro.\n",
            "url": "https://github.com/fake/repo/pull/5805",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/5805",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewThreads": [
                {
                    "id": "thread-outdated",
                    "isResolved": False,
                    "isOutdated": True,
                    "comments": {
                        "nodes": [
                            {
                                "author": {"login": "coderabbitai"},
                                "body": "Clean up a line that no longer exists.",
                                "url": "https://github.com/fake/repo/pull/5805#discussion_r1",
                            }
                        ]
                    },
                }
            ],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {"5805": []},
    "job_logs": {},
}
Path(os.environ["STATE_PATH"]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY

run_worker() {
  python3 scripts/mergify_admin_requeue.py --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5805 2>&1
}

if ! dry_out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5805 2>&1)"; then
  fail "dry-run failed for outdated bot thread" "$dry_out"
fi
printf '%s\n' "$dry_out"
echo "$dry_out" | grep -q 'DRY-RUN resolve-bot-threads PR #5805 thread=thread-outdated' \
  || fail "dry-run did not resolve the outdated bot thread" "$dry_out"
! echo "$dry_out" | grep -q 'DRY-RUN repair-check PR #5805 check="thread-outdated"' \
  || fail "dry-run tried to repair an outdated bot thread" "$dry_out"

if ! out="$(run_worker)"; then
  fail "worker failed resolving outdated bot thread" "$out"
fi
printf '%s\n' "$out"
[ ! -f "$CLAUDE_CALLED" ] || fail "worker invoked Claude for outdated bot thread" "$(cat "$CLAUDE_CALLED")"
echo "$out" | grep -q 'resolve-bot-threads PR #5805 thread=thread-outdated' \
  || fail "worker did not execute resolve-bot-threads" "$out"
grep -q 'resolveReviewThread' "$FAKE_GH_STATE_DIR/calls.log" \
  || fail "worker did not call the review-thread resolve mutation" "$(cat "$FAKE_GH_STATE_DIR/calls.log")"
! grep -q '"kind": "repair-bot-thread"' "$LEDGER_PATH" 2>/dev/null \
  || fail "worker recorded a bot-thread repair instead of resolving stale feedback" "$(cat "$LEDGER_PATH")"

if ! next_out="$(python3 scripts/mergify_admin_requeue.py --dry-run --once --repo fake/repo --state-file "$LEDGER_PATH" --pr 5805 2>&1)"; then
  fail "dry-run failed after resolving outdated bot thread" "$next_out"
fi
printf '%s\n' "$next_out"
echo "$next_out" | grep -q 'DRY-RUN requeue PR #5805' \
  || fail "worker did not advance to requeue after resolving stale feedback" "$next_out"

echo "[repro] passed"
