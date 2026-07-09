#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] problem: unresolved MCP cliPath is treated like a standalone executable"
echo "[repro] expected: resolveCliInvocation rejects an empty cliPath before spawning Node with run as a script"

python3 - "$ROOT/packages/cli/src/mcp-server.ts" <<'PY'
import pathlib
import sys

src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
try:
    body = src.split("export function resolveCliInvocation(", 1)[1].split("\nfunction createProcessRunner", 1)[0]
except IndexError:
    raise SystemExit("[repro] FAIL: resolveCliInvocation not found")
empty_check = body.find("if (!cliPath)")
throw_check = body.find("throw new Error('Unable to resolve CLI path for spawning invoker-cli')")
standalone_check = body.find("if (cliPath === execPath)")
buggy_check = body.find("if (!cliPath || cliPath === execPath)")

if buggy_check != -1:
    raise SystemExit("[repro] FAIL: empty cliPath still falls through as standalone")
if empty_check == -1 or throw_check == -1:
    raise SystemExit("[repro] FAIL: empty cliPath is not rejected with a clear error")
if standalone_check == -1:
    raise SystemExit("[repro] FAIL: standalone execPath === cliPath case is missing")
if not (empty_check < throw_check < standalone_check):
    raise SystemExit("[repro] FAIL: empty cliPath must be rejected before standalone argv handling")

print("[repro] PASS: empty cliPath is rejected before standalone argv handling")
PY
