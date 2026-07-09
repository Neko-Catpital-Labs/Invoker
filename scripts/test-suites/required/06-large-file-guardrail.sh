#!/usr/bin/env bash
# Deterministic large-file guardrail proof.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

node "$ROOT/scripts/check-large-files.mjs"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TMP_ROOT/packages/example/src" "$TMP_ROOT/packages/example/dist"

for _ in 1 2 3 4 5 6; do
  printf 'export const oversized = true;\n'
done > "$TMP_ROOT/packages/example/src/oversized.ts"

for _ in 1 2 3 4 5 6 7 8; do
  printf 'export const ignoredBuildArtifact = true;\n'
done > "$TMP_ROOT/packages/example/dist/ignored-build-artifact.ts"

printf 'lockfile content is ignored\n' > "$TMP_ROOT/pnpm-lock.yaml"

if node "$ROOT/scripts/check-large-files.mjs" --root "$TMP_ROOT" --max-lines 5 >"$TMP_ROOT/stdout.log" 2>"$TMP_ROOT/stderr.log"; then
  echo "[large-files] Expected oversized production source to fail the guardrail" >&2
  exit 1
fi

if ! grep -F "packages/example/src/oversized.ts: 6 lines" "$TMP_ROOT/stderr.log" >/dev/null; then
  echo "[large-files] Oversized production source was not reported deterministically" >&2
  cat "$TMP_ROOT/stderr.log" >&2
  exit 1
fi

if grep -F "ignored-build-artifact.ts" "$TMP_ROOT/stderr.log" >/dev/null; then
  echo "[large-files] Build artifact was incorrectly scanned" >&2
  cat "$TMP_ROOT/stderr.log" >&2
  exit 1
fi
