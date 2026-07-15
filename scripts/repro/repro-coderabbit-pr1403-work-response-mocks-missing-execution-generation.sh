#!/usr/bin/env bash
set -euo pipefail

# Repro for CodeRabbit PR #1403 review findings (discussion r3458135296 and
# r3458135299): the mocked completion payloads were missing WorkResponse
# `executionGeneration`, so these tests could silently stop exercising the
# generation-aware response contract.
#
# Exits NON-ZERO when either targeted mock omits `executionGeneration`.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] pr1403 work response mocks include executionGeneration"

node <<'NODE'
const { readFileSync } = require('node:fs');

const checks = [
  {
    file: 'packages/execution-engine/src/__tests__/ssh-pool-member-capacity.test.ts',
    needles: [
      "completeByTask.get(task.id)?.({",
      "attemptId: task.execution.selectedAttemptId,",
      "executionGeneration: task.execution.generation ?? 0,",
    ],
  },
  {
    file: 'packages/execution-engine/src/__tests__/task-runner-fix-publish-and-ssh.test.ts',
    needles: [
      "completeByTask.get(task.id)?.({",
      "attemptId: 'crab-task-attempt',",
      "executionGeneration: task.execution.generation ?? 0,",
    ],
  },
];

let ok = true;
for (const check of checks) {
  const text = readFileSync(check.file, 'utf8');
  const missing = check.needles.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    ok = false;
    console.error(`FAIL: ${check.file} is missing expected mock fields:`);
    for (const needle of missing) console.error(`  - ${needle}`);
  }
}

if (!ok) process.exit(1);
console.log('PASS: targeted WorkResponse mocks include executionGeneration');
NODE
