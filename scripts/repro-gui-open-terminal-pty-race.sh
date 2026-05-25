#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/app"
pnpm exec vitest run src/__tests__/embedded-terminal-manager.test.ts -t "PTY output race regression"
