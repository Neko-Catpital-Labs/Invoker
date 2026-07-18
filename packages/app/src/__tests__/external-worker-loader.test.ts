import { describe, expect, it } from 'vitest';
import { createWorkerRegistry } from '@invoker/execution-engine';

import { registerExternalWorkersFromConfig } from '../external-worker-loader.js';

const externalWorkers = [
  {
    kind: 'preview',
    launch: {
      executable: '/usr/local/bin/invoker-preview-worker',
      args: ['--stdio'],
    },
  },
];

describe('external worker loader', () => {
  it('registers configured external workers by kind', () => {
    const registry = registerExternalWorkersFromConfig(externalWorkers, createWorkerRegistry());

    const definition = registry.get('preview');

    expect(definition).toBeDefined();
    expect(definition?.kind).toBe('preview');
    expect(registry.list().map((worker) => worker.kind)).toEqual(['preview']);
  });

  it('defaults to no external workers when config is absent', () => {
    const registry = registerExternalWorkersFromConfig(undefined, createWorkerRegistry());

    expect(registry.list()).toEqual([]);
  });
});
