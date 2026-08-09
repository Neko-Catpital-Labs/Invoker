#!/usr/bin/env bash
# Contract tests for the prove-it skill.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_MD="$REPO_ROOT/skills/prove-it/SKILL.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

must_contain() {
  local needle="$1"
  local hint="$2"
  grep -qF -- "$needle" "$SKILL_MD" || fail "$hint — missing: $needle"
}

[[ -f "$SKILL_MD" ]] || fail "expected $SKILL_MD"

must_contain "do not assert something is fixed, working, passing, merged, or running" \
  "prove-it skill must state the core no-unverified-claim rule in its description"
must_contain "actually opened the exact screenshot or video yourself" \
  "prove-it skill must require actually opening visual proof media before claiming it"
must_contain "An automated DOM assertion, a test passing, or a file existing at the expected path is not a substitute for looking" \
  "prove-it skill must reject automated signals as a substitute for looking"
must_contain "run the exact query command fresh in this turn and cite its real output" \
  "prove-it skill must require a fresh query for live-system claims"
must_contain "Never restate a count or status from earlier in the conversation as if it were still current" \
  "prove-it skill must forbid restating stale status as current"
must_contain "A hypothesis that has not been directly observed is a guess" \
  "prove-it skill must require root-cause claims to be directly observed, not guessed"
must_contain "write \`UNVERIFIED:\` immediately before the claim" \
  "prove-it skill must require the UNVERIFIED prefix when evidence is missing"
must_contain "rejects a \`## Visual Proof\` section that has" \
  "prove-it skill must document the mechanical validate-pr-body.mjs gate"

echo "OK: prove-it skill contract checks passed"
