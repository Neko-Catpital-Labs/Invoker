#!/usr/bin/env bash
# Regression proof for merge gates running as normal executor actions.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

exec "$ROOT/scripts/lib/require-vitest-active-tests.sh" \
  --package @invoker/execution-engine \
  --test-file src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  --test-name "starts an independent merge gate while another merge gate is still preparing review"
