#!/usr/bin/env bash
# Behavior test for scripts/daily-e2e-do-submit.sh with the battery and the
# Invoker submit path stubbed. No build, no real Invoker, no network.
#
# Covers:
#   A. Dry-run: logs an intended submission for the FAILED suite only (never the
#      passed one) and never calls the submit command; the generated plan YAML is
#      a valid single-task plan with onFinish: pull_request.
#   B. Real run: submits exactly once for the failing suite and records a marker.
#   C. Resubmit guard: a fresh marker makes the suite skip (no submit).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORKER="$REPO_ROOT/scripts/daily-e2e-do-submit.sh"
FAIL_REL="required/20-e2e-dry-run.sh"
FAIL_SLUG="20-e2e-dry-run"

SANDBOXES=()
cleanup() { local d; for d in ${SANDBOXES[@]+"${SANDBOXES[@]}"}; do rm -rf "$d"; done; return 0; }
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; [ -n "${2:-}" ] && { echo "----- log -----" >&2; cat "$2" >&2; }; exit 1; }

# Run the worker in a fresh sandbox. Sets globals: sb (sandbox), calls (submit
# call-record file), log (worker output). Control via exported env:
# INVOKER_DAILY_E2E_DRY_RUN, and a pre-touched marker for the guard scenario.
run_worker() {
  sb="$(mktemp -d "${TMPDIR:-/tmp}/test-daily-e2e-do.XXXXXX")"
  SANDBOXES+=("$sb")
  mkdir -p "$sb/bin" "$sb/work"
  calls="$sb/submit-calls"

  # Stub submit command: record each plan path it was handed.
  cat > "$sb/bin/submit-stub" <<STUB
#!/usr/bin/env bash
echo "\$1" >> "$calls"
exit 0
STUB
  chmod +x "$sb/bin/submit-stub"

  # Seed state: one FAILED and one PASSED extended row (absolute paths).
  cat > "$sb/state.tsv" <<TSV
extended	/x/scripts/test-suites/$FAIL_REL	failed
extended	/x/scripts/test-suites/required/10-vitest-workspace.sh	passed
TSV

  log="$sb/worker.log"
  env \
    INVOKER_DAILY_E2E_SKIP_BATTERY=1 \
    INVOKER_DAILY_E2E_STATE_FILE="$sb/state.tsv" \
    INVOKER_DAILY_E2E_WORK_DIR="$sb/work" \
    INVOKER_DAILY_E2E_SUBMIT_CMD="$sb/bin/submit-stub" \
    INVOKER_DAILY_E2E_REPO_URL="git@github.com:Neko-Catpital-Labs/Invoker.git" \
    bash "$WORKER" > "$log" 2>&1 || true
}

# ── A. Dry-run: failing suite only, no submit, valid plan YAML ────────────────
unset INVOKER_DAILY_E2E_DRY_RUN 2>/dev/null || true
export INVOKER_DAILY_E2E_DRY_RUN=1
run_worker
grep -q "suite $FAIL_REL: would submit fix plan" "$log" \
  || fail "A: dry-run did not log intended submission for the failed suite" "$log"
if grep -q "10-vitest-workspace" "$log"; then
  fail "A: the passed suite must never be a submission target" "$log"
fi
[ ! -s "$calls" ] || fail "A: submit command must not run in dry-run" "$log"
plan="$sb/work/e2e-$FAIL_SLUG.yaml"
[ -f "$plan" ] || fail "A: expected plan YAML at $plan" "$log"
PLAN="$plan" FAIL_REL="$FAIL_REL" FAIL_SLUG="$FAIL_SLUG" node -e '
const YAML = require("yaml");
const fs = require("fs");
const d = YAML.parse(fs.readFileSync(process.env.PLAN, "utf8"));
const t = d.tasks;
if (d.onFinish !== "pull_request") throw new Error("onFinish=" + d.onFinish);
if (d.baseBranch !== "master") throw new Error("baseBranch=" + d.baseBranch);
if (!Array.isArray(t) || t.length !== 1) throw new Error("expected one task");
if (t[0].command !== "bash scripts/test-suites/" + process.env.FAIL_REL) throw new Error("command=" + t[0].command);
if (t[0].id !== "e2e-fix-" + process.env.FAIL_SLUG) throw new Error("id=" + t[0].id);
' >/dev/null || fail "A: generated plan YAML is not the expected single-task shape" "$log"
echo "  A ok: dry-run targets the failed suite only; plan YAML valid"

# ── B. Real run: submits once, records marker ─────────────────────────────────
unset INVOKER_DAILY_E2E_DRY_RUN
export INVOKER_DAILY_E2E_DRY_RUN=0
run_worker
[ "$(wc -l < "$calls")" -eq 1 ] || fail "B: expected exactly one submission" "$log"
grep -q "e2e-$FAIL_SLUG.yaml" "$calls" || fail "B: submitted the wrong plan" "$log"
[ -f "$sb/work/submitted-$FAIL_SLUG" ] || fail "B: resubmit marker not written" "$log"
grep -q "submitted=1" "$log" || fail "B: summary should report submitted=1" "$log"
echo "  B ok: submits once for the failing suite and records a marker"

# ── C. Resubmit guard: fresh marker -> skip ───────────────────────────────────
export INVOKER_DAILY_E2E_DRY_RUN=0
run_worker                              # creates sandbox
touch "$sb/work/submitted-$FAIL_SLUG"   # pre-existing fresh marker
# Re-run in the SAME sandbox so the marker is seen.
env \
  INVOKER_DAILY_E2E_SKIP_BATTERY=1 \
  INVOKER_DAILY_E2E_STATE_FILE="$sb/state.tsv" \
  INVOKER_DAILY_E2E_WORK_DIR="$sb/work" \
  INVOKER_DAILY_E2E_SUBMIT_CMD="$sb/bin/submit-stub" \
  bash "$WORKER" > "$sb/worker2.log" 2>&1 || true
grep -q "submitted within" "$sb/worker2.log" \
  || fail "C: fresh marker did not trigger the resubmit guard" "$sb/worker2.log"
grep -q "skipped=1" "$sb/worker2.log" || fail "C: summary should report skipped=1" "$sb/worker2.log"
echo "  C ok: resubmit guard skips a recently submitted suite"

echo "PASS: daily-e2e-do-submit.sh behavior verified (dry-run, submit, resubmit-guard)"
exit 0
