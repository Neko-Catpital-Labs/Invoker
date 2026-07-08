#!/usr/bin/env bash
# TEMPORARY tooling — a stopgap daily job co-located with the Invoker owner that
# runs the FULL extended e2e battery once a day and, for every still-failing
# suite, launches an `omp` agent that repairs the tree and opens ONE schema-valid
# PR upstream (never auto-landed — a human reviews/merges).
#
# Unlike the once-per-tick */5 PR-maintenance crons (cron-coderabbit-address.sh,
# cron-pr-conflict-rebase.sh), this daily job processes EVERY failing suite in a
# single run: a per-suite omp failure logs and continues to the next suite rather
# than exiting the whole worker.
#
# Prerequisites on the owner host (same as the other PR crons): `gh auth login`
# as the PR author, `omp` on PATH with creds, and the extended battery's local
# infra (SSH targets, Playwright/xvfb, etc.). Missing infra makes those suites
# self-skip or fail locally exactly as a manual `pnpm test:all:extended` would.
#
# Source cron-pr-lib.sh AFTER `set -euo pipefail`; it provides log_line,
# cron_lock, gh_json, the ledger API, and the TARGET_REPO / PR_AUTHOR / DRY_RUN
# config constants.
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

# ---------------------------------------------------------------------------
# Configuration (all overridable via env)
# ---------------------------------------------------------------------------

# Bound on omp launches per run; also caps a runaway all-red battery.
MAX_FIXES="${INVOKER_DAILY_E2E_MAX_FIXES:-5}"
# Lifetime attempts per suite before we stop retrying (dedup key = suite slug).
MAX_ATTEMPTS="${INVOKER_DAILY_E2E_MAX_ATTEMPTS:-5}"
# Dedicated battery checkout, kept warm across runs.
CHECKOUT="${INVOKER_DAILY_E2E_CHECKOUT:-${HOME}/.invoker/daily-e2e-work/repo}"
# Per-run state TSV (mode<TAB>suite<TAB>status) written by run-all-tests.sh.
STATE_FILE="${INVOKER_DAILY_E2E_STATE_FILE:-${HOME}/.invoker/daily-e2e-work/state.tsv}"
# Durable append-only attempt ledger.
LEDGER_FILE="${INVOKER_DAILY_E2E_LEDGER:-${HOME}/.invoker/daily-e2e-fix-submissions.tsv}"
# Focused per-suite re-run logs.
LOGDIR="${INVOKER_DAILY_E2E_LOGDIR:-${HOME}/.invoker/daily-e2e-work/logs}"
OMP_CMD="${INVOKER_OMP_COMMAND:-omp}"
OMP_TIMEOUT="${INVOKER_DAILY_E2E_OMP_TIMEOUT:-45m}"

# Dedicated lock: do NOT share the */5 PR-cron lock, or this long daily run would
# starve the frequent PR crons (and vice versa). cron_lock reads $CRON_LOCK at
# call time, so reassigning it after sourcing the lib is honored.
CRON_LOCK="${INVOKER_DAILY_E2E_CRON_LOCK:-${TMPDIR:-/tmp}/invoker-daily-e2e.lock}"
cron_lock

ledger_init "$LEDGER_FILE"

TODAY="$(date -u +%Y-%m-%d)"

# ---------------------------------------------------------------------------
# Battery checkout: clone once, then hard-reset to origin/master and rebuild the
# app the extended battery (Playwright) needs. Mirrors prepare_checkout in the
# coderabbit worker, minus the PR-head checkout.
# ---------------------------------------------------------------------------

prepare_battery_checkout() {
  mkdir -p "$(dirname "$CHECKOUT")"
  if [ ! -d "$CHECKOUT/.git" ]; then
    rm -rf "$CHECKOUT"
    if ! gh repo clone "$TARGET_REPO" "$CHECKOUT" -- --quiet >/dev/null 2>&1; then
      log_line "battery checkout: clone of $TARGET_REPO failed"
      return 1
    fi
  fi
  if ! ( cd "$CHECKOUT" && git fetch origin --quiet && git reset --hard origin/master && git clean -fd ) >/dev/null 2>&1; then
    log_line "battery checkout: git fetch/reset/clean failed"
    return 1
  fi
  if ! ( cd "$CHECKOUT" && pnpm install --frozen-lockfile && pnpm --filter @invoker/ui build && pnpm --filter @invoker/app build ); then
    log_line "battery checkout: pnpm install/build failed"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Run the extended battery. A non-zero exit (suites failed) is EXPECTED and must
# not abort the worker, so capture it under set +e/set -e.
# ---------------------------------------------------------------------------

run_battery() {
  mkdir -p "$(dirname "$STATE_FILE")"
  rm -f "$STATE_FILE"
  local rc=0
  set +e
  ( cd "$CHECKOUT" && env INVOKER_TEST_ALL_EXTENDED=1 INVOKER_TEST_ALL_STATE_FILE="$STATE_FILE" bash scripts/run-all-tests.sh )
  rc=$?
  set -e
  log_line "extended battery finished (exit $rc)"
}

# ---------------------------------------------------------------------------
# Re-run a single suite in isolation for a clean focused log and a flake filter.
# INVOKER_DAILY_E2E_RERUN_CMD is a test seam: when set it is invoked as
# "$INVOKER_DAILY_E2E_RERUN_CMD <rel>" instead of the real suite.
# Returns the suite's exit status; output is captured to <logfile>.
# ---------------------------------------------------------------------------

rerun_suite() {
  local rel="$1" logfile="$2"
  if [ -n "${INVOKER_DAILY_E2E_RERUN_CMD:-}" ]; then
    ( cd "$CHECKOUT" && "$INVOKER_DAILY_E2E_RERUN_CMD" "$rel" ) >"$logfile" 2>&1
  else
    ( cd "$CHECKOUT" && bash "scripts/test-suites/$rel" ) >"$logfile" 2>&1
  fi
}

# ---------------------------------------------------------------------------
# The omp prompt: the failing suite IS the reproduction. Keep the diff in one
# review lane and open exactly one PR upstream via create-pr.mjs.
# ---------------------------------------------------------------------------

build_prompt() {
  # build_prompt <rel> <slug> <branch> <ctx_file>
  local rel="$1" slug="$2" branch="$3" ctx="$4"
  cat <<EOF
You are fixing a failing end-to-end test suite in a fresh checkout of $TARGET_REPO.
HEAD is already on branch $branch (base: origin/master); opening the PR via the
create-pr CLI publishes that branch.

Context JSON: $ctx
Fields: .suite (the failing suite's repo-relative path), .slug, .branch, .base,
        .targetRepo, .log (the captured failing run log from this session).

The failing suite scripts/test-suites/$rel IS the reproduction. Do this, in order:

1. Run it and confirm it fails:  bash scripts/test-suites/$rel
   Read its captured log at the .log path for the failure detail. If the suite
   PASSES, make NO commit and exit 0 (nothing to fix).
2. Diagnose the root cause across the suite, the scripts it calls, and the product
   code it exercises. Implement the MINIMAL fix so 'bash scripts/test-suites/$rel'
   exits 0. Do NOT weaken, skip, or delete the assertion to make it pass.
3. Keep the ENTIRE diff inside ONE review lane (scope rules in
   scripts/validate-pr-body.mjs): packages/ -> product -> lane 'behavior' or
   'refactor'; scripts/ -> 'policy'; scripts/repro/ -> 'proof'; skills, docs, and
   *.md -> 'docs'. Do NOT mix lanes. A new scripts/repro/ file is usually
   unnecessary — the suite already reproduces.
4. If the fix unavoidably touches UI-impacting paths (packages/ui/,
   packages/app/src/window/, main.ts, preload.ts, app-menu.ts), follow the
   skills/visual-proof skill and add a '## Visual Proof' section to the PR body.
   Otherwise avoid those paths.
5. Author the PR body:  cp scripts/pr-body-template.md <tmp>  then fill EVERY
   required section (## Summary, ## Review Claim, ## Review Lane, ## Review Unit,
   ## Safety Invariant, ## Slice Rationale, ## Non-goals, ## Test Plan, ## Revert
   Plan). Set ## Review Lane to the single matching lane. Validate and iterate:
   node scripts/validate-pr-body.mjs --body-file <tmp>  until it exits 0.
6. Commit the fix on the current branch ($branch), then open EXACTLY ONE PR
   upstream:
   node scripts/create-pr.mjs --title "<title>" --base master --body-file <tmp>
   Do NOT land, merge, run 'mergify stack push', or add labels. If you CANNOT make
   the suite pass, make no commit and exit non-zero.
EOF
}

# ---------------------------------------------------------------------------
# Launch omp for one failing suite in the isolated branch. Returns omp's exit
# status. Mirrors launch_omp in the coderabbit worker (ctx-file JSON, omp flags,
# timeout wrap).
# ---------------------------------------------------------------------------

launch_omp_for_suite() {
  # launch_omp_for_suite <rel> <slug> <branch> <logfile>
  local rel="$1" slug="$2" branch="$3" logfile="$4"

  local ctx_file
  ctx_file="$(mktemp -t invoker-daily-e2e-ctx.XXXXXX)"
  jq -n --arg suite "scripts/test-suites/$rel" --arg slug "$slug" \
        --arg branch "$branch" --arg base "master" \
        --arg targetRepo "$TARGET_REPO" --arg log "$logfile" '
    { suite: $suite, slug: $slug, branch: $branch, base: $base,
      targetRepo: $targetRepo, log: $log }
  ' > "$ctx_file"

  local prompt
  prompt="$(build_prompt "$rel" "$slug" "$branch" "$ctx_file")"
  local omp_args=(--no-title --auto-approve)
  [ -n "${INVOKER_PR_CRON_OMP_MODEL:-}" ] && omp_args+=(--model "$INVOKER_PR_CRON_OMP_MODEL")
  omp_args+=(-p "$prompt")

  local omp_run=("$OMP_CMD" "${omp_args[@]}")
  if command -v timeout >/dev/null 2>&1; then
    omp_run=(timeout --kill-after=1m "$OMP_TIMEOUT" "$OMP_CMD" "${omp_args[@]}")
  fi

  log_line "suite $rel: launching omp on $CHECKOUT (branch $branch)"
  local rc=0
  ( cd "$CHECKOUT" && "${omp_run[@]}" ) || rc=$?
  rm -f "$ctx_file"
  return "$rc"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if [ "${INVOKER_DAILY_E2E_SKIP_BATTERY:-0}" != "1" ]; then
  if ! prepare_battery_checkout; then
    log_line "battery checkout preparation failed; exiting"
    exit 1
  fi
  run_battery
else
  log_line "INVOKER_DAILY_E2E_SKIP_BATTERY=1: using pre-seeded state file $STATE_FILE"
fi

if [ ! -f "$STATE_FILE" ]; then
  log_line "no state file at $STATE_FILE; nothing to do"
  exit 0
fi

attempted=0
failing_count=0
skipped_dedup=0
opened=0

while IFS= read -r suite; do
  [ -z "$suite" ] && continue
  failing_count=$((failing_count + 1))

  rel="${suite##*/scripts/test-suites/}"
  slug="$(basename "$rel" .sh | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '-' | sed -e 's/^-*//' -e 's/-*$//')"
  branch="autofix/e2e-$slug"

  # Bound on omp launches this run (counts launches; break when reached).
  if [ "$attempted" -ge "$MAX_FIXES" ]; then
    log_line "reached max fixes ($MAX_FIXES) this run; stopping"
    break
  fi

  # Same-day idempotency: never attempt the same suite twice in one calendar day.
  if ledger_marker_seen daily-e2e-fix "$slug" "$TODAY"; then
    log_line "suite $rel: already attempted today; skip"
    skipped_dedup=$((skipped_dedup + 1))
    continue
  fi

  # Open-PR dedup (primary): a fix is already in review for this suite's branch.
  open_prs="$(gh_json pr list --repo "$TARGET_REPO" --author "$PR_AUTHOR" --state open \
    --head "$branch" --json number 2>/dev/null || printf '[]')"
  if [ "$(printf '%s' "$open_prs" | jq 'length' 2>/dev/null || printf '0')" -gt 0 ]; then
    log_line "suite $rel: open PR on $branch already in review; skip"
    skipped_dedup=$((skipped_dedup + 1))
    continue
  fi

  # Lifetime attempt cap: stop retrying a suite we can never fix automatically.
  if [ "$(ledger_count daily-e2e-fix "$slug")" -ge "$MAX_ATTEMPTS" ]; then
    log_line "suite $rel: hit lifetime attempt cap ($MAX_ATTEMPTS); skip"
    skipped_dedup=$((skipped_dedup + 1))
    continue
  fi

  # Dry-run seam: log the intended action, mutate nothing (no ledger, omp, or gh).
  if [ "$DRY_RUN" = "1" ]; then
    log_line "suite $rel: would open PR $branch (dry-run)"
    continue
  fi

  # Isolate the fix branch off a clean origin/master.
  if ! ( cd "$CHECKOUT" && git reset --hard origin/master >/dev/null 2>&1 && git switch -C "$branch" >/dev/null 2>&1 ); then
    log_line "suite $rel: failed to isolate branch $branch; skip"
    continue
  fi

  # Flake filter: re-run the one suite in isolation. If it now passes, it was a
  # flake (or already fixed) — record nothing and open no PR.
  mkdir -p "$LOGDIR"
  log="$LOGDIR/$slug.log"
  if rerun_suite "$rel" "$log"; then
    log_line "suite $rel: passed on isolated re-run (flake/already green); no PR"
    continue
  fi

  # Count the attempt (incl. omp failures) so repeated failures hit the cap.
  ledger_record daily-e2e-fix "$slug" "$TODAY"
  attempted=$((attempted + 1))

  if launch_omp_for_suite "$rel" "$slug" "$branch" "$log"; then
    opened=$((opened + 1))
    log_line "suite $rel: omp opened PR on $branch"
  else
    log_line "suite $rel: omp exited non-zero; no PR this run (retry a future day)"
  fi
done < <(awk -F '\t' '$1=="extended" && $3=="failed"{print $2}' "$STATE_FILE")

log_line "daily-e2e summary: failing=$failing_count skipped-dedup=$skipped_dedup attempted=$attempted opened=$opened"
