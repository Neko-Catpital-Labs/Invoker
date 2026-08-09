#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_MD="$REPO_ROOT/skills/land-stack/SKILL.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

must_contain() {
  local needle="$1"
  local hint="$2"
  grep -qF -- "$needle" "$SKILL_MD" || fail "$hint — missing: $needle"
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

must_contain "Detect whether two or more open candidates share the same \`headRefName\`." \
  "land-stack must detect duplicate head branches before requesting confirmation"
must_contain "This is the only discovery case that requires" \
  "land-stack must limit confirmation to duplicate head branches"
must_contain "land it without an additional confirmation." \
  "land-stack must proceed after a passing guard when head branches are unique"
must_contain "SHA-verified PR number" \
  "land-stack must retain SHA-verified PR-number selection"
must_contain "every PR must pass the guard" \
  "land-stack must require a passing guard before writes"
must_contain "before any write" \
  "land-stack must require the guard before writes"
must_contain "fresh discovery pass" \
  "land-stack must require a fresh discovery pass after guard failure"
must_contain "do not work around it" \
  "land-stack must reject guard workarounds"
must_contain "Do not run \`gh pr list --head <branch>\`" \
  "land-stack must retain the unsafe branch lookup prohibition"
must_contain "node scripts/land-stack.mjs <bottom-pr> ... --execute" \
  "land-stack must retain guarded landing"
must_appear_before "before any write" \
  "node scripts/land-stack.mjs <bottom-pr> ... --execute" \
  "land-stack must require the guard before its landing command"

must_contain "re-run the exact \`gh pr view\`/queue query in that same turn" \
  "land-stack must require a fresh status query before reporting PR state"
must_contain "\"Merging\" is not \"merged\"" \
  "land-stack must distinguish an in-progress merge from a completed one"
must_contain "skills/prove-it/SKILL.md" \
  "land-stack must reference the shared prove-it evidence rule"

echo "OK: land-stack skill contract checks passed"
