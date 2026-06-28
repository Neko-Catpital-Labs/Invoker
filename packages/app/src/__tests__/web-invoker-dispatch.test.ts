import { describe, expect, it, vi } from 'vitest';
import { buildWebInvokerDispatch } from '../web/web-invoker-dispatch.js';

function makeTask(id: string) {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-01-01'),
    config: {},
    execution: {},
  };
}

function makeDispatch(overrides: Record<string, unknown> = {}) {
  const approveTask = vi.fn(async () => ({ ok: true }));
  const deps = {
    orchestrator: {
      getAllTasks: () => [makeTask('wf-1/task-1')],
      getWorkflowStatus: () => ({ total: 1, completed: 0, failed: 0, closed: 0, running: 0, pending: 1 }),
      getTask: () => null,
    },
    persistence: {
      listWorkflows: () => [{ id: 'wf-1', name: 'Workflow 1', status: 'pending' }],
    },
    mutations: { approveTask },
    agentRegistry: { listExecution: () => [] },
    loadConfig: () => ({}),
    getStreamSequence: () => 7,
    refreshTaskGraph: vi.fn(async () => {}),
    deleteWorkflow: vi.fn(async () => {}),
    detachWorkflow: vi.fn(async () => {}),
    ...overrides,
  };
  return { dispatch: buildWebInvokerDispatch(deps as never), approveTask };
}

describe('buildWebInvokerDispatch', () => {
  it('list-workflows returns the persisted workflows', async () => {
    const { dispatch } = makeDispatch();
    expect(await dispatch('invoker:list-workflows', [])).toEqual([
      { id: 'wf-1', name: 'Workflow 1', status: 'pending' },
    ]);
  });

  it('get-tasks returns the { tasks, workflows, streamSequence } snapshot', async () => {
    const { dispatch } = makeDispatch();
    expect(await dispatch('invoker:get-tasks', [])).toEqual({
      tasks: [makeTask('wf-1/task-1')],
      workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'pending' }],
      streamSequence: 7,
    });
  });

  it('approve routes to the mutation facade', async () => {
    const { dispatch, approveTask } = makeDispatch();
    await dispatch('invoker:approve', ['wf/x']);
    expect(approveTask).toHaveBeenCalledWith('wf/x');
  });

  it('open-terminal degrades gracefully instead of rejecting', async () => {
    const { dispatch } = makeDispatch();
    expect(await dispatch('invoker:open-terminal', ['t'])).toEqual({
      opened: false,
      reason: expect.any(String),
    });
  });

  it('a global-lifecycle channel rejects as unsupported_on_web', async () => {
    const { dispatch } = makeDispatch();
    await expect(dispatch('invoker:start', [])).rejects.toMatchObject({ code: 'unsupported_on_web' });
  });

  it('an unknown channel rejects with code unknown_channel', async () => {
    const { dispatch } = makeDispatch();
    await expect(dispatch('invoker:does-not-exist', [])).rejects.toMatchObject({ code: 'unknown_channel' });
  });
});
