#!/usr/bin/env bash
# Static owner-boundary policy checks.
# Enforces that runtime writable persistence initialization stays in owner modules.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0

if command -v rg >/dev/null 2>&1; then
  # 1) Runtime SQLiteAdapter.create() callsites must stay owner-only.
  create_violations="$(rg -n "SQLiteAdapter\\.create\\(" packages \
    --glob '!**/__tests__/**' \
    --glob '!**/*.test.ts' \
    --glob '!**/node_modules/**' \
    --glob '!packages/app/src/main.ts' \
    --glob '!packages/persistence/src/sqlite-adapter.ts' || true)"

  # 2) Runtime value-imports of SQLiteAdapter must stay owner-only.
  # type-only imports are allowed outside owner modules.
  value_import_violations="$(rg -n "import\\s+\\{[^}]*\\bSQLiteAdapter\\b[^}]*\\}\\s+from\\s+'@invoker/persistence'" packages \
    --glob '!**/__tests__/**' \
    --glob '!**/*.test.ts' \
    --glob '!**/node_modules/**' \
    --glob '!packages/app/src/main.ts' || true)"

  # 3) Owner init path in main.ts must explicitly pass ownerCapability.
  if ! rg -n "ownerCapability:\s*!readOnly" packages/app/src/main.ts >/dev/null; then
    echo "[owner-boundary] main.ts initServices must pass ownerCapability: !readOnly" >&2
    fail=1
  fi
else
  # Fallback for environments without ripgrep.
  create_violations="$(grep -RInE "SQLiteAdapter\\.create\\(" packages \
    --exclude-dir="__tests__" \
    --exclude-dir="node_modules" \
    --exclude="*.test.ts" \
    | grep -v '^packages/app/src/main.ts:' \
    | grep -v '^packages/persistence/src/sqlite-adapter.ts:' || true)"

  value_import_violations="$(grep -RInE "import[[:space:]]+\\{[^}]*SQLiteAdapter[^}]*\\}[[:space:]]+from[[:space:]]+'@invoker/persistence'" packages \
    --exclude-dir="__tests__" \
    --exclude-dir="node_modules" \
    --exclude="*.test.ts" \
    | grep -v '^packages/app/src/main.ts:' || true)"

  if ! grep -nE "ownerCapability:[[:space:]]*!readOnly" packages/app/src/main.ts >/dev/null; then
    echo "[owner-boundary] main.ts initServices must pass ownerCapability: !readOnly" >&2
    fail=1
  fi
fi

if [[ -n "$create_violations" ]]; then
  echo "[owner-boundary] Disallowed runtime SQLiteAdapter.create() callsites:" >&2
  echo "$create_violations" >&2
  fail=1
fi

if [[ -n "$value_import_violations" ]]; then
  echo "[owner-boundary] Disallowed runtime value-import of SQLiteAdapter outside owner modules:" >&2
  echo "$value_import_violations" >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "[owner-boundary] policy checks passed"
