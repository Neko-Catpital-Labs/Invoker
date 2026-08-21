import { describe, expect, it, vi } from 'vitest';
import { buildWebInvokerDispatch } from '../web/web-invoker-dispatch.js';
import type { InvokerConfig } from '../config.js';

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
  const spawnRepairWorkflow = vi.fn(async () => ({ ok: true }));
  const editTaskModel = vi.fn(async () => ({ ok: true }));
  const deps = {
    orchestrator: {
      syncAllFromDb: vi.fn(),
      getAllTasks: () => [makeTask('wf-1/task-1')],
      getWorkflowStatus: () => ({ total: 1, completed: 0, failed: 0, closed: 0, running: 0, pending: 1 }),
      getTask: () => null,
    },
    persistence: {
      listWorkflows: () => [{ id: 'wf-1', name: 'Workflow 1', status: 'pending' }],
    },
    mutations: { approveTask, spawnRepairWorkflow, editTaskModel },
    agentRegistry: { listExecutionHarnesses: () => [] },
    loadConfig: () => ({}),
    getStreamSequence: () => 7,
    refreshTaskGraph: vi.fn(async () => {}),
    deleteWorkflow: vi.fn(async () => {}),
    detachWorkflow: vi.fn(async () => {}),
    ...overrides,
  };
  return { dispatch: buildWebInvokerDispatch(deps as never), approveTask, spawnRepairWorkflow, editTaskModel };
}
function makeTaskTerminalAdapter() {
  return {
    open: vi.fn(async (taskId: string) => ({
      opened: true,
      session: { sessionId: `session-${taskId}`, taskId, kind: 'task', status: 'running' },
    })),
    list: vi.fn(async () => [{ sessionId: 'session-1', taskId: 'task-1', kind: 'task', status: 'running' }]),
    write: vi.fn(async (sessionId: string, data: string) => ({ ok: true, sessionId, bytes: data.length })),
    resize: vi.fn(async (sessionId: string, cols: number, rows: number) => ({ ok: true, sessionId, cols, rows })),
    close: vi.fn(async (sessionId: string) => ({ ok: true, sessionId })),
  };
}

describe('buildWebInvokerDispatch', () => {
  it('list-workflows returns the persisted workflows', async () => {
    const { dispatch } = makeDispatch();
    expect(await dispatch('invoker:list-workflows', [])).toEqual([
      { id: 'wf-1', name: 'Workflow 1', status: 'pending' },
    ]);
  });

  it('get-tasks returns the { tasks, workflows, streamSequence } snapshot', async () => {
    const staleTask = makeTask('wf-1/stale-task');
    const freshTask = makeTask('wf-1/fresh-task');
    let syncedFromDb = false;
    const syncAllFromDb = vi.fn(() => {
      syncedFromDb = true;
    });
    const getAllTasks = vi.fn(() => (syncedFromDb ? [freshTask] : [staleTask]));
    const { dispatch } = makeDispatch({
      orchestrator: {
        syncAllFromDb,
        getAllTasks,
        getWorkflowStatus: () => ({ total: 1, completed: 0, failed: 0, closed: 0, running: 0, pending: 1 }),
        getTask: () => null,
      },
    });

    expect(await dispatch('invoker:get-tasks', [])).toEqual({
      tasks: [freshTask],
      workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'pending' }],
      streamSequence: 7,
    });
    expect(syncAllFromDb).toHaveBeenCalledTimes(1);
    expect(getAllTasks).toHaveBeenCalledTimes(1);
  });

  it('get-execution-harnesses returns harness metadata', async () => {
    const harnesses = [
      { name: 'claude', supportedModels: [{ id: 'sonnet', label: 'Claude Sonnet' }] },
    ];
    const { dispatch } = makeDispatch({
      agentRegistry: { listExecutionHarnesses: () => harnesses },
    });
    expect(await dispatch('invoker:get-execution-harnesses', [])).toEqual(harnesses);
  });

  it('get-execution-harnesses honors the enabledExecutionAgents allowlist', async () => {
    const harnesses = [
      { name: 'claude', supportedModels: [{ id: 'sonnet', label: 'Claude Sonnet' }] },
      { name: 'codex', supportedModels: [] },
    ];
    const { dispatch } = makeDispatch({
      agentRegistry: { listExecutionHarnesses: () => harnesses },
      loadConfig: () => ({ enabledExecutionAgents: ['claude'] } as unknown as InvokerConfig),
    });
    expect(await dispatch('invoker:get-execution-harnesses', [])).toEqual([
      { name: 'claude', supportedModels: [{ id: 'sonnet', label: 'Claude Sonnet' }] },
    ]);
  });

  it('get-planning-presets returns configured planning presets', async () => {
    const { dispatch } = makeDispatch({
      loadConfig: () =>
        ({
          defaultSlackHarnessPreset: 'omp+claude',
          slackHarnessPresets: {
            custom: { tool: 'codex' },
          },
        } as unknown as InvokerConfig),
    });
    expect(await dispatch('invoker:get-planning-presets', [])).toEqual(expect.arrayContaining([
      { key: 'omp+claude', label: 'Claude via OMP', tool: 'omp', model: 'claude', isDefault: true, defaultConfirmationMode: 'require' },
      { key: 'custom', label: 'custom', tool: 'codex', model: undefined, isDefault: false, defaultConfirmationMode: 'require' },
    ]));
  });

  it('get-execution-defaults returns configured task execution defaults', async () => {
    const { dispatch } = makeDispatch({
      loadConfig: () =>
        ({ defaultExecutionAgent: 'omp', defaultExecutionModel: 'chatgpt-5.4' } as unknown as InvokerConfig),
    });
    expect(await dispatch('invoker:get-execution-defaults', [])).toEqual({
      executionAgent: 'omp',
      executionModel: 'chatgpt-5.4',
    });
  });

  it('get-history-tasks returns persistence history rows', async () => {
    const historyRows = [
      {
        id: 't1',
        description: 'History task',
        status: 'completed',
        workflowName: 'Plan A',
        lastEventAt: '2026-07-01T00:00:00Z',
        eventCount: 2,
      },
    ];
    const { dispatch } = makeDispatch({
      persistence: {
        listWorkflows: () => [{ id: 'wf-1', name: 'Workflow 1', status: 'pending' }],
        loadAllHistoryTasks: () => historyRows,
      },
    });
    expect(await dispatch('invoker:get-history-tasks', [])).toEqual(historyRows);
  });

  it('get-events returns a paginated page for a task', async () => {
    const events = [{ id: 1, taskId: 't1', eventType: 'task.running', createdAt: '2026-07-01T00:00:00Z' }];
    const getEvents = vi.fn(() => events);
    const { dispatch } = makeDispatch({
      persistence: {
        listWorkflows: () => [{ id: 'wf-1', name: 'Workflow 1', status: 'pending' }],
        getEvents,
      },
    });
    expect(await dispatch('invoker:get-events', ['t1', { limit: 50, sortBy: 'desc' }])).toEqual(events);
    expect(getEvents).toHaveBeenCalledWith('t1', 'desc', 50, undefined);
  });

  it('get-events rejects missing limit', async () => {
    const { dispatch } = makeDispatch({
      persistence: {
        listWorkflows: () => [{ id: 'wf-1', name: 'Workflow 1', status: 'pending' }],
        getEvents: vi.fn(() => []),
      },
    });
    await expect(dispatch('invoker:get-events', ['t1'])).rejects.toThrow(/limit/i);
  });

  it('approve routes to the mutation facade', async () => {
    const { dispatch, approveTask } = makeDispatch();
    await dispatch('invoker:approve', ['wf/x']);
    expect(approveTask).toHaveBeenCalledWith('wf/x');
  });

  it('spawn-repair-workflow routes to the mutation facade', async () => {
    const payload = { upstreamWorkflowId: 'wf-upstream' };
    const { dispatch, spawnRepairWorkflow } = makeDispatch();
    await dispatch('invoker:spawn-repair-workflow', [payload]);
    expect(spawnRepairWorkflow).toHaveBeenCalledWith(payload);
  });

  it('edit-task-model routes to the mutation facade', async () => {
    const { dispatch, editTaskModel } = makeDispatch();
    await dispatch('invoker:edit-task-model', ['wf-1/task-1', 'gpt-5.3-codex-spark']);
    expect(editTaskModel).toHaveBeenCalledWith('wf-1/task-1', 'gpt-5.3-codex-spark');
  });

  it('open-terminal degrades gracefully when task terminal support is absent', async () => {
    const { dispatch } = makeDispatch();
    expect(await dispatch('invoker:open-terminal', ['t'])).toEqual({
      opened: false,
      reason: expect.any(String),
    });
  });

  it('routes task terminal channels through the injected adapter', async () => {
    const taskTerminals = makeTaskTerminalAdapter();
    const { dispatch } = makeDispatch({ taskTerminals });

    await expect(dispatch('invoker:open-terminal', ['task-1'])).resolves.toEqual({
      opened: true,
      session: expect.objectContaining({ sessionId: 'session-task-1', taskId: 'task-1' }),
    });
    await expect(dispatch('invoker:terminal-list', [])).resolves.toEqual([
      expect.objectContaining({ sessionId: 'session-1', taskId: 'task-1' }),
    ]);
    await expect(dispatch('invoker:terminal-write', ['session-1', 'echo hi'])).resolves.toEqual({
      ok: true,
      sessionId: 'session-1',
      bytes: 7,
    });
    await expect(dispatch('invoker:terminal-resize', ['session-1', 120, 40])).resolves.toEqual({
      ok: true,
      sessionId: 'session-1',
      cols: 120,
      rows: 40,
    });
    await expect(dispatch('invoker:terminal-close', ['session-1'])).resolves.toEqual({
      ok: true,
      sessionId: 'session-1',
    });

    expect(taskTerminals.open).toHaveBeenCalledWith('task-1');
    expect(taskTerminals.list).toHaveBeenCalledWith();
    expect(taskTerminals.write).toHaveBeenCalledWith('session-1', 'echo hi');
    expect(taskTerminals.resize).toHaveBeenCalledWith('session-1', 120, 40);
    expect(taskTerminals.close).toHaveBeenCalledWith('session-1');
  });

  it('keeps planning terminal routes degraded on the web surface', async () => {
    const taskTerminals = makeTaskTerminalAdapter();
    const { dispatch } = makeDispatch({ taskTerminals });

    await expect(dispatch('invoker:planning-terminal-open', ['plan-1'])).resolves.toEqual({
      opened: false,
      reason: 'Planning terminals are not available in the web UI',
    });
    await expect(dispatch('invoker:planning-terminal-list', [])).resolves.toEqual([]);
    await expect(dispatch('invoker:planning-terminal-write', ['session-1', 'x'])).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
    await expect(dispatch('invoker:planning-terminal-resize', ['session-1', 80, 24])).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
    await expect(dispatch('invoker:planning-terminal-close', ['session-1'])).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
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

  describe('planning routes', () => {
    it('routes planning-chat channels through guiMutations when wired', async () => {
      const guiMutations = vi.fn(async (channel: string) => ({ ok: true, channel }));
      const { dispatch } = makeDispatch({ guiMutations });
      const request = { title: 'demo' };
      expect(await dispatch('invoker:planning-chat-create', [request])).toEqual({
        ok: true,
        channel: 'invoker:planning-chat-create',
      });
      expect(guiMutations).toHaveBeenCalledWith('invoker:planning-chat-create', [request]);
      await dispatch('invoker:planning-chat-list', []);
      await dispatch('invoker:planning-chat-set-terminal-mode', [{ sessionId: 's1', mode: 'tmux' }]);
      expect(guiMutations).toHaveBeenCalledTimes(3);
    });

    it('keeps the historical downgrades when guiMutations is absent', async () => {
      const { dispatch } = makeDispatch();
      await expect(dispatch('invoker:planning-chat-create', [{}])).rejects.toMatchObject({
        code: 'unsupported_on_web',
      });
      expect(await dispatch('invoker:planning-chat-set-terminal-mode', [{}])).toEqual({
        ok: false,
        error: 'Planning tmux is not available in the web UI',
      });
    });

    it('routes planning-terminal channels through the adapter when wired', async () => {
      const planningTerminals = {
        open: vi.fn(async (planningSessionId: string) => ({
          opened: true,
          session: { sessionId: `pt-${planningSessionId}`, taskId: `planning:${planningSessionId}`, kind: 'planning', status: 'running' },
        })),
        list: vi.fn(() => [{ sessionId: 'pt-1', taskId: 'planning:chat-1', kind: 'planning', status: 'running' }]),
        write: vi.fn((sessionId: string, data: string) => ({ ok: true as const, sessionId, bytes: data.length })),
        resize: vi.fn(() => ({ ok: true as const })),
        appliedSize: vi.fn(() => ({ cols: 80, rows: 24 })),
        close: vi.fn(() => ({ ok: true as const })),
      };
      const { dispatch } = makeDispatch({ planningTerminals });
      const opened = await dispatch('invoker:planning-terminal-open', ['chat-1']) as { opened: boolean };
      expect(opened.opened).toBe(true);
      expect(planningTerminals.open).toHaveBeenCalledWith('chat-1');
      expect(await dispatch('invoker:planning-terminal-list', [])).toHaveLength(1);
      await dispatch('invoker:planning-terminal-write', ['pt-1', 'ls\n']);
      expect(planningTerminals.write).toHaveBeenCalledWith('pt-1', 'ls\n');
      await dispatch('invoker:planning-terminal-resize', ['pt-1', 120, 40]);
      expect(planningTerminals.resize).toHaveBeenCalledWith('pt-1', 120, 40);
      expect(await dispatch('invoker:planning-terminal-applied-size', ['pt-1'])).toEqual({ cols: 80, rows: 24 });
      await dispatch('invoker:planning-terminal-close', ['pt-1']);
      expect(planningTerminals.close).toHaveBeenCalledWith('pt-1');
    });

    it('keeps planning terminals downgraded when the adapter is absent', async () => {
      const { dispatch } = makeDispatch();
      expect(await dispatch('invoker:planning-terminal-open', ['chat-1'])).toEqual({
        opened: false,
        reason: 'Planning terminals are not available in the web UI',
      });
      expect(await dispatch('invoker:planning-terminal-list', [])).toEqual([]);
      expect(await dispatch('invoker:planning-terminal-applied-size', ['pt-1'])).toBeNull();
      expect(await dispatch('invoker:planning-terminal-write', ['pt-1', 'x'])).toEqual({ ok: false, reason: 'unsupported' });
    });
  });

});
