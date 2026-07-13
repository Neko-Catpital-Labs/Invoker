import { describe, expect, it } from 'vitest';
import { resolveWorkerControlMutation } from '../worker-control-delegation.js';

describe('resolveWorkerControlMutation', () => {
  it('maps `worker start <kind>` to the start-worker gui mutation', () => {
    expect(resolveWorkerControlMutation(['worker', 'start', 'autofix'])).toEqual({
      action: 'start',
      channel: 'invoker:start-worker',
      kind: 'autofix',
    });
  });

  it('maps `worker stop <kind>` to the stop-worker gui mutation', () => {
    expect(resolveWorkerControlMutation(['worker', 'stop', 'autofix'])).toEqual({
      action: 'stop',
      channel: 'invoker:stop-worker',
      kind: 'autofix',
    });
  });

  it('returns null for worker read subcommands so they run locally', () => {
    expect(resolveWorkerControlMutation(['worker'])).toBeNull();
    expect(resolveWorkerControlMutation(['worker', 'list'])).toBeNull();
    expect(resolveWorkerControlMutation(['worker', 'status'])).toBeNull();
  });

  it('returns null for non-worker commands', () => {
    expect(resolveWorkerControlMutation(['query', 'workflows'])).toBeNull();
    expect(resolveWorkerControlMutation(['retry-task', 'wf-1/t'])).toBeNull();
    expect(resolveWorkerControlMutation([])).toBeNull();
  });

  it('throws when the worker kind is missing', () => {
    expect(() => resolveWorkerControlMutation(['worker', 'start'])).toThrow(/Missing worker kind/);
    expect(() => resolveWorkerControlMutation(['worker', 'stop'])).toThrow(/Missing worker kind/);
  });
});
