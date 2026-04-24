#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
EXTRACT_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/extract-assumptions.sh"
GENERATE_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/generate-verify-plan.sh"
CHECK_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/check-policy-coverage.sh"
CHECK_MAP_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/check-coverage-map.sh"
CHECK_MANIFEST_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/check-stack-manifest.sh"
GENERATE_MAP_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/generate-coverage-map-template.sh"
GENERATE_MANIFEST_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/generate-stack-manifest-template.sh"
DOCTOR_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/skill-doctor.sh"
SOURCE_DOC="$REPO_ROOT/skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.md"
GOOD_MAP="$REPO_ROOT/skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.coverage-map.json"
BAD_MAP="$REPO_ROOT/skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.missing-coverage-map.json"
GOOD_MANIFEST="$REPO_ROOT/skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.stack-manifest.json"
BAD_MANIFEST="$REPO_ROOT/skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.bad-stack-manifest.json"
BAD_SOURCE_MANIFEST="$REPO_ROOT/skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.bad-source.stack-manifest.json"
BAD_PATH_MANIFEST="$REPO_ROOT/skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.bad-plan-path.stack-manifest.json"
POSITIVE_PLAN="$REPO_ROOT/skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_verify_task_present() {
  local task_id="$1"
  local file="$2"
  if command -v rg >/dev/null 2>&1; then
    rg -q "^  - id: ${task_id}\$" "$file"
  else
    grep -qF "  - id: ${task_id}" "$file"
  fi
}

[[ -f "$SOURCE_DOC" ]] || fail "missing source doc $SOURCE_DOC"
[[ -f "$POSITIVE_PLAN" ]] || fail "missing positive plan $POSITIVE_PLAN"
[[ -x "$(command -v jq)" ]] || fail "jq is required"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

assumptions="$tmpdir/assumptions.json"
verify_plan="$tmpdir/verify.yaml"
map_template="$tmpdir/coverage-map.json"
manifest_template="$tmpdir/stack-manifest.json"

bash "$EXTRACT_SCRIPT" "$SOURCE_DOC" > "$assumptions"

jq -e '.sourceKind == "policy_matrix"' "$assumptions" >/dev/null || fail "expected policy_matrix sourceKind"
jq -e '.coverageItems | length > 0' "$assumptions" >/dev/null || fail "expected non-empty coverageItems"
jq -e '.coverageItems[] | select(.coverageKey == "decision-change-external-gate-policy")' "$assumptions" >/dev/null || fail "missing external gate decision row"
jq -e '.coverageItems[] | select(.coverageKey == "decision-approve-or-reject-fix")' "$assumptions" >/dev/null || fail "missing fix approve/reject decision row"
jq -e '.coverageItems[] | select(.coverageKey == "decision-approve-or-reject-fix" and .rowType == "non_invalidating_exception")' "$assumptions" >/dev/null || fail "fix approve/reject should be classified as non-invalidating"
jq -e '.coverageItems[] | select(.coverageKey == "hard-invariant-cancel-first")' "$assumptions" >/dev/null || fail "missing hard invariant coverage row"
jq -e '.coverageItems[] | select(.coverageKey == "inconsistency-naming-inconsistency")' "$assumptions" >/dev/null || fail "missing naming inconsistency coverage row"

cat "$assumptions" | bash "$GENERATE_SCRIPT" "task-invalidation-chart" > "$verify_plan"

if assert_verify_task_present "verify-noop" "$verify_plan"; then
  fail "policy matrix verify plan degraded to verify-noop"
fi

assert_verify_task_present "verify-coverage-decision-change-external-gate-policy" "$verify_plan" || fail "missing external gate coverage verify task"
assert_verify_task_present "verify-coverage-hard-invariant-cancel-first" "$verify_plan" || fail "missing hard invariant coverage verify task"

bash "$CHECK_SCRIPT" "$assumptions" "$verify_plan" >/dev/null || fail "coverage check failed"
bash "$GENERATE_MAP_SCRIPT" "$assumptions" > "$map_template"
jq -e '.sourceKind == "policy_matrix" and .sourceFile == $source and (.mappings | length > 0)' --arg source "$SOURCE_DOC" "$map_template" >/dev/null || fail "expected generated coverage map template"
bash "$GENERATE_MANIFEST_SCRIPT" "$GOOD_MAP" "$SOURCE_DOC" > "$manifest_template"
jq -e '.sourceFile == $source and (.workflows | length > 0)' --arg source "$SOURCE_DOC" "$manifest_template" >/dev/null || fail "expected generated stack manifest template"
jq -e '.workflows[] | select(.label == "Step 17: Explicit lifecycle commands obey the matrix" and .planFile == "")' "$manifest_template" >/dev/null || fail "expected generated stack manifest template to include workflow labels with blank planFile"
bash "$CHECK_MAP_SCRIPT" "$assumptions" "$GOOD_MAP" >/dev/null || fail "expected valid coverage map to pass"
bash "$CHECK_MANIFEST_SCRIPT" "$GOOD_MAP" "$GOOD_MANIFEST" "$SOURCE_DOC" >/dev/null || fail "expected valid stack manifest to pass"
if bash "$CHECK_MAP_SCRIPT" "$assumptions" "$BAD_MAP" >/dev/null 2>&1; then
  fail "expected incomplete coverage map to fail"
fi
if bash "$CHECK_MANIFEST_SCRIPT" "$GOOD_MAP" "$BAD_MANIFEST" "$SOURCE_DOC" >/dev/null 2>&1; then
  fail "expected incomplete stack manifest to fail"
fi
if bash "$CHECK_MANIFEST_SCRIPT" "$GOOD_MAP" "$BAD_SOURCE_MANIFEST" "$SOURCE_DOC" >/dev/null 2>&1; then
  fail "expected stack manifest source mismatch to fail"
fi
if bash "$CHECK_MANIFEST_SCRIPT" "$GOOD_MAP" "$BAD_PATH_MANIFEST" "$SOURCE_DOC" >/dev/null 2>&1; then
  fail "expected missing planFile path in stack manifest to fail"
fi

bad_empty_labels="$tmpdir/bad-empty-labels.json"
jq '(.mappings[] | select(.coverageKey == "decision-change-external-gate-policy") | .workflowLabels) = []' "$GOOD_MAP" > "$bad_empty_labels"
if bash "$CHECK_MAP_SCRIPT" "$assumptions" "$bad_empty_labels" >/dev/null 2>&1; then
  fail "expected empty workflow labels to fail"
fi

bad_rowtype="$tmpdir/bad-rowtype.json"
jq '(.mappings[] | select(.coverageKey == "decision-approve-or-reject-fix") | .rowType) = "mutation_path"' "$GOOD_MAP" > "$bad_rowtype"
if bash "$CHECK_MAP_SCRIPT" "$assumptions" "$bad_rowtype" >/dev/null 2>&1; then
  fail "expected rowType mismatch to fail"
fi

bad_rationale="$tmpdir/bad-rationale.json"
jq '(.mappings[] | select(.coverageKey == "hard-invariant-cancel-first") | .rationale) = ""' "$GOOD_MAP" > "$bad_rationale"
if bash "$CHECK_MAP_SCRIPT" "$assumptions" "$bad_rationale" >/dev/null 2>&1; then
  fail "expected empty rationale to fail"
fi

bad_map_source="$tmpdir/bad-source-map.json"
jq '.sourceFile = "skills/plan-to-invoker/fixtures/policy/not-the-task-invalidation-chart.md"' "$GOOD_MAP" > "$bad_map_source"
if bash "$CHECK_MAP_SCRIPT" "$assumptions" "$bad_map_source" >/dev/null 2>&1; then
  fail "expected wrong coverage-map sourceFile to fail"
fi

bad_map_kind="$tmpdir/bad-kind-map.json"
jq '.sourceKind = "generic"' "$GOOD_MAP" > "$bad_map_kind"
if bash "$CHECK_MAP_SCRIPT" "$assumptions" "$bad_map_kind" >/dev/null 2>&1; then
  fail "expected wrong coverage-map sourceKind to fail"
fi

bad_unused_manifest="$tmpdir/bad-unused-step.stack-manifest.json"
jq '.workflows += [{"label":"Step 19: Unmapped extra workflow","planFile":"skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml","order":19}]' "$GOOD_MANIFEST" > "$bad_unused_manifest"
if bash "$CHECK_MANIFEST_SCRIPT" "$GOOD_MAP" "$bad_unused_manifest" "$SOURCE_DOC" >/dev/null 2>&1; then
  fail "expected unused stack manifest workflow labels to fail"
fi

bad_duplicate_order_manifest="$tmpdir/bad-duplicate-order.stack-manifest.json"
jq '(.workflows[] | select(.label == "Step 18: Cancel-first invariant audit") | .order) = 17' "$GOOD_MANIFEST" > "$bad_duplicate_order_manifest"
if bash "$CHECK_MANIFEST_SCRIPT" "$GOOD_MAP" "$bad_duplicate_order_manifest" "$SOURCE_DOC" >/dev/null 2>&1; then
  fail "expected duplicate stack manifest order to fail"
fi

bad_gap_order_manifest="$tmpdir/bad-gap-order.stack-manifest.json"
jq '(.workflows[] | select(.label == "Step 18: Cancel-first invariant audit") | .order) = 19' "$GOOD_MANIFEST" > "$bad_gap_order_manifest"
if bash "$CHECK_MANIFEST_SCRIPT" "$GOOD_MAP" "$bad_gap_order_manifest" "$SOURCE_DOC" >/dev/null 2>&1; then
  fail "expected non-contiguous stack manifest order to fail"
fi

doctor_missing_map="$tmpdir/doctor-missing-map.json"
if bash "$DOCTOR_SCRIPT" --skip-atomicity --source-file "$SOURCE_DOC" "$POSITIVE_PLAN" > "$doctor_missing_map" 2>/dev/null; then
  fail "expected skill-doctor to require --coverage-map for policy-matrix source inputs"
fi
jq -e '.firstFailedStep == "check-coverage-map"' "$doctor_missing_map" >/dev/null || fail "expected missing coverage map to fail at check-coverage-map"

doctor_missing_manifest="$tmpdir/doctor-missing-manifest.json"
if bash "$DOCTOR_SCRIPT" --skip-atomicity --source-file "$SOURCE_DOC" --coverage-map "$GOOD_MAP" "$POSITIVE_PLAN" > "$doctor_missing_manifest" 2>/dev/null; then
  fail "expected skill-doctor to require --stack-manifest for policy-matrix source inputs"
fi
jq -e '.firstFailedStep == "check-stack-manifest"' "$doctor_missing_manifest" >/dev/null || fail "expected missing stack manifest to fail at check-stack-manifest"

bash "$DOCTOR_SCRIPT" --skip-atomicity --source-file "$SOURCE_DOC" --coverage-map "$GOOD_MAP" --stack-manifest "$GOOD_MANIFEST" "$POSITIVE_PLAN" >/dev/null || {
  fail "expected skill-doctor to pass with source file and valid coverage map"
}

echo "OK: policy coverage extraction, projection, traceability, and stack-manifest checks passed"
