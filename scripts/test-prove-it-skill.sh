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
must_contain "investigating, diagnosing, debugging, proving, or explaining what happened or why for any problem or situation" \
  "prove-it skill metadata must load for broad problem and situation investigations"
must_contain "investigate, diagnose, debug, prove, explain what happened, explain why something happened" \
  "prove-it skill must name the generalized investigation trigger phrases"
must_contain "actually opened the exact screenshot or video yourself" \
  "prove-it skill must require actually opening visual proof media before claiming it"
must_contain "An automated DOM assertion, a test passing, or a file existing at the expected path is not a substitute for looking" \
  "prove-it skill must reject automated signals as a substitute for looking"
must_contain "run the exact query command fresh in this turn and cite its real output" \
  "prove-it skill must require a fresh query for live-system claims"
must_contain "Never restate a count or status from earlier in the conversation as if it were still current" \
  "prove-it skill must forbid restating stale status as current"
must_contain "first restate the literal reported behavior and resolve the current target being investigated" \
  "prove-it skill must require restating the literal behavior and current target before causal explanation"
must_contain "author and execute a task-specific repro that visibly fails against that current target before explaining why" \
  "prove-it skill must require an executable failing repro before explaining why"
must_contain "isolate the suspected cause with a controlled comparison in the actual failing path" \
  "prove-it skill must require controlled cause isolation"
must_contain "A hypothesis that has not been directly observed is a guess" \
  "prove-it skill must require root-cause claims to be directly observed, not guessed"
must_contain "rerun the same repro that failed before the fix and show the real passing output" \
  "prove-it skill must require the same repro to pass after a fix"
must_contain "All unproven causal hypotheses must be prefixed with \`UNVERIFIED:\`" \
  "prove-it skill must label unproven causal hypotheses"
must_contain "write \`UNVERIFIED:\` immediately before the claim" \
  "prove-it skill must require the UNVERIFIED prefix when evidence is missing"
must_contain "Proxy proof:" \
  "prove-it skill must include a generalized proxy-proof example"
must_contain "Stale state:" \
  "prove-it skill must include a generalized stale-state example"
must_contain "Wrong target:" \
  "prove-it skill must include a generalized wrong-target example"
must_contain "Broken repro:" \
  "prove-it skill must include a generalized broken-repro example"
must_contain "Premature theory:" \
  "prove-it skill must include a generalized premature-theory example"
must_contain "Scope drift:" \
  "prove-it skill must include a generalized scope-drift example"
must_contain "Assertion mismatch:" \
  "prove-it skill must include a generalized assertion-mismatch example"
must_contain "Visual mismatch:" \
  "prove-it skill must include a generalized visual-mismatch example"
must_contain "Live-state mismatch:" \
  "prove-it skill must include a generalized live-state-mismatch example"
must_contain "rejects a \`## Visual Proof\` section that has" \
  "prove-it skill must document the mechanical validate-pr-body.mjs gate"

echo "OK: prove-it skill contract checks passed"
