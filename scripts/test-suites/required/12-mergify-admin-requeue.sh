#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
ADMIN_REQUEUE_PYTHONPATH="$ROOT/packages/mergify-admin-requeue"
export PYTHONPATH="$ADMIN_REQUEUE_PYTHONPATH${PYTHONPATH:+:$PYTHONPATH}"

python3 -m unittest discover -s packages/mergify-admin-requeue/tests -p 'test_mergify_admin_requeue*.py'
bash scripts/repro/repro-mergify-admin-requeue.sh
bash scripts/repro/repro-mergify-admin-requeue-stack-expansion.sh
bash scripts/repro/repro-mergify-rejected-pr.sh
bash scripts/repro/repro-mergify-closed-pr-guard.sh
bash scripts/repro/repro-babysit-pr-body-human-split.sh
bash scripts/repro/repro-babysit-no-current-bottom-comment.sh
bash scripts/repro/repro-babysit-retarget-stale-bottom-base.sh
