#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

EXPECTATION="fixed"
CASE_NAME="case-2.15-recreate-preempt-attempt-refresh.sh"
REQUIRED_RESET_SUITE="$ROOT_DIR/scripts/test-suites/required/21-e2e-dry-run-downstream-reset.sh"

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

if [[ "$EXPECTATION" == "bug" ]]; then
  merge_queue_block="$(awk '/if is_merge_queue; then/{inside=1} inside{print} inside && /^fi$/{exit}' "$REQUIRED_RESET_SUITE")"
  merge_queue_cases="$(printf '%s\n' "$merge_queue_block" | sed '/^[[:space:]]*#/d')"
  required_cases="$(sed '/^[[:space:]]*#/d' "$REQUIRED_RESET_SUITE")"
  if [[ -z "$merge_queue_block" ]]; then
    echo "repro: could not find merge-queue branch in required/21 reset shard" >&2
    exit 1
  fi
  if printf '%s\n' "$merge_queue_cases" | grep -Fq "$CASE_NAME"; then
    echo "repro: expected merge-queue branch to omit $CASE_NAME before the fix" >&2
    exit 1
  fi
  if ! printf '%s\n' "$required_cases" | grep -Fq "$CASE_NAME"; then
    echo "repro: expected default required/21 reset shard to include $CASE_NAME" >&2
    exit 1
  fi
  echo "repro: confirmed merge-queue quarantine for $CASE_NAME"
  echo "repro: reproduce with:"
  echo "GITHUB_EVENT_NAME=pull_request GITHUB_HEAD_REF=mergify/merge-queue/repro bash scripts/test-suites/required/21-e2e-dry-run-downstream-reset.sh"
  echo "repro: the merge-queue branch omits $CASE_NAME; the default wrapper still runs it with:"
  echo "bash scripts/repro/prove-reset-assertions.sh"
  exit 0
fi

exec bash scripts/e2e-dry-run/run-all.sh case-2.15-recreate-preempt-attempt-refresh.sh
