#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

node --experimental-strip-types --input-type=module - "$ROOT_DIR" <<'NODE'
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const rootDir = process.argv[2];
const moduleUrl = pathToFileURL(path.join(rootDir, 'packages/workflow-core/src/state-invariants.ts')).href;
const { assertWorkflowConsistent, assertWorkflowPatchConsistent } = await import(moduleUrl);

const validDependency = {
  workflowId: 'wf-upstream',
  taskId: '__merge__',
  requiredStatus: 'completed',
  gatePolicy: 'completed',
};

assertWorkflowConsistent({
  id: 'wf-valid',
  name: 'Valid workflow',
  generation: 2,
  externalDependencies: [validDependency],
});

let emptyDepsRejected = false;
try {
  assertWorkflowConsistent({
    id: 'wf-empty',
    name: 'Empty deps',
    externalDependencies: [],
  });
} catch (error) {
  emptyDepsRejected = String(error).includes('externalDependencies must be non-empty when present');
}
if (!emptyDepsRejected) {
  throw new Error('expected empty externalDependencies to be rejected');
}

let dependencyLossRejected = false;
try {
  assertWorkflowPatchConsistent(
    {
      id: 'wf-loss',
      name: 'Loss source',
      externalDependencies: [validDependency],
    },
    {
      id: 'wf-loss',
      name: 'Loss source',
      baseBranch: 'main',
    },
    { baseBranch: 'main' },
  );
} catch (error) {
  dependencyLossRejected = String(error).includes('removed externalDependencies');
}
if (!dependencyLossRejected) {
  throw new Error('expected dependency loss without removal history to be rejected');
}

console.log('state invariants proof passed');
NODE
