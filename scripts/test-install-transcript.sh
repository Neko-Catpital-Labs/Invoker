#!/usr/bin/env bash
# Contract: docs/install-transcript.txt matches install --demo and required banners.
# When the golden is not in this checkout yet (earlier stack slices), only syntax-check.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GOLDEN="$REPO_ROOT/docs/install-transcript.txt"
CLI_DIST="$REPO_ROOT/packages/cli/dist/index.js"
CAPTURE="$REPO_ROOT/scripts/capture-install-transcript.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$CAPTURE" ]] || fail "missing $CAPTURE"
[[ -x "$CAPTURE" ]] || fail "capture-install-transcript.sh must be executable"
bash -n "$CAPTURE" || fail "bash -n capture failed"
bash -n "$0" || fail "bash -n self failed"

if [[ ! -f "$GOLDEN" ]]; then
  echo "OK: install transcript scripts (golden docs/install-transcript.txt lands in docs slice)"
  exit 0
fi

must_contain() {
  grep -qF -- "$1" "$GOLDEN" || fail "golden missing: $1"
}

must_contain '==> Invoker quick-install'
must_contain 'Slack: skipped'
must_contain 'Remote machines: skipped'
must_contain 'Workers on: pr-status, autofix, auto-approve'
must_contain 'Quick-install complete'
must_contain 'auto-approve-authors --add-current-github-user'

if [[ ! -f "$CLI_DIST" ]]; then
  pnpm --filter @invoker/cli run build
  [[ -f "$CLI_DIST" ]] || fail "missing $CLI_DIST after build"
fi

actual="$(mktemp)"
node "$CLI_DIST" install --demo >"$actual"
if ! diff -u "$GOLDEN" "$actual"; then
  rm -f "$actual"
  fail "golden transcript drift — re-run bash scripts/capture-install-transcript.sh"
fi
rm -f "$actual"

echo "OK: install transcript contract"
