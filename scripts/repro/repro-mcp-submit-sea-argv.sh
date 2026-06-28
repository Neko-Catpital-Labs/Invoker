#!/usr/bin/env bash
# Repro: MCP submit failed with `Unknown command:` because the SEA process
# runner spawned `<execPath> <execPath> run …`, turning the second executable
# path into the parsed CLI command.
#
# This script proves the bad argv shape was the root cause:
#   - control case:   node dist/index.js run <plan> …            -> exit 0
#   - bad-argv case:  node dist/index.js <node_path> run <plan> … -> exit != 0
#                                                                   stderr contains "Unknown command:"
#
# The bad-argv case models the old SEA double-prefix path by inserting an
# executable path before `run` — the same shape `createProcessRunner` produced
# when `cliPath === process.execPath` was treated as a JS entrypoint.
#
# Usage:
#   bash scripts/repro/repro-mcp-submit-sea-argv.sh
#
# Exit codes:
#   0 — both cases behave as expected (root cause demonstrated)
#   1 — control case failed, or bad-argv case did not fail with `Unknown command:`
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CLI_ENTRY="packages/cli/dist/index.js"
PLAN_FIXTURE="plans/fixtures/hello-world.yaml"

if [ ! -f "$CLI_ENTRY" ]; then
  echo "[repro] $CLI_ENTRY not found — building @invoker/cli..."
  pnpm --filter @invoker/cli build >/dev/null
fi

if [ ! -f "$PLAN_FIXTURE" ]; then
  echo "[repro] FAIL: fixture plan $PLAN_FIXTURE is missing" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "[repro] FAIL: node not on PATH" >&2
  exit 1
fi

TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/repro-mcp-submit-sea-argv-XXXXXX")"
trap 'rm -rf "$TMPBASE"' EXIT

CONTROL_DB="$TMPBASE/control-db"
BAD_DB="$TMPBASE/bad-db"
mkdir -p "$CONTROL_DB" "$BAD_DB"

CONTROL_OUT="$TMPBASE/control.out"
CONTROL_ERR="$TMPBASE/control.err"
BAD_OUT="$TMPBASE/bad.out"
BAD_ERR="$TMPBASE/bad.err"

echo "[repro] root cause: createProcessRunner prepended cliPath even when cliPath === process.execPath,"
echo "[repro] so spawn(execPath, [execPath, 'run', ...]) made the CLI treat the executable path as the command."
echo "[repro] control case   = correct argv (run first)"
echo "[repro] bad-argv case  = inserts an executable path before 'run' to model the old SEA double-prefix"
echo

# ---------------------------------------------------------------------------
# Control case — correct argv shape: run is the first positional.
# ---------------------------------------------------------------------------
echo "[repro] control: node $CLI_ENTRY run $PLAN_FIXTURE --standalone --db-dir <tmp> --json"
set +e
node "$CLI_ENTRY" run "$PLAN_FIXTURE" --standalone --db-dir "$CONTROL_DB" --json \
  >"$CONTROL_OUT" 2>"$CONTROL_ERR"
CONTROL_STATUS=$?
set -e

if [ "$CONTROL_STATUS" -ne 0 ]; then
  echo "[repro] FAIL: control case exited $CONTROL_STATUS (expected 0)" >&2
  echo "--- control stdout ---" >&2
  cat "$CONTROL_OUT" >&2 || true
  echo "--- control stderr ---" >&2
  cat "$CONTROL_ERR" >&2 || true
  exit 1
fi
echo "[repro] control PASS: exit 0"
echo

# ---------------------------------------------------------------------------
# Bad-argv case — inserts an executable path before `run`, mirroring the
# argv that the old createProcessRunner built when cliPath === execPath.
# ---------------------------------------------------------------------------
echo "[repro] bad-argv: node $CLI_ENTRY $NODE_BIN run $PLAN_FIXTURE --standalone --db-dir <tmp> --json"
set +e
node "$CLI_ENTRY" "$NODE_BIN" run "$PLAN_FIXTURE" --standalone --db-dir "$BAD_DB" --json \
  >"$BAD_OUT" 2>"$BAD_ERR"
BAD_STATUS=$?
set -e

if [ "$BAD_STATUS" -eq 0 ]; then
  echo "[repro] FAIL: bad-argv case unexpectedly exited 0" >&2
  echo "--- bad-argv stdout ---" >&2
  cat "$BAD_OUT" >&2 || true
  echo "--- bad-argv stderr ---" >&2
  cat "$BAD_ERR" >&2 || true
  exit 1
fi

if ! grep -Fq "Unknown command:" "$BAD_ERR"; then
  echo "[repro] FAIL: bad-argv case exited $BAD_STATUS but stderr did not contain 'Unknown command:'" >&2
  echo "--- bad-argv stderr ---" >&2
  cat "$BAD_ERR" >&2 || true
  exit 1
fi
echo "[repro] bad-argv PASS: exit $BAD_STATUS, stderr contains 'Unknown command:'"
echo

echo "[repro] PASS: argv shape with an extra executable path before 'run' reproduces the MCP submit failure;"
echo "[repro]       the fix in resolveCliInvocation prevents this shape when cliPath === process.execPath."
