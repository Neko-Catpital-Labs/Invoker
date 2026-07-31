#!/usr/bin/env bash
# Repro: a stale queue-submitted marker must not make admin-bypass queue wait
# forever after the matching ad-hoc repair workflow has terminally failed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-admin-bypass-queue-retries-failed-workflow.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home" "$TMP/plans"
export FAKE_GH_STATE_DIR="$TMP/state"

cat > "$FAKE_GH_STATE_DIR/state.json" <<'JSON'
{
  "prs": [
    {
      "number": 902,
      "title": "Failed delegated repair should retry",
      "body": "## Summary\n\nQueue retry repro.\n",
      "url": "https://github.com/fake/repo/pull/902",
      "state": "OPEN",
      "isDraft": false,
      "baseRefName": "master",
      "headRefName": "stack/902",
      "headRefOid": "2222222222222222222222222222222222222222",
      "mergeStateStatus": "BLOCKED",
      "mergeable": "MERGEABLE",
      "labels": ["admin-bypass"],
      "reviewThreads": [],
      "checks": {"UI Vitest": "FAILURE"}
    }
  ],
  "issue_comments": {"902": []},
  "job_logs": {}
}
JSON

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"
: > "$NODE_LOG"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node args=%s\n' "\$*" >> "$NODE_LOG"
exit 0
EOF
chmod +x "$TMP/bin/node"

cat > "$TMP/review-gate.sh" <<'RG'
#!/usr/bin/env bash
printf '{}\n'
RG
chmod +x "$TMP/review-gate.sh"

run_cron() {
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_ADMIN_BYPASS_QUEUE_STATE_FILE="$TMP/ledger.tsv" \
  INVOKER_ADMIN_BYPASS_QUEUE_PLAN_DIR="$TMP/plans" \
  INVOKER_ADMIN_BYPASS_QUEUE_MAX_ATTEMPTS=3 \
  bash "$ROOT/scripts/cron-admin-bypass-queue.sh" 2>&1
}

out="$(run_cron)" || fail "tick 1 exited non-zero" "$out"
echo "$out" | grep -q "PR #902: submitted ad-hoc repair plan (category=failed_checks" \
  || fail "tick 1: expected initial ad-hoc submission" "$out"
node_calls="$(wc -l < "$NODE_LOG")"
[ "$node_calls" -eq 1 ] || fail "tick 1: expected exactly one node call, got $node_calls" "$(cat "$NODE_LOG")"

fp="$(awk -F '\t' '$1 == "queue-submitted" && $2 == "902" { print $3 }' "$TMP/ledger.tsv")"
[ -n "$fp" ] || fail "could not read queue-submitted fingerprint" "$(cat "$TMP/ledger.tsv")"

mkdir -p "$TMP/home/.invoker"
python3 - "$TMP/home/.invoker/invoker.db" "$fp" <<'PY'
import sqlite3
import sys

db_path, fingerprint = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db_path)
con.execute("create table workflows (id text primary key, name text, created_at text)")
con.execute("create table tasks (id text primary key, workflow_id text, status text, error text)")
workflow_id = "wf-failed-902"
con.execute(
    "insert into workflows (id, name, created_at) values (?, ?, ?)",
    (workflow_id, f"admin-bypass-repair-pr-902-{fingerprint}", "2026-07-31T04:48:16.489Z"),
)
con.execute(
    "insert into tasks (id, workflow_id, status, error) values (?, ?, ?, ?)",
    (f"{workflow_id}/repair", workflow_id, "failed", "Application quit"),
)
con.commit()
PY

out="$(run_cron)" || fail "tick 2 exited non-zero" "$out"
echo "$out" | grep -q "PR #902: previous repair workflow wf-failed-902 failed for this head-state ($fp): wf-failed-902/repair (Application quit); retrying" \
  || fail "tick 2: expected failed workflow to be retried" "$out"
! echo "$out" | grep -q "PR #902: repair already submitted for this head-state ($fp); waiting" \
  || fail "tick 2: stale queue-submitted marker still forced waiting" "$out"
node_calls="$(wc -l < "$NODE_LOG")"
[ "$node_calls" -eq 2 ] || fail "tick 2: expected retry submission, got $node_calls node calls" "$(cat "$NODE_LOG")"
grep -q $'queue-failed\t902\t'"$fp"$':wf-failed-902' "$TMP/ledger.tsv" \
  || fail "tick 2: failed workflow marker missing" "$(cat "$TMP/ledger.tsv")"
attempts="$(awk -F '\t' '$1 == "queue-attempt" && $2 == "902" { c++ } END { print c + 0 }' "$TMP/ledger.tsv")"
[ "$attempts" -eq 1 ] || fail "tick 2: failed workflow should count one attempt, got $attempts" "$(cat "$TMP/ledger.tsv")"

echo "[repro] passed"
