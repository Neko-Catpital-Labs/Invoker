#!/usr/bin/env bash
# Repro: GUI/headless mutations must route through one standalone daemon owner.
#
# Root cause guarded here:
#   A GUI process that opens the SQLite DB as the mutation owner can race with
#   headless submitters and other GUI instances. In daemon-owner mode the GUI
#   must become a read-only client and delegate write IPC to the shared owner.
#
# Fixed behavior:
#   The owner bootstrap/thundering-herd e2e proves peer clients converge on one
#   standalone-capable owner instead of stealing the IPC socket or DB writer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pnpm --filter @invoker/app build
exec scripts/repro/repro-headless-thundering-herd.sh
