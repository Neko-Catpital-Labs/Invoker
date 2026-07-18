/**
 * Regression repro: the task graph flickers because adding a node makes EVERY
 * already-placed node jump to the synchronous fallback layout until the async ELK
 * layout for the new node set resolves, then snap back.
 *
 * `activeLayout` fell back to `makeFallbackLayout` for ALL nodes whenever the
 * resolved ELK layout did not cover the current task set. Under the recreate
 * storm the set changes constantly, so nodes visibly jumped once per change.
 *
 * The correct behavior (asserted below): while a re-layout is in flight, nodes
 * that already have an ELK position keep it; only genuinely-new nodes use the
 * fallback. Fails on the pre-fix code (existing nodes jump), passes after the fix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { TaskState } from '../types.js';
import { makeUITask } from './helpers/mock-invoker.js';

// vitest hoists vi.mock; its factory cannot close over test-scope bindings, so
// the controllable ELK layout lives inside the factory closure.
vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Deterministic ELK: each task gets a distinctive large coordinate so an ELK
// position is unmistakable from a fallback position. The FIRST layout resolves;
// the SECOND (triggered by the added node) stays pending, holding the transition
// window open so the test can observe whether existing nodes jumped.
vi.mock('../lib/layout.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/layout.js')>('../lib/layout.js');
  let call = 0;
  const { promise: pendingSecondLayout } = Promise.withResolvers<never>();
  const layoutTaskGraph = vi.fn((tasks: { id: string }[]) => {
    call += 1;
    const positions = new Map<string, { x: number; y: number }>();
    [...tasks]
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((task, index) => positions.set(task.id, { x: 5000 + index * 100, y: 6000 + index * 100 }));
    const result = { positions, edgePoints: new Map(), usedFallback: false };
    return call === 1 ? Promise.resolve(result) : pendingSecondLayout;
  });
  return { ...actual, layoutTaskGraph };
});

const { TaskDAG } = await import('../components/TaskDAG.js');

function taskMap(...tasks: TaskState[]): Map<string, TaskState> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function nodeX(id: string): string | null {
  return document.querySelector(`[data-testid="rf__node-${id}"]`)?.getAttribute('data-x') ?? null;
}

describe('task graph does not flicker on node-set change', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps existing nodes at their ELK positions while a re-layout for a new node is in flight', async () => {
    const a = makeUITask({ id: 'wf-1/a', workflowId: 'wf-1', status: 'running' });
    const b = makeUITask({ id: 'wf-1/b', workflowId: 'wf-1', status: 'pending' });
    const c = makeUITask({ id: 'wf-1/c', workflowId: 'wf-1', status: 'pending' });

    const { rerender } = render(<TaskDAG tasks={taskMap(a, b)} />);

    // First ELK layout resolves: A and B settle at their ELK coordinates.
    await waitFor(() => {
      expect(nodeX('wf-1/a')).toBe('5000');
      expect(nodeX('wf-1/b')).toBe('5100');
    });

    // A new node arrives → a fresh ELK layout is requested but stays in flight.
    rerender(<TaskDAG tasks={taskMap(a, b, c)} />);

    // The new node must appear, proving the re-layout window is active.
    await waitFor(() => {
      expect(document.querySelector('[data-testid="rf__node-wf-1/c"]')).not.toBeNull();
    });

    // Existing nodes must NOT have jumped to the fallback layout.
    expect(nodeX('wf-1/a')).toBe('5000');
    expect(nodeX('wf-1/b')).toBe('5100');
    // The genuinely-new node uses the fallback (the in-flight ELK never resolved),
    // so it is NOT at the ELK coordinate 5200.
    expect(nodeX('wf-1/c')).not.toBe('5200');
  });
});
