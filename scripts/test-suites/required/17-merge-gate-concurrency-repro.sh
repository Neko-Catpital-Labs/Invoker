#!/usr/bin/env bash
# Regression proof for merge gates running as normal executor actions.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEST_FILE="src/__tests__/task-runner-fix-publish-and-ssh.test.ts"
TEST_NAME="starts an independent merge gate while another merge gate is still preparing review"

exec bash "$ROOT/scripts/vitest-require-active.sh" \
  @invoker/execution-engine \
  "$TEST_FILE" \
  -t "$TEST_NAME"
