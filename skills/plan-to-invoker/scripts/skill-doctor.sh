#!/usr/bin/env bash
# skill-doctor.sh: Deterministic orchestrator for plan validation scripts
# Usage: bash skill-doctor.sh [OPTIONS] <plan-file>
#
# OPTIONS:
#   --help              Show this help message
#   --skip-assumptions  Skip assumption extraction (also skips verify plan generation)
#   --skip-atomicity    Skip atomicity linting
#   --skip-validation   Skip YAML plan validation
#   --source-file FILE  Use a separate source document for assumption/coverage checks
#   --coverage-map FILE Validate row-to-workflow traceability for policy-matrix inputs
#   --stack-manifest FILE Validate coverage-map workflow labels against a real authored stack manifest
#   --verbose           Show detailed output from each sub-check
#   --warn-delegation  Pass through to atomicity lint (advisory delegation-hint warnings only; no extra failures)
#
# Exit codes:
#   0 = all checks passed
#   1 = one or more checks failed
#   2 = usage/argument error
#
# Output: JSON summary of all checks with pass/fail status
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default mode flags
SKIP_ASSUMPTIONS=false
SKIP_ATOMICITY=false
SKIP_VALIDATION=false
VERBOSE=false
WARN_DELEGATION=false
COVERAGE_MAP_FILE=""
STACK_MANIFEST_FILE=""
SOURCE_FILE=""
PLAN_FILE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      sed -n '2,18p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    --skip-assumptions)
      SKIP_ASSUMPTIONS=true
      shift
      ;;
    --skip-atomicity)
      SKIP_ATOMICITY=true
      shift
      ;;
    --skip-validation)
      SKIP_VALIDATION=true
      shift
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --coverage-map)
      COVERAGE_MAP_FILE="${2:-}"
      if [[ -z "$COVERAGE_MAP_FILE" ]]; then
        echo "ERROR: --coverage-map requires a file path" >&2
        exit 2
      fi
      shift 2
      ;;
    --stack-manifest)
      STACK_MANIFEST_FILE="${2:-}"
      if [[ -z "$STACK_MANIFEST_FILE" ]]; then
        echo "ERROR: --stack-manifest requires a file path" >&2
        exit 2
      fi
      shift 2
      ;;
    --source-file)
      SOURCE_FILE="${2:-}"
      if [[ -z "$SOURCE_FILE" ]]; then
        echo "ERROR: --source-file requires a file path" >&2
        exit 2
      fi
      shift 2
      ;;
    --warn-delegation)
      WARN_DELEGATION=true
      shift
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      echo "Run with --help for usage information" >&2
      exit 2
      ;;
    *)
      if [[ -z "$PLAN_FILE" ]]; then
        PLAN_FILE="$1"
      else
        echo "ERROR: Multiple plan files specified" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$PLAN_FILE" ]]; then
  echo "ERROR: Plan file argument required" >&2
  echo "Usage: bash skill-doctor.sh [OPTIONS] <plan-file>" >&2
  echo "Run with --help for more information" >&2
  exit 2
fi

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "ERROR: Plan file not found: $PLAN_FILE" >&2
  exit 2
fi

if [[ -n "$SOURCE_FILE" && ! -f "$SOURCE_FILE" ]]; then
  echo "ERROR: Source file not found: $SOURCE_FILE" >&2
  exit 2
fi

if [[ -n "$COVERAGE_MAP_FILE" && ! -f "$COVERAGE_MAP_FILE" ]]; then
  echo "ERROR: Coverage map file not found: $COVERAGE_MAP_FILE" >&2
  exit 2
fi

if [[ -n "$STACK_MANIFEST_FILE" && ! -f "$STACK_MANIFEST_FILE" ]]; then
  echo "ERROR: Stack manifest file not found: $STACK_MANIFEST_FILE" >&2
  exit 2
fi

# Temp files for collecting check results
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

CHECKS_FILE="$TEMP_DIR/checks.json"
echo "[]" > "$CHECKS_FILE"

# Track overall success
OVERALL_FAILED=false
FIRST_FAILED_STEP=""

# Helper: add check result to JSON array
add_check_result() {
  local step_id="$1"
  local status="$2"
  local message="${3:-}"
  local output_file="${4:-}"

  if command -v jq &>/dev/null; then
    local entry
    entry=$(jq -n \
      --arg id "$step_id" \
      --arg status "$status" \
      --arg msg "$message" \
      '{stepId: $id, status: $status, message: $msg}')

    if [[ -n "$output_file" && -f "$output_file" ]]; then
      local output_content
      output_content=$(cat "$output_file")
      entry=$(echo "$entry" | jq --arg out "$output_content" '. + {output: $out}')
    fi

    jq --argjson entry "$entry" '. + [$entry]' "$CHECKS_FILE" > "$CHECKS_FILE.tmp"
    mv "$CHECKS_FILE.tmp" "$CHECKS_FILE"
  else
    # Fallback without jq - append simple JSON manually
    echo "WARNING: jq not available, JSON output will be minimal" >&2
  fi

  if [[ "$status" == "failed" ]] && [[ -z "$FIRST_FAILED_STEP" ]]; then
    FIRST_FAILED_STEP="$step_id"
  fi
}

# Helper: run a check and capture result
run_check() {
  local step_id="$1"
  local description="$2"
  shift 2
  local cmd=("$@")

  local output_file="$TEMP_DIR/${step_id}.out"
  local stderr_file="$TEMP_DIR/${step_id}.err"

  if [[ "$VERBOSE" == "true" ]]; then
    echo "Running check: $step_id - $description" >&2
  fi

  set +e
  "${cmd[@]}" > "$output_file" 2> "$stderr_file"
  local exit_code=$?
  set -e

  if [[ "$VERBOSE" == "true" ]]; then
    if [[ -s "$output_file" ]]; then
      echo "  Output:" >&2
      cat "$output_file" >&2
    fi
    if [[ -s "$stderr_file" ]]; then
      echo "  Errors:" >&2
      cat "$stderr_file" >&2
    fi
  fi

  if [[ $exit_code -eq 0 ]]; then
    add_check_result "$step_id" "passed" "$description" "$output_file"
    if [[ "$VERBOSE" == "true" ]]; then
      echo "  ✓ PASSED" >&2
    fi
  else
    OVERALL_FAILED=true
    local error_msg="$description (exit code: $exit_code)"
    if [[ -s "$stderr_file" ]]; then
      error_msg="$error_msg - $(head -1 "$stderr_file")"
    fi
    add_check_result "$step_id" "failed" "$error_msg" "$stderr_file"
    if [[ "$VERBOSE" == "true" ]]; then
      echo "  ✗ FAILED (exit code: $exit_code)" >&2
    fi
  fi

  return 0
}

# Check 1: Extract assumptions (if not skipped)
ASSUMPTIONS_FILE="$TEMP_DIR/assumptions.json"
if [[ "$SKIP_ASSUMPTIONS" == "false" ]]; then
  ASSUMPTIONS_INPUT="$PLAN_FILE"
  if [[ -n "$SOURCE_FILE" ]]; then
    ASSUMPTIONS_INPUT="$SOURCE_FILE"
  fi
  run_check \
    "extract-assumptions" \
    "Extract assumptions from plan" \
    bash "$SCRIPT_DIR/extract-assumptions.sh" "$ASSUMPTIONS_INPUT"

  # Save assumptions output for generate-verify-plan step
  if [[ -f "$TEMP_DIR/extract-assumptions.out" ]]; then
    cp "$TEMP_DIR/extract-assumptions.out" "$ASSUMPTIONS_FILE"
  fi
fi

# Check 2: Generate verification plan (if assumptions were extracted)
VERIFY_PLAN_FILE="$TEMP_DIR/verify-plan.yaml"
if [[ "$SKIP_ASSUMPTIONS" == "false" && -f "$ASSUMPTIONS_FILE" ]]; then
  # Extract plan name from the plan file
  PLAN_NAME=$(basename "$PLAN_FILE" .yaml)
  run_check \
    "generate-verify-plan" \
    "Generate verification plan from assumptions" \
    bash -c "cat '$ASSUMPTIONS_FILE' | bash '$SCRIPT_DIR/generate-verify-plan.sh' '$PLAN_NAME' > '$VERIFY_PLAN_FILE' && cat '$VERIFY_PLAN_FILE'"
fi

# Check 2a: policy coverage must not degrade to empty coverage or verify-noop
if [[ "$SKIP_ASSUMPTIONS" == "false" && -f "$ASSUMPTIONS_FILE" ]]; then
  run_check \
    "check-policy-coverage" \
    "Validate policy-matrix coverage extraction and verify-plan projection" \
    bash "$SCRIPT_DIR/check-policy-coverage.sh" "$ASSUMPTIONS_FILE" "$VERIFY_PLAN_FILE"
fi

if [[ "$SKIP_ASSUMPTIONS" == "false" && -f "$ASSUMPTIONS_FILE" ]]; then
  ASSUMPTIONS_SOURCE_KIND="$(jq -r '.sourceKind // "generic"' "$ASSUMPTIONS_FILE" 2>/dev/null || echo generic)"
  if [[ "$ASSUMPTIONS_SOURCE_KIND" == "policy_matrix" && -z "$COVERAGE_MAP_FILE" ]]; then
    OVERALL_FAILED=true
    add_check_result \
      "check-coverage-map" \
      "failed" \
      "Policy-matrix inputs require --coverage-map so every required source row is traced to a workflow label."
  fi
  if [[ "$ASSUMPTIONS_SOURCE_KIND" == "policy_matrix" && -z "$STACK_MANIFEST_FILE" ]]; then
    OVERALL_FAILED=true
    add_check_result \
      "check-stack-manifest" \
      "failed" \
      "Policy-matrix inputs require --stack-manifest so coverage-map workflow labels are validated against a real authored stack."
  fi
fi

if [[ -n "$COVERAGE_MAP_FILE" && "$SKIP_ASSUMPTIONS" == "false" && -f "$ASSUMPTIONS_FILE" ]]; then
  run_check \
    "check-coverage-map" \
    "Validate row-to-workflow traceability coverage map" \
    bash "$SCRIPT_DIR/check-coverage-map.sh" "$ASSUMPTIONS_FILE" "$COVERAGE_MAP_FILE"
fi

if [[ -n "$COVERAGE_MAP_FILE" && -n "$STACK_MANIFEST_FILE" && "$SKIP_ASSUMPTIONS" == "false" && -f "$ASSUMPTIONS_FILE" ]]; then
  run_check \
    "check-stack-manifest" \
    "Validate coverage-map workflow labels against the authored stack manifest" \
    bash "$SCRIPT_DIR/check-stack-manifest.sh" "$COVERAGE_MAP_FILE" "$STACK_MANIFEST_FILE" "$ASSUMPTIONS_INPUT"
fi

# Check 3: YAML plan validation (if not skipped)
if [[ "$SKIP_VALIDATION" == "false" ]]; then
  run_check \
    "validate-plan" \
    "Validate plan YAML structure and schema" \
    bash "$SCRIPT_DIR/validate-plan.sh" "$PLAN_FILE"
fi

# Check 4: Task atomicity linting (if not skipped)
if [[ "$SKIP_ATOMICITY" == "false" ]]; then
  if [[ "$WARN_DELEGATION" == "true" ]]; then
    run_check \
      "lint-task-atomicity" \
      "Lint task atomicity and detail requirements (with delegation hints advisory)" \
      bash "$SCRIPT_DIR/lint-task-atomicity.sh" --warn-delegation "$PLAN_FILE"
  else
    run_check \
      "lint-task-atomicity" \
      "Lint task atomicity and detail requirements" \
      bash "$SCRIPT_DIR/lint-task-atomicity.sh" "$PLAN_FILE"
  fi
fi

# Check 5: Validate parse-results.sh with mock execution output
MOCK_RESULTS=$(cat <<'MOCK_EOF'
[verify-file-test] completed
task "verify-pattern-foo" completed
PASS verify-tests-pkg
MOCK_EOF
)
run_check \
  "parse-results" \
  "Validate parse-results.sh can parse execution output" \
  bash -c "echo '$MOCK_RESULTS' | bash '$SCRIPT_DIR/parse-results.sh' | jq -e '.summary.total >= 0'"

# Generate final summary JSON
if command -v jq &>/dev/null; then
  SUMMARY=$(jq -n \
    --argjson checks "$(cat "$CHECKS_FILE")" \
    --arg planFile "$PLAN_FILE" \
    --argjson allPassed "$(if [[ "$OVERALL_FAILED" == "false" ]]; then echo true; else echo false; fi)" \
    --arg firstFailedStep "${FIRST_FAILED_STEP:-null}" \
    '{
      planFile: $planFile,
      allPassed: $allPassed,
      firstFailedStep: ($firstFailedStep | if . == "null" then null else . end),
      checks: $checks
    }')

  echo "$SUMMARY"
else
  # Fallback without jq - minimal JSON
  echo '{"planFile":"'"$PLAN_FILE"'","allPassed":false,"error":"jq not available for full report"}'
fi

# Exit with appropriate code
if [[ "$OVERALL_FAILED" == "true" ]]; then
  if [[ -n "$FIRST_FAILED_STEP" ]]; then
    echo "ERROR: First failed step: $FIRST_FAILED_STEP" >&2
  fi
  exit 1
fi

exit 0
