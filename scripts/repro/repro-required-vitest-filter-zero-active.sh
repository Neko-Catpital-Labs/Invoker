#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REQUIRED_SCRIPT="$ROOT_DIR/scripts/test-suites/required/17-merge-gate-concurrency-repro.sh"
ACTIVE_TEST_HELPER="$ROOT_DIR/scripts/lib/require-vitest-active-tests.sh"
TEST_NAME="starts an independent merge gate while another merge gate is still preparing review"
BUG_TARGET="src/__tests__/task-runner.test.ts"
FIXED_TARGET="src/__tests__/task-runner-fix-publish-and-ssh.test.ts"
EXPECTATION="fixed"

usage() {
  echo "usage: $0 [--expect-bug|--expect-fixed]" >&2
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
  if [[ "$target_rel" != "$BUG_TARGET" ]]; then
    echo "repro: expected required/17 to target $BUG_TARGET before the fix, got $target_rel" >&2
    exit 1
  fi
  if [[ "$active_matches" -ne 0 ]]; then
    echo "repro: expected zero active matches in $BUG_TARGET, got $active_matches" >&2
    exit 1
  fi
  if [[ "$fixed_matches" -lt 1 ]]; then
    echo "repro: expected relocated test name in $FIXED_TARGET, got $fixed_matches matches" >&2
    exit 1
  fi
  echo "repro: confirmed bug"
  echo "repro: required/17 targets packages/execution-engine/$BUG_TARGET"
  echo "repro: active matches in that target for the -t filter: 0"
  echo "repro: relocated matches in packages/execution-engine/$FIXED_TARGET: $fixed_matches"
else
  if [[ ! -x "$ACTIVE_TEST_HELPER" ]]; then
    echo "repro: missing executable active-test helper: $ACTIVE_TEST_HELPER" >&2
    exit 1
  fi

  stale_log="$(mktemp)"
  trap 'rm -f "$stale_log"' EXIT

  if [[ "$active_matches" -lt 1 ]]; then
    echo "repro: expected fixed required/17 target to contain at least one active test for the -t filter" >&2
    echo "repro: current target: packages/execution-engine/$target_rel" >&2
    echo "repro: active matches: $active_matches" >&2
    exit 1
  fi
  if ! bash "$REQUIRED_SCRIPT"; then
    echo "repro: expected fixed required/17 to pass" >&2
    exit 1
  fi
  if "$ACTIVE_TEST_HELPER" \
    --package @invoker/execution-engine \
    --test-file "$BUG_TARGET" \
    --test-name "$TEST_NAME" >"$stale_log" 2>&1; then
    echo "repro: expected stale target packages/execution-engine/$BUG_TARGET to fail active-test assertion" >&2
    exit 1
  fi
  if ! grep -Fq "expected at least one passed active test" "$stale_log"; then
    echo "repro: stale target failed for an unexpected reason" >&2
    sed -n '1,200p' "$stale_log" >&2
    exit 1
  fi
  echo "repro: confirmed fixed behavior"
  echo "repro: required/17 target packages/execution-engine/$target_rel contains $active_matches active match(es)"
  echo "repro: stale target packages/execution-engine/$BUG_TARGET is rejected by the active-test assertion"
fi
