#!/usr/bin/env bash
# Prove merge-gate review_ready responses persist their gate workspace path.
#
# The Vitest case creates a dummy local git repo, runs the real merge-gate
# consolidation path against it, discards legacy taskChanges, and feeds only
# the WorkResponse into workflow-core.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> Running dummy-repo merge-gate workspace proof"
pnpm --dir packages/execution-engine exec vitest run src/__tests__/merge-gate-workspace-path-dummy-repo.e2e.test.ts
