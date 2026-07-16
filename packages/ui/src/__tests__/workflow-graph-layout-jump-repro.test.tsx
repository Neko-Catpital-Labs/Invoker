/**
 * Characterization repro: the workflow graph re-packs every node whenever
 * workflow data refreshes, because positions are rank-based (newest-createdAt
 * first, cumulative Y offset) and recomputed from scratch each render.
 *
 * A workflow first seen through a rollup-delta patch has no createdAt and
 * name = its id, so it sorts LAST. A frame later refreshWorkflowMetadata lands
 * the real createdAt (newest) and it jumps to FIRST — shifting every other node
 * down a row, though the user did nothing.
 *
 * This slice pins that behavior: the assertions below describe the current jump
 * so the fix has a baseline. The fix slice flips them to assert stability.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { WorkflowGraph } from '../components/WorkflowGraph.js';
import type { WorkflowMeta, WorkflowStatus } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

function wf(id: string, name: string, createdAt?: string): WorkflowMeta {
  return { id, name, status: 'running' as WorkflowStatus, createdAt, updatedAt: createdAt } as WorkflowMeta;
}

function wfMap(...list: WorkflowMeta[]): Map<string, WorkflowMeta> {
  return new Map(list.map((w) => [w.id, w]));
}

function nodeY(id: string): string | null {
  return document.querySelector(`[data-testid="rf__node-${id}"]`)?.getAttribute('data-y') ?? null;
}

const baseProps = {
  selectedWorkflowId: null,
  statusFilters: new Set<WorkflowStatus>(),
  onSelectWorkflow: () => {},
  onWorkflowContextMenu: () => {},
};

describe('workflow graph re-packs on a metadata refresh', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shifts existing nodes when a patched workflow later gains its metadata', () => {
    const oldA = wf('wf-old-a', 'Alpha plan', '2026-07-01T00:00:00Z');
    const oldB = wf('wf-old-b', 'Beta plan', '2026-07-02T00:00:00Z');

    // Frame 1: the newcomer arrived via a rollup patch — no createdAt, name = id.
    const { rerender } = render(
      <WorkflowGraph {...baseProps} workflows={wfMap(oldA, oldB, wf('wf-new', 'wf-new'))} />,
    );
    const beforeA = nodeY('wf-old-a');
    const beforeB = nodeY('wf-old-b');

    // Frame 2: refreshWorkflowMetadata lands the real name + newest createdAt.
    rerender(
      <WorkflowGraph {...baseProps} workflows={wfMap(oldA, oldB, wf('wf-new', 'Fix login bug', '2026-07-15T00:00:00Z'))} />,
    );

    // Current behavior: the metadata refresh re-packs the canvas, so the two
    // untouched workflows are no longer where they were.
    expect(nodeY('wf-old-a')).not.toBe(beforeA);
    expect(nodeY('wf-old-b')).not.toBe(beforeB);
  });
});
