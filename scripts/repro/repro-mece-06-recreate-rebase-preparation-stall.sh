#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

pnpm --dir packages/execution-engine exec vitest run src/__tests__/repo-pool.test.ts \
  -t "MECE 06"
