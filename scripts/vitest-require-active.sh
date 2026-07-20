#!/usr/bin/env bash
# Run a focused Vitest command and fail if the JSON report has no passed tests.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN_PASSED="${VITEST_REQUIRE_MIN_PASSED:-1}"

usage() {
  echo "usage: $0 <workspace-filter> <vitest-run-args...>" >&2
}

if [[ $# -lt 2 ]]; then
  usage
  exit 2
fi

workspace_filter="$1"
shift

report_file="$(mktemp "${TMPDIR:-/tmp}/vitest-active-report.XXXXXX.json")"
cleanup() {
  rm -f "$report_file"
}
trap cleanup EXIT

cd "$ROOT"
set +e
pnpm --filter "$workspace_filter" exec vitest run "$@" --reporter=json --outputFile "$report_file"
vitest_status=$?
set -e

if [[ ! -s "$report_file" ]]; then
  echo "vitest active-test assertion failed: JSON report was not written" >&2
  if [[ "$vitest_status" -ne 0 ]]; then
    exit "$vitest_status"
  fi
  exit 1
fi

node --input-type=module - "$report_file" "$MIN_PASSED" "$vitest_status" <<'NODE'
import fs from 'node:fs';

const [reportPath, minPassedRaw, vitestStatusRaw] = process.argv.slice(2);
const minPassed = Number(minPassedRaw);
const vitestStatus = Number(vitestStatusRaw);

if (!Number.isInteger(minPassed) || minPassed < 1) {
  console.error(`vitest active-test assertion failed: invalid VITEST_REQUIRE_MIN_PASSED=${minPassedRaw}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`vitest active-test assertion failed: could not parse JSON report: ${error.message}`);
  process.exit(1);
}

const numberOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const fallback = { passed: 0, failed: 0, skipped: 0, todo: 0 };
const visitResults = (value) => {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visitResults(item);
    }
    return;
  }
  if (Array.isArray(value.assertionResults)) {
    for (const assertion of value.assertionResults) {
      if (assertion?.status === 'passed') {
        fallback.passed += 1;
      } else if (assertion?.status === 'failed') {
        fallback.failed += 1;
      } else if (assertion?.status === 'pending' || assertion?.status === 'skipped') {
        fallback.skipped += 1;
      } else if (assertion?.status === 'todo') {
        fallback.todo += 1;
      }
    }
  }
  visitResults(value.testResults);
  visitResults(value.children);
  visitResults(value.suites);
  visitResults(value.tests);
};

visitResults(report);

const passed = numberOrNull(report.numPassedTests) ?? fallback.passed;
const failed = numberOrNull(report.numFailedTests) ?? fallback.failed;
const skipped =
  (numberOrNull(report.numPendingTests) ?? fallback.skipped) +
  (numberOrNull(report.numTodoTests) ?? fallback.todo);
const active = passed + failed;

const failures = [];
if (failed !== 0) {
  failures.push(`expected zero failed tests, got ${failed}`);
}
if (passed < minPassed) {
  failures.push(`expected at least ${minPassed} passed active test(s), got ${passed}`);
}
if (vitestStatus !== 0) {
  failures.push(`vitest exited ${vitestStatus}`);
}

if (failures.length > 0) {
  console.error(`vitest active-test assertion failed: ${failures.join('; ')}`);
  console.error(`vitest active-test counts: ${active} active (${passed} passed, ${failed} failed), ${skipped} skipped`);
  process.exit(1);
}

console.log(`vitest active-test assertion passed: ${active} active (${passed} passed, ${failed} failed), ${skipped} skipped`);
NODE
