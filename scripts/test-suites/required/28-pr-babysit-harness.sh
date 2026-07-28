#!/usr/bin/env bash
# Offline battle harness for the PR-babysitting chain: conflict-rebase cron,
# CI-failure scan cron, the mergify admin-bypass landing brain, and the
# orphan-repair cron for unmapped PRs, all driven against the reusable fake
# gh in scripts/repro/fixtures/fake-gh/.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
bash scripts/repro/repro-babysit-conflict-cron.sh
bash scripts/repro/repro-babysit-ci-cron.sh
bash scripts/repro/repro-babysit-land-dryrun.sh
bash scripts/repro/repro-pr-orphan-repair.sh
bash scripts/repro/repro-pr-orphan-admin-bypass-race.sh
