#!/usr/bin/env bash
# Regression proof for merge gates running as normal executor actions.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT/scripts/lib/required-vitest.sh"

run_required_vitest_filter \
  "$ROOT/packages/execution-engine" \
  "src/__tests__/task-runner-fix-publish-and-ssh.test.ts" \
  "starts an independent merge gate while another merge gate is still preparing review"
