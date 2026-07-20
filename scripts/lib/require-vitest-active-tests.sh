#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_FILTER=""
TEST_FILE=""
TEST_NAME=""

usage() {
  echo "usage: $0 --package <pnpm-filter> --test-file <path> --test-name <name>" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package)
      PACKAGE_FILTER="${2:-}"
      shift 2
      ;;
    --test-file)
      TEST_FILE="${2:-}"
      shift 2
      ;;
    --test-name)
      TEST_NAME="${2:-}"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$PACKAGE_FILTER" || -z "$TEST_FILE" || -z "$TEST_NAME" ]]; then
  usage
  exit 2
fi

TMP_DIR="$(mktemp -d)"
JSON_REPORT="$TMP_DIR/vitest-report.json"
VITEST_LOG="$TMP_DIR/vitest.log"
trap 'rm -rf "$TMP_DIR"' EXIT

set +e
(
  cd "$ROOT"
  pnpm --filter "$PACKAGE_FILTER" exec vitest run "$TEST_FILE" \
    -t "$TEST_NAME" \
    --reporter=json \
    --outputFile="$JSON_REPORT"
) >"$VITEST_LOG" 2>&1
VITEST_STATUS=$?
node - "$JSON_REPORT" "$VITEST_STATUS" <<'NODE'
const fs = require('fs');

const [reportPath, statusText] = process.argv.slice(2);
const vitestStatus = Number(statusText);

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`vitest active-test assertion failed: could not read JSON report at ${reportPath}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function deriveAssertionCounts(value, counts = { passed: 0, failed: 0, skipped: 0, todo: 0 }) {
  if (!value || typeof value !== 'object') {
    return counts;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      deriveAssertionCounts(item, counts);
    }
    return counts;
  }

  if (typeof value.status === 'string' && ('ancestorTitles' in value || 'fullName' in value)) {
    if (value.status === 'passed') {
      counts.passed += 1;
    } else if (value.status === 'failed') {
      counts.failed += 1;
    } else if (value.status === 'pending' || value.status === 'skipped') {
      counts.skipped += 1;
    } else if (value.status === 'todo') {
      counts.todo += 1;
    }
    return counts;
  }

  for (const child of Object.values(value)) {
    deriveAssertionCounts(child, counts);
  }
  return counts;
}

const derived = deriveAssertionCounts(report);
const passed = numeric(report.numPassedTests) ?? derived.passed;
const failed = numeric(report.numFailedTests) ?? derived.failed;
const skipped = numeric(report.numPendingTests) ?? derived.skipped;
const todo = numeric(report.numTodoTests) ?? derived.todo;
const total = numeric(report.numTotalTests) ?? (passed + failed + skipped + todo);

if (vitestStatus !== 0 || report.success === false) {
  console.error(
    `vitest active-test assertion failed: vitest exited ${vitestStatus}; passed=${passed} failed=${failed} skipped=${skipped} todo=${todo} total=${total}`,
  );
  process.exit(1);
}

if (failed !== 0) {
  console.error(
    `vitest active-test assertion failed: expected zero failed tests, got passed=${passed} failed=${failed} skipped=${skipped} todo=${todo} total=${total}`,
  );
  process.exit(1);
}

if (passed < 1) {
  console.error(
    `vitest active-test assertion failed: expected at least one passed active test, got passed=${passed} failed=${failed} skipped=${skipped} todo=${todo} total=${total}`,
  );
  process.exit(1);
}

console.log(`vitest active-test assertion passed: passed=${passed} failed=${failed} skipped=${skipped} todo=${todo} total=${total}`);
NODE
ASSERT_STATUS=$?
set -e

if [[ "$ASSERT_STATUS" -ne 0 ]]; then
  if [[ -s "$VITEST_LOG" ]]; then
    echo "vitest output:" >&2
    sed -n '1,200p' "$VITEST_LOG" >&2
  fi
  exit "$ASSERT_STATUS"
fi
