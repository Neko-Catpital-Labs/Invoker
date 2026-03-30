#!/usr/bin/env bash
# Docker executor matrix; uses ~/.invoker/invoker.db and a live Docker daemon.
# Only registered under dangerous/ — run via pnpm run test:all:destructive.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/test-docker-comprehensive.sh"
