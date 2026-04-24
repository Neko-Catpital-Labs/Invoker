#!/usr/bin/env bash
set -euo pipefail

assumptions_file="${1:?Usage: bash check-policy-coverage.sh <assumptions.json> [verify-plan.yaml]}"
verify_plan_file="${2:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

source_kind="$(jq -r '.sourceKind // "generic"' "$assumptions_file")"
if [[ "$source_kind" != "policy_matrix" ]]; then
  echo "true"
  exit 0
fi

coverage_count="$(jq '.coverageItems | length' "$assumptions_file")"
if [[ "$coverage_count" -le 0 ]]; then
  echo "Policy-matrix source produced zero coverageItems" >&2
  exit 1
fi

if [[ -n "$verify_plan_file" ]]; then
  if rg -q '^  - id: verify-noop$' "$verify_plan_file"; then
    echo "Policy-matrix source degraded to verify-noop" >&2
    exit 1
  fi
  verify_count="$(rg -c '^  - id: verify-coverage-' "$verify_plan_file" || true)"
  if [[ "$verify_count" -le 0 ]]; then
    echo "Policy-matrix verify plan contains no coverage verification tasks" >&2
    exit 1
  fi
fi

echo "true"
