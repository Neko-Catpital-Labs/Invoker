#!/usr/bin/env bash
# Repro: GUI embedded PTY first-frame output must be replayed after openTerminal returns.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/packages/app"

echo "==> Running focused embedded PTY first-frame replay repro"
pnpm exec vitest run src/__tests__/embedded-terminal-manager.test.ts -t "replays first-frame PTY output emitted synchronously during spawn"
