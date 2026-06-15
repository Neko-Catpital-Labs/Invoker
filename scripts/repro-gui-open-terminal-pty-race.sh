#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pnpm --dir packages/app exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "replays PTY first-frame output emitted before openOrReuse returns"
