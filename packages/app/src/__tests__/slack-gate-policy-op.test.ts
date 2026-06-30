import { describe, expect, it, vi } from 'vitest';
import { executeSlackGatePolicyOp } from '../slack-gate-policy-op.js';

function makePersistence() {
  const workflows = [
    {
      id: 'wf-down',
      name: 'Downstream',
      externalDependencies: [
        { workflowId: 'wf-up', gatePolicy: 'completed' as const },
        { workflowId: 'wf-other', taskId: 'api', gatePolicy: 'completed' as const },
      ],
    },
    {
      id: 'wf-skip',
      name: 'Skip Me',
      externalDependencies: [{ workflowId: 'wf-other', gatePolicy: 'completed' as const }],
    },
    {
      id: 'wf-up',
      name: 'Upstream',
      externalDependencies: [],
    },
  ];
  return {
    listWorkflows: vi.fn(() => workflows),
    loadWorkflow: vi.fn((workflowId: string) => workflows.find((workflow) => workflow.id === workflowId)),
  };
}

describe('executeSlackGatePolicyOp', () => {
  it('resolves workflow names and updates matching external dependency policies through the facade', async () => {
    const persistence = makePersistence();
    const mutations = {
      setWorkflowExternalGatePolicies: vi.fn(async () => ({ runnable: [{ id: 'task-a' }] })),
      retryWorkflow: vi.fn(),
      recreateWorkflow: vi.fn(),
      cancelWorkflow: vi.fn(),
    };

    const result = await executeSlackGatePolicyOp({
      operation: 'gate-policy',
      target: { workflow: 'Downstream' },
      updates: [{ workflowId: 'Upstream', gatePolicy: 'review_ready' }],
    }, { persistence, mutations });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('1 updated');
    expect(mutations.setWorkflowExternalGatePolicies).toHaveBeenCalledWith(
      'wf-down',
      [{ workflowId: 'wf-up', gatePolicy: 'review_ready' }],
    );
    expect(mutations.retryWorkflow).not.toHaveBeenCalled();
    expect(mutations.recreateWorkflow).not.toHaveBeenCalled();
    expect(mutations.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('expands all targets but only mutates workflows with the requested dependency', async () => {
    const persistence = makePersistence();
    const mutations = {
      setWorkflowExternalGatePolicies: vi.fn(async () => ({ runnable: [] })),
    };

    const result = await executeSlackGatePolicyOp({
      operation: 'gate-policy',
      target: { all: true },
      updates: [{ workflowId: 'wf-up', gatePolicy: 'review_ready' }],
    }, { persistence, mutations });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('1 updated');
    expect(result.summary).toContain('2 skipped');
    expect(mutations.setWorkflowExternalGatePolicies).toHaveBeenCalledTimes(1);
    expect(mutations.setWorkflowExternalGatePolicies).toHaveBeenCalledWith(
      'wf-down',
      [{ workflowId: 'wf-up', gatePolicy: 'review_ready' }],
    );
  });

  it('reports unmatched upstream workflows without mutating', async () => {
    const persistence = makePersistence();
    const mutations = {
      setWorkflowExternalGatePolicies: vi.fn(),
    };

    const result = await executeSlackGatePolicyOp({
      operation: 'gate-policy',
      target: { workflow: 'wf-down' },
      updates: [{ workflowId: 'missing-upstream', gatePolicy: 'review_ready' }],
    }, { persistence, mutations });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('No upstream workflow matching');
    expect(mutations.setWorkflowExternalGatePolicies).not.toHaveBeenCalled();
  });
});
