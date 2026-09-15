#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const checks = [
  ['packages/execution-engine/src/builtin-workers.ts', /registerThrashDetectorWorker/],
  ['packages/execution-engine/src/worker-runtime-dependencies.ts', /thrashDetector\?: ThrashDetectorWorkerConfig/],
  ['packages/app/src/worker-control.ts', /THRASH_DETECTOR_WORKER_KIND/],
  ['packages/app/src/config.ts', /thrashDetector\?: ThrashDetectorConfig/],
  ['packages/app/src/config-validation.ts', /validateThrashDetectorConfig\(config\)/],
  ['packages/app/src/main.ts', /thrashDetector: \{/],
  ['packages/app/src/headless.ts', /resolveHeadlessThrashDetectorConfig/],
  ['packages/ui/src/lib/worker-display.ts', /kind === 'thrash-detector'/],
];

const worker = read('packages/execution-engine/src/workers/thrash-detector-worker.ts');
const forbidden = [
  /invoker:fix-with-agent/,
  /invoker:approve/,
  /invoker:reject/,
  /recreate-task/,
  /\.submit\(/,
  /updateTask\(/,
  /saveTask\(/,
  /deleteTask\(/,
];

let failed = false;
for (const [path, pattern] of checks) {
  if (!pattern.test(read(path))) {
    console.error(`missing touchpoint ${path}: ${pattern}`);
    failed = true;
  }
}
for (const pattern of forbidden) {
  if (pattern.test(worker)) {
    console.error(`worker safety check failed: ${pattern}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('thrash-detector worker touchpoints and safety checks passed');
