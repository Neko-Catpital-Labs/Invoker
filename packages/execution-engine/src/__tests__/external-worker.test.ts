import { describe, expect, it } from 'vitest';

import { registerExternalWorkers, type ExternalWorkerRuntime } from '../external-worker.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import { createWorkerRegistry } from '../worker-registry.js';

const externalWorkers = [
  {
    kind: 'preview',
    launch: {
      executable: '/usr/local/bin/invoker-preview-worker',
      args: ['--stdio'],
    },
  },
];

function createSleepingExternalWorker(): ExternalWorkerRuntime {
  const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
  registerExternalWorkers(registry, [
    {
      kind: 'external-sleep',
      launch: {
        executable: 'sleep',
        args: ['30'],
      },
    },
  ]);

  const definition = registry.get('external-sleep');
  expect(definition).toBeDefined();
  return definition!.factory({} as WorkerRuntimeDependencies) as ExternalWorkerRuntime;
}

describe('external worker registration', () => {
  it('registers configured external workers by kind', () => {
    const registry = registerExternalWorkers(createWorkerRegistry(), externalWorkers);

    const definition = registry.get('preview');

    expect(definition).toBeDefined();
    expect(definition?.kind).toBe('preview');
    expect(registry.list().map((worker) => worker.kind)).toEqual(['preview']);
  });

  it('defaults to no external workers when config is absent', () => {
    const registry = registerExternalWorkers(createWorkerRegistry(), undefined);

    expect(registry.list()).toEqual([]);
  });
});

describe('external worker runtime', () => {
  it('returns from a manual tick after spawning the external process', async () => {
    const runtime = createSleepingExternalWorker();

    await runtime.tick();
    await runtime.stop();
    await runtime.finished;
  });
});
