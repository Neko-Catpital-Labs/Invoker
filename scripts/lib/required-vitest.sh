#!/usr/bin/env bash

_required_vitest_has_binary() {
  local package_dir="$1"
  (
    cd "$package_dir" \
      && pnpm exec vitest --version >/dev/null 2>&1
  )
}

_required_vitest_package_name() {
  local package_dir="$1"
  node - "$package_dir/package.json" <<'NODE'
const fs = require('node:fs');

const packagePath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
  process.exit(1);
}

process.stdout.write(manifest.name);
NODE
}

ensure_required_vitest_available() {
  if [[ $# -ne 1 ]]; then
    echo "usage: ensure_required_vitest_available <package-dir>" >&2
    return 2
  fi

  local package_dir="$1"
  if [[ ! -d "$package_dir" ]]; then
    echo "required-vitest: package directory does not exist: $package_dir" >&2
    return 2
  fi

  if _required_vitest_has_binary "$package_dir"; then
    return 0
  fi

  local workspace_root
  workspace_root="$(git -C "$package_dir" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "$workspace_root" || ! -f "$workspace_root/pnpm-lock.yaml" ]]; then
    echo "required-vitest: could not find workspace root for $package_dir" >&2
    return 1
  fi

  local package_name
  package_name="$(_required_vitest_package_name "$package_dir" 2>/dev/null || true)"
  if [[ -z "$package_name" ]]; then
    echo "required-vitest: could not read package name from $package_dir/package.json" >&2
    return 1
  fi

  echo "required-vitest: Vitest binary is unavailable; installing filtered workspace dependencies for $package_name"
  (
    cd "$workspace_root" \
      && pnpm --filter "$package_name..." install --frozen-lockfile --ignore-scripts --prod=false
  ) || return $?

  if ! _required_vitest_has_binary "$package_dir"; then
    echo "required-vitest: Vitest binary is still unavailable after filtered install for $package_name" >&2
    return 1
  fi
}

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

  ensure_required_vitest_available "$package_dir" || return $?

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
