#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$repo_root"

pnpm --dir packages/app exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t 'FIRST_FRAME_FROM_PTY|synchronous backend exit does not throw'
