#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "usage: $0 <package-dir> <test-file> <test-name> [-- <extra-vitest-args...>]" >&2
}

if [[ $# -lt 3 ]]; then
  usage
  exit 2
fi

PACKAGE_DIR="$1"
TEST_FILE="$2"
TEST_NAME="$3"
shift 3

if [[ $# -gt 0 && "$1" == "--" ]]; then
  shift
fi

PACKAGE_PATH="$ROOT_DIR/$PACKAGE_DIR"
if [[ ! -d "$PACKAGE_PATH" ]]; then
  echo "vitest active-test guard: package directory does not exist: $PACKAGE_DIR" >&2
  exit 1
fi

if [[ ! -f "$PACKAGE_PATH/$TEST_FILE" ]]; then
  echo "vitest active-test guard: test file does not exist: $PACKAGE_DIR/$TEST_FILE" >&2
  exit 1
fi

REPORT_FILE="$(mktemp "${TMPDIR:-/tmp}/vitest-active-report.XXXXXX.json")"
cleanup() {
  rm -f "$REPORT_FILE"
}
trap cleanup EXIT

echo "vitest active-test guard: running $PACKAGE_DIR/$TEST_FILE"
echo "vitest active-test guard: filter \"$TEST_NAME\""

cd "$PACKAGE_PATH"

set +e
pnpm exec vitest run "$TEST_FILE" -t "$TEST_NAME" --reporter=default --reporter=json --outputFile="$REPORT_FILE" "$@"
VITEST_STATUS=$?
set -e

ASSERT_STATUS=0
if [[ ! -s "$REPORT_FILE" ]]; then
  echo "vitest active-test guard: missing JSON report at $REPORT_FILE" >&2
  ASSERT_STATUS=1
else
  node - "$REPORT_FILE" "$PACKAGE_DIR/$TEST_FILE" "$TEST_NAME" <<'NODE' || ASSERT_STATUS=$?
const fs = require('node:fs');

const [, , reportPath, target, testName] = process.argv;
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function countAssertions(value, counts) {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      countAssertions(item, counts);
    }
    return;
  }
  if (Array.isArray(value.assertionResults)) {
    for (const assertion of value.assertionResults) {
      if (!assertion || typeof assertion !== 'object') {
        continue;
      }
      const status = assertion.status;
      counts[status] = (counts[status] ?? 0) + 1;
    }
  }
  for (const child of Object.values(value)) {
    countAssertions(child, counts);
  }
}

const assertionCounts = {};
countAssertions(report, assertionCounts);

const passed = finiteNumber(report.numPassedTests) ?? assertionCounts.passed ?? 0;
const failed = finiteNumber(report.numFailedTests) ?? assertionCounts.failed ?? 0;
const pending = finiteNumber(report.numPendingTests);
const todo = finiteNumber(report.numTodoTests);
const skipped =
  pending !== undefined || todo !== undefined
    ? (pending ?? 0) + (todo ?? 0)
    : (assertionCounts.pending ?? 0) + (assertionCounts.todo ?? 0) + (assertionCounts.skipped ?? 0);
const total = finiteNumber(report.numTotalTests) ?? passed + failed + skipped;

console.log(
  `vitest active-test guard: passed=${passed} failed=${failed} skipped=${skipped} total=${total}`,
);

const errors = [];
if (passed < 1) {
  errors.push(`expected at least one passed active test for "${testName}" in ${target}`);
}
if (failed !== 0) {
  errors.push(`expected zero failed tests for "${testName}" in ${target}, got ${failed}`);
}

if (errors.length > 0) {
  console.error('vitest active-test guard: assertion failed');
  for (const error of errors) {
    console.error(`vitest active-test guard: ${error}`);
  }
  process.exit(1);
}
NODE
fi

if [[ "$ASSERT_STATUS" -ne 0 ]]; then
  exit "$ASSERT_STATUS"
fi

if [[ "$VITEST_STATUS" -ne 0 ]]; then
  echo "vitest active-test guard: vitest exited with status $VITEST_STATUS" >&2
  exit "$VITEST_STATUS"
fi
