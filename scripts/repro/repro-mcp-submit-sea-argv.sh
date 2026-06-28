#!/usr/bin/env bash
# Repro: MCP submit path under a compiled (SEA) invoker-cli inserted the
# executable path as the first argv before "run", so the CLI parsed the
# executable path as the command name and failed with `Unknown command:`.
#
# This script models the bad argv shape against the built JS entry: it runs
# a known-good control case, then prepends `$(command -v node)` before `run`
# to recreate the double-prefix the old MCP runner produced for SEA binaries.
#
# Exit 0 iff:
#   - control case (correct argv) exits 0, AND
#   - modeled bad-argv case exits non-zero with `Unknown command:` on stderr.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PLAN="plans/fixtures/hello-world.yaml"
CLI_ENTRY="packages/cli/dist/index.js"

if [ ! -f "$CLI_ENTRY" ]; then
  echo "[repro] missing $CLI_ENTRY — build with: pnpm --filter @invoker/cli build" >&2
  exit 2
fi

TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/repro-mcp-submit-sea-argv-XXXXXX")"
trap 'rm -rf "$TMPBASE"' EXIT

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "[repro] node not found on PATH" >&2
  exit 2
fi

echo "[repro] problem: MCP submit on compiled invoker-cli spawned with argv = [cliPath, 'run', ...] so the executable path became the parsed command"
echo "[repro] root cause: createProcessRunner unconditionally prepended cliPath, which equals execPath in a SEA binary"
echo "[repro] model: prepend \$(command -v node) before 'run' to recreate the double-prefix the old runner produced"

# --- Control case: correct argv ---------------------------------------------
CTRL_DB="$TMPBASE/db-control"
mkdir -p "$CTRL_DB"
CTRL_STDOUT="$TMPBASE/ctrl.stdout"
CTRL_STDERR="$TMPBASE/ctrl.stderr"

echo "[repro] control: node $CLI_ENTRY run $PLAN --standalone --db-dir <tmp> --json"
set +e
node "$CLI_ENTRY" run "$PLAN" --standalone --db-dir "$CTRL_DB" --json \
  >"$CTRL_STDOUT" 2>"$CTRL_STDERR"
CTRL_EC=$?
set -e

if [ "$CTRL_EC" -ne 0 ]; then
  echo "[repro][FAIL] control case exited $CTRL_EC, expected 0" >&2
  echo "--- control stderr ---" >&2
  cat "$CTRL_STDERR" >&2 || true
  exit 1
fi
echo "[repro] control: exit=0 (correct argv runs the plan)"

# --- Bad-argv case: modeled SEA double-prefix --------------------------------
BAD_DB="$TMPBASE/db-bad"
mkdir -p "$BAD_DB"
BAD_STDOUT="$TMPBASE/bad.stdout"
BAD_STDERR="$TMPBASE/bad.stderr"

echo "[repro] bad-argv: node $CLI_ENTRY $NODE_BIN run $PLAN --standalone --db-dir <tmp> --json"
set +e
node "$CLI_ENTRY" "$NODE_BIN" run "$PLAN" --standalone --db-dir "$BAD_DB" --json \
  >"$BAD_STDOUT" 2>"$BAD_STDERR"
BAD_EC=$?
set -e

if [ "$BAD_EC" -eq 0 ]; then
  echo "[repro][FAIL] modeled bad-argv case exited 0, expected non-zero" >&2
  echo "--- bad-argv stdout ---" >&2
  cat "$BAD_STDOUT" >&2 || true
  exit 1
fi

if ! grep -q "Unknown command:" "$BAD_STDERR"; then
  echo "[repro][FAIL] modeled bad-argv case did not surface 'Unknown command:' on stderr" >&2
  echo "--- bad-argv stderr ---" >&2
  cat "$BAD_STDERR" >&2 || true
  exit 1
fi
echo "[repro] bad-argv: exit=$BAD_EC with stderr containing 'Unknown command:' (matches the old SEA failure mode)"

echo "[repro][PASS] argv shape is the root cause: prepending an executable path before 'run' breaks command parsing; the correct shape runs cleanly"
