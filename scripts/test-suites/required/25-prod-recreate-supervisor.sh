#!/usr/bin/env bash
# Wrapper: focused tests for scripts/prod-recreate-supervisor.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/test-prod-recreate-supervisor.sh"
