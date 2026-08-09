#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_MD="$REPO_ROOT/skills/visual-proof/SKILL.md"

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

# Regression: PR #7215 embedded an unrelated, stale gif (from PR #3242) as
# "Visual Proof" for a cursor/spinner fix it never captured. These checks
# fail if the guardrail that prevents that is ever quietly removed.
must_contain "Never reuse an unrelated or stale asset as proof" \
  "visual-proof skill must keep the anti-stale-asset section heading"
must_contain "must come from a capture run" \
  "visual-proof skill must require proof captured against the actual change"
must_contain "a stale asset asserts something that was never verified" \
  "visual-proof skill must explain why stale assets are misleading, not just forbidden"
must_contain "Capture whatever partial signal actually IS visible" \
  "visual-proof skill must require capturing the provable part of an otherwise-uncapturable behavior"
must_contain "substitute an image that doesn't actually demonstrate the claim" \
  "visual-proof skill must forbid substituting an unrelated image for an uncapturable claim"

# A captured file is not proof anyone looked at it. Locks the prove-it hard gate wiring.
must_contain "A captured screenshot or video file is not proof that anyone looked at it" \
  "visual-proof skill must state that capture alone is not proof"
must_contain "open the exact file yourself" \
  "visual-proof skill must require opening the exact captured media before claiming it"
must_contain "rejects a Visual Proof section that has media but no \`Manually inspected:\` line" \
  "visual-proof skill must document the Manually inspected validator gate"
must_contain "skills/prove-it/SKILL.md" \
  "visual-proof skill must reference the shared prove-it evidence rule"

echo "OK: visual-proof skill contract checks passed"
