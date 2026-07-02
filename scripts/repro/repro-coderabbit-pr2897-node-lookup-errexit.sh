#!/usr/bin/env bash
# Repro: repro-mcp-submit-sea-argv.sh must emit its friendly missing-node error.
# Buggy behavior: NODE_BIN="$(command -v node)" exits under set -e before the
# script reaches the explicit "node not found" message and exit-2 path.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TARGET="scripts/repro/repro-mcp-submit-sea-argv.sh"
CLI_ENTRY="packages/cli/dist/index.js"
BASH_BIN="$(command -v bash)"

if [ ! -f "$TARGET" ]; then
  echo "[repro] FAIL: missing target script at $TARGET" >&2
  exit 1
fi

TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/repro-coderabbit-pr2897-node-lookup-XXXXXX")"
CREATED_CLI=0
cleanup() {
  if [ "$CREATED_CLI" -eq 1 ]; then
    rm -f "$CLI_ENTRY"
    rmdir packages/cli/dist 2>/dev/null || true
  fi
  rm -rf "$TMPBASE"
}
trap cleanup EXIT

if [ ! -f "$CLI_ENTRY" ]; then
  mkdir -p "$(dirname "$CLI_ENTRY")"
  printf '%s\n' '#!/usr/bin/env node' 'process.exit(0);' >"$CLI_ENTRY"
  CREATED_CLI=1
fi

FAKE_BIN="$TMPBASE/bin"
mkdir -p "$FAKE_BIN"
ln -s "$(command -v dirname)" "$FAKE_BIN/dirname"

STDOUT="$TMPBASE/stdout"
STDERR="$TMPBASE/stderr"
set +e
PATH="$FAKE_BIN" "$BASH_BIN" "$TARGET" >"$STDOUT" 2>"$STDERR"
STATUS=$?
set -e

if [ "$STATUS" -eq 2 ] && grep -Fq "[repro] node not found on PATH" "$STDERR"; then
  echo "[repro] PASS: missing node reaches the friendly error path"
  exit 0
fi

echo "[repro] FAIL: missing node did not use the friendly error path" >&2
echo "[repro] expected exit=2 and stderr containing '[repro] node not found on PATH'" >&2
echo "[repro] actual exit=$STATUS" >&2
echo "[repro] stdout:" >&2
sed 's/^/[repro]   /' "$STDOUT" >&2 || true
echo "[repro] stderr:" >&2
sed 's/^/[repro]   /' "$STDERR" >&2 || true
exit 1
