#!/usr/bin/env bash
# Offline battle harness for the surviving PR-babysitting paths:
# admin-bypass-land owns mapped/admin-bypass conflict, failed-check, landable,
# and CodeRabbit repair routing; orphan-repair owns unmapped broken PRs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
bash scripts/repro/repro-babysit-land-dryrun.sh
bash scripts/repro/repro-admin-bypass-queue.sh
bash scripts/repro/repro-pr-maintenance-worker-routing.sh
bash scripts/repro/repro-pr-orphan-repair.sh
bash scripts/repro/repro-pr-orphan-admin-bypass-race.sh
