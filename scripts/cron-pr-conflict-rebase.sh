#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/packages/execution-engine/scripts/pr-maintenance/cron-pr-conflict-rebase.sh" "$@"
