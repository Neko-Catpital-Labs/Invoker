#!/usr/bin/env bash
# Run the full Invoker test matrix: discover suite scripts under scripts/test-suites/
# and execute them in lexicographic order (use numeric prefixes: 10-, 20-, …).
#
# Usage (repo root):
#   bash scripts/run-all-tests.sh
#   pnpm run test:all
#
# Directories (all optional except required/ is expected to exist):
#   scripts/test-suites/required/   — always run (default CI surface)
#   scripts/test-suites/optional/   — run when INVOKER_TEST_ALL_EXTENDED=1
#   scripts/test-suites/dangerous/  — run only when INVOKER_TEST_ALL_DANGEROUS=1
#                                     (must also set INVOKER_TEST_ALL_EXTENDED=1)
#
# Environment:
#   INVOKER_TEST_ALL_EXTENDED=1     — include optional/ suites
#   INVOKER_TEST_ALL_DANGEROUS=1    — include dangerous/ (implies extended checks;
#                                     dangerous runs only if extended is set)
#   INVOKER_TEST_ALL_FAIL_FAST=1    — exit on first suite failure
#
# Files named _*.sh are ignored (helpers / templates).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAIL_FAST="${INVOKER_TEST_ALL_FAIL_FAST:-0}"
EXTENDED="${INVOKER_TEST_ALL_EXTENDED:-0}"
DANGEROUS="${INVOKER_TEST_ALL_DANGEROUS:-0}"

total_pass=0
total_fail=0
failed_names=() # bash 3.2 / set -u: define before +=

run_dir() {
  local label=$1
  local dir=$2

  if [[ ! -d "$dir" ]]; then
    echo "==> [$label] (no directory: $dir — skipping)"
    return 0
  fi

  shopt -s nullglob
  local scripts=( "$dir"/*.sh )
  shopt -u nullglob

  if [[ ${#scripts[@]} -eq 0 ]]; then
    echo "==> [$label] (no *.sh suites — skipping)"
    return 0
  fi

  # Lexicographic sort keeps 10- before 20- (bash 3.2–compatible; no mapfile)
  local f base
  while IFS= read -r f; do
    base="$(basename "$f")"
    [[ "$base" == _* ]] && continue

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  [$label] $base"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if bash "$f" </dev/null; then
      total_pass=$((total_pass + 1))
    else
      local ec=$?
      total_fail=$((total_fail + 1))
      failed_names+=("[$label] $base (exit $ec)")
      echo "FAILED: $f (exit $ec)"
      if [[ "$FAIL_FAST" == "1" ]]; then
        exit "$ec"
      fi
    fi
  done < <(printf '%s\n' "${scripts[@]}" | sort)
}

echo "==> Invoker run-all-tests (repo: $ROOT)"
echo "    required: always | extended: $EXTENDED | dangerous: $DANGEROUS | fail_fast: $FAIL_FAST"
echo ""

run_dir "required" "$ROOT/scripts/test-suites/required"

if [[ "$EXTENDED" == "1" ]]; then
  run_dir "optional" "$ROOT/scripts/test-suites/optional"
  if [[ "$DANGEROUS" == "1" ]]; then
    run_dir "dangerous" "$ROOT/scripts/test-suites/dangerous"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Summary: $total_pass suite(s) passed, $total_fail suite(s) failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $total_fail -gt 0 ]]; then
  for n in "${failed_names[@]}"; do
    echo "  - $n"
  done
  exit 1
fi

exit 0
