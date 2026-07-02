import { describe, expect, it } from 'vitest';

import { createWorkerRegistry } from '../worker-registry.js';
import { registerExternalWorkers } from '../external-worker.js';

const externalWorkers = [
  {
    kind: 'preview',
    launch: {
      executable: '/usr/local/bin/invoker-preview-worker',
      args: ['--stdio'],
    },
  },
];

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
