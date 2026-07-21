import { describe, expect, it } from 'vitest';

import { renderWorkerLifecycle } from '../headless-worker-lifecycle.js';

describe('renderWorkerLifecycle', () => {
  it('reports unknown when runtime liveness was not observable', () => {
    expect(renderWorkerLifecycle({ lifecycle: 'stopped' })).toBe('unknown');
  });

  it('reports the owner lifecycle when liveness is known', () => {
    expect(renderWorkerLifecycle({ lifecycle: 'running', running: true })).toBe('running');
    expect(renderWorkerLifecycle({ lifecycle: 'stopped', running: false })).toBe('stopped');
    expect(renderWorkerLifecycle({ lifecycle: 'exited', running: false })).toBe('exited');
  });
});
