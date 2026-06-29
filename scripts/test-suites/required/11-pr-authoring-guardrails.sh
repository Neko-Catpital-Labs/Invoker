#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
node scripts/test-pr-diff-atomicity.mjs
node scripts/test-pr-body-validator.mjs
node scripts/test-create-pr-visual-proof.mjs
