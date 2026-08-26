#!/usr/bin/env bash
# Regenerate docs/install-transcript.txt from invoker-cli install --demo.
# Prefer the built package binary when available; otherwise tsx/source via vitest-free node.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/docs/install-transcript.txt"
CLI_DIST="$REPO_ROOT/packages/cli/dist/index.js"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "$(dirname "$OUT")"

if [[ -f "$CLI_DIST" ]]; then
  node "$CLI_DIST" install --demo >"$OUT"
elif command -v invoker-cli >/dev/null 2>&1; then
  invoker-cli install --demo >"$OUT"
else
  # Build cli first so dist exists, then capture.
  pnpm --filter @invoker/cli run build
  [[ -f "$CLI_DIST" ]] || fail "missing $CLI_DIST after build"
  node "$CLI_DIST" install --demo >"$OUT"
fi

grep -qF 'Slack: skipped' "$OUT" || fail "transcript missing Slack skip"
grep -qF 'Remote machines: skipped' "$OUT" || fail "transcript missing machines skip"
grep -qF 'Workers on: pr-status, autofix, auto-approve' "$OUT" || fail "transcript missing workers"
grep -qF 'Quick-install complete' "$OUT" || fail "transcript missing completion banner"

echo "Wrote $OUT"
