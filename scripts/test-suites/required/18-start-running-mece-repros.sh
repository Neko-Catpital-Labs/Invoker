#!/usr/bin/env bash
# Required regression coverage for MECE start-running failure attribution.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

exec bash "$ROOT/scripts/repro/repro-mece-03-remote-git-bootstrap-lock.sh"
