#!/usr/bin/env bash
# Repro: a failed dependent safe-push with "fatal: invalid reference: <sha>"
# is an upstream repair-publication failure, not a downstream task to recreate.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-admin-bypass-queue-invalid-ref-stop.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home" "$TMP/plans"
export FAKE_GH_STATE_DIR="$TMP/state"

cat > "$FAKE_GH_STATE_DIR/state.json" <<'JSON'
{
  "prs": [
    {
      "number": 907,
      "title": "Invalid reference failed handoff must stop",
      "body": "## Summary\n\nInvalid-reference queue repro.\n",
      "url": "https://github.com/fake/repo/pull/907",
      "state": "OPEN",
      "isDraft": false,
      "baseRefName": "master",
      "headRefName": "stack/907",
      "headRefOid": "7777777777777777777777777777777777777777",
      "mergeStateStatus": "BLOCKED",
      "mergeable": "MERGEABLE",
      "labels": ["admin-bypass"],
      "reviewThreads": [],
      "checks": {"UI Vitest": "FAILURE"}
    }
  ],
  "issue_comments": {"907": []},
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
echo "$out" | grep -q "PR #907: submitted ad-hoc repair plan (category=failed_checks" \
  || fail "tick 1: expected initial ad-hoc submission" "$out"
node_calls="$(wc -l < "$NODE_LOG")"
[ "$node_calls" -eq 1 ] || fail "tick 1: expected exactly one node call, got $node_calls" "$(cat "$NODE_LOG")"

fp="$(awk -F '\t' '$1 == "queue-submitted" && $2 == "907" { print $3 }' "$TMP/ledger.tsv")"
[ -n "$fp" ] || fail "could not read queue-submitted fingerprint" "$(cat "$TMP/ledger.tsv")"

git init --bare "$TMP/remote.git" >/dev/null
git init "$TMP/git-work" >/dev/null
git -C "$TMP/git-work" config user.email repro@example.test
git -C "$TMP/git-work" config user.name "Queue Repro"
printf 'stale\n' > "$TMP/git-work/file.txt"
git -C "$TMP/git-work" add file.txt
git -C "$TMP/git-work" commit -m stale >/dev/null
repair_branch="experiment/wf-failed-907/repair/g0.t0.a-repro"
git -C "$TMP/git-work" push "$TMP/remote.git" "HEAD:refs/heads/$repair_branch" >/dev/null
stale="$(git -C "$TMP/git-work" rev-parse HEAD)"
printf 'unpublished\n' > "$TMP/git-work/file.txt"
git -C "$TMP/git-work" commit -am unpublished >/dev/null
unpublished="$(git -C "$TMP/git-work" rev-parse HEAD)"

mkdir -p "$TMP/home/.invoker"
python3 - "$TMP/home/.invoker/invoker.db" "$fp" "$TMP/remote.git" "$repair_branch" "$unpublished" <<'PY'
import sqlite3
import sys

db_path, fingerprint, repo_url, repair_branch, unpublished = sys.argv[1:]
con = sqlite3.connect(db_path)
con.execute("create table workflows (id text primary key, name text, repo_url text, created_at text)")
con.execute("create table tasks (id text primary key, workflow_id text, status text, error text, branch text, commit_hash text, completed_at text)")
workflow_id = "wf-failed-907"
con.execute(
    "insert into workflows (id, name, repo_url, created_at) values (?, ?, ?, ?)",
    (workflow_id, f"admin-bypass-repair-pr-907-{fingerprint}", repo_url, "2026-07-31T04:48:16.489Z"),
)
con.execute(
    "insert into tasks (id, workflow_id, status, error, branch, commit_hash, completed_at) values (?, ?, ?, ?, ?, ?, ?)",
    (f"{workflow_id}/repair", workflow_id, "completed", "", repair_branch, unpublished, "2026-07-31T04:49:00.000Z"),
)
con.execute(
    "insert into tasks (id, workflow_id, status, error, branch, commit_hash, completed_at) values (?, ?, ?, ?, ?, ?, ?)",
    (
        f"{workflow_id}/safe-push",
        workflow_id,
        "failed",
        f"Error: Executor startup failed (ssh): fatal: invalid reference: {unpublished}",
        "experiment/wf-failed-907/safe-push/g0.t1.a-repro",
        "",
        "2026-07-31T04:50:00.000Z",
    ),
)
con.commit()
PY

out="$(run_cron)" || fail "tick 2 exited non-zero" "$out"
echo "$out" | grep -q "PR #907: upstream publication/reachability failure; not retrying" \
  || fail "tick 2: expected invalid-reference stop" "$out"
echo "$out" | grep -q "$unpublished" \
  || fail "tick 2: missing unpublished commit in stop reason" "$out"
echo "$out" | grep -q "refs/heads/$repair_branch resolves to $stale" \
  || fail "tick 2: missing stale remote branch proof" "$out"
node_calls="$(wc -l < "$NODE_LOG")"
[ "$node_calls" -eq 1 ] || fail "tick 2: invalid reference must not submit another task" "$(cat "$NODE_LOG")"
grep -q $'queue-unreachable\t907\t'"$fp"$':wf-failed-907:'"$unpublished" "$TMP/ledger.tsv" \
  || fail "tick 2: missing queue-unreachable marker" "$(cat "$TMP/ledger.tsv")"
comments="$(grep -c "^gh pr comment 907" "$FAKE_GH_STATE_DIR/calls.log" || true)"
[ "$comments" -eq 1 ] || fail "tick 2: expected one blocker comment, got $comments"

out="$(run_cron)" || fail "tick 3 exited non-zero" "$out"
node_calls="$(wc -l < "$NODE_LOG")"
[ "$node_calls" -eq 1 ] || fail "tick 3: invalid reference must still not submit another task" "$(cat "$NODE_LOG")"
comments="$(grep -c "^gh pr comment 907" "$FAKE_GH_STATE_DIR/calls.log" || true)"
[ "$comments" -eq 1 ] || fail "tick 3: blocker comment must be one-time, got $comments"

echo "[repro] passed"
