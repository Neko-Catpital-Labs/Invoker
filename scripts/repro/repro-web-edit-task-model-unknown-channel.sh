#!/usr/bin/env bash
# Repro: the web bridge (packages/app/src/web/web-invoker-dispatch.ts) has no
# case for 'invoker:edit-task-model', so the browser UI's "AI Model" dropdown
# fails with "request failed" (code: unknown_channel) and never reaches
# WorkflowMutationFacade/orchestrator.editTaskModel. edit-task-agent works
# fine because it does have a case in the same switch.
#
# Usage: bash scripts/repro/repro-web-edit-task-model-unknown-channel.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

pnpm --filter @invoker/app test -- -t "edit-task-model currently rejects as unknown_channel"
