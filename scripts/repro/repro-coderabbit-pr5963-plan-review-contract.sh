#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SKILL="skills/plan-to-invoker/SKILL.md"
CONTRACT="scripts/test-plan-to-invoker-skill.sh"

fail() {
  echo "[repro] FAIL: $1" >&2
  exit 1
}

must_contain() {
  local file="$1"
  local needle="$2"
  local label="$3"
  grep -Fq "$needle" "$file" || fail "$label"
}

must_not_contain() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq "$needle" "$file"; then
    fail "$label"
  fi
}

echo "[repro] Checking shell-contract alignment for MCP review flow"
must_contain "$SKILL" 'invoker_prepare_plan_review' 'skill is missing invoker_prepare_plan_review review flow'
must_contain "$SKILL" 'confirmationText' 'skill is missing confirmationText review instructions'
must_contain "$SKILL" 'confirmationMode: auto_submit' 'skill is missing auto-submit review instructions'
must_contain "$CONTRACT" 'invoker_prepare_plan_review' 'shell contract still misses invoker_prepare_plan_review'
must_contain "$CONTRACT" 'confirmationText' 'shell contract still misses confirmationText'
must_contain "$CONTRACT" 'confirmationMode: auto_submit' 'shell contract still misses auto-submit wording'
must_contain "$CONTRACT" 'optional diagnostic, not the approval gate.' 'shell contract still misses the updated outside-checkout review semantics'
must_not_contain "$CONTRACT" 'Outside an Invoker source checkout, \`invoker_validate_plan\` is the deterministic validation gate.' 'shell contract still enforces the obsolete validate-plan gate'
must_not_contain "$CONTRACT" 'Prefer the MCP tools \`invoker_validate_plan\` and \`invoker_submit_plan\` when available.' 'shell contract still enforces the obsolete validate-plan submit wording'

echo "[repro] PASS: shell contract matches the MCP review flow"