import { describe, expect, it } from 'vitest';
import type { ActionGraphNode } from '@invoker/contracts';
import { selectWorkflowCoreActivity } from '../lib/workflow-core-activity.js';

const workflowId = 'wf-1';

function node(overrides: Partial<ActionGraphNode> & Pick<ActionGraphNode, 'id' | 'type' | 'status'>): ActionGraphNode {
  return {
    label: overrides.id,
    workflowId,
    ...overrides,
  } as ActionGraphNode;
}

describe('selectWorkflowCoreActivity', () => {
  it('uses queued launch state instead of running mutation intent labels', () => {
    const selected = selectWorkflowCoreActivity([
      node({ id: 'intent:77', type: 'mutation-intent', status: 'running', label: 'invoker:rebase-recreate' }),
      node({ id: 'launch-dispatch:1', type: 'launch-dispatch', status: 'queued' }),
    ], workflowId);

    expect(selected?.label).toBe('Pending: queued for launch');
  });

  it('ignores running mutation intent when no core activity exists', () => {
    const selected = selectWorkflowCoreActivity([
      node({ id: 'intent:77', type: 'mutation-intent', status: 'running', label: 'invoker:rebase-recreate' }),
    ], workflowId);

    expect(selected).toBeUndefined();
  });

  it('maps leased launch dispatches to accepted pending launch state', () => {
    const selected = selectWorkflowCoreActivity([
      node({ id: 'launch-dispatch:2', type: 'launch-dispatch', status: 'running' }),
    ], workflowId);

    expect(selected?.label).toBe('Pending: launch accepted');
  });

  it('lets a running task attempt outrank queued launch dispatches', () => {
    const selected = selectWorkflowCoreActivity([
      node({ id: 'launch-dispatch:1', type: 'launch-dispatch', status: 'queued' }),
      node({ id: 'attempt:1', type: 'task-attempt', status: 'running' }),
    ], workflowId);

    expect(selected?.label).toBe('Running: task executing');
  });

  it('lets failed blockers outrank running task attempts', () => {
    const selected = selectWorkflowCoreActivity([
      node({ id: 'attempt:1', type: 'task-attempt', status: 'running' }),
      node({ id: 'blocker:1', type: 'blocker', status: 'failed' }),
    ], workflowId);

    expect(selected?.label).toBe('Failed: see details');
  });

  it('uses newest startedAt or createdAt for same-rank candidates', () => {
    const selected = selectWorkflowCoreActivity([
      node({ id: 'launch-dispatch:old', type: 'launch-dispatch', status: 'queued', createdAt: '2026-06-22T09:00:00.000Z' }),
      node({ id: 'launch-dispatch:new', type: 'launch-dispatch', status: 'queued', startedAt: '2026-06-22T10:00:00.000Z' }),
    ], workflowId);

    expect(selected?.nodeId).toBe('launch-dispatch:new');
  });
});
