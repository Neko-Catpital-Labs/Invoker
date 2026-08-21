#!/usr/bin/env bash
set -euo pipefail

# Narrowest local probe for CI job "UI Vitest", first observed failing at
# 85b789cd95ead25b19bace5ea4c9cae46675ced8:
#   FAIL src/__tests__/task-interaction.test.tsx > Task interaction (component)
#     > renders task.worker_action events in the task timeline
#   TestingLibraryElementError: Unable to find an element by:
#     [data-testid="rf__node-task-worker-action"]
#
# This did not reproduce locally: a full `pnpm --filter @invoker/ui test`
# run at the anchor commit (94/94 files, 863/863 tests) passed, and it still
# passed under synthetic CPU contention (6 busy-loop processes pinned on a
# 4-core sandbox). Treat this script as a standing probe for the same
# symptom, not as proof of the failure -- see the Repro waiver in the fix
# task summary for the CI-only evidence this fix is based on.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR/packages/ui"

exec pnpm exec vitest run src/__tests__/task-interaction.test.tsx \
  -t "renders task.worker_action events in the task timeline"
