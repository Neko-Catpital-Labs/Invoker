#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] __merge__wf-1778826126740-7 was left running after launch metadata because a no-track active-outbox retry could consume a dispatch with a transient headless TaskRunner."
echo "[repro] This focused test forces that path: active launch outbox, no owner TaskRunner, no deferred owner launch."
echo "[repro] Before the fix, runHeadless could mark the merge task launched and then let the headless process exit; after the fix it refuses that unsafe launch ownership with a diagnostic."

pnpm --filter @invoker/app exec vitest run src/__tests__/headless-delegation.test.ts \
  -t "headless (workflow|task) retry in no-track active outbox mode waits for owner launch handoff before returning|headless task retry in no-track active outbox mode rejects transient launch ownership"
