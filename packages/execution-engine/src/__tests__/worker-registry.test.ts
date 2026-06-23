import { describe, expect, it } from 'vitest';

import { AUTO_FIX_WORKER_KIND, createWorkerRegistry } from '../worker-registry.js';

describe('WorkerRegistry', () => {
  it('registers the built-in autofix worker by kind', () => {
    const registry = createWorkerRegistry();

    const definition = registry.getByKind(AUTO_FIX_WORKER_KIND);
    expect(definition).toBeDefined();
    expect(definition?.kind).toBe(AUTO_FIX_WORKER_KIND);
    expect(definition?.operatorNote).toContain('autofix');
  });

  it('returns undefined for an unknown kind', () => {
    const registry = createWorkerRegistry();

    expect(registry.getByKind('nonexistent')).toBeUndefined();
  });

  it('exposes the registered definitions', () => {
    const registry = createWorkerRegistry();

    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getAll()[0]?.kind).toBe(AUTO_FIX_WORKER_KIND);
  });
});
