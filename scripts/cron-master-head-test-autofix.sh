#!/usr/bin/env bash
# Run the full destructive suite against upstream master and open one repair PR
# only when an OMP-authored fix makes the same suite pass.
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/cron-pr-lib.sh"

INVOKER_MASTER_HEAD_AUTOFIX_REPO_URL="${INVOKER_MASTER_HEAD_AUTOFIX_REPO_URL:-git@github.com:Neko-Catpital-Labs/Invoker.git}"
INVOKER_MASTER_HEAD_AUTOFIX_REPO_SLUG="${INVOKER_MASTER_HEAD_AUTOFIX_REPO_SLUG:-Neko-Catpital-Labs/Invoker}"
INVOKER_MASTER_HEAD_AUTOFIX_BASE_BRANCH="${INVOKER_MASTER_HEAD_AUTOFIX_BASE_BRANCH:-master}"
INVOKER_MASTER_HEAD_AUTOFIX_WORKDIR="${INVOKER_MASTER_HEAD_AUTOFIX_WORKDIR:-$HOME/.invoker/master-head-test-autofix}"
INVOKER_MASTER_HEAD_AUTOFIX_STATE_FILE="${INVOKER_MASTER_HEAD_AUTOFIX_STATE_FILE:-$HOME/.invoker/master-head-test-autofix.tsv}"
INVOKER_MASTER_HEAD_AUTOFIX_MAX_ATTEMPTS="${INVOKER_MASTER_HEAD_AUTOFIX_MAX_ATTEMPTS:-3}"
INVOKER_MASTER_HEAD_AUTOFIX_OMP_MODEL="${INVOKER_MASTER_HEAD_AUTOFIX_OMP_MODEL:-openai-codex/gpt-5.3-codex-spark}"
INVOKER_MASTER_HEAD_AUTOFIX_OMP_TIMEOUT_SECONDS="${INVOKER_MASTER_HEAD_AUTOFIX_OMP_TIMEOUT_SECONDS:-7200}"
INVOKER_MASTER_HEAD_AUTOFIX_TEST_TIMEOUT_SECONDS="${INVOKER_MASTER_HEAD_AUTOFIX_TEST_TIMEOUT_SECONDS:-3600}"
INVOKER_MASTER_HEAD_AUTOFIX_CONFIRM_FAILURE="${INVOKER_MASTER_HEAD_AUTOFIX_CONFIRM_FAILURE:-1}"
INVOKER_MASTER_HEAD_AUTOFIX_TEST_COMMAND="${INVOKER_MASTER_HEAD_AUTOFIX_TEST_COMMAND:-pnpm run test:all:destructive}"
INVOKER_MASTER_HEAD_AUTOFIX_RUN_RETENTION="${INVOKER_MASTER_HEAD_AUTOFIX_RUN_RETENTION:-10}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="$INVOKER_MASTER_HEAD_AUTOFIX_WORKDIR/runs/$RUN_ID"
CHECKOUT_DIR="$RUN_DIR/checkout"
LOG_DIR="$RUN_DIR/logs"
VISUAL_PROOF_DIR="$RUN_DIR/visual-proof"

cron_lock
ledger_init "$INVOKER_MASTER_HEAD_AUTOFIX_STATE_FILE"
mkdir -p "$CHECKOUT_DIR" "$LOG_DIR" "$VISUAL_PROOF_DIR"

infrastructure_unavailable() {
  log_line "infrastructure unavailable: $1"
  exit 1
}

# Bound disk usage: each run keeps a full clone + node_modules + logs + visual
# proof under runs/<RUN_ID>. Keep only the newest N run directories (RUN_ID is a
# UTC timestamp, so lexical order == chronological), deleting the rest. Runs
# after cron_lock so only the worker holding a slot prunes, and before the
# clone so a nearly-full disk is reclaimed before the heavy work.
prune_old_run_dirs() {
  local runs_dir="$INVOKER_MASTER_HEAD_AUTOFIX_WORKDIR/runs"
  local keep="$INVOKER_MASTER_HEAD_AUTOFIX_RUN_RETENTION"
  [ "$keep" -ge 1 ] 2>/dev/null || return 0
  [ -d "$runs_dir" ] || return 0
  local victim
  while IFS= read -r victim; do
    [ -n "$victim" ] || continue
    log_line "pruning old run dir $victim"
    rm -rf -- "$victim"
  done < <(find "$runs_dir" -mindepth 1 -maxdepth 1 -type d | sort | head -n "-${keep}")
}

preflight() {
  local tool
  for tool in git gh node pnpm omp docker; do
    command -v "$tool" >/dev/null 2>&1 || infrastructure_unavailable "$tool"
  done
  docker info >/dev/null 2>&1 || infrastructure_unavailable "docker"
  omp models >/dev/null 2>&1 || infrastructure_unavailable "omp-auth"
}

configure_git_identity_if_missing() {
  git config user.name >/dev/null 2>&1 || git config user.name "Invoker Cron"
  git config user.email >/dev/null 2>&1 || git config user.email "ci@invoker.dev"
}


cleanup_checkout_processes() {
  python3 - "$CHECKOUT_DIR" <<'PYCLEANUP'
import os
import signal
import sys
import time

checkout = os.path.realpath(sys.argv[1])
self_pid = os.getpid()

def matching_process_groups():
    groups = set()
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        pid = int(name)
        if pid == self_pid:
            continue
        try:
            raw = open(f'/proc/{pid}/cmdline', 'rb').read()
            cmd = raw.replace(b'\0', b' ').decode(errors='replace')
            cwd = os.path.realpath(os.readlink(f'/proc/{pid}/cwd'))
            pgid = os.getpgid(pid)
        except Exception:
            continue
        if checkout in cmd or cwd.startswith(checkout):
            groups.add(pgid)
    return groups

for sig in (signal.SIGTERM, signal.SIGKILL):
    groups = matching_process_groups()
    if not groups:
        break
    for pgid in groups:
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            pass
    time.sleep(2 if sig == signal.SIGTERM else 0)
PYCLEANUP
}

make_log_path() {
  local label="$1"
  printf '%s/%s-%s.log' "$LOG_DIR" "$(date -u +%Y%m%dT%H%M%SZ)" "$label"
}

run_full_tests() {
  local label="$1"
  local log_file="$2"
  local command="$INVOKER_MASTER_HEAD_AUTOFIX_TEST_COMMAND"

  log_line "$label: running $command"
  set +e
  if [ "$INVOKER_MASTER_HEAD_AUTOFIX_TEST_TIMEOUT_SECONDS" -gt 0 ]; then
    (
      cd "$CHECKOUT_DIR"
      run_with_optional_timeout "$INVOKER_MASTER_HEAD_AUTOFIX_TEST_TIMEOUT_SECONDS" \
        env \
          CI="${CI:-true}" \
          INVOKER_TEST_ALL_FORCE_RERUN="${INVOKER_TEST_ALL_FORCE_RERUN:-1}" \
          INVOKER_TEST_ALL_RESUME="${INVOKER_TEST_ALL_RESUME:-0}" \
          INVOKER_PLAYWRIGHT_WORKERS="${INVOKER_PLAYWRIGHT_WORKERS:-1}" \
          INVOKER_TEST_ALL_JOBS="${INVOKER_TEST_ALL_JOBS:-1}" \
          bash -c "$command"
    ) > "$log_file" 2>&1
  else
    (
      cd "$CHECKOUT_DIR"
      env \
        CI="${CI:-true}" \
        INVOKER_TEST_ALL_FORCE_RERUN="${INVOKER_TEST_ALL_FORCE_RERUN:-1}" \
        INVOKER_TEST_ALL_RESUME="${INVOKER_TEST_ALL_RESUME:-0}" \
        INVOKER_PLAYWRIGHT_WORKERS="${INVOKER_PLAYWRIGHT_WORKERS:-1}" \
        INVOKER_TEST_ALL_JOBS="${INVOKER_TEST_ALL_JOBS:-1}" \
        bash -c "$command"
    ) > "$log_file" 2>&1
  fi
  local code=$?
  cleanup_checkout_processes

  if [ "$code" -eq 0 ] && grep -Eq 'Skipped unavailable:[[:space:]]*[1-9][0-9]*' "$log_file"; then
    log_line "$label: infrastructure unavailable: skipped suite in $log_file"
    return 125
  fi

  if [ "$code" -eq 0 ]; then
    log_line "$label: passed; log $log_file"
  else
    log_line "$label: failed with exit $code; log $log_file"
  fi
  return "$code"
}

build_prompt() {
  local base_sha="$1"
  local failing_log="$2"
  cat <<PROMPT
Repo: $INVOKER_MASTER_HEAD_AUTOFIX_REPO_SLUG
Base branch: $INVOKER_MASTER_HEAD_AUTOFIX_BASE_BRANCH
Exact base SHA: $base_sha
Failing command: $INVOKER_MASTER_HEAD_AUTOFIX_TEST_COMMAND
Failing log path: $failing_log

Required behavior:
- Fix only the failing test run shown in the log.
- Preserve unrelated code.
- Run targeted checks as needed.
- Leave the final full test rerun to this cron script.
- Do not create the PR manually.
PROMPT
}

run_omp() {
  local prompt="$1"
  local omp_cmd="${INVOKER_OMP_COMMAND:-omp}"
  log_line "launching omp on $CHECKOUT_DIR"
  if [ "$INVOKER_MASTER_HEAD_AUTOFIX_OMP_TIMEOUT_SECONDS" -gt 0 ]; then
    (
      cd "$CHECKOUT_DIR"
      run_with_optional_timeout "$INVOKER_MASTER_HEAD_AUTOFIX_OMP_TIMEOUT_SECONDS" \
        "$omp_cmd" --no-title --auto-approve --model "$INVOKER_MASTER_HEAD_AUTOFIX_OMP_MODEL" -p "$prompt"
    )
  else
    (
      cd "$CHECKOUT_DIR"
      "$omp_cmd" --no-title --auto-approve --model "$INVOKER_MASTER_HEAD_AUTOFIX_OMP_MODEL" -p "$prompt"
    )
  fi
}

ui_impacting_files() {
  local changed_file_list="$1"
  (
    cd "$CHECKOUT_DIR"
    node --input-type=module - "$changed_file_list" <<'NODE'
import { readFileSync } from 'node:fs';
import { getUiImpactingFiles } from './scripts/create-pr.mjs';

const listPath = process.argv[2];
const files = readFileSync(listPath, 'utf8').split('\n').filter(Boolean);
process.stdout.write(getUiImpactingFiles(files).join('\n'));
NODE
  )
}

first_visual_proof_png() {
  find "$VISUAL_PROOF_DIR" -type f -name '*.png' | sort | sed -n '1p'
}

test_plan_command_text() {
  printf 'CI=%s INVOKER_TEST_ALL_FORCE_RERUN=%s INVOKER_TEST_ALL_RESUME=%s INVOKER_PLAYWRIGHT_WORKERS=%s INVOKER_TEST_ALL_JOBS=%s %s' \
    "${CI:-true}" \
    "${INVOKER_TEST_ALL_FORCE_RERUN:-1}" \
    "${INVOKER_TEST_ALL_RESUME:-0}" \
    "${INVOKER_PLAYWRIGHT_WORKERS:-1}" \
    "${INVOKER_TEST_ALL_JOBS:-1}" \
    "$INVOKER_MASTER_HEAD_AUTOFIX_TEST_COMMAND"
}

write_pr_body() {
  local body_file="$1"
  local base_sha="$2"
  local pass_log="$3"
  local fix_sha="$4"
  local visual_png="${5:-}"
  local test_command_text
  test_command_text="$(test_plan_command_text)"

  cat > "$body_file" <<BODY
## Summary

The master-head test cron found a failing full destructive test run and this PR fixes it.

The failing base was $base_sha. The fixed branch reran $INVOKER_MASTER_HEAD_AUTOFIX_TEST_COMMAND successfully.

<details>
<summary>Review metadata</summary>

Review Claim: This PR fixes the full destructive test run from upstream master $base_sha.

Review Lane: behavior

Review Unit: tooling-policy

Safety Invariant: The branch is based on origin/master $base_sha and the passing rerun log is $pass_log.

Slice Rationale: One cron run creates one repair PR so review maps to one failing master-head run.

</details>

## Non-goals

This PR does not change cron scheduling or unrelated tests.

## Test Plan

- [x] \`$test_command_text\`
BODY

  if [ -n "$visual_png" ]; then
    cat >> "$body_file" <<BODY

## Visual Proof

![Visual proof]($visual_png)
BODY
  fi

  cat >> "$body_file" <<BODY

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert $fix_sha\`
- Post-revert steps: None
- Data migration? No
BODY
}

prune_old_run_dirs

preflight

log_line "cloning $INVOKER_MASTER_HEAD_AUTOFIX_REPO_URL into $CHECKOUT_DIR"
git clone --origin origin "$INVOKER_MASTER_HEAD_AUTOFIX_REPO_URL" "$CHECKOUT_DIR"
(
  cd "$CHECKOUT_DIR"
  git fetch origin "$INVOKER_MASTER_HEAD_AUTOFIX_BASE_BRANCH"
  git switch --detach "origin/$INVOKER_MASTER_HEAD_AUTOFIX_BASE_BRANCH"
  configure_git_identity_if_missing
)

BASE_SHA="$(cd "$CHECKOUT_DIR" && git rev-parse HEAD)"
SHORT_SHA="$(cd "$CHECKOUT_DIR" && git rev-parse --short HEAD)"
log_line "testing origin/$INVOKER_MASTER_HEAD_AUTOFIX_BASE_BRANCH at $BASE_SHA"

log_line "installing dependencies"
(
  cd "$CHECKOUT_DIR"
  pnpm install --frozen-lockfile
)

FIRST_LOG="$(make_log_path first)"
set +e
run_full_tests first "$FIRST_LOG"
FIRST_STATUS=$?
set -e
if [ "$FIRST_STATUS" -eq 0 ]; then
  ledger_record green "$BASE_SHA" "$(date +%s)"
  exit 0
fi
if [ "$FIRST_STATUS" -eq 125 ]; then
  exit 1
fi

FAILED_LOG="$FIRST_LOG"
if [ "$INVOKER_MASTER_HEAD_AUTOFIX_CONFIRM_FAILURE" = "1" ]; then
  CONFIRM_LOG="$(make_log_path confirm)"
  set +e
  run_full_tests confirm "$CONFIRM_LOG"
  CONFIRM_STATUS=$?
  set -e
  if [ "$CONFIRM_STATUS" -eq 0 ]; then
    ledger_record flake-green "$BASE_SHA" "$(date +%s)"
    exit 0
  fi
  if [ "$CONFIRM_STATUS" -eq 125 ]; then
    exit 1
  fi
  FAILED_LOG="$CONFIRM_LOG"
fi

ATTEMPTS="$(ledger_count master-head-attempt "$BASE_SHA")"
if [ "$ATTEMPTS" -ge "$INVOKER_MASTER_HEAD_AUTOFIX_MAX_ATTEMPTS" ]; then
  log_line "attempt cap reached for $BASE_SHA ($ATTEMPTS/$INVOKER_MASTER_HEAD_AUTOFIX_MAX_ATTEMPTS); not launching omp"
  exit 1
fi

if ledger_marker_seen master-head-pr "$BASE_SHA" created; then
  log_line "repair PR already exists for $BASE_SHA; exiting"
  exit 0
fi

BRANCH="cron/master-head-test-fix-$SHORT_SHA-$RUN_ID"
(
  cd "$CHECKOUT_DIR"
  git switch -c "$BRANCH" "$BASE_SHA"
)

PROMPT="$(build_prompt "$BASE_SHA" "$FAILED_LOG")"
set +e
run_omp "$PROMPT"
OMP_STATUS=$?
set -e
cleanup_checkout_processes
if [ "$OMP_STATUS" -ne 0 ]; then
  ledger_record master-head-attempt "$BASE_SHA" "omp-failed-$OMP_STATUS"
  exit 1
fi

if ( cd "$CHECKOUT_DIR" && [ -z "$(git status --porcelain --untracked-files=all)" ] ); then
  ledger_record master-head-attempt "$BASE_SHA" no-diff
  log_line "omp exited without changes; no PR created"
  exit 1
fi

RERUN_LOG="$(make_log_path rerun)"
set +e
run_full_tests rerun "$RERUN_LOG"
RERUN_STATUS=$?
set -e
if [ "$RERUN_STATUS" -ne 0 ]; then
  ledger_record master-head-attempt "$BASE_SHA" failed-rerun
  exit 1
fi

(
  cd "$CHECKOUT_DIR"
  git add -A
  git commit -m "Fix master HEAD full test failures"
)
FIX_SHA="$(cd "$CHECKOUT_DIR" && git rev-parse HEAD)"
CHANGED_FILE_LIST="$RUN_DIR/changed-files.txt"
(
  cd "$CHECKOUT_DIR"
  git diff --name-only "$BASE_SHA"...HEAD > "$CHANGED_FILE_LIST"
)
UI_FILES="$(ui_impacting_files "$CHANGED_FILE_LIST")"
VISUAL_PNG=""
if [ -n "$UI_FILES" ]; then
  log_line "UI-impacting files changed; capturing visual proof"
  if ! ( cd "$CHECKOUT_DIR" && bash scripts/ui-visual-proof.sh capture-after --output-dir "$VISUAL_PROOF_DIR" ); then
    log_line "visual proof capture failed; no PR created"
    exit 1
  fi
  VISUAL_PNG="$(first_visual_proof_png)"
  if [ -z "$VISUAL_PNG" ]; then
    log_line "visual proof capture produced no PNG; no PR created"
    exit 1
  fi
fi

BODY_FILE="$RUN_DIR/pr-body.md"
write_pr_body "$BODY_FILE" "$BASE_SHA" "$RERUN_LOG" "$FIX_SHA" "$VISUAL_PNG"
PR_URL="$(
  cd "$CHECKOUT_DIR"
  node scripts/create-pr.mjs \
    --title "Fix master HEAD full test failures ($SHORT_SHA)" \
    --base "$INVOKER_MASTER_HEAD_AUTOFIX_BASE_BRANCH" \
    --body-file "$BODY_FILE"
)"
ledger_record master-head-pr "$BASE_SHA" created
log_line "created PR: $PR_URL"
printf '%s\n' "$PR_URL"
