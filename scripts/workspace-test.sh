#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# INV-117 keeps this wrapper as package/build evidence; proof thresholds live in run-all-tests.sh.
if [ -n "${INVOKER_WORKSPACE_TEST_CONCURRENCY:-}" ]; then
  CONCURRENCY="$INVOKER_WORKSPACE_TEST_CONCURRENCY"
elif [ -n "${CI:-}" ]; then
  CONCURRENCY=1
else
  CONCURRENCY=4
fi

if ! [[ "$CONCURRENCY" =~ ^[0-9]+$ ]] || [ "$CONCURRENCY" -lt 1 ]; then
  echo "ERROR: INVOKER_WORKSPACE_TEST_CONCURRENCY must be a positive integer" >&2
  exit 2
fi

# CI-only: local `pnpm -r test` runs the full suite unchanged. vitest
# resolves --exclude relative to the package it runs in either way, so the
# same registry entries work whether this ran via `pnpm --filter <pkg> test`
# (a single package) or `pnpm -r test` (every package) -- see
# scripts/flaky-test-registry.mjs.
FLAKY_EXCLUDE_ARGS=()
if [ -n "${CI:-}" ]; then
  # shellcheck disable=SC2207
  FLAKY_EXCLUDE_ARGS=($(node "$ROOT/scripts/flaky-test-registry.mjs" exclude-args))
fi

echo "==> Running package workspace tests (concurrency=$CONCURRENCY)"
env -u INVOKER_HEADLESS_STANDALONE pnpm -r --workspace-concurrency="$CONCURRENCY" test -- "${FLAKY_EXCLUDE_ARGS[@]}"
echo "==> Running required package builds"
env -u INVOKER_HEADLESS_STANDALONE bash "$ROOT/scripts/required-builds.sh"
