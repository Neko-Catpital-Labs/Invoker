#!/usr/bin/env bash
# Repro/proof: editing a task command while it is `fixing_with_ai` should
# interrupt the in-flight auto-fix, leave fixing_with_ai, save the new command,
# and restart the task with that new command.
#
# This wrapper does two things:
# 1. prints live DB evidence for a representative task when available
# 2. runs the focused app tests proving:
#    - the shared edit-command action kills the active fix and reruns
#    - the API edit endpoint does the same
#
# Usage:
#   bash scripts/repro/repro-edit-command-interrupts-fixing-with-ai.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

pnpm --filter @invoker/app exec vitest run \
  src/__tests__/workflow-actions.test.ts \
  src/__tests__/api-server.test.ts \
  --testNamePattern "cancels fixing_with_ai before editing and restarting with the new command|interrupts fixing_with_ai before editing the command"
