import { describe, it, expect } from 'vitest';
import { isStale, isBlocked, isReady, deriveNodeStatus } from '../validity.js';
import { createTaskState, createAttempt } from '../types.js';
import type { TaskState, Attempt } from '../types.js';

// Helper to build lookup functions
function makeLookups(nodes: TaskState[], attempts: Attempt[]) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const attemptMap = new Map(attempts.map(a => [a.id, a]));
  return {
    getNode: (id: string) => nodeMap.get(id),
    getAttempt: (id: string) => attemptMap.get(id),
  };
}

function withSelectedAttempt(task: TaskState, attemptId: string): TaskState {
  return { ...task, execution: { ...task.execution, selectedAttemptId: attemptId } };
}

describe('isStale', () => {
  it('returns false when node has no selected attempt', () => {
    const node = createTaskState('A', 'A', []);
    const { getNode, getAttempt } = makeLookups([node], []);
    expect(isStale(node, getNode, getAttempt)).toBe(false);
  });

  it('returns false when selected attempt is not completed', () => {
    const node = withSelectedAttempt(createTaskState('A', 'A', ['B']), 'A-a1');
    const attempt = createAttempt('A', 1, { status: 'running' });
    const { getNode, getAttempt } = makeLookups([node], [attempt]);
    expect(isStale(node, getNode, getAttempt)).toBe(false);
  });

  it('returns false when upstream attempt matches', () => {
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a1');
    const node = withSelectedAttempt(createTaskState('B', 'B', ['A']), 'B-a1');
    const aAttempt = createAttempt('A', 1, { status: 'completed' });
    const bAttempt = createAttempt('B', 1, { status: 'completed', upstreamAttemptIds: ['A-a1'] });
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt, bAttempt]);
    expect(isStale(node, getNode, getAttempt)).toBe(false);
  });

  it('returns true when upstream attempt has changed', () => {
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a2');
    const node = withSelectedAttempt(createTaskState('B', 'B', ['A']), 'B-a1');
    const aAttempt2 = createAttempt('A', 2, { status: 'completed' });
    const bAttempt = createAttempt('B', 1, { status: 'completed', upstreamAttemptIds: ['A-a1'] });
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt2, bAttempt]);
    expect(isStale(node, getNode, getAttempt)).toBe(true);
  });

  it('returns false when upstreamAttemptIds is empty (backward compat guard)', () => {
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a1');
    const node = withSelectedAttempt(createTaskState('B', 'B', ['A']), 'B-a1');
    const aAttempt = createAttempt('A', 1, { status: 'completed' });
    const bAttempt = createAttempt('B', 1, { status: 'completed', upstreamAttemptIds: [] });
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt, bAttempt]);
    expect(isStale(node, getNode, getAttempt)).toBe(false);
  });

  it('returns false for root node with empty upstreamAttemptIds (no deps)', () => {
    const node = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a1');
    const attempt = createAttempt('A', 1, { status: 'completed' });
    const { getNode, getAttempt } = makeLookups([node], [attempt]);
    expect(isStale(node, getNode, getAttempt)).toBe(false);
  });
});

describe('isBlocked', () => {
  it('returns false when no upstream is failed', () => {
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a1');
    const node = createTaskState('B', 'B', ['A']);
    const aAttempt = createAttempt('A', 1, { status: 'completed' });
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt]);
    expect(isBlocked(node, getNode, getAttempt)).toBe(false);
  });

  it('returns true when upstream attempt is failed', () => {
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a1');
    const node = createTaskState('B', 'B', ['A']);
    const aAttempt = createAttempt('A', 1, { status: 'failed' });
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt]);
    expect(isBlocked(node, getNode, getAttempt)).toBe(true);
  });
});

describe('isReady', () => {
  it('returns true for root nodes (no dependencies)', () => {
    const node = createTaskState('A', 'A', []);
    const { getNode, getAttempt } = makeLookups([node], []);
    expect(isReady(node, getNode, getAttempt)).toBe(true);
  });

  it('returns true when all upstream completed and non-stale', () => {
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a1');
    const node = createTaskState('B', 'B', ['A']);
    const aAttempt = createAttempt('A', 1, { status: 'completed' });
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt]);
    expect(isReady(node, getNode, getAttempt)).toBe(true);
  });

  it('returns false when upstream has no selected attempt', () => {
    const depA = createTaskState('A', 'A', []);
    const node = createTaskState('B', 'B', ['A']);
    const { getNode, getAttempt } = makeLookups([depA, node], []);
    expect(isReady(node, getNode, getAttempt)).toBe(false);
  });

  it('returns false when upstream attempt is not completed', () => {
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a1');
    const node = createTaskState('B', 'B', ['A']);
    const aAttempt = createAttempt('A', 1, { status: 'running' });
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt]);
    expect(isReady(node, getNode, getAttempt)).toBe(false);
  });
});

describe('deriveNodeStatus', () => {
  it('returns stored status when no selected attempt', () => {
    const node = createTaskState('A', 'A', []);
    const { getNode, getAttempt } = makeLookups([node], []);
    expect(deriveNodeStatus(node, getNode, getAttempt)).toBe('pending');
  });

  it('returns stale when completed but upstream changed', () => {
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a2');
    const node = withSelectedAttempt(createTaskState('B', 'B', ['A']), 'B-a1');
    const aAttempt2 = createAttempt('A', 2, { status: 'completed' });
    const bAttempt = createAttempt('B', 1, { status: 'completed', upstreamAttemptIds: ['A-a1'] });
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt2, bAttempt]);
    expect(deriveNodeStatus(node, getNode, getAttempt)).toBe('stale');
  });

  it('returns blocked when upstream is failed', () => {
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a1');
    const node = withSelectedAttempt(createTaskState('B', 'B', ['A']), 'B-a1');
    const aAttempt = createAttempt('A', 1, { status: 'failed' });
    const bAttempt = createAttempt('B', 1, { status: 'pending' });
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt, bAttempt]);
    expect(deriveNodeStatus(node, getNode, getAttempt)).toBe('blocked');
  });

  it('maps superseded to stale', () => {
    const node = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a1');
    const attempt = createAttempt('A', 1, { status: 'superseded' });
    const { getNode, getAttempt } = makeLookups([node], [attempt]);
    expect(deriveNodeStatus(node, getNode, getAttempt)).toBe('stale');
  });

  it('maps completed to completed when not stale', () => {
    const node = withSelectedAttempt(createTaskState('A', 'A', []), 'A-a1');
    const attempt = createAttempt('A', 1, { status: 'completed' });
    const { getNode, getAttempt } = makeLookups([node], [attempt]);
    expect(deriveNodeStatus(node, getNode, getAttempt)).toBe('completed');
  });
});
