#!/usr/bin/env bash
set -euo pipefail

# Repro for CodeRabbit PR #6638 finding:
#   The queue-status stale repro script must run its focused test through the
#   standard `pnpm test` script (packages/ui -> node scripts/run-vitest.mjs),
#   which adds a missing-vitest auto-install fallback. Per CLAUDE.md, plan/repro
#   task commands must NEVER invoke `vitest run` / `npx vitest run` directly.
#
# This proof FAILS (exit non-zero) if the target script contains a direct
# vitest invocation, and PASSES once it goes through `pnpm ... test`.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$REPO_ROOT/scripts/repro/repro-queue-status-stale.sh"

if [[ ! -f "$TARGET" ]]; then
  echo "[repro] FAIL: target script not found: $TARGET"
  exit 1
fi

if grep -Eq 'vitest[[:space:]]+run' "$TARGET"; then
  echo "[repro] FAIL: $TARGET invokes 'vitest run' directly; use the standard 'pnpm ... test' script instead."
  grep -nE 'vitest[[:space:]]+run' "$TARGET"
  exit 1
fi

if ! grep -Eq -- '--filter @invoker/ui test' "$TARGET"; then
  echo "[repro] FAIL: $TARGET does not run the focused test through 'pnpm --filter @invoker/ui test'."
  exit 1
fi

echo "[repro] PASS: queue-status stale repro runs its test through the standard 'pnpm test' script."
exit 0
