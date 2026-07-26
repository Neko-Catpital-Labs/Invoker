#!/usr/bin/env bash
# Contract tests for the loop-generator skill.
# Run from repo root: bash scripts/test-loop-generator-skill.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_MD="$REPO_ROOT/skills/loop-generator/SKILL.md"
REFERENCE_MD="$REPO_ROOT/skills/loop-generator/references/missing-fields-example.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

must_contain() {
  local file="$1"
  local needle="$2"
  local hint="$3"
  if ! grep -qF -- "$needle" "$file"; then
    fail "$hint — missing in $file: $needle"
  fi
}

[[ -f "$SKILL_MD" ]] || fail "expected $SKILL_MD"
[[ -f "$REFERENCE_MD" ]] || fail "expected $REFERENCE_MD"

must_contain "$SKILL_MD" "Treat this as a conversation before a draft." "Skill must stay conversational before drafting"
must_contain "$SKILL_MD" "Do not draft until draft authorization is explicit." "Skill must require explicit draft authorization"
must_contain "$SKILL_MD" 'Default submission mode is `review_then_submit`.' "Skill must default to review_then_submit"
must_contain "$SKILL_MD" '`write_mode` — one of `diagnostic_only`, `worker_owned_writes`, or `choose_each_run`.' "Skill must lock write_mode literals"
must_contain "$SKILL_MD" '`output_location_mode` — one of `repo_artifacts` or `planning_artifacts`.' "Skill must lock output modes"
must_contain "$SKILL_MD" '`submission_mode` — one of `review_then_submit`, `generate_only`, or `submit_immediately`.' "Skill must lock submission modes"

for field in \
  '`loop_name`' \
  '`loop_slug`' \
  '`goal`' \
  '`motivation`' \
  '`target_scope`' \
  '`target_discovery_command`' \
  '`target_identity_key`' \
  '`success_criteria`' \
  '`human_only_blockers`' \
  '`evidence_sources`' \
  '`fail_condition_rule`' \
  '`local_proxy_command`' \
  '`write_mode`' \
  '`output_location_mode`' \
  '`submission_mode`'; do
  must_contain "$SKILL_MD" "$field" "Skill must require the full interview schema"
done

must_contain "$SKILL_MD" '`plans/<loop_slug>-loop.md`' "Skill must lock repo_artifacts loop doc path"
must_contain "$SKILL_MD" '`scripts/<loop_slug>-driver.sh`' "Skill must lock repo_artifacts driver path"
must_contain "$SKILL_MD" '`plans/<loop_slug>.yaml`' "Skill must lock repo_artifacts yaml path"
must_contain "$SKILL_MD" '`plans/<loop_slug>-step-N.template.yaml`' "Skill must lock repo_artifacts stacked yaml path"
must_contain "$SKILL_MD" '`plans/generated-loops/<loop_slug>-loop.md`' "Skill must lock planning_artifacts loop doc path"
must_contain "$SKILL_MD" '`plans/generated-loops/<loop_slug>-driver.sh`' "Skill must lock planning_artifacts driver path"
must_contain "$SKILL_MD" '`plans/invoker-handoff.md`' "Skill must reuse the canonical markdown handoff path"
must_contain "$SKILL_MD" '`plans/invoker-handoff.yaml`' "Skill must reuse the canonical yaml handoff path"
must_contain "$SKILL_MD" '`plans/invoker-handoff-step-N.template.yaml`' "Skill must lock planning_artifacts stacked yaml path"

must_contain "$SKILL_MD" '`skill://make-pr/SKILL.md`' "Skill must route PR publication work through make-pr"
must_contain "$SKILL_MD" '`skill://review-compression/SKILL.md`' "Skill must route multi-slice yaml through review-compression"
must_contain "$SKILL_MD" '`bugfix` formula' "Skill must document the single-workflow formula"
must_contain "$SKILL_MD" '`skills/plan-to-invoker/formulas/implementation-stack/formula.yaml`' "Skill must document the stacked workflow formula"
must_contain "$SKILL_MD" '`invoker_validate_plan`' "Skill must validate via invoker_validate_plan"
must_contain "$SKILL_MD" '`bash skills/plan-to-invoker/scripts/skill-doctor.sh plans/invoker-handoff.yaml`' "Skill must run skill-doctor in Invoker checkouts"
must_contain "$SKILL_MD" '`invoker_submit_plan`' "Skill must submit via invoker_submit_plan"
must_contain "$SKILL_MD" 'mode `live`' "Skill must submit in live mode"

must_contain "$REFERENCE_MD" '`success_criteria`' "Reference example must ask for missing success criteria"
must_contain "$REFERENCE_MD" '`output_location_mode`' "Reference example must ask for missing output-location choice"
must_contain "$REFERENCE_MD" 'Drafting is allowed only after the answers are resolved and the user gives explicit draft authorization.' "Reference example must keep drafting gated"

echo "OK: loop-generator skill contract checks passed"
