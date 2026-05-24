#!/usr/bin/env bash
# Required regression for scripts/prod-recreate-supervisor.sh: ref-sync uses
# fetch + update-ref only, no checkout/reset, and recreate is enqueued via the
# expected headless command shape.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/test-prod-recreate-supervisor.sh"
