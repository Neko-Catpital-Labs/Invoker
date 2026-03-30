#!/usr/bin/env bash
# DOM snapshot leg of ui-visual-proof (no pixel screenshots; no extra Electron capture).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/ui-visual-proof.sh" --validate
