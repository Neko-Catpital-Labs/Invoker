#!/usr/bin/env bash
# Prove a formula is compliant "by construction": render it with its declared
# example vars and run skill-doctor on every rendered plan. Exit 0 only if all
# rendered plans pass. This is the authoring-time gate for a recipe — validate
# the shape once here so every instance is compliant without re-deriving it.
#
# For stacked recipes, a rendered step still carries the reserved
# __UPSTREAM_WORKFLOW_ID__ token and baseBranch: master, both of which
# submit-workflow-chain.sh rewrites at submit time. To validate the shape as it
# will appear after wiring, this gate checks a dummy-wired copy: a concrete
# upstream id and a non-default baseBranch. The rendered plan itself is left
# untouched for the real chain submission.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: bash formula-doctor.sh <formula|path/to/formula.yaml>" >&2
  exit 2
fi
FORMULA="$1"

cd "$REPO_ROOT"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

LIST_FILE="$TMP_DIR/.rendered.list"
if ! node "$SCRIPT_DIR/render-formula.mjs" "$FORMULA" --example --out "$TMP_DIR" --print >"$LIST_FILE"; then
  echo "formula-doctor: render failed" >&2
  exit 1
fi

mapfile -t RENDERED <"$LIST_FILE"
if [[ ${#RENDERED[@]} -eq 0 ]]; then
  echo "formula-doctor: render produced no plans" >&2
  exit 1
fi

fail=0
for plan in "${RENDERED[@]}"; do
  check_plan="$plan"
  if grep -q '__UPSTREAM_WORKFLOW_ID__' "$plan"; then
    # Stacked step: simulate submit-workflow-chain.sh wiring for validation only.
    check_plan="${plan%.yaml}.wired.yaml"
    sed -e 's|__UPSTREAM_WORKFLOW_ID__|wf-example-upstream|g' \
        -e 's|^baseBranch:.*$|baseBranch: plan/example-upstream-feature|' \
        "$plan" >"$check_plan"
  fi
  echo "== skill-doctor: $check_plan =="
  if bash "$SCRIPT_DIR/skill-doctor.sh" "$check_plan"; then
    echo "PASS: $plan"
  else
    echo "FAIL: $plan"
    fail=1
  fi
done

if [[ $fail -ne 0 ]]; then
  echo "formula-doctor: FAILED — $FORMULA is not compliant by construction" >&2
  exit 1
fi
echo "formula-doctor: OK — $FORMULA renders to skill-doctor-passing plans"
