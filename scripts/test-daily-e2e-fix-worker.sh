#!/usr/bin/env bash
# Behavior test for scripts/cron-daily-e2e-fix.sh with the battery, the omp
# agent, gh, and git all stubbed. No network, no real agent, no real git.
#
# Covers, per the daily-e2e plan:
#   A. Dry-run logs the intended autofix/e2e-<slug> action for the FAILED suite
#      only (never the passed one), and mutates nothing (no omp, no ledger).
#   B. Open-PR dedup: a non-empty `gh pr list` for the head branch skips the suite
#      before omp runs.
#   C. INVOKER_DAILY_E2E_MAX_FIXES=0 yields zero attempted launches.
#   D. Flake filter: when the isolated single-suite re-run passes, no PR is opened
#      and no attempt is recorded.
#   E. A repeated failure launches omp exactly once and records one attempt.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORKER="$REPO_ROOT/scripts/cron-daily-e2e-fix.sh"
FAIL_SLUG="20-e2e-dry-run"
FAIL_BRANCH="autofix/e2e-$FAIL_SLUG"

SANDBOXES=()
cleanup() { local d; for d in ${SANDBOXES[@]+"${SANDBOXES[@]}"}; do rm -rf "$d"; done; return 0; }
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; [ -n "${2:-}" ] && { echo "----- worker log -----" >&2; cat "$2" >&2; }; exit 1; }

# Run the worker in a fresh sandbox. Control knobs are read from the caller's
# EXPORTED environment (env(1) inherits them): FAKE_GH_PRS, FAKE_OMP_EXIT,
# FAKE_RERUN_EXIT, INVOKER_PR_CRON_DRY_RUN, INVOKER_DAILY_E2E_MAX_FIXES.
# Sets the global `sb` to the sandbox path (must run directly, NOT in a command
# substitution, or SANDBOXES would be appended in a throwaway subshell). The
# worker's combined output is at "$sb/worker.log".
run_worker() {
  sb="$(mktemp -d "${TMPDIR:-/tmp}/repro-daily-e2e.XXXXXX")"
  SANDBOXES+=("$sb")
  mkdir -p "$sb/bin" "$sb/home" "$sb/checkout" "$sb/logs"

  cat > "$sb/bin/gh" <<'GH'
#!/usr/bin/env bash
# The worker only uses `gh pr list ... --json number`; echo the configured JSON.
printf '%s' "${FAKE_GH_PRS:-[]}"
GH
  cat > "$sb/bin/omp" <<'OMP'
#!/usr/bin/env bash
# One line per invocation (never echo $*: the -p prompt is multi-line).
echo invoked >> "${OMP_CALLS_FILE:?OMP_CALLS_FILE unset}"
exit "${FAKE_OMP_EXIT:-0}"
OMP
  cat > "$sb/bin/git" <<'GIT'
#!/usr/bin/env bash
# Fake git: branch isolation (reset/switch) succeeds against the temp checkout.
exit 0
GIT
  cat > "$sb/bin/rerun-stub" <<'RS'
#!/usr/bin/env bash
# Deterministic single-suite re-run for the flake filter.
exit "${FAKE_RERUN_EXIT:-1}"
RS
  chmod +x "$sb/bin/gh" "$sb/bin/omp" "$sb/bin/git" "$sb/bin/rerun-stub"

  # Seed the state TSV: one FAILED and one PASSED extended row (absolute paths).
  {
    printf 'extended\t%s/scripts/test-suites/required/20-e2e-dry-run.sh\tfailed\n' "$sb/checkout"
    printf 'extended\t%s/scripts/test-suites/required/10-vitest-workspace.sh\tpassed\n' "$sb/checkout"
  } > "$sb/state.tsv"

  env PATH="$sb/bin:$PATH" HOME="$sb/home" \
    OMP_CALLS_FILE="$sb/omp-calls" \
    INVOKER_OMP_COMMAND=omp \
    INVOKER_DAILY_E2E_SKIP_BATTERY=1 \
    INVOKER_DAILY_E2E_STATE_FILE="$sb/state.tsv" \
    INVOKER_DAILY_E2E_LEDGER="$sb/ledger.tsv" \
    INVOKER_DAILY_E2E_CRON_LOCK="$sb/lock" \
    INVOKER_DAILY_E2E_CHECKOUT="$sb/checkout" \
    INVOKER_DAILY_E2E_LOGDIR="$sb/logs" \
    INVOKER_DAILY_E2E_RERUN_CMD="$sb/bin/rerun-stub" \
    bash "$WORKER" > "$sb/worker.log" 2>&1 || true
}

reset_knobs() {
  unset FAKE_GH_PRS FAKE_OMP_EXIT FAKE_RERUN_EXIT \
        INVOKER_PR_CRON_DRY_RUN INVOKER_DAILY_E2E_MAX_FIXES 2>/dev/null || true
}

# ── A. Dry-run: intended action for the failed suite only, no mutation ────────
reset_knobs
export INVOKER_PR_CRON_DRY_RUN=1
export FAKE_GH_PRS='[]'
run_worker
grep -q "would open PR $FAIL_BRANCH (dry-run)" "$sb/worker.log" \
  || fail "A: dry-run did not log the intended PR action for the failed suite" "$sb/worker.log"
if grep -q "10-vitest-workspace" "$sb/worker.log"; then
  fail "A: the passed suite must never appear as an action target" "$sb/worker.log"
fi
grep -q "failing=1 " "$sb/worker.log" \
  || fail "A: expected exactly one failing suite in the summary" "$sb/worker.log"
[ ! -s "$sb/omp-calls" ] || fail "A: omp must not run in dry-run" "$sb/worker.log"
[ ! -s "$sb/ledger.tsv" ] || fail "A: dry-run must not write the ledger" "$sb/worker.log"
echo "  A ok: dry-run surfaces the failed suite only, mutates nothing"

# ── B. Open-PR dedup: existing PR on the head branch skips before omp ─────────
reset_knobs
export INVOKER_PR_CRON_DRY_RUN=0
export FAKE_GH_PRS='[{"number":1}]'
run_worker
grep -q "open PR on $FAIL_BRANCH already in review; skip" "$sb/worker.log" \
  || fail "B: did not skip on existing open PR" "$sb/worker.log"
[ ! -s "$sb/omp-calls" ] || fail "B: omp must not run when a PR already exists" "$sb/worker.log"
echo "  B ok: open-PR dedup short-circuits before omp"

# ── C. MAX_FIXES=0: zero attempted launches ──────────────────────────────────
reset_knobs
export INVOKER_PR_CRON_DRY_RUN=0
export FAKE_GH_PRS='[]'
export INVOKER_DAILY_E2E_MAX_FIXES=0
run_worker
grep -q "reached max fixes (0) this run; stopping" "$sb/worker.log" \
  || fail "C: did not stop at max fixes 0" "$sb/worker.log"
grep -q "attempted=0 " "$sb/worker.log" \
  || fail "C: expected attempted=0 in the summary" "$sb/worker.log"
[ ! -s "$sb/omp-calls" ] || fail "C: omp must not run when max fixes is 0" "$sb/worker.log"
echo "  C ok: max-fixes=0 launches nothing"

# ── D. Flake filter: isolated re-run passes -> no PR, no attempt recorded ─────
reset_knobs
export INVOKER_PR_CRON_DRY_RUN=0
export FAKE_GH_PRS='[]'
export FAKE_RERUN_EXIT=0
run_worker
grep -q "passed on isolated re-run (flake/already green); no PR" "$sb/worker.log" \
  || fail "D: flake filter did not treat a passing re-run as a flake" "$sb/worker.log"
[ ! -s "$sb/omp-calls" ] || fail "D: omp must not run on a flake" "$sb/worker.log"
[ ! -s "$sb/ledger.tsv" ] || fail "D: a flake must not record an attempt" "$sb/worker.log"
echo "  D ok: flake filter opens no PR and records no attempt"

# ── E. Repeated failure: omp launches once, one attempt recorded ─────────────
reset_knobs
export INVOKER_PR_CRON_DRY_RUN=0
export FAKE_GH_PRS='[]'
export FAKE_RERUN_EXIT=1
export FAKE_OMP_EXIT=0
run_worker
grep -q "omp opened PR on $FAIL_BRANCH" "$sb/worker.log" \
  || fail "E: omp launch did not report an opened PR" "$sb/worker.log"
[ -s "$sb/omp-calls" ] || fail "E: omp should have run on a repeated failure" "$sb/worker.log"
[ "$(wc -l < "$sb/omp-calls")" -eq 1 ] || fail "E: omp should launch exactly once" "$sb/worker.log"
awk -F '\t' -v s="$FAIL_SLUG" '$1=="daily-e2e-fix" && $2==s{f=1} END{exit f?0:1}' "$sb/ledger.tsv" \
  || fail "E: the attempt was not recorded in the ledger" "$sb/worker.log"
grep -q "attempted=1 opened=1" "$sb/worker.log" \
  || fail "E: expected attempted=1 opened=1 in the summary" "$sb/worker.log"
echo "  E ok: repeated failure launches omp once and records one attempt"

echo "PASS: cron-daily-e2e-fix.sh behavior verified (dry-run, dedup, max-fixes, flake, launch)"
exit 0
