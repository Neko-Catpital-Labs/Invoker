#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function assertContains(path, needle) {
  const source = read(path);
  if (!source.includes(needle)) {
    throw new Error(`${path} is missing ${needle}`);
  }
}

const touchpoints = [
  ['packages/execution-engine/src/workers/thrash-detector-worker.ts', 'THRASH_DETECTOR_WORKER_KIND'],
  ['packages/execution-engine/src/builtin-workers.ts', 'registerThrashDetectorWorker'],
  ['packages/execution-engine/src/worker-runtime-dependencies.ts', 'thrashDetector?: ThrashDetectorWorkerConfig'],
  ['packages/app/src/worker-control.ts', 'THRASH_DETECTOR_WORKER_KIND'],
  ['packages/app/src/config.ts', 'interface ThrashDetectorConfig'],
  ['packages/app/src/config-validation.ts', 'validateThrashDetectorConfig'],
  ['packages/app/src/main.ts', 'thrashDetector:'],
  ['packages/app/src/headless.ts', 'resolveHeadlessThrashDetectorConfig'],
  ['packages/ui/src/lib/worker-display.ts', "kind === 'thrash-detector'"],
  ['packages/execution-engine/src/__tests__/thrash-detector-worker.test.ts', 'runThrashDetectorTick'],
];

for (const [path, needle] of touchpoints) {
  assertContains(path, needle);
}

const workerSource = read('packages/execution-engine/src/workers/thrash-detector-worker.ts');
const forbidden = [
  'invoker:fix-with-agent',
  'invoker:approve',
  'invoker:reject',
  'recreate-task',
  '.submit(',
  'approve(',
  'reject(',
  'recreateTask(',
  'fixWithAgent(',
];

for (const needle of forbidden) {
  if (workerSource.includes(needle)) {
    throw new Error(`thrash detector worker contains forbidden mutation channel marker: ${needle}`);
  }
}

console.log('thrash-detector worker touchpoints and mutation-channel guard passed');
