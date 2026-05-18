#!/usr/bin/env bash
# Deterministic large-file guardrail checks.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

node scripts/check-large-files.mjs

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
PROOF_OUTPUT="$TMP_ROOT/large-file-guardrail.out"

mkdir -p "$TMP_ROOT/packages/sample/src"
for i in $(seq 1 6); do
  printf 'export const value%s = %s;\n' "$i" "$i"
done > "$TMP_ROOT/packages/sample/src/oversized.ts"

if node scripts/check-large-files.mjs --root "$TMP_ROOT" --max-lines 5 >"$PROOF_OUTPUT" 2>&1; then
  cat "$PROOF_OUTPUT"
  echo "ERROR: large-file guardrail accepted an intentionally oversized production source." >&2
  exit 1
fi

if ! grep -Fq 'packages/sample/src/oversized.ts: 6 lines' "$PROOF_OUTPUT"; then
  cat "$PROOF_OUTPUT"
  echo "ERROR: large-file guardrail failure output did not identify the oversized sample deterministically." >&2
  exit 1
fi

echo "Large-file guardrail proof passed."
