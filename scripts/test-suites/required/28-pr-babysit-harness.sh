#!/usr/bin/env bash
# Offline battle harness for the surviving unmapped-PR babysitting path.
# Admin-bypass planner coverage lives in 12-mergify-admin-requeue; this harness
# keeps retired conflict-rebase and CI-scan cron proofs out of the required set.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
bash scripts/repro/repro-pr-orphan-repair.sh
bash scripts/repro/repro-pr-orphan-admin-bypass-race.sh
