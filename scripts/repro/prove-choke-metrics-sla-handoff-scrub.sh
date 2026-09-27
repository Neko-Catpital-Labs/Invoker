#!/usr/bin/env bash
# Prove the choke metrics SLA stack leaves no terminal handoff artifacts behind.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> Running choke metrics SLA handoff scrub proof"
exec bash scripts/scrub-handoff-artifacts.sh --check
