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
#   --warn-delegation  Pass through to atomicity lint (prints advisory delegation-hint warnings)
#                      Experiment artifact handoff validation runs with atomicity linting.
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

check_experiment_handoff() {
  local step_id="check-experiment-handoff"
  local description="Validate experiment artifact handoff consumption contract from docs/context/inv-63/experiment-brief.md"
  local output_file="$TEMP_DIR/${step_id}.out"
  local stderr_file="$TEMP_DIR/${step_id}.err"

  if [[ "$VERBOSE" == "true" ]]; then
    echo "Running check: $step_id - $description" >&2
  fi

  set +e
  awk '
function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
function strip_quotes(s) { gsub(/["\047]/, "", s); return s }
function first_experiment_artifact(s) {
  if (match(s, /docs\/context\/[^ ,`"\047\t]+\/experiment-brief\.md/)) {
    return substr(s, RSTART, RLENGTH)
  }
  return ""
}
function task_suffix(task_id, prefix,    n) {
  n = length(prefix)
  if (substr(task_id, 1, n) == prefix) return substr(task_id, n + 1)
  return ""
}
function csv_has(csv, needle,    parts, i, item) {
  if (csv == "" || needle == "") return 0
  split(csv, parts, /,/)
  for (i in parts) {
    item = trim(parts[i])
    if (item == needle) return 1
  }
  return 0
}
function flush_task(    idx, suffix) {
  if (!in_task) return
  idx = ++taskn
  task_descriptions[idx] = desc
  task_prompts[idx] = prompt_text
  task_dependencies[idx] = dependencies_csv
  task_id_to_index[id] = idx

  if (id ~ /^experiment-/ && has_prompt) {
    has_experiment_tasks = 1
    suffix = task_suffix(id, "experiment-")
    experiment_id_by_suffix[suffix] = id
    experiment_artifact_by_suffix[suffix] = first_experiment_artifact(desc " " prompt_text)
  }
  if (id ~ /^implement-/ && has_prompt) {
    suffix = task_suffix(id, "implement-")
    implement_id_by_suffix[suffix] = id
  }
}
BEGIN {
  in_task = 0
  in_dep_block = 0
  in_description_block = 0
  in_prompt_block = 0
  taskn = 0
  errn = 0
  has_experiment_tasks = 0
  on_finish = "pull_request"
  enforce_handoff = 1
}
{
  line = $0

  if (!in_task && line ~ /^[[:space:]]*onFinish:[[:space:]]*/) {
    on_finish = line
    sub(/^[[:space:]]*onFinish:[[:space:]]*/, "", on_finish)
    on_finish = trim(strip_quotes(on_finish))
    enforce_handoff = (tolower(on_finish) != "none")
    next
  }

  if (in_description_block) {
    if (line ~ /^[[:space:]][[:space:]][[:space:]][[:space:]][[:space:]][[:space:]]*[^[:space:]]/) {
      desc = desc "\n" trim(line)
      next
    }
    in_description_block = 0
  }

  if (in_dep_block) {
    if (line ~ /^[[:space:]][[:space:]][[:space:]][[:space:]][[:space:]][[:space:]]*-[[:space:]]*[^[:space:]]/) {
      dep = line
      sub(/^[[:space:]][[:space:]][[:space:]][[:space:]][[:space:]][[:space:]]*-[[:space:]]*/, "", dep)
      dep = trim(strip_quotes(dep))
      if (dep != "") {
        if (dependencies_csv != "") dependencies_csv = dependencies_csv ","
        dependencies_csv = dependencies_csv dep
      }
      next
    }
    in_dep_block = 0
  }

  if (line ~ /^[[:space:]]*-[[:space:]]+id:[[:space:]]*/) {
    flush_task()
    in_task = 1
    in_dep_block = 0
    in_description_block = 0
    in_prompt_block = 0

    id = line
    sub(/^[[:space:]]*-[[:space:]]+id:[[:space:]]*/, "", id)
    id = trim(strip_quotes(id))
    desc = ""
    prompt_text = ""
    dependencies_csv = ""
    has_prompt = 0
    next
  }

  if (!in_task) next

  if (line ~ /^[[:space:]]+description:[[:space:]]*/) {
    desc = line
    sub(/^[[:space:]]+description:[[:space:]]*/, "", desc)
    desc = trim(strip_quotes(desc))
    if (desc == "|" || desc == ">") {
      desc = ""
      in_description_block = 1
    }
    next
  }

  if (line ~ /^[[:space:]]+dependencies:[[:space:]]*/) {
    dep_line = line
    sub(/^[[:space:]]+dependencies:[[:space:]]*/, "", dep_line)
    dep_line = trim(dep_line)
    if (dep_line == "" || dep_line == "|" || dep_line == ">") {
      in_dep_block = 1
    } else if (dep_line ~ /^\[[^]]*\]$/) {
      gsub(/^\[/, "", dep_line)
      gsub(/\]$/, "", dep_line)
      split(dep_line, dep_parts, /,/)
      for (k in dep_parts) {
        dep = trim(strip_quotes(dep_parts[k]))
        if (dep != "") {
          if (dependencies_csv != "") dependencies_csv = dependencies_csv ","
          dependencies_csv = dependencies_csv dep
        }
      }
    }
    next
  }

  if (line ~ /^[[:space:]]+prompt:[[:space:]]*/) {
    has_prompt = 1
    in_prompt_block = 1
    p = line
    sub(/^[[:space:]]+prompt:[[:space:]]*/, "", p)
    if (p != "|" && p != "") prompt_text = prompt_text " " p
    next
  }

  if (in_prompt_block) {
    if (line ~ /^[[:space:]][[:space:]][[:space:]][[:space:]][[:space:]][[:space:]]*[^[:space:]]/) {
      prompt_text = prompt_text " " trim(line)
      next
    }
    in_prompt_block = 0
  }
}
END {
  flush_task()
  if (enforce_handoff == 1 && has_experiment_tasks == 1) {
    for (suffix in experiment_id_by_suffix) {
      experiment_id = experiment_id_by_suffix[suffix]
      artifact = experiment_artifact_by_suffix[suffix]
      implement_id = implement_id_by_suffix[suffix]
      implement_idx = task_id_to_index[implement_id]
      desc = task_descriptions[implement_idx]
      prompt = task_prompts[implement_idx]
      combined_lower = tolower(desc " " prompt)

      if (implement_id == "") {
        errors[++errn] = "Task \"" experiment_id "\" requires matching implement task \"implement-" suffix "\" to consume experiment artifact"
        continue
      }
      if (!csv_has(task_dependencies[implement_idx], experiment_id)) {
        errors[++errn] = "Task \"" implement_id "\" must depend on \"" experiment_id "\" for deterministic experiment artifact handoff"
      }
      if (artifact == "") {
        errors[++errn] = "Task \"" experiment_id "\" must name docs/context/<issue>/experiment-brief.md before implementation can consume it"
        continue
      }
      if (index(desc, artifact) == 0) {
        errors[++errn] = "Task \"" implement_id "\" description must reference exact experiment artifact path " artifact
      }
      if (index(prompt, artifact) == 0) {
        errors[++errn] = "Task \"" implement_id "\" prompt must reference exact experiment artifact path " artifact
      }
      if (combined_lower !~ /consum/) {
        errors[++errn] = "Task \"" implement_id "\" must use explicit consume/consumed/consumes language for experiment artifact " artifact
      }
      if (combined_lower !~ /acceptance criteria:/) {
        errors[++errn] = "Task \"" implement_id "\" must include acceptance language proving it consumed experiment artifact " artifact
      }
    }
  }

  if (errn > 0) {
    for (i = 1; i <= errn; i++) print "ERROR: " errors[i] > "/dev/stderr"
    exit 1
  }
  print "Experiment artifact handoff validation passed"
}
' "$PLAN_FILE" > "$output_file" 2> "$stderr_file"
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
      echo "  PASSED" >&2
    fi
  else
    OVERALL_FAILED=true
    local error_msg="$description (exit code: $exit_code)"
    if [[ -s "$stderr_file" ]]; then
      error_msg="$error_msg - $(head -1 "$stderr_file")"
    fi
    add_check_result "$step_id" "failed" "$error_msg" "$stderr_file"
    if [[ "$VERBOSE" == "true" ]]; then
      echo "  FAILED (exit code: $exit_code)" >&2
    fi
  fi
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
  atomicity_args=(--strict-delegation)
  if [[ -n "$STACK_MANIFEST_FILE" ]]; then
    atomicity_args+=(--stack-manifest "$STACK_MANIFEST_FILE")
  fi
  if [[ "$WARN_DELEGATION" == "true" ]]; then
    atomicity_args+=(--warn-delegation)
    run_check \
      "lint-task-atomicity" \
      "Lint task atomicity and detail requirements (strict zero-context prompt gating + delegation warnings)" \
      bash "$SCRIPT_DIR/lint-task-atomicity.sh" "${atomicity_args[@]}" "$PLAN_FILE"
  else
    run_check \
      "lint-task-atomicity" \
      "Lint task atomicity and detail requirements (strict zero-context prompt gating)" \
      bash "$SCRIPT_DIR/lint-task-atomicity.sh" "${atomicity_args[@]}" "$PLAN_FILE"
  fi

  check_experiment_handoff
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
