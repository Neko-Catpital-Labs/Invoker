#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

bash "$ROOT/scripts/repro/repro-mece-05-repo-mirror-contention.sh"
bash "$ROOT/scripts/repro/repro-mece-06-recreate-rebase-preparation-stall.sh"
