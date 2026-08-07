#!/usr/bin/env bash
# Repro: a self-targeted scripts/deploy-do1.sh run can leave slack-manager
# stopped forever.
#
# Root cause guarded here:
#   deploy-do1.sh's remote sequence stops slack-manager.service, SIGTERMs
#   the owner process (packages/app/dist/main.js), then restarts
#   slack-manager.service and waits for the owner to come back. If this
#   deploy is itself dispatched as an Invoker task on the SAME host it is
#   redeploying, that SIGTERM lands on the owner that dispatched the task,
#   whose graceful-shutdown path (packages/app/src/main.ts
#   handleHeadlessTerminationSignal -> runHeadlessShutdownCleanup) calls
#   executorRegistry.destroyAll(), which SIGTERMs every still-running
#   task's process group (packages/execution-engine/src/worktree-executor.ts
#   destroyAll -> killProcessGroup) -- including the deploy task itself,
#   before it reaches `systemctl --user restart slack-manager.service`.
#
# Fixed behavior:
#   deploy-do1.sh now runs the stop/kill/restart/wait tail via `setsid`,
#   detached from the invoking shell, so killing the task's own process
#   group cannot take the restart sequence down with it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec node scripts/repro/repro-deploy-self-kill-aborts-restart.mjs
