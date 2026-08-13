#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_MD="$REPO_ROOT/skills/admin-bypass-sweep/SKILL.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

must_contain() {
  local needle="$1"
  local hint="$2"
  grep -qF -- "$needle" "$SKILL_MD" || fail "$hint — missing: $needle"
}

must_not_contain() {
  local needle="$1"
  local hint="$2"
  grep -qF -- "$needle" "$SKILL_MD" && fail "$hint — must not contain: $needle" || true
}

must_appear_before() {
  local first="$1"
  local second="$2"
  local hint="$3"
  local first_line
  local second_line
  first_line="$(grep -nF -- "$first" "$SKILL_MD" | awk -F: 'NR == 1 { print $1 }')"
  second_line="$(grep -nF -- "$second" "$SKILL_MD" | awk -F: 'NR == 1 { print $1 }')"
  [[ -n "$first_line" && -n "$second_line" && "$first_line" -lt "$second_line" ]] || fail "$hint"
}

[[ -f "$SKILL_MD" ]] || fail "expected $SKILL_MD"

# The description must read as manual/human-only, not as an agent auto-trigger.
must_contain "MANUAL, HUMAN-ONLY skill" \
  "admin-bypass-sweep must declare itself manual and human-only in its description"
must_contain "Do not auto-invoke this skill from a" \
  "admin-bypass-sweep's description must refuse natural-language auto-triggering"
must_not_contain "Trigger when asked to" \
  "admin-bypass-sweep must not use auto-trigger phrasing that invites description-match invocation"

# Requirement 1: explicit slash-command invocation only.
must_contain "It must have been invoked by a literal, explicit slash command" \
  "admin-bypass-sweep must require literal slash-command invocation"
must_contain "\`/admin-bypass-sweep\` if this" \
  "admin-bypass-sweep must state the unprefixed slash-command form"
must_contain "\`/invoker-admin-bypass-sweep\` if it" \
  "admin-bypass-sweep must state the invoker-prefixed slash-command form used by this repo's install pipeline"
must_contain "Check which form is actually listed as available" \
  "admin-bypass-sweep must require checking the live session's skill list rather than guessing the invoked form"
must_contain "do not proceed" \
  "admin-bypass-sweep must instruct refusal when not explicitly slash-invoked"

# Requirement 2: explicit typed confirmation sentence, re-required every invocation.
must_contain "I understand this bypasses CI and force-merges to master" \
  "admin-bypass-sweep must require the exact confirmation phrase"
must_contain "say it again for each new invocation of this skill" \
  "admin-bypass-sweep must not accept a prior, unrelated confirmation as consent"
must_contain "Do not accept a paraphrase" \
  "admin-bypass-sweep must require the literal confirmation phrase, not a paraphrase"

# Both requirements must be stated before Step 4 (the actual merge step), and
# Step 4 must reference them rather than running unconditionally.
must_contain "## Step 4: Merge each stack, bottom-up" \
  "admin-bypass-sweep must have a Step 4 merge section"
must_appear_before "It must have been invoked by a literal, explicit slash command" \
  "## Step 4: Merge each stack, bottom-up" \
  "admin-bypass-sweep must state requirement 1 before the merge step"
must_appear_before "I understand this bypasses CI and force-merges to master" \
  "## Step 4: Merge each stack, bottom-up" \
  "admin-bypass-sweep must state requirement 2 before the merge step"
must_appear_before "## STOP — read this before doing anything" \
  "## Step 1: Discover and group" \
  "admin-bypass-sweep must place the STOP section before Step 1"
must_contain "Both requirements in the STOP section must be satisfied before this step runs." \
  "admin-bypass-sweep's Step 4 must restate the requirement inline"

# The skill must instruct against surfacing "gate" jargon to the human, and
# must not itself use numbered-gate labels outside that instruction.
must_contain "Do not refer to these as" \
  "admin-bypass-sweep must instruct against calling its requirements \"gates\" to the human"
must_not_contain "Gate 1" \
  "admin-bypass-sweep must not label its requirements as numbered gates"
must_not_contain "Gate 2" \
  "admin-bypass-sweep must not label its requirements as numbered gates"

# Never guess at real merge conflicts.
must_contain "Do not attempt to resolve it by picking a side" \
  "admin-bypass-sweep must forbid guessing at real merge conflicts"
must_contain "genuine content conflict" \
  "admin-bypass-sweep must distinguish real conflicts from transient UNKNOWN state"

# Prove final state rather than trust a running tally.
must_contain "re-query every PR number touched" \
  "admin-bypass-sweep must require re-querying final PR state before reporting"

# Cross-reference to the separate, deterministic worker path, and that
# satisfying one authorization path is not sufficient for the other.
must_contain "scripts/jailbreak-admin-bypass-land.mjs" \
  "admin-bypass-sweep must reference the separate deterministic worker path"
must_contain "satisfying one is never sufficient authorization for the other" \
  "admin-bypass-sweep must not let its own requirements satisfy the worker's authorization or vice versa"

echo "OK: admin-bypass-sweep skill contract checks passed"
