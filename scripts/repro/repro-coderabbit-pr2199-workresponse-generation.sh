#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$ROOT_DIR/packages/execution-engine/src/__tests__/task-runner-fix-publish-and-ssh.test.ts"

node --input-type=module - "$TARGET" <<'NODE'
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const src = readFileSync(file, 'utf8');
const inlineCasts = [...src.matchAll(/completeByTask\.get\(task\.id\)\?\.\(\{[\s\S]*?\}\s+as WorkResponse\);/g)];
if (inlineCasts.length > 0) {
  console.error(`FAIL: ${file} still casts inline completion payloads as WorkResponse`);
  process.exit(1);
}

const typedPayloads = [
  ...src.matchAll(/const response: WorkResponse = \{([\s\S]*?)\};\s*completeByTask\.get\(task\.id\)\?\.\(response\);/g),
];
if (typedPayloads.length < 2) {
  console.error(`FAIL: expected typed WorkResponse completion payloads in ${file}`);
  process.exit(1);
}

const missingGeneration = typedPayloads.filter((match) => !/\bexecutionGeneration\s*:/.test(match[1] ?? ''));
if (missingGeneration.length > 0) {
  console.error('FAIL: a synthetic WorkResponse completion payload is missing executionGeneration');
  process.exit(1);
}
NODE

echo "PASS: synthetic WorkResponse completion payloads are typed and include executionGeneration"
