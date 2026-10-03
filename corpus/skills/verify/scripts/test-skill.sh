#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SKILL_DIR="$REPO_ROOT/corpus/skills/verify"
SKILL_MD="$SKILL_DIR/SKILL.md"
CLI="$REPO_ROOT/skills/verify/control-invoker.mjs"

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
[[ -f "$CLI" ]] || fail "expected $CLI"

must_contain "control-invoker.mjs" "verify skill must name the CLI"
must_contain "never attach to the user's already-open window" "verify skill must forbid live-window attach"
must_contain "skills/prove-it/SKILL.md" "verify skill must reference prove-it"
must_contain "catalog --check" "verify skill must document catalog drift gate"
must_contain "references/features/" "verify skill must point at the feature map"

# Contract: CLI help and catalog check are runnable without Electron.
node "$CLI" --help >/dev/null || fail "control-invoker --help failed"
node "$CLI" catalog --check --json >/dev/null || fail "control-invoker catalog --check failed"
node "$SKILL_DIR/tests/control-invoker.test.mjs" || fail "control-invoker unit tests failed"
node "$SKILL_DIR/tests/efficacy-router.test.mjs" || fail "verify efficacy router tests failed"

[[ -f "$SKILL_DIR/tests/fires_example.md" ]] || fail "missing fires_example.md"
[[ -f "$SKILL_DIR/tests/stays_silent_example.md" ]] || fail "missing stays_silent_example.md"
grep -qF 'prove command-palette' "$SKILL_DIR/tests/fires_example.md" \
  || fail "fires_example.md must instruct prove command-palette"
grep -qF 'does not apply' "$SKILL_DIR/tests/stays_silent_example.md" \
  || fail "stays_silent_example.md must say verify does not apply"

echo "OK: verify skill contract checks passed"
