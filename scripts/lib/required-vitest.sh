#!/usr/bin/env bash

run_required_vitest_filter() {
  if [[ $# -ne 3 ]]; then
    echo "usage: run_required_vitest_filter <package-dir> <test-target> <test-name>" >&2
    return 2
  fi

  local package_dir="$1"
  local test_target="$2"
  local test_name="$3"

  if [[ ! -d "$package_dir" ]]; then
    echo "required-vitest: package directory does not exist: $package_dir" >&2
    return 2
  fi

  if [[ ! -f "$package_dir/$test_target" ]]; then
    echo "required-vitest: test target does not exist: $test_target" >&2
    return 2
  fi

  local report_file
  local log_file
  report_file="$(mktemp "${TMPDIR:-/tmp}/required-vitest-report.XXXXXX.json")"
  log_file="$(mktemp "${TMPDIR:-/tmp}/required-vitest-output.XXXXXX.log")"

  local had_errexit=0
  case "$-" in
    *e*) had_errexit=1 ;;
  esac

  set +e
  (
    cd "$package_dir" \
      && pnpm exec vitest run "$test_target" -t "$test_name" \
        --reporter=json \
        --outputFile="$report_file"
  ) >"$log_file" 2>&1
  local vitest_status=$?

  if [[ -s "$log_file" ]]; then
    cat "$log_file"
  fi

  local validator_status=0
  if [[ -s "$report_file" ]]; then
    python3 - "$report_file" "$test_target" "$test_name" <<'PY'
import json
import sys

report_path, test_target, test_name = sys.argv[1:]

try:
    with open(report_path, encoding="utf-8") as fh:
        report = json.load(fh)
except Exception as exc:
    print(f"required-vitest: could not read Vitest JSON report: {exc}", file=sys.stderr)
    sys.exit(1)


def optional_int(name):
    value = report.get(name)
    return value if isinstance(value, int) else None


assertions = []
for suite in report.get("testResults", []):
    if not isinstance(suite, dict):
        continue
    for result in suite.get("assertionResults", []):
        if isinstance(result, dict):
            assertions.append(result)

assertion_passed = sum(1 for result in assertions if result.get("status") == "passed")
assertion_failed = sum(1 for result in assertions if result.get("status") == "failed")

passed = optional_int("numPassedTests")
failed = optional_int("numFailedTests")
failed_suites = optional_int("numFailedTestSuites")

if passed is None:
    passed = assertion_passed
if failed is None:
    failed = assertion_failed
if failed_suites is None:
    failed_suites = 0

problems = []
if report.get("success") is False:
    problems.append("Vitest reported success=false")
if failed != 0:
    problems.append(f"expected zero failed tests, got {failed}")
if failed_suites != 0:
    problems.append(f"expected zero failed test suites, got {failed_suites}")
if passed < 1:
    problems.append("expected at least one passed active test, got 0")

if problems:
    print(
        f"required-vitest: {test_target} -t {test_name!r} did not execute the required active test",
        file=sys.stderr,
    )
    for problem in problems:
        print(f"required-vitest: {problem}", file=sys.stderr)
    sys.exit(1)

print(
    f"required-vitest: {test_target} -t {test_name!r} passed {passed} active test(s) with {failed} failure(s)"
)
PY
    validator_status=$?
  elif [[ $vitest_status -eq 0 ]]; then
    echo "required-vitest: Vitest exited successfully but did not write a JSON report" >&2
    validator_status=1
  fi

  if [[ $had_errexit -eq 1 ]]; then
    set -e
  fi

  rm -f "$report_file" "$log_file"

  if [[ $vitest_status -ne 0 ]]; then
    return "$vitest_status"
  fi
  return "$validator_status"
}
