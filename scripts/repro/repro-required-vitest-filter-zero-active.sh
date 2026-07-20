#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REQUIRED_SCRIPT="$ROOT_DIR/scripts/test-suites/required/17-merge-gate-concurrency-repro.sh"
HELPER="$ROOT_DIR/scripts/lib/required-vitest.sh"
TEST_NAME="starts an independent merge gate while another merge gate is still preparing review"
BUG_TARGET="src/__tests__/task-runner.test.ts"
FIXED_TARGET="src/__tests__/task-runner-fix-publish-and-ssh.test.ts"
EXPECTATION="fixed"

usage() {
  echo "usage: $0 [--expect-bug|--expect-fixed]" >&2
}

confirm_raw_vitest_zero_active_bug() {
  local report_file
  local log_file
  report_file="$(mktemp "${TMPDIR:-/tmp}/raw-vitest-report.XXXXXX.json")"
  log_file="$(mktemp "${TMPDIR:-/tmp}/raw-vitest-output.XXXXXX.log")"

  set +e
  (
    cd "$ROOT_DIR/packages/execution-engine" \
      && pnpm exec vitest run "$BUG_TARGET" -t "$TEST_NAME" \
        --reporter=json \
        --outputFile="$report_file"
  ) >"$log_file" 2>&1
  local vitest_status=$?
  set -e

  if [[ -s "$log_file" ]]; then
    cat "$log_file"
  fi

  if [[ $vitest_status -ne 0 ]]; then
    echo "repro: expected unguarded stale Vitest target to exit 0, got $vitest_status" >&2
    rm -f "$report_file" "$log_file"
    return 1
  fi

  if [[ ! -s "$report_file" ]]; then
    echo "repro: unguarded stale Vitest run did not write a JSON report" >&2
    rm -f "$report_file" "$log_file"
    return 1
  fi

  if ! python3 - "$report_file" "$BUG_TARGET" "$TEST_NAME" <<'PY'
import json
import sys

report_path, test_target, test_name = sys.argv[1:]

with open(report_path, encoding="utf-8") as fh:
    report = json.load(fh)

passed = report.get("numPassedTests")
failed = report.get("numFailedTests")
if not isinstance(passed, int):
    passed = -1
if not isinstance(failed, int):
    failed = -1

if report.get("success") is not True or passed != 0 or failed != 0:
    print(
        f"repro: expected raw Vitest stale filter to pass with 0 active tests for {test_target} -t {test_name!r}; "
        f"success={report.get('success')!r}, passed={passed}, failed={failed}",
        file=sys.stderr,
    )
    sys.exit(1)

print(
    f"repro: raw Vitest accepted stale target {test_target} -t {test_name!r} with {passed} passed and {failed} failed tests"
)
PY
  then
    rm -f "$report_file" "$log_file"
    return 1
  fi

  rm -f "$report_file" "$log_file"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-bug)
      EXPECTATION="bug"
      shift
      ;;
    --expect-fixed)
      EXPECTATION="fixed"
      shift
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ ! -f "$REQUIRED_SCRIPT" ]]; then
  echo "repro: missing required suite script: $REQUIRED_SCRIPT" >&2
  exit 1
fi

if [[ ! -f "$HELPER" ]]; then
  echo "repro: missing required Vitest helper: $HELPER" >&2
  exit 1
fi

source "$HELPER"

target_rel="$(grep -Eo 'src/__tests__/[^[:space:]]+\.test\.ts' "$REQUIRED_SCRIPT" | head -n1 || true)"
if [[ -z "$target_rel" ]]; then
  echo "repro: could not find a vitest test target in required/17" >&2
  exit 1
fi

if ! grep -Fq "$TEST_NAME" "$REQUIRED_SCRIPT"; then
  echo "repro: required/17 no longer contains the expected test-name filter" >&2
  exit 1
fi

target_path="$ROOT_DIR/packages/execution-engine/$target_rel"
if [[ ! -f "$target_path" ]]; then
  echo "repro: required/17 target file does not exist: packages/execution-engine/$target_rel" >&2
  exit 1
fi

active_matches="$( (grep -F "$TEST_NAME" "$target_path" || true) | wc -l | tr -d '[:space:]' )"
fixed_matches=0
if [[ -f "$ROOT_DIR/packages/execution-engine/$FIXED_TARGET" ]]; then
  fixed_matches="$( (grep -F "$TEST_NAME" "$ROOT_DIR/packages/execution-engine/$FIXED_TARGET" || true) | wc -l | tr -d '[:space:]' )"
fi

if [[ "$EXPECTATION" == "bug" ]]; then
  bug_matches="$( (grep -F "$TEST_NAME" "$ROOT_DIR/packages/execution-engine/$BUG_TARGET" || true) | wc -l | tr -d '[:space:]' )"
  if [[ "$bug_matches" -ne 0 ]]; then
    echo "repro: expected zero active matches in $BUG_TARGET, got $bug_matches" >&2
    exit 1
  fi
  if [[ "$fixed_matches" -lt 1 ]]; then
    echo "repro: expected relocated test name in $FIXED_TARGET, got $fixed_matches matches" >&2
    exit 1
  fi

  confirm_raw_vitest_zero_active_bug

  echo "repro: confirmed bug"
  echo "repro: active matches in that target for the -t filter: 0"
  echo "repro: relocated matches in packages/execution-engine/$FIXED_TARGET: $fixed_matches"
else
  if [[ "$target_rel" != "$FIXED_TARGET" ]]; then
    echo "repro: expected required/17 to target $FIXED_TARGET after the fix, got $target_rel" >&2
    exit 1
  fi
  if [[ "$active_matches" -lt 1 ]]; then
    echo "repro: expected fixed required/17 target to contain at least one active test for the -t filter" >&2
    echo "repro: current target: packages/execution-engine/$target_rel" >&2
    echo "repro: active matches: $active_matches" >&2
    exit 1
  fi

  echo "repro: verifying stale target fails the active-test guard"
  if run_required_vitest_filter "$ROOT_DIR/packages/execution-engine" "$BUG_TARGET" "$TEST_NAME"; then
    echo "repro: stale target unexpectedly passed the active-test guard" >&2
    exit 1
  fi

  echo "repro: verifying required/17 executes the relocated active test"
  bash "$REQUIRED_SCRIPT"

  echo "repro: confirmed fixed behavior"
  echo "repro: required/17 target packages/execution-engine/$target_rel contains $active_matches active match(es)"
fi
