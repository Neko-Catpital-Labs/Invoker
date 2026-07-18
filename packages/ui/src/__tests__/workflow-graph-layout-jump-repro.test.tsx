/**
 * Regression: the workflow graph must not re-pack existing nodes on a refresh.
 *
 * Positions are rank-based (newest-createdAt first, cumulative Y offset). A
 * workflow first seen through a rollup-delta patch has no createdAt and name =
 * its id, so it sorts LAST; a frame later refreshWorkflowMetadata lands the real
 * createdAt (newest) and it used to jump to FIRST, shifting every other node.
 *
 * The fix keys layout reuse on topology (node ids + edges) alone, so a refresh
 * that changes neither the node set nor the edges reuses the prior positions. A
 * genuine node add/remove still relays out. Fails on the pre-fix code.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { WorkflowGraph } from '../components/WorkflowGraph.js';
import type { WorkflowMeta, WorkflowStatus } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

function wf(id: string, name: string, createdAt?: string, status: WorkflowStatus = 'running'): WorkflowMeta {
  return { id, name, status, createdAt, updatedAt: createdAt } as WorkflowMeta;
}

function wfMap(...list: WorkflowMeta[]): Map<string, WorkflowMeta> {
  return new Map(list.map((w) => [w.id, w]));
}

function nodePos(id: string): { x: string | null; y: string | null } {
  const el = document.querySelector(`[data-testid="rf__node-${id}"]`);
  return { x: el?.getAttribute('data-x') ?? null, y: el?.getAttribute('data-y') ?? null };
}

const baseProps = {
  selectedWorkflowId: null,
  statusFilters: new Set<WorkflowStatus>(),
  onSelectWorkflow: () => {},
  onWorkflowContextMenu: () => {},
};

describe('workflow graph does not re-pack existing nodes on refresh', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps positions stable when a patched workflow later gains its metadata', () => {
    const oldA = wf('wf-old-a', 'Alpha plan', '2026-07-01T00:00:00Z');
    const oldB = wf('wf-old-b', 'Beta plan', '2026-07-02T00:00:00Z');

    // Frame 1: the newcomer arrived via a rollup patch — no createdAt, name = id.
    const { rerender } = render(
      <WorkflowGraph {...baseProps} workflows={wfMap(oldA, oldB, wf('wf-new', 'wf-new'))} />,
    );
    const before = { a: nodePos('wf-old-a'), b: nodePos('wf-old-b'), n: nodePos('wf-new') };

    // Frame 2: refreshWorkflowMetadata lands the real name + newest createdAt.
    rerender(
      <WorkflowGraph {...baseProps} workflows={wfMap(oldA, oldB, wf('wf-new', 'Fix login bug', '2026-07-15T00:00:00Z'))} />,
    );

    expect(nodePos('wf-old-a')).toEqual(before.a);
    expect(nodePos('wf-old-b')).toEqual(before.b);
    expect(nodePos('wf-new')).toEqual(before.n);
  });

  it('keeps positions stable across a status-only refresh', () => {
    const a = wf('wf-a', 'Alpha', '2026-07-01T00:00:00Z', 'running');
    const b = wf('wf-b', 'Beta', '2026-07-02T00:00:00Z', 'running');

    const { rerender } = render(<WorkflowGraph {...baseProps} workflows={wfMap(a, b)} />);
    const before = { a: nodePos('wf-a'), b: nodePos('wf-b') };

    // Same set, a status flips, brand-new Map (as the delta pipeline produces).
    rerender(
      <WorkflowGraph
        {...baseProps}
        workflows={wfMap(wf('wf-a', 'Alpha', '2026-07-01T00:00:00Z', 'completed'), b)}
      />,
    );

    expect(nodePos('wf-a')).toEqual(before.a);
    expect(nodePos('wf-b')).toEqual(before.b);
  });

  it('still relays out when the node set genuinely changes', () => {
    const a = wf('wf-a', 'Alpha', '2026-07-01T00:00:00Z');
    const b = wf('wf-b', 'Beta', '2026-07-02T00:00:00Z');

    const { rerender } = render(<WorkflowGraph {...baseProps} workflows={wfMap(a, b)} />);
    rerender(
      <WorkflowGraph
        {...baseProps}
        workflows={wfMap(a, b, wf('wf-c', 'Gamma', '2026-07-15T00:00:00Z'))}
      />,
    );

    // The genuinely-new node must have a real position (layout actually ran).
    expect(nodePos('wf-c').y).not.toBeNull();
  });
});
