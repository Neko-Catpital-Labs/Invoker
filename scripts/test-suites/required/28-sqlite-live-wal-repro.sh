#!/usr/bin/env bash
# Required proof coverage for the live SQLite WAL follower hazard.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

EXPECT_PATCHED_GUARD=1 exec bash scripts/repro/repro-readonly-follower-live-wal.sh
