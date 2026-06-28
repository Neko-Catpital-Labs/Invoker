import { describe, expect, it } from 'vitest';

import { createWorkerRegistry } from '@invoker/execution-engine';

import { registerExternalWorkers } from '../external-worker-loader.js';

const externalWorkers = [{
  kind: 'preview',
  launch: {
    executable: '/usr/local/bin/invoker-preview-worker',
    args: ['--stdio'],
  },
}];

describe('registerExternalWorkers', () => {
  it('registers configured external workers by kind', () => {
    const registry = registerExternalWorkers(createWorkerRegistry(), externalWorkers);

    const definition = registry.get('preview');
    expect(definition).toBeDefined();
    expect(definition?.kind).toBe('preview');
    expect(definition?.note).toContain('/usr/local/bin/invoker-preview-worker');
    expect(registry.list().map((worker) => worker.kind)).toEqual(['preview']);
  });

  it('defaults to no registered external workers when config is absent', () => {
    const registry = registerExternalWorkers(createWorkerRegistry(), undefined);

    expect(registry.list()).toEqual([]);
    expect(registry.get('preview')).toBeUndefined();
  });
});
