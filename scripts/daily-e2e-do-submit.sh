#!/usr/bin/env bash
# Twice-daily worker (runs on the DO droplet "do1" via cron): refresh the
# checkout to origin/master, run the FULL extended e2e battery, and for every
# still-failing suite submit ONE single-task Invoker plan.
#
# This script does NOT fix anything or open PRs itself. It hands each failing
# suite to Invoker as a plan with `onFinish: pull_request`. Invoker's own
# auto-fix then repairs the suite with the configured agent and opens exactly
# one PR per failing suite. Fix + PR + retry budget all live in Invoker.
#
# Enabling the fix is a do1 config concern, not this script's: set
# `autoFixRetries` > 0 and `autoFixAgent: "omp"` in ~/.invoker/config.json. With
# autoFixRetries=0 the plans still submit and run the suites, but Invoker never
# dispatches the agent.
#
# Test seams: INVOKER_DAILY_E2E_SKIP_BATTERY=1 skips the refresh+battery and
# reuses a pre-seeded state file; INVOKER_DAILY_E2E_SUBMIT_CMD overrides the
# submit binary; INVOKER_DAILY_E2E_DRY_RUN=1 logs intended submissions only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

STATE_FILE="${INVOKER_DAILY_E2E_STATE_FILE:-${TMPDIR:-/tmp}/daily-e2e-do-state.tsv}"
WORK_DIR="${INVOKER_DAILY_E2E_WORK_DIR:-${TMPDIR:-/tmp}/daily-e2e-do}"
SUBMIT_CMD="${INVOKER_DAILY_E2E_SUBMIT_CMD:-$REPO_ROOT/submit-plan.sh}"
DRY_RUN="${INVOKER_DAILY_E2E_DRY_RUN:-0}"
BASE_BRANCH="${INVOKER_DAILY_E2E_BASE:-master}"
REPO_URL="${INVOKER_DAILY_E2E_REPO_URL:-$(git remote get-url origin 2>/dev/null || echo .)}"
# Skip a suite already submitted within this many minutes, so the second daily
# run does not open a duplicate PR while the morning fix is still in review.
RESUBMIT_GUARD_MIN="${INVOKER_DAILY_E2E_RESUBMIT_GUARD_MIN:-1200}"

log() { printf '[daily-e2e-do %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# 1. Refresh to latest master and rebuild the app (the extended battery's
#    Playwright suite needs the built app), then run the battery.
if [ "${INVOKER_DAILY_E2E_SKIP_BATTERY:-0}" != "1" ]; then
  log "refreshing checkout to origin/$BASE_BRANCH"
  git fetch origin --quiet
  git reset --hard "origin/$BASE_BRANCH"
  git clean -fd
  pnpm install --frozen-lockfile
  pnpm --filter @invoker/ui build
  pnpm --filter @invoker/app build

  rm -f "$STATE_FILE"
  mkdir -p "$(dirname "$STATE_FILE")"
  log "running extended e2e battery"
  set +e
  env INVOKER_TEST_ALL_EXTENDED=1 INVOKER_TEST_ALL_STATE_FILE="$STATE_FILE" bash scripts/run-all-tests.sh
  log "battery finished (exit $?)"
  set -e
else
  log "INVOKER_DAILY_E2E_SKIP_BATTERY=1: reusing state file $STATE_FILE"
fi

if [ ! -f "$STATE_FILE" ]; then
  log "no state file at $STATE_FILE; nothing to do"
  exit 0
fi

# 2. One single-task fix plan per failing extended suite.
mkdir -p "$WORK_DIR"
failing=0
submitted=0
skipped=0

while IFS= read -r suite; do
  [ -n "$suite" ] || continue
  failing=$((failing + 1))

  rel="${suite##*/scripts/test-suites/}"
  slug="$(basename "$rel" .sh | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '-' | sed -e 's/^-*//' -e 's/-*$//')"

  # Resubmit guard: skip if we submitted this suite recently.
  marker="$WORK_DIR/submitted-$slug"
  if [ -n "$(find "$marker" -mmin "-$RESUBMIT_GUARD_MIN" 2>/dev/null)" ]; then
    log "suite $rel: submitted within ${RESUBMIT_GUARD_MIN}m; skip"
    skipped=$((skipped + 1))
    continue
  fi

  plan="$WORK_DIR/e2e-$slug.yaml"
  cat > "$plan" <<YAML
name: "Daily e2e fix: $rel"
description: "Repair the failing extended e2e suite $rel (submitted by the do1 twice-daily worker)."
repoUrl: $REPO_URL
baseBranch: $BASE_BRANCH
onFinish: pull_request
tasks:
  - id: e2e-fix-$slug
    description: "Make 'bash scripts/test-suites/$rel' exit 0 by fixing the root cause. Do not weaken, skip, or delete assertions."
    command: bash scripts/test-suites/$rel
YAML

  if [ "$DRY_RUN" = "1" ]; then
    log "suite $rel: would submit fix plan $plan"
    continue
  fi

  log "suite $rel: submitting fix plan"
  if ( "$SUBMIT_CMD" "$plan" ); then
    : > "$marker"
    submitted=$((submitted + 1))
    log "suite $rel: submitted to Invoker"
  else
    log "suite $rel: submit failed (continuing to next suite)"
  fi
done < <(awk -F '\t' '$1=="extended" && $3=="failed"{print $2}' "$STATE_FILE")

log "summary: failing=$failing submitted=$submitted skipped=$skipped"
