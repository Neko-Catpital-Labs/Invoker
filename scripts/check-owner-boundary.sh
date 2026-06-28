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
    --glob '!**/*.d.ts' \
    --glob '!**/dist/**' \
    --glob '!**/e2e/**' \
    --glob '!**/node_modules/**' \
    --glob '!packages/app/src/viewer-db-boundary.ts' \
    --glob '!packages/cli/src/index.ts' \
    --glob '!packages/persistence/src/sqlite-adapter.ts' \
    --glob '!packages/data-store/src/sqlite-adapter.ts' || true)"

  # 2) Runtime value-imports of SQLiteAdapter must stay owner-only.
  # type-only imports are allowed outside owner modules.
  value_import_violations="$(rg -n "import\\s+\\{[^}]*\\bSQLiteAdapter\\b[^}]*\\}\\s+from\\s+'@invoker/(persistence|data-store)'" packages \
    --glob '!**/__tests__/**' \
    --glob '!**/*.test.ts' \
    --glob '!**/*.d.ts' \
    --glob '!**/dist/**' \
    --glob '!**/e2e/**' \
    --glob '!**/node_modules/**' \
    --glob '!packages/app/src/viewer-db-boundary.ts' \
    --glob '!packages/cli/src/index.ts' || true)"

  raw_memory_violations="$(rg -n "SQLiteAdapter\\.create\\(['\"]:memory:" packages \
    --glob '!**/__tests__/**' \
    --glob '!**/*.test.ts' \
    --glob '!**/*.d.ts' \
    --glob '!**/dist/**' \
    --glob '!**/e2e/**' \
    --glob '!**/node_modules/**' \
    --glob '!packages/data-store/src/sqlite-adapter.ts' || true)"

  # 3) Owner opener path must explicitly pass ownerCapability.
  if ! rg -n "ownerCapability:\s*!options\.readOnly" packages/app/src/viewer-db-boundary.ts >/dev/null; then
    echo "[owner-boundary] viewer-db-boundary.ts must pass ownerCapability: !options.readOnly" >&2
    fail=1
  fi

  if rg -n "SQLiteAdapter\\.create\\(" packages/app/src/main.ts >/dev/null \
    || ! rg -n "openMainProcessDatabase\\(\\{" packages/app/src/main.ts >/dev/null; then
    echo "[owner-boundary] main.ts must open persistence through openMainProcessDatabase()." >&2
    fail=1
  fi
else
  # Fallback for environments without ripgrep.
  create_violations="$(grep -RInE "SQLiteAdapter\\.create\\(" packages \
    --exclude-dir="__tests__" \
    --exclude-dir="dist" \
    --exclude-dir="e2e" \
    --exclude-dir="node_modules" \
    --exclude="*.d.ts" \
    --exclude="*.test.ts" \
    | grep -v '^packages/app/src/viewer-db-boundary.ts:' \
    | grep -v '^packages/cli/src/index.ts:' \
    | grep -v '^packages/persistence/src/sqlite-adapter.ts:' \
    | grep -v '^packages/data-store/src/sqlite-adapter.ts:' || true)"

  value_import_violations="$(grep -RInE "import[[:space:]]+\\{[^}]*SQLiteAdapter[^}]*\\}[[:space:]]+from[[:space:]]+'@invoker/(persistence|data-store)'" packages \
    --exclude-dir="__tests__" \
    --exclude-dir="dist" \
    --exclude-dir="e2e" \
    --exclude-dir="node_modules" \
    --exclude="*.d.ts" \
    --exclude="*.test.ts" \
    | grep -v '^packages/app/src/viewer-db-boundary.ts:' \
    | grep -v '^packages/cli/src/index.ts:' || true)"

  raw_memory_violations="$(grep -RInE "SQLiteAdapter\\.create\\(['\"]:memory:" packages \
    --exclude-dir="__tests__" \
    --exclude-dir="dist" \
    --exclude-dir="e2e" \
    --exclude-dir="node_modules" \
    --exclude="*.d.ts" \
    --exclude="*.test.ts" \
    | grep -v '^packages/data-store/src/sqlite-adapter.ts:' || true)"

  if ! grep -nE "ownerCapability:[[:space:]]*!options\\.readOnly" packages/app/src/viewer-db-boundary.ts >/dev/null; then
    echo "[owner-boundary] viewer-db-boundary.ts must pass ownerCapability: !options.readOnly" >&2
    fail=1
  fi

  if grep -nE "SQLiteAdapter\\.create\\(" packages/app/src/main.ts >/dev/null \
    || ! grep -nE "openMainProcessDatabase\\(\\{" packages/app/src/main.ts >/dev/null; then
    echo "[owner-boundary] main.ts must open persistence through openMainProcessDatabase()." >&2
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

if [[ -n "$raw_memory_violations" ]]; then
  echo "[owner-boundary] Runtime raw SQLite :memory: opens are forbidden; use openDetachedViewerDatabase() or SQLiteAdapter.createEphemeral()." >&2
  echo "$raw_memory_violations" >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "[owner-boundary] policy checks passed"
