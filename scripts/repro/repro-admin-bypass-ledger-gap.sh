#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export PYTHONDONTWRITEBYTECODE=1
python3 scripts/repro/repro-admin-bypass-ledger-gap.py

echo "[repro] PASS admin-bypass ledger-before-dispatch gap is closed"
