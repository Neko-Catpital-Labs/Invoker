#!/usr/bin/env bash
# Repro: MCP submit SEA argv double-prefix bug.
#
# Before the fix, packages/cli/src/mcp-server.ts always spawned the standalone
# CLI as `spawn(process.execPath, [process.argv[1], ...args])`. When the CLI was
# the SEA (single-executable application) binary, `process.argv[1]` already was
# the same executable path, so the spawned process saw argv like
#   <invoker-cli-path> run plan.yaml --standalone --json
# and parseArgs() treated the leading executable path as the command, failing
# with `Unknown command: <path>`.
#
# This script proves the contract by running the built CLI two ways:
#   1. Control: argv begins at `run` — must succeed.
#   2. Modeled bad-argv: argv begins with an extra executable path, then `run`
#      — must fail with `Unknown command:` on stderr.
#
# Both cases use the existing plans/fixtures/hello-world.yaml so the only
# difference is argv shape. The script exits 0 only when both expectations hold.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PLAN_PATH="plans/fixtures/hello-world.yaml"
CLI_ENTRY="packages/cli/dist/index.js"
NODE_BIN="$(command -v node)"

if [ ! -f "$CLI_ENTRY" ]; then
  echo "[repro] FAIL: $CLI_ENTRY does not exist. Build the CLI first: pnpm --filter @invoker/cli build" >&2
  exit 2
fi
if [ ! -f "$PLAN_PATH" ]; then
  echo "[repro] FAIL: fixture plan $PLAN_PATH is missing" >&2
  exit 2
fi
if [ -z "$NODE_BIN" ]; then
  echo "[repro] FAIL: could not locate node on PATH" >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/repro-mcp-submit-sea-argv-XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

CONTROL_DB="$TMP_ROOT/control-db"
BAD_DB="$TMP_ROOT/bad-db"
mkdir -p "$CONTROL_DB" "$BAD_DB"

echo "[repro] Inserting an executable path before \`run\` in argv models the"
echo "[repro] pre-fix MCP submit path on SEA builds, where process.argv[1] was"
echo "[repro] re-prepended ahead of the real CLI args."
echo

echo "[repro] Control case: argv begins at \`run\` (expected: exit 0)."
set +e
CONTROL_OUT="$(node "$CLI_ENTRY" run "$PLAN_PATH" --standalone --db-dir "$CONTROL_DB" --json 2>"$TMP_ROOT/control.stderr")"
CONTROL_STATUS=$?
set -e
CONTROL_STDERR="$(cat "$TMP_ROOT/control.stderr")"
echo "[repro] control exit=$CONTROL_STATUS"
if [ "$CONTROL_STATUS" -ne 0 ]; then
  echo "[repro] FAIL: control case should succeed but exited $CONTROL_STATUS" >&2
  echo "$CONTROL_STDERR" >&2
  exit 1
fi
if ! printf '%s' "$CONTROL_OUT" | python3 -c "import json,sys; json.loads(sys.stdin.read())" >/dev/null 2>&1; then
  echo "[repro] FAIL: control --json stdout was not parseable JSON" >&2
  echo "$CONTROL_OUT" >&2
  exit 1
fi

echo
echo "[repro] Bad-argv case: argv begins with \"$NODE_BIN\" then \`run\` (expected: non-zero, \`Unknown command:\` on stderr)."
set +e
BAD_OUT="$(node "$CLI_ENTRY" "$NODE_BIN" run "$PLAN_PATH" --standalone --db-dir "$BAD_DB" --json 2>"$TMP_ROOT/bad.stderr")"
BAD_STATUS=$?
set -e
BAD_STDERR="$(cat "$TMP_ROOT/bad.stderr")"
echo "[repro] bad-argv exit=$BAD_STATUS"
if [ "$BAD_STATUS" -eq 0 ]; then
  echo "[repro] FAIL: bad-argv case should have failed but exited 0" >&2
  echo "$BAD_OUT" >&2
  exit 1
fi
if ! printf '%s' "$BAD_STDERR" | grep -q "Unknown command:"; then
  echo "[repro] FAIL: bad-argv stderr did not contain \`Unknown command:\`" >&2
  echo "--- stderr ---" >&2
  echo "$BAD_STDERR" >&2
  exit 1
fi

echo
echo "[repro] PASS: control succeeded and bad-argv failed with \`Unknown command:\` — the SEA double-prefix shape is the root cause."
