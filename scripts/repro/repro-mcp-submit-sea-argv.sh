#!/usr/bin/env bash
# Repro: MCP submit path passed a duplicated executable path to invoker-cli.
#
# The compiled SEA build of invoker-cli is itself the executable. The original
# MCP runner called `spawn(process.execPath, [process.argv[1], ...args])`,
# which under SEA expanded to `spawn(<invoker-cli>, [<invoker-cli>, 'run', ...])`.
# The CLI then parsed its first positional arg as the command, saw the second
# executable path, and exited with `Unknown command: <path>`.
#
# This script models that bug against the built dev entry by deliberately
# inserting an extra executable path before `run`. Pass condition:
#   - Control case (correct argv)                 : exit code 0
#   - Modeled bad-argv case (duplicated exec path): non-zero exit AND
#                                                   stderr contains
#                                                   `Unknown command:`
#
# Prereq: the @invoker/cli package must already be built so that
# packages/cli/dist/index.js exists. Run `pnpm --filter @invoker/cli build`
# (or `pnpm -r build`) first.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

CLI_ENTRY="packages/cli/dist/index.js"
FIXTURE_PLAN="plans/fixtures/hello-world.yaml"

if [ ! -f "$CLI_ENTRY" ]; then
  echo "[repro] missing built CLI entry at $CLI_ENTRY" >&2
  echo "[repro] build it first: pnpm --filter @invoker/cli build" >&2
  exit 2
fi

if [ ! -f "$FIXTURE_PLAN" ]; then
  echo "[repro] missing fixture plan at $FIXTURE_PLAN" >&2
  exit 2
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "[repro] node not found on PATH" >&2
  exit 2
fi

TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/repro-mcp-submit-sea-argv-XXXXXX")"
trap 'rm -rf "$TMPBASE"' EXIT

CONTROL_DB="$TMPBASE/control-db"
BAD_DB="$TMPBASE/bad-db"
mkdir -p "$CONTROL_DB" "$BAD_DB"

echo "[repro] CLI entry : $CLI_ENTRY"
echo "[repro] fixture   : $FIXTURE_PLAN"
echo "[repro] node      : $NODE_BIN"
echo "[repro] tmp base  : $TMPBASE"
echo

# ---------------------------------------------------------------------------
# Control case: argv starts at `run`. This is what the fixed runner emits.
# ---------------------------------------------------------------------------
echo "[repro] ==> Control case (correct argv shape)"
echo "[repro]     node $CLI_ENTRY run $FIXTURE_PLAN --standalone --db-dir <tmp> --json"

CONTROL_STDOUT="$TMPBASE/control.stdout"
CONTROL_STDERR="$TMPBASE/control.stderr"
set +e
node "$CLI_ENTRY" run "$FIXTURE_PLAN" --standalone --db-dir "$CONTROL_DB" --json \
  >"$CONTROL_STDOUT" 2>"$CONTROL_STDERR"
CONTROL_EXIT=$?
set -e

echo "[repro]     exit=$CONTROL_EXIT"
if [ "$CONTROL_EXIT" -ne 0 ]; then
  echo "[repro] FAIL: control case should exit 0 but exited $CONTROL_EXIT" >&2
  echo "[repro] control stderr:" >&2
  sed 's/^/[repro]   /' "$CONTROL_STDERR" >&2
  echo "[repro] control stdout:" >&2
  sed 's/^/[repro]   /' "$CONTROL_STDOUT" >&2
  exit 1
fi
echo "[repro]     control OK"
echo

# ---------------------------------------------------------------------------
# Modeled bad-argv case: an extra executable path is inserted before `run`,
# matching the old SEA spawn shape `spawn(execPath, [execPath, 'run', ...])`.
# ---------------------------------------------------------------------------
echo "[repro] ==> Modeled bad-argv case (duplicated executable path before \`run\`)"
echo "[repro]     node $CLI_ENTRY \"$NODE_BIN\" run $FIXTURE_PLAN --standalone --db-dir <tmp> --json"
echo "[repro]     (inserting an executable path before \`run\` models the old SEA double-prefix bug)"

BAD_STDOUT="$TMPBASE/bad.stdout"
BAD_STDERR="$TMPBASE/bad.stderr"
set +e
node "$CLI_ENTRY" "$NODE_BIN" run "$FIXTURE_PLAN" --standalone --db-dir "$BAD_DB" --json \
  >"$BAD_STDOUT" 2>"$BAD_STDERR"
BAD_EXIT=$?
set -e

echo "[repro]     exit=$BAD_EXIT"

if [ "$BAD_EXIT" -eq 0 ]; then
  echo "[repro] FAIL: bad-argv case unexpectedly succeeded (exit 0)" >&2
  exit 1
fi

if ! grep -q "Unknown command:" "$BAD_STDERR"; then
  echo "[repro] FAIL: bad-argv case stderr did not contain 'Unknown command:'" >&2
  echo "[repro] bad-argv stderr:" >&2
  sed 's/^/[repro]   /' "$BAD_STDERR" >&2
  exit 1
fi

echo "[repro]     bad-argv reproduced: non-zero exit with 'Unknown command:' on stderr"
echo
echo "[repro] PASS: control argv runs cleanly and the duplicated-exec-path shape"
echo "[repro]       reproduces the original 'Unknown command:' failure."
