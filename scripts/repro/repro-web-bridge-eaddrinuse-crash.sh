#!/usr/bin/env bash
# Repro: the web bridge (packages/app/src/web/web-bridge-server.ts) used to
# call server.listen() with no 'error' listener and no failure path on
# whenReady. When the configured webPort (4200 in production) was already held
# by another process -- an owner-serve instance, a standalone tracked headless
# run, or a standalone-owner bootstrap that mis-detected "no owner" under
# load -- the EADDRINUSE 'error' event escalated to a process-level
# uncaughtException and the whole booting process died mid-startup. Confirmed
# live in ~/.invoker/invoker.log:
#   2026-07-30T02:05:41 / 04:46:04 (same-process double bind)
#   2026-08-03T19:33:30 / 23:18:43 / 23:19:28 (cross-process bind race)
# A 600-request connection storm was tested as the alternative hypothesis and
# never harmed the listener; the storm case is fenced alongside the bind race.
#
# Exit 0 = losing a bind race settles whenReady with EADDRINUSE, never reaches
#          the process-level uncaughtException handler, and leaves the winning
#          listener serving (fix present).
# Exit 1 = the bind failure escalates to a process-level uncaughtException
#          (the pre-fix crash reproduces).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT/packages/app"
exec pnpm test -- src/__tests__/web-bridge-port-conflict.test.ts
