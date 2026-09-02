import { describe, expect, it, vi } from 'vitest';
import { buildWebInvokerDispatch } from '../web/web-invoker-dispatch.js';
import type { InvokerConfig } from '../config.js';
import { OwnerCapabilityRegistry } from '../owner-capability-registry.js';

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
  it('report-ui-perf persists the metric to the activity log like the GUI handler', async () => {
    const writeActivityLog = vi.fn();
    const { dispatch } = makeDispatch({
      persistence: {
        listWorkflows: () => [],
        writeActivityLog,
      },
    });
    await dispatch('invoker:report-ui-perf', ['planning_send_start', { sessionId: 's-1', turnId: 't-1' }]);
    expect(writeActivityLog).toHaveBeenCalledTimes(1);
    const [source, level, message] = writeActivityLog.mock.calls[0];
    expect(source).toBe('ui-perf');
    expect(level).toBe('info');
    expect(JSON.parse(message)).toMatchObject({ metric: 'planning_send_start', sessionId: 's-1', turnId: 't-1' });
  });

  it('report-ui-perf swallows activity-log write failures', async () => {
    const { dispatch } = makeDispatch({
      persistence: {
        listWorkflows: () => [],
        writeActivityLog: vi.fn(() => {
          throw new Error('database is locked');
        }),
      },
    });
    await expect(dispatch('invoker:report-ui-perf', ['planning_send_start', {}])).resolves.toBeUndefined();
  });

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

  it('get-worker-decisions mirrors the owner read handler', async () => {
    const listWorkerActions = vi.fn(() => []);
    const { dispatch } = makeDispatch({
      persistence: {
        listWorkflows: () => [],
        listWorkerActions,
      },
    });

    await expect(dispatch('invoker:get-worker-decisions', [{
      workflowId: 'wf-1',
      decision: 'act',
      limit: 25,
      offset: 0,
    }])).resolves.toEqual({
      workflowId: 'wf-1',
      actions: [],
      limit: 25,
      offset: 0,
      hasMore: false,
    });
    expect(listWorkerActions).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      decision: 'act',
      limit: 26,
      offset: 0,
    });
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

  it('routes a registered global-lifecycle capability through the owner registry', async () => {
    const ownerCapabilities = new OwnerCapabilityRegistry();
    const start = vi.fn(async () => ['started']);
    ownerCapabilities.register('invoker:start', start);
    const { dispatch } = makeDispatch({ ownerCapabilities });

    await expect(dispatch('invoker:start', [])).resolves.toEqual(['started']);
    expect(start).toHaveBeenCalledOnce();
  });

  it('start-ready forwards the dry-run request through the owner registry when wired', async () => {
    const response = { ok: true, ready: ['wf-1/task-1'] };
    const ownerCapabilities = new OwnerCapabilityRegistry();
    const startReady = vi.fn(async () => response);
    ownerCapabilities.register('invoker:start-ready', startReady);
    const { dispatch } = makeDispatch({ ownerCapabilities });
    const request = { dryRun: true };

    await expect(dispatch('invoker:start-ready', [request])).resolves.toBe(response);
    expect(startReady).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('distinguishes a known channel with no owner provider from an unknown channel', async () => {
    const { dispatch } = makeDispatch();
    const missingOwner = dispatch('invoker:start-ready', [{ dryRun: true }]);

    await expect(missingOwner).rejects.toMatchObject({
      code: 'capability_provider_missing',
    });
    await expect(dispatch('invoker:does-not-exist', [])).rejects.toMatchObject({ code: 'unknown_channel' });
  });

  it('bridges a known channel through the legacy guiMutations callback when no owner registry is wired', async () => {
    const guiMutations = vi.fn(async (channel: string) => ({ ok: true, channel }));
    const { dispatch } = makeDispatch({ guiMutations });
    await expect(dispatch('invoker:planning-chat-list', [])).resolves.toEqual({
      ok: true,
      channel: 'invoker:planning-chat-list',
    });
    expect(guiMutations).toHaveBeenCalledExactlyOnceWith('invoker:planning-chat-list', []);
  });

  it('allows Codex and forbids Claude by deployment policy without restricting HTTP itself', async () => {
    const ownerCapabilities = new OwnerCapabilityRegistry();
    const fixWithAgent = vi.fn(async (_taskId: unknown, agentName: unknown) => ({ agentName }));
    ownerCapabilities.register('invoker:fix-with-agent', fixWithAgent);
    const { dispatch } = makeDispatch({
      ownerCapabilities,
      loadConfig: () => ({ enabledExecutionAgents: ['codex'] } as InvokerConfig),
    });

    await expect(dispatch('invoker:fix-with-agent', ['task-1', 'codex'])).resolves.toEqual({
      agentName: 'codex',
    });
    await expect(dispatch('invoker:fix-with-agent', ['task-1', 'claude'])).rejects.toMatchObject({
      code: 'execution_agent_disabled',
    });
    expect(fixWithAgent).toHaveBeenCalledTimes(1);
  });

  it('reports a registered agent-bearing capability with no provider as unavailable before policy', async () => {
    const { dispatch } = makeDispatch({
      loadConfig: () => ({ enabledExecutionAgents: ['codex'] } as InvokerConfig),
    });

    await expect(dispatch('invoker:fix-with-agent', ['task-1', 'claude'])).rejects.toMatchObject({
      code: 'capability_provider_missing',
    });
  });

  describe('planning routes', () => {
    it('routes planning-chat channels through owner capabilities when wired', async () => {
      const ownerCapabilities = new OwnerCapabilityRegistry();
      const create = vi.fn(async () => ({ ok: true, channel: 'invoker:planning-chat-create' }));
      const list = vi.fn(async () => ({ ok: true, sessions: [] }));
      const setTerminalMode = vi.fn(async () => ({ ok: true }));
      ownerCapabilities.register('invoker:planning-chat-create', create);
      ownerCapabilities.register('invoker:planning-chat-list', list);
      ownerCapabilities.register('invoker:planning-chat-set-terminal-mode', setTerminalMode);
      const { dispatch } = makeDispatch({ ownerCapabilities });
      const request = { title: 'demo' };
      expect(await dispatch('invoker:planning-chat-create', [request])).toEqual({
        ok: true,
        channel: 'invoker:planning-chat-create',
      });
      expect(create).toHaveBeenCalledWith(request);
      await dispatch('invoker:planning-chat-list', []);
      await dispatch('invoker:planning-chat-set-terminal-mode', [{ sessionId: 's1', mode: 'tmux' }]);
      expect(list).toHaveBeenCalledOnce();
      expect(setTerminalMode).toHaveBeenCalledOnce();
    });

    it('reports missing owner providers instead of transport restrictions', async () => {
      const { dispatch } = makeDispatch();
      const missingCreateOwner = dispatch('invoker:planning-chat-create', [{}]);
      const missingTerminalModeOwner = dispatch('invoker:planning-chat-set-terminal-mode', [{}]);

      await expect(missingCreateOwner).rejects.toMatchObject({
        code: 'capability_provider_missing',
      });
      await expect(missingTerminalModeOwner).rejects.toMatchObject({
        code: 'capability_provider_missing',
      });
    });

    it('applies deployment policy to the planning preset before invoking the owner', async () => {
      const ownerCapabilities = new OwnerCapabilityRegistry();
      const create = vi.fn(async (request: unknown) => request);
      ownerCapabilities.register('invoker:planning-chat-create', create);
      const { dispatch } = makeDispatch({
        ownerCapabilities,
        loadConfig: () => ({ enabledExecutionAgents: ['codex'] } as InvokerConfig),
      });

      await expect(dispatch('invoker:planning-chat-create', [{ presetKey: 'codex' }])).resolves.toEqual({
        presetKey: 'codex',
      });
      await expect(dispatch('invoker:planning-chat-create', [{ presetKey: 'claude' }])).rejects.toMatchObject({
        code: 'execution_agent_disabled',
      });
      expect(create).toHaveBeenCalledTimes(1);
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
