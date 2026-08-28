#!/usr/bin/env bash
# Linear invoker-ready → Invoker intake (DO1 cron companion to daily-e2e-do-submit).
#
# Fills Goal/Motivation from the ticket when possible, comments gaps on Linear,
# and auto-submits only after check-planning-completeness passes.
#
# Env: see scripts/linear-ticket-intake.mjs header.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
exec node "$REPO_ROOT/scripts/linear-ticket-intake.mjs" "$@"
