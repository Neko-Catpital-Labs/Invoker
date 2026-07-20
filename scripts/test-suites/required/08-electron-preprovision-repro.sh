#!/usr/bin/env bash
# Regression: Electron launcher must verify pre-provisioning without running installers.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
bash "$ROOT/scripts/repro/repro-mece-04-remote-electron-provisioning.sh"
bash "$ROOT/scripts/repro/repro-run-sh-preprovisioned-bootstrap.sh"
