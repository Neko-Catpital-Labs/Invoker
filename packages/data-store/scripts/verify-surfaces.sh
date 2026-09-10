#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
pnpm --filter @invoker/data-store test src/__tests__/surface-persistence.test.ts
