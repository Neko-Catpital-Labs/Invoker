#!/usr/bin/env bash
# Thin wrapper: prefer scripts/switch-slack-to-local.sh
set -euo pipefail
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$REPO_ROOT/scripts/switch-slack-to-local.sh" --force-start --no-build "$@"
