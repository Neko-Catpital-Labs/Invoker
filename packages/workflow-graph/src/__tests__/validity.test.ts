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
    const attempt = createAttempt('A', { status: 'running' });
    const node = withSelectedAttempt(createTaskState('A', 'A', ['B']), attempt.id);
    const { getNode, getAttempt } = makeLookups([node], [attempt]);
    expect(isStale(node, getNode, getAttempt)).toBe(false);
  });

  it('returns false when upstream attempt matches', () => {
    const aAttempt = createAttempt('A', { status: 'completed' });
    const bAttempt = createAttempt('B', { status: 'completed', upstreamAttemptIds: [aAttempt.id] });
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), aAttempt.id);
    const node = withSelectedAttempt(createTaskState('B', 'B', ['A']), bAttempt.id);
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt, bAttempt]);
    expect(isStale(node, getNode, getAttempt)).toBe(false);
  });

  it('returns true when upstream attempt has changed', () => {
    const aAttemptOld = createAttempt('A', { status: 'completed' });
    const aAttemptNew = createAttempt('A', { status: 'completed' });
    const bAttempt = createAttempt('B', { status: 'completed', upstreamAttemptIds: [aAttemptOld.id] });
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), aAttemptNew.id);
    const node = withSelectedAttempt(createTaskState('B', 'B', ['A']), bAttempt.id);
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttemptNew, bAttempt]);
    expect(isStale(node, getNode, getAttempt)).toBe(true);
  });

  it('returns false when upstreamAttemptIds is empty (backward compat guard)', () => {
    const aAttempt = createAttempt('A', { status: 'completed' });
    const bAttempt = createAttempt('B', { status: 'completed', upstreamAttemptIds: [] });
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), aAttempt.id);
    const node = withSelectedAttempt(createTaskState('B', 'B', ['A']), bAttempt.id);
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt, bAttempt]);
    expect(isStale(node, getNode, getAttempt)).toBe(false);
  });

  it('returns false for root node with empty upstreamAttemptIds (no deps)', () => {
    const attempt = createAttempt('A', { status: 'completed' });
    const node = withSelectedAttempt(createTaskState('A', 'A', []), attempt.id);
    const { getNode, getAttempt } = makeLookups([node], [attempt]);
    expect(isStale(node, getNode, getAttempt)).toBe(false);
  });
});

describe('isBlocked', () => {
  it('returns false when no upstream is failed', () => {
    const aAttempt = createAttempt('A', { status: 'completed' });
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), aAttempt.id);
    const node = createTaskState('B', 'B', ['A']);
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt]);
    expect(isBlocked(node, getNode, getAttempt)).toBe(false);
  });

  it('returns true when upstream attempt is failed', () => {
    const aAttempt = createAttempt('A', { status: 'failed' });
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), aAttempt.id);
    const node = createTaskState('B', 'B', ['A']);
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
    const aAttempt = createAttempt('A', { status: 'completed' });
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), aAttempt.id);
    const node = createTaskState('B', 'B', ['A']);
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
    const aAttempt = createAttempt('A', { status: 'running' });
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), aAttempt.id);
    const node = createTaskState('B', 'B', ['A']);
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
    const aAttemptOld = createAttempt('A', { status: 'completed' });
    const aAttemptNew = createAttempt('A', { status: 'completed' });
    const bAttempt = createAttempt('B', { status: 'completed', upstreamAttemptIds: [aAttemptOld.id] });
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), aAttemptNew.id);
    const node = withSelectedAttempt(createTaskState('B', 'B', ['A']), bAttempt.id);
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttemptNew, bAttempt]);
    expect(deriveNodeStatus(node, getNode, getAttempt)).toBe('stale');
  });

  it('returns blocked when upstream is failed', () => {
    const aAttempt = createAttempt('A', { status: 'failed' });
    const bAttempt = createAttempt('B', { status: 'pending' });
    const depA = withSelectedAttempt(createTaskState('A', 'A', []), aAttempt.id);
    const node = withSelectedAttempt(createTaskState('B', 'B', ['A']), bAttempt.id);
    const { getNode, getAttempt } = makeLookups([depA, node], [aAttempt, bAttempt]);
    expect(deriveNodeStatus(node, getNode, getAttempt)).toBe('blocked');
  });

  it('maps superseded to stale', () => {
    const attempt = createAttempt('A', { status: 'superseded' });
    const node = withSelectedAttempt(createTaskState('A', 'A', []), attempt.id);
    const { getNode, getAttempt } = makeLookups([node], [attempt]);
    expect(deriveNodeStatus(node, getNode, getAttempt)).toBe('stale');
  });

  it('maps completed to completed when not stale', () => {
    const attempt = createAttempt('A', { status: 'completed' });
    const node = withSelectedAttempt(createTaskState('A', 'A', []), attempt.id);
    const { getNode, getAttempt } = makeLookups([node], [attempt]);
    expect(deriveNodeStatus(node, getNode, getAttempt)).toBe('completed');
  });
});
