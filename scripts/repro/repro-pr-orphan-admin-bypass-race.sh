#!/usr/bin/env bash
# Battle-test: an admin-bypass-labeled PR must be left ENTIRELY to
# admin-bypass-land (scripts/cron-pr-admin-bypass-land.sh); orphan-repair must
# not also act on it, even when it's unmapped and has a real failing required
# check.
#
# Fixture pr-orphan-admin-bypass.json (#6106): open, non-draft, unmapped
# (review-gate stub resolves nothing for it), admin-bypass labeled,
# mergeable/mergeStateStatus clean, one failing required check
# ("quality / TypeScript Types"). Without the admin-bypass skip, orphan-repair
# classifies the failing check as a blocker and submits a repair task — racing
# scripts/mergify_admin_requeue.py, which independently detects the same
# failing check via its own `--label admin-bypass` query and produces a
# `repair_check` action (see test_failed_check_triggers_repair in
# scripts/test_mergify_admin_requeue_plan.py). This repro asserts orphan-repair
# skips it and defers to admin-bypass-land instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-orphan-admin-bypass.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home" "$TMP/plans"
export FAKE_GH_STATE_DIR="$TMP/state"
cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/pr-orphan-admin-bypass.json" "$FAKE_GH_STATE_DIR/state.json"

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"; : > "$NODE_LOG"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node %s\n' "\$*" >> "$NODE_LOG"
exit 0
EOF
chmod +x "$TMP/bin/node"

# Review-gate stub: #6106 is unmapped everywhere (admin-bypass-land owns it by
# label alone, not by workflow mapping).
cat > "$TMP/review-gate.sh" <<'RG'
#!/usr/bin/env bash
printf '{}\n'
RG
chmod +x "$TMP/review-gate.sh"

run_cron() {
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_PR_CRON_AUTHOR="fake-bot" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_PR_ORPHAN_STATE_FILE="$TMP/ledger.tsv" \
  INVOKER_PR_ORPHAN_PLAN_DIR="$TMP/plans" \
  INVOKER_PR_ORPHAN_MAX_ATTEMPTS=3 \
  bash "$ROOT/scripts/cron-pr-orphan-repair.sh" 2>&1
}

out="$(run_cron)" || fail "tick exited non-zero" "$out"
echo "$out" | grep -q "PR #6106: admin-bypass labeled; admin-bypass-land owns it" \
  || fail "expected orphan-repair to skip the admin-bypass labeled PR and defer to admin-bypass-land" "$out"
echo "$out" | grep -q "PR #6106: submitted repair task" \
  && fail "orphan-repair must NOT submit a repair task for an admin-bypass labeled PR" "$out"

runs="$(grep -c "exec -- run " "$NODE_LOG" || true)"
[ "$runs" -eq 0 ] || fail "expected zero repair-task submissions for #6106, got $runs" "$(cat "$NODE_LOG")"

plan="$TMP/plans/repair-pr-6106.yaml"
[ -f "$plan" ] && fail "orphan-repair must not generate a plan file for an admin-bypass labeled PR" "$(cat "$plan")"

echo "[repro] passed"
