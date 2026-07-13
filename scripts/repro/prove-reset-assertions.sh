#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

exec bash scripts/e2e-dry-run/run-all.sh case-2.15-recreate-preempt-attempt-refresh.sh
