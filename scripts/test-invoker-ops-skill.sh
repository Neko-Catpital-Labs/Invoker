#!/usr/bin/env bash
# Contract tests for the invoker-ops skill and safe bulk retry wrapper.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_MD="$REPO_ROOT/skills/invoker-ops/SKILL.md"
RETRY_SCRIPT="$REPO_ROOT/scripts/retry-tasks-by-status.sh"
RUN_SH="$REPO_ROOT/run.sh"
README="$REPO_ROOT/README.md"

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
[[ -x "$RETRY_SCRIPT" ]] || fail "expected executable $RETRY_SCRIPT"

must_contain "$SKILL_MD" "Do not query or mutate the SQLite database directly" "skill must forbid normal direct DB operations"
must_contain "$SKILL_MD" "./run.sh --headless retry-tasks --status failed --parallel 8" "skill must document failed retry command"
must_contain "$SKILL_MD" "./run.sh --headless retry-tasks --status pending --parallel 8" "skill must document pending retry command"
must_contain "$SKILL_MD" "Bulk retry commands must use \`--no-track\`" "skill must document acknowledgement boundary"
must_contain "$SKILL_MD" "Do not invent SQL as the fallback" "skill must reject SQL fallback"

must_contain "$RETRY_SCRIPT" "--no-track" "retry wrapper must dispatch no-track task retries"
must_contain "$RETRY_SCRIPT" "query tasks --workflow" "retry wrapper must use Invoker query surface"
must_contain "$RUN_SH" "retry-tasks" "run.sh must expose the retry-tasks headless wrapper"
must_contain "$README" "invoker-ops" "README must mention the operator skill"

bash "$RETRY_SCRIPT" --self-test

echo "OK: invoker-ops skill contract checks passed"
