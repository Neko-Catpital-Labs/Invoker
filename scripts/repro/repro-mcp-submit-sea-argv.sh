#!/usr/bin/env bash
# Repro script: MCP submit failed against the standalone (SEA-style) invoker-cli
# because createProcessRunner spawned the executable while also passing its own
# path as the first positional arg. The CLI parser then treated that executable
# path as the command and bailed out with "Unknown command: <path>".
#
# This script proves the root cause is the argv shape — not the plan, not the
# CLI binary itself, not the standalone executor — by running two cases against
# the built dev CLI entry:
#
#   control:  node dist/index.js run <plan> --standalone --json
#             (correct argv: first positional is "run")  → exit 0
#
#   bad argv: node dist/index.js "$(command -v node)" run <plan> --standalone --json
#             (models the old SEA double-prefix:
#               argv[0] = node binary, argv[1] = "run", argv[2] = plan)
#             → non-zero, stderr contains "Unknown command:"
#
# Pass: control succeeds AND bad-argv case fails with "Unknown command:".
# Fail: either expectation is violated.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PLAN="plans/fixtures/hello-world.yaml"
CLI_ENTRY="packages/cli/dist/index.js"

if [ ! -f "$CLI_ENTRY" ]; then
  echo "[repro] missing $CLI_ENTRY — build the CLI first: pnpm --filter @invoker/cli build" >&2
  exit 2
fi
if [ ! -f "$PLAN" ]; then
  echo "[repro] missing fixture $PLAN" >&2
  exit 2
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "[repro] node not on PATH" >&2
  exit 2
fi

TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/repro-mcp-submit-sea-argv-XXXXXX")"
trap 'rm -rf "$TMPBASE"' EXIT

CONTROL_DB="$TMPBASE/control-db"
BAD_DB="$TMPBASE/bad-db"
mkdir -p "$CONTROL_DB" "$BAD_DB"

echo "[repro] root cause: MCP runner spawned invoker-cli with argv [<exe>, 'run', ...] when the executable was already the SEA binary, so 'run' was parsed as plan and <exe> as command."
echo "[repro] control case: argv begins at 'run' (correct shape after the fix)."

set +e
CONTROL_STDOUT="$("$NODE_BIN" "$CLI_ENTRY" run "$PLAN" --standalone --db-dir "$CONTROL_DB" --json 2> "$TMPBASE/control.stderr")"
CONTROL_EC=$?
set -e
echo "[repro] control exit=$CONTROL_EC"

if [ "$CONTROL_EC" -ne 0 ]; then
  echo "[repro] FAIL: control case failed unexpectedly. stderr:" >&2
  sed 's/^/[repro][control.stderr] /' "$TMPBASE/control.stderr" >&2
  exit 1
fi

echo "[repro] bad-argv case: prepend an executable path before 'run' to model the old SEA double-prefix bug."
set +e
BAD_STDOUT="$("$NODE_BIN" "$CLI_ENTRY" "$NODE_BIN" run "$PLAN" --standalone --db-dir "$BAD_DB" --json 2> "$TMPBASE/bad.stderr")"
BAD_EC=$?
set -e
echo "[repro] bad-argv exit=$BAD_EC"

if [ "$BAD_EC" -eq 0 ]; then
  echo "[repro] FAIL: bad-argv case unexpectedly succeeded. stdout:" >&2
  echo "$BAD_STDOUT" | sed 's/^/[repro][bad.stdout] /' >&2
  exit 1
fi

if ! grep -q "Unknown command:" "$TMPBASE/bad.stderr"; then
  echo "[repro] FAIL: bad-argv case failed but stderr did not contain 'Unknown command:'. stderr:" >&2
  sed 's/^/[repro][bad.stderr] /' "$TMPBASE/bad.stderr" >&2
  exit 1
fi

echo "[repro] observed bad-argv stderr line:"
grep -m1 "Unknown command:" "$TMPBASE/bad.stderr" | sed 's/^/[repro][bad.stderr] /'

echo "[repro] PASS: control exited 0; bad-argv case failed with 'Unknown command:', confirming the argv shape was the root cause."
