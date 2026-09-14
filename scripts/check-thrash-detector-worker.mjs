#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const checks = [
  {
    file: 'packages/execution-engine/src/workers/thrash-detector-worker.ts',
    required: [
      'THRASH_DETECTOR_WORKER_KIND',
      'thrash.detected',
      'classifyAutoFixRecoveryPhase',
      'store.logEvent',
    ],
    forbidden: [
      'invoker:fix-with-agent',
      'invoker:approve',
      'invoker:reject',
      'invoker:recreate-task',
      'submitter',
      'executeFixWithAgentMutation',
      'recreateTask',
      'approveTask',
    ],
  },
  {
    file: 'packages/execution-engine/src/builtin-workers.ts',
    required: ['registerThrashDetectorWorker(registry)'],
  },
  {
    file: 'packages/execution-engine/src/worker-runtime-dependencies.ts',
    required: ['thrashDetector?: ThrashDetectorWorkerConfig'],
  },
  {
    file: 'packages/app/src/worker-control.ts',
    required: ['THRASH_DETECTOR_WORKER_KIND', 'thrash.detected'],
  },
  {
    file: 'packages/app/src/config.ts',
    required: ['interface ThrashDetectorConfig', 'thrashDetector?: ThrashDetectorConfig'],
  },
  {
    file: 'packages/app/src/config-validation.ts',
    required: ['validateThrashDetectorConfig(config)'],
  },
  {
    file: 'packages/app/src/main.ts',
    required: ['thrashDetector: {'],
  },
  {
    file: 'packages/app/src/headless.ts',
    required: ['resolveHeadlessThrashDetectorConfig', 'thrashDetector: resolveHeadlessThrashDetectorConfig'],
  },
  {
    file: 'packages/ui/src/lib/worker-display.ts',
    required: ['thrash-detector', 'Thrash detector'],
  },
];

const failures = [];
for (const check of checks) {
  const content = readFileSync(check.file, 'utf8');
  for (const needle of check.required ?? []) {
    if (!content.includes(needle)) {
      failures.push(`${check.file}: missing ${JSON.stringify(needle)}`);
    }
  }
  for (const needle of check.forbidden ?? []) {
    if (content.includes(needle)) {
      failures.push(`${check.file}: forbidden ${JSON.stringify(needle)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('thrash-detector worker wiring and mutation-channel guard passed');
