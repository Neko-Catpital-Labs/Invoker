#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-cli-smoke-db.XXXXXX")"

cd "$ROOT"
pnpm --filter @invoker/cli build

BEFORE="$(pgrep -af '[E]lectron|owner-serve' || true)"
OUTPUT="$(./packages/cli/dist/index.js run plans/fixtures/hello-world.yaml --standalone --db-dir "$DB_DIR" 2>&1)"
AFTER="$(pgrep -af '[E]lectron|owner-serve' || true)"
printf '%s\n' "$OUTPUT"

grep -q 'hello-from-invoker-cli' <<<"$OUTPUT"

if ! diff -u <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") >/dev/null; then
  echo "Standalone CLI smoke changed Electron/owner-serve process set." >&2
  exit 1
fi

if find "$DB_DIR" -maxdepth 1 -name '*.sock' -print -quit | grep -q .; then
  echo "Unexpected IPC owner socket in CLI db dir: $DB_DIR" >&2
  exit 1
fi
