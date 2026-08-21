#!/usr/bin/env bash
# Repro for CI job `playwright / 2-of-9` (see
# packages/app/src/__tests__/playwright-2-of-9-sidecar-draft-override-repro.test.ts
# for the root-cause writeup). Runs that dedicated test through packages/app's
# own vitest config (workspace aliases like @invoker/surfaces resolve the same
# way the app's real test suite resolves them) without pulling in the rest of
# that package's suite. Exit code mirrors whether the sidecar-style
# test-override draft reached draft_ready.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/packages/app"

exec pnpm exec vitest run src/__tests__/playwright-2-of-9-sidecar-draft-override-repro.test.ts --reporter=default
