#!/usr/bin/env bash
# Deterministic TS source import guard proof.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

node "$ROOT/scripts/check-ts-source-imports.mjs"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TMP_ROOT/packages/clean-lib/src" \
         "$TMP_ROOT/packages/execution-engine/src" \
         "$TMP_ROOT/packages/runtime-app/src"

cat > "$TMP_ROOT/packages/clean-lib/package.json" <<'JSON'
{
  "name": "clean-lib",
  "main": "src/index.ts"
}
JSON

cat > "$TMP_ROOT/packages/execution-engine/package.json" <<'JSON'
{
  "name": "execution-engine",
  "main": "src/index.ts"
}
JSON

cat > "$TMP_ROOT/packages/runtime-app/package.json" <<'JSON'
{
  "name": "runtime-app",
  "main": "dist/main.js"
}
JSON

cat > "$TMP_ROOT/packages/clean-lib/src/index.ts" <<'TS'
import './bad.js';
export const clean = true;
TS

cat > "$TMP_ROOT/packages/clean-lib/src/index.test.ts" <<'TS'
import './test-only.js';
export const cleanTest = true;
TS

cat > "$TMP_ROOT/packages/execution-engine/src/index.ts" <<'TS'
import './legacy.js';
export const legacy = true;
TS

cat > "$TMP_ROOT/packages/runtime-app/src/index.ts" <<'TS'
import './runtime.js';
export const runtime = true;
TS

if node "$ROOT/scripts/check-ts-source-imports.mjs" --root "$TMP_ROOT" >"$TMP_ROOT/stdout.log" 2>"$TMP_ROOT/stderr.log"; then
  echo "[ts-source-imports] Expected TS-exported package with production .js import to fail" >&2
  exit 1
fi

if ! grep -F "packages/clean-lib/src/index.ts: ./bad.js" "$TMP_ROOT/stderr.log" >/dev/null; then
  echo "[ts-source-imports] Forbidden production .js import was not reported deterministically" >&2
  cat "$TMP_ROOT/stderr.log" >&2
  exit 1
fi

if grep -F "index.test.ts" "$TMP_ROOT/stderr.log" >/dev/null; then
  echo "[ts-source-imports] Test-only .js import should be ignored" >&2
  cat "$TMP_ROOT/stderr.log" >&2
  exit 1
fi

if grep -F "legacy.js" "$TMP_ROOT/stderr.log" >/dev/null; then
  echo "[ts-source-imports] Temporary legacy exception package should be skipped" >&2
  cat "$TMP_ROOT/stderr.log" >&2
  exit 1
fi

if grep -F "runtime.js" "$TMP_ROOT/stderr.log" >/dev/null; then
  echo "[ts-source-imports] Built-JS runtime package should not be enforced" >&2
  cat "$TMP_ROOT/stderr.log" >&2
  exit 1
fi
