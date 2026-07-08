#!/usr/bin/env bash
# Regression test for skills/remote-ci-verify/scripts/run-remote-ci-verify.sh.
#
# The script passes env to the remote by prefixing `VAR=value ... bash -se` onto
# the ssh command. ssh joins its args with spaces, so a multi-word value like
# CI_VERIFY_REMOTE_TEST_COMMAND="pnpm run test:all" used to be re-split by the
# remote shell into `CI_VERIFY_REMOTE_TEST_COMMAND=pnpm run test:all bash -se`,
# leaving `run` to be executed as a command ("run: command not found").
#
# The fix single-quotes each value (sh_squote) into one REMOTE_ENV prefix. This
# test exercises the real sh_squote from the script and guards the construction.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/skills/remote-ci-verify/scripts/run-remote-ci-verify.sh"

[[ -f "$SCRIPT" ]] || { echo "FAIL: script not found: $SCRIPT" >&2; exit 1; }

# Syntax must be valid.
bash -n "$SCRIPT"

# Load the real sh_squote definition from the script (no duplicated logic).
eval "$(sed -n '/^sh_squote() {/,/^}/p' "$SCRIPT")"

assert_roundtrip() {
  local value=$1
  local quoted got
  quoted=$(sh_squote "$value")
  # Simulate the remote shell re-parsing `VAR=<quoted>; <cmd>` in a fresh shell,
  # exactly as the remote `sh -c` parses the env prefix ssh sends it.
  got=$(bash -c "VAR=$quoted; printf '%s' \"\$VAR\"")
  if [[ "$got" != "$value" ]]; then
    echo "FAIL: [$value] -> quoted [$quoted] -> remote-parsed [$got]" >&2
    exit 1
  fi
  echo "ok: multi-token value survives remote re-parse: [$value]"
}

assert_roundtrip "pnpm run test:all"
assert_roundtrip "pnpm run test:all:extended"
assert_roundtrip "fix/liveness-stall-requeue-worker"
assert_roundtrip ""
assert_roundtrip "value with 'embedded' quotes"

# Guard against reverting to the bare unquoted ssh arg that caused the bug.
if grep -qE 'CI_VERIFY_REMOTE_TEST_COMMAND="\$REMOTE_TEST_CMD" \\' "$SCRIPT"; then
  echo "FAIL: script passes CI_VERIFY_REMOTE_TEST_COMMAND as a bare (unquoted) ssh arg" >&2
  exit 1
fi

# The fix must build a single quoted env prefix and pass it as one ssh argument.
grep -q 'REMOTE_ENV=' "$SCRIPT" || { echo "FAIL: REMOTE_ENV prefix missing" >&2; exit 1; }
grep -qF '"${REMOTE_ENV}bash -se"' "$SCRIPT" || { echo "FAIL: ssh does not pass REMOTE_ENV as one arg" >&2; exit 1; }

echo "PASS: remote-ci-verify env quoting"
