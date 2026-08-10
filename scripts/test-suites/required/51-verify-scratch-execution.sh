#!/usr/bin/env bash
# Headless submit-plan e2e for scratch: true (no-repo) execution.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/verify-scratch-execution.sh"
