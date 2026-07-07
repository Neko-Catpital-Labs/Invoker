/**
 * Parity regression tests spanning API, UI bridge (facade), headless
 * delegation, and command-service mutation behavior.
 *
 * These tests verify the invariant that all three entry surfaces
 * (api-server HTTP, headless CLI, command-service) route mutations
 * through the same WorkflowMutationFacade dispatch+topup lifecycle
 * and produce structurally equivalent results.
 *
 * Test groups:
 *   1. Facade dispatch+topup lifecycle — every mutation method
 *      filters runnable tasks, records accepted launches, then
 *      calls startExecution for global topup with deduplication.
 *   2. API server → facade wiring — HTTP endpoints call the correct
 *      facade method and return the structured result.
 *   3. Headless → commandService routing — headless CLI verbs
 *      delegate to the right commandService method (not directly
 *      to orchestrator).
 *   4. CommandService → orchestrator mutex serialization — each
 *      command service method calls the correct orchestrator
 *      primitive under the workflow-scoped mutex.
 *   5. Cross-surface isolation — mutation verbs on one surface
 *      never accidentally trigger unrelated mutation paths.
 */
import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import { WorkflowMutationFacade, type WorkflowMutationFacadeDeps } from '../workflow-mutation-facade.js';
import { startApiServer, type ApiServer } from '../api-server.js';
import { CommandService } from '@invoker/workflow-core';
import type { CommandEnvelope } from '@invoker/contracts';

// ── Shared helpers ──────────────────────────────────────────

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    status: 'running' as const,
    description: 'test task',
    dependencies: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    config: { workflowId: 'wf-1' },
    execution: {},
    ...overrides,
  };
}

function makePendingTask(overrides: Record<string, unknown> = {}) {
  return makeTask({ status: 'pending', ...overrides });
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode!, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeFacadeDeps(overrides: Partial<WorkflowMutationFacadeDeps> = {}): WorkflowMutationFacadeDeps {
  const orchestrator = {
    retryTask: vi.fn(() => [makeTask()]),
    recreateTask: vi.fn(() => [makeTask()]),
    recreateDownstream: vi.fn(() => [makeTask()]),
    retryWorkflow: vi.fn(() => [makeTask()]),
    recreateWorkflow: vi.fn(() => [makeTask()]),
    recreateWorkflowFromFreshBase: vi.fn(async () => [makeTask()]),
    cascadeInvalidationToDownstream: vi.fn(() => []),
    cancelTask: vi.fn(() => ({ cancelled: ['task-1'], runningCancelled: ['task-1'] })),
    cancelWorkflow: vi.fn(() => ({ cancelled: ['task-1'], runningCancelled: ['task-1'] })),
    deleteWorkflow: vi.fn(),
    detachWorkflow: vi.fn(),
    forkWorkflow: vi.fn(() => ({
      forkedWorkflowId: 'wf-fork',
      sourceWorkflowId: 'wf-1',
      started: [makeTask({ id: 'fork-t1' })],
    })),
    editTaskCommand: vi.fn(() => [makeTask()]),
    editTaskPrompt: vi.fn(() => [makeTask()]),
    editTaskAgent: vi.fn(() => [makeTask()]),
    setTaskExternalGatePolicies: vi.fn(() => []),
    selectExperiment: vi.fn(() => [makeTask()]),
    approve: vi.fn(async () => [makeTask()]),
    reject: vi.fn(),
    provideInput: vi.fn(),
    getTask: vi.fn(() => makeTask()),
    getAllTasks: vi.fn(() => []),
    startExecution: vi.fn(() => []),
  };
  const persistence = {
    loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 1 })),
    updateWorkflow: vi.fn(),
    loadTasks: vi.fn(() => []),
  };
  const taskExecutor = {
    executeTasks: vi.fn().mockResolvedValue(undefined),
    publishAfterFix: vi.fn().mockResolvedValue(undefined),
    resolveConflict: vi.fn().mockResolvedValue(undefined),
    fixWithAgent: vi.fn().mockResolvedValue(undefined),
    commitApprovedFix: vi.fn().mockResolvedValue(undefined),
    killActiveExecution: vi.fn().mockResolvedValue(undefined),
    preparePoolForRebaseRetry: vi.fn().mockResolvedValue(undefined),
  };
  const commandService = {
    retryTask: vi.fn(async (envelope: { payload: { taskId: string } }) => ({ ok: true as const, data: orchestrator.retryTask(envelope.payload.taskId) })),
    recreateTask: vi.fn(async (envelope: { payload: { taskId: string } }) => ({ ok: true as const, data: orchestrator.recreateTask(envelope.payload.taskId) })),
    recreateDownstream: vi.fn(async (envelope: { payload: { taskId: string } }) => ({ ok: true as const, data: orchestrator.recreateDownstream(envelope.payload.taskId) })),
    retryWorkflow: vi.fn(async (envelope: { payload: { workflowId: string } }) => ({ ok: true as const, data: orchestrator.retryWorkflow(envelope.payload.workflowId) })),
    recreateWorkflow: vi.fn(async (envelope: { payload: { workflowId: string } }) => {
      const workflow = persistence.loadWorkflow(envelope.payload.workflowId);
      persistence.updateWorkflow(envelope.payload.workflowId, { generation: (workflow.generation ?? 0) + 1 });
      return { ok: true as const, data: orchestrator.recreateWorkflow(envelope.payload.workflowId) };
    }),
    runSerializedForWorkflow: vi.fn(async (_workflowId: string | undefined, fn: () => Promise<any> | any) => ({ ok: true as const, data: await fn() })),
  };
  return {
    orchestrator: orchestrator as any,
    persistence: persistence as any,
    commandService: commandService as any,
    taskExecutor: taskExecutor as any,
    killRunningTask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── 1. Facade dispatch+topup lifecycle parity ───────────────

describe('Parity: facade dispatch+topup lifecycle', () => {
  let deps: WorkflowMutationFacadeDeps;
  let facade: WorkflowMutationFacade;

  beforeEach(() => {
    deps = makeFacadeDeps();
    facade = new WorkflowMutationFacade(deps);
  });

  /**
   * lifecycle: call orchestrator → filter runnable →
   * startExecution (topup) → return { started, runnable, topup }.
   */
  const mutationCases: Array<{
    name: string;
    invoke: (f: WorkflowMutationFacade) => Promise<any>;
    orchestratorMethod: string;
  }> = [
    { name: 'retryTask', invoke: (f) => f.retryTask('task-1'), orchestratorMethod: 'retryTask' },
    { name: 'recreateTask', invoke: (f) => f.recreateTask('task-1'), orchestratorMethod: 'recreateTask' },
    { name: 'editTaskCommand', invoke: (f) => f.editTaskCommand('task-1', 'echo ok'), orchestratorMethod: 'editTaskCommand' },
    { name: 'editTaskPrompt', invoke: (f) => f.editTaskPrompt('task-1', 'do it'), orchestratorMethod: 'editTaskPrompt' },
    { name: 'editTaskAgent', invoke: (f) => f.editTaskAgent('task-1', 'codex'), orchestratorMethod: 'editTaskAgent' },
    { name: 'selectExperiment', invoke: (f) => f.selectExperiment('task-1', 'exp-1'), orchestratorMethod: 'selectExperiment' },
    { name: 'retryWorkflow', invoke: (f) => f.retryWorkflow('wf-1'), orchestratorMethod: 'retryWorkflow' },
    { name: 'recreateWorkflow', invoke: (f) => f.recreateWorkflow('wf-1'), orchestratorMethod: 'recreateWorkflow' },
  ];

  for (const { name, invoke, orchestratorMethod } of mutationCases) {
    it(`${name}: follows dispatch+topup lifecycle and returns MutationResult shape`, async () => {
      const result = await invoke(facade);

      // Correct orchestrator method was called
      expect((deps.orchestrator as any)[orchestratorMethod]).toHaveBeenCalled();

      // Runnable tasks are returned for the durable dispatch outbox.
      expect(result.runnable.length).toBeGreaterThan(0);

      // Global topup invoked (startExecution)
      expect(deps.orchestrator.startExecution).toHaveBeenCalled();

      // Result has the canonical MutationResult shape
      expect(result).toHaveProperty('started');
      expect(result).toHaveProperty('runnable');
      expect(result).toHaveProperty('topup');
      expect(Array.isArray(result.started)).toBe(true);
      expect(Array.isArray(result.runnable)).toBe(true);
      expect(Array.isArray(result.topup)).toBe(true);
    });
  }

  it('all mutations filter non-running tasks from dispatch', async () => {
    // Orchestrator returns a mix of running and pending tasks
    const mixed = [makeTask({ id: 'task-1', status: 'running' }), makePendingTask({ id: 't2' })];
    (deps.orchestrator as any).retryTask.mockReturnValue(mixed);
    facade = new WorkflowMutationFacade(deps);

    const result = await facade.retryTask('task-1');

    // Only the running task should be dispatched
    expect(result.runnable).toHaveLength(1);
    expect(result.runnable[0].id).toBe('task-1');
    expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
  });

  it('topup deduplicates tasks already dispatched in scoped phase', async () => {
    const scoped = makeTask({
      id: 'task-1',
      execution: { selectedAttemptId: 'attempt-1' },
    });
    (deps.orchestrator as any).retryTask.mockReturnValue([scoped]);
    // Global topup returns the same attempt
    (deps.orchestrator as any).startExecution.mockReturnValue([
      makeTask({ id: 'task-1', execution: { selectedAttemptId: 'attempt-1' } }),
    ]);
    facade = new WorkflowMutationFacade(deps);

    const result = await facade.retryTask('task-1');

    // Scoped dispatch happens, but topup should NOT re-dispatch
    expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    expect(result.topup).toHaveLength(0);
  });

  it('topup dispatches genuinely new tasks from global pool', async () => {
    const scoped = makeTask({
      id: 'task-1',
      execution: { selectedAttemptId: 'attempt-1' },
    });
    const topupTask = makeTask({
      id: 'wf-2/task-9',
      config: { workflowId: 'wf-2' },
      execution: { selectedAttemptId: 'attempt-9' },
    });
    (deps.orchestrator as any).retryTask.mockReturnValue([scoped]);
    (deps.orchestrator as any).startExecution.mockReturnValue([topupTask]);
    facade = new WorkflowMutationFacade(deps);

    const result = await facade.retryTask('task-1');

    expect(deps.taskExecutor.executeTasks).not.toHaveBeenCalled();
    expect(result.topup).toHaveLength(1);
    expect(result.topup[0].id).toBe('wf-2/task-9');
  });
});

// ── 2. Cancel mutations: topup-only lifecycle ───────────────

describe('Parity: cancel mutations follow topup-only lifecycle', () => {
  let deps: WorkflowMutationFacadeDeps;
  let facade: WorkflowMutationFacade;

  beforeEach(() => {
    deps = makeFacadeDeps();
    facade = new WorkflowMutationFacade(deps);
  });

  it('cancelTask: kills running tasks, runs topup, returns CancelMutationResult', async () => {
    const result = await facade.cancelTask('task-1');

    expect(deps.orchestrator.cancelTask).toHaveBeenCalledWith('task-1');
    expect(deps.killRunningTask).toHaveBeenCalledWith('task-1');
    expect(deps.orchestrator.startExecution).toHaveBeenCalled();
    expect(result).toHaveProperty('cancelled');
    expect(result).toHaveProperty('runningCancelled');
    expect(result).toHaveProperty('topup');
  });

  it('cancelWorkflow: kills running tasks, runs topup, returns CancelMutationResult', async () => {
    const result = await facade.cancelWorkflow('wf-1');

    expect(deps.orchestrator.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    expect(deps.killRunningTask).toHaveBeenCalledWith('task-1');
    expect(deps.orchestrator.startExecution).toHaveBeenCalled();
    expect(result).toHaveProperty('cancelled');
    expect(result).toHaveProperty('runningCancelled');
    expect(result).toHaveProperty('topup');
  });
});

// ── 3. API → facade wiring parity ──────────────────────────

describe('Parity: API endpoints wire to facade methods', () => {
  let api: ApiServer;
  let port: number;
  let mocks: ReturnType<typeof createApiMocks>;

  function createApiMocks() {
    const m = {
      orchestrator: {
        getWorkflowStatus: vi.fn(() => ({ total: 1, completed: 0, failed: 0, running: 1, pending: 0 })),
        getAllTasks: vi.fn(() => [makeTask()]),
        startExecution: vi.fn(() => []),
        getTask: vi.fn(() => makeTask()),
        approve: vi.fn().mockResolvedValue([]),
        reject: vi.fn(),
        revertFixSession: vi.fn(),
        provideInput: vi.fn(),
        beginFixSession: vi.fn(() => ({ savedError: 'saved-error' })),
        setFixAwaitingApproval: vi.fn(),
        retryTask: vi.fn(() => [makeTask()]),
        recreateTask: vi.fn(() => [makeTask()]),
        recreateDownstream: vi.fn(() => [makeTask()]),
        retryWorkflow: vi.fn(() => [makeTask()]),
        recreateWorkflowFromFreshBase: vi.fn(async () => [makeTask()]),
        cascadeInvalidationToDownstream: vi.fn(() => []),
        editTaskCommand: vi.fn(() => [makeTask()]),
        editTaskPrompt: vi.fn(() => [makeTask()]),
        editTaskAgent: vi.fn(() => [makeTask()]),
        setTaskExternalGatePolicies: vi.fn(() => [makeTask()]),
        cancelTask: vi.fn(() => ({ cancelled: ['task-1'], runningCancelled: ['task-1'] })),
        cancelWorkflow: vi.fn(() => ({ cancelled: ['task-1'], runningCancelled: ['task-1'] })),
        forkWorkflow: vi.fn(() => ({
          sourceWorkflowId: 'wf-1',
          forkedWorkflowId: 'wf-1-fork',
          started: [makeTask({ id: 'wf-1-fork/task-1', config: { workflowId: 'wf-1-fork' } })],
        })),
        deleteWorkflow: vi.fn(),
        detachWorkflow: vi.fn(),
        getQueueStatus: vi.fn(() => ({
          maxConcurrency: 4, runningCount: 1,
          running: [{ taskId: 'task-1', description: 'test' }], queued: [],
        })),
        recreateWorkflow: vi.fn(() => [makeTask()]),
      },
      persistence: {
        listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'test', generation: 1 }]),
        loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 1 })),
        updateWorkflow: vi.fn(),
        loadTasks: vi.fn(() => []),
        getEvents: vi.fn(() => []),
        getTaskOutput: vi.fn(() => 'output'),
      },
      executorRegistry: {},
      taskExecutor: {
        executeTasks: vi.fn().mockResolvedValue(undefined),
        publishAfterFix: vi.fn().mockResolvedValue(undefined),
        resolveConflict: vi.fn().mockResolvedValue(undefined),
        fixWithAgent: vi.fn().mockResolvedValue(undefined),
        commitApprovedFix: vi.fn().mockResolvedValue(undefined),
        killActiveExecution: vi.fn().mockResolvedValue(undefined),
        preparePoolForRebaseRetry: vi.fn().mockResolvedValue(undefined),
      },
      killRunningTask: vi.fn().mockResolvedValue(undefined),
      deleteWorkflow: vi.fn().mockResolvedValue(undefined),
      detachWorkflow: vi.fn().mockResolvedValue(undefined),
    };
    return m;
  }

  beforeAll(async () => {
    mocks = createApiMocks();
    const commandService = {
      retryTask: vi.fn(async (envelope: { payload: { taskId: string } }) => ({ ok: true as const, data: mocks.orchestrator.retryTask(envelope.payload.taskId) })),
      recreateTask: vi.fn(async (envelope: { payload: { taskId: string } }) => ({ ok: true as const, data: mocks.orchestrator.recreateTask(envelope.payload.taskId) })),
      retryWorkflow: vi.fn(async (envelope: { payload: { workflowId: string } }) => ({ ok: true as const, data: mocks.orchestrator.retryWorkflow(envelope.payload.workflowId) })),
      recreateWorkflow: vi.fn(async (envelope: { payload: { workflowId: string } }) => {
        const workflow = mocks.persistence.loadWorkflow(envelope.payload.workflowId);
        mocks.persistence.updateWorkflow(envelope.payload.workflowId, { generation: (workflow.generation ?? 0) + 1 });
        return { ok: true as const, data: mocks.orchestrator.recreateWorkflow(envelope.payload.workflowId) };
      }),
      runSerializedForWorkflow: vi.fn(async (_workflowId: string | undefined, fn: () => Promise<any> | any) => ({ ok: true as const, data: await fn() })),
    };
    const facade = new WorkflowMutationFacade({
      orchestrator: mocks.orchestrator as any,
      persistence: mocks.persistence as any,
      commandService: commandService as any,
      taskExecutor: mocks.taskExecutor as any,
      killRunningTask: mocks.killRunningTask,
    });
    process.env.INVOKER_API_PORT = '0';
    api = startApiServer({
      orchestrator: mocks.orchestrator as any,
      persistence: mocks.persistence as any,
      executorRegistry: mocks.executorRegistry as any,
      mutations: facade,
      deleteWorkflow: mocks.deleteWorkflow,
      detachWorkflow: mocks.detachWorkflow,
    });
    await new Promise<void>((resolve) => {
      if (api.server.listening) resolve();
      else api.server.on('listening', resolve);
    });
    const addr = api.server.address();
    port = typeof addr === 'object' && addr ? addr.port : api.port;
  });

  afterAll(async () => {
    await api.close();
    delete process.env.INVOKER_API_PORT;
  });

  beforeEach(() => {
    for (const group of [mocks.orchestrator, mocks.persistence, mocks.taskExecutor]) {
      for (const fn of Object.values(group)) {
        if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
      }
    }
    mocks.killRunningTask.mockClear();
    mocks.deleteWorkflow.mockClear();
    mocks.detachWorkflow.mockClear();

    // Re-apply default return values
    mocks.orchestrator.retryTask.mockReturnValue([makeTask()]);
    mocks.orchestrator.editTaskCommand.mockReturnValue([makeTask()]);
    mocks.orchestrator.editTaskPrompt.mockReturnValue([makeTask()]);
    mocks.orchestrator.editTaskAgent.mockReturnValue([makeTask()]);
    mocks.orchestrator.setTaskExternalGatePolicies.mockReturnValue([makeTask()]);
    mocks.orchestrator.approve.mockResolvedValue([]);
    mocks.orchestrator.startExecution.mockReturnValue([]);
    mocks.orchestrator.cancelTask.mockReturnValue({ cancelled: ['task-1'], runningCancelled: ['task-1'] });
    mocks.orchestrator.cancelWorkflow.mockReturnValue({ cancelled: ['task-1'], runningCancelled: ['task-1'] });
    mocks.orchestrator.getTask.mockReturnValue(makeTask());
    mocks.orchestrator.recreateWorkflow.mockReturnValue([makeTask()]);
    mocks.persistence.loadWorkflow.mockReturnValue({ id: 'wf-1', generation: 1 });
    mocks.taskExecutor.executeTasks.mockResolvedValue(undefined);
    mocks.killRunningTask.mockResolvedValue(undefined);
    mocks.deleteWorkflow.mockResolvedValue(undefined);
    mocks.detachWorkflow.mockResolvedValue(undefined);
    mocks.orchestrator.forkWorkflow.mockReturnValue({
      sourceWorkflowId: 'wf-1',
      forkedWorkflowId: 'wf-1-fork',
      started: [makeTask({ id: 'wf-1-fork/task-1', config: { workflowId: 'wf-1-fork' } })],
    });
  });

  /**
   * Each API write endpoint must:
   *   1. Route to the correct orchestrator method (via facade)
   *   2. Trigger executeTasks for runnable work
   *   3. Trigger startExecution for global topup
   *   4. Return 200 with { ok: true }
   */
  const apiWriteCases: Array<{
    name: string;
    method: string;
    path: string;
    body?: unknown;
    orchestratorMethod: string;
    expectTopup: boolean;
  }> = [
    { name: 'POST /api/tasks/:id/restart', method: 'POST', path: '/api/tasks/task-1/restart', orchestratorMethod: 'retryTask', expectTopup: true },
    { name: 'POST /api/tasks/:id/edit', method: 'POST', path: '/api/tasks/task-1/edit', body: { command: 'echo ok' }, orchestratorMethod: 'editTaskCommand', expectTopup: true },
    { name: 'POST /api/tasks/:id/edit-prompt', method: 'POST', path: '/api/tasks/task-1/edit-prompt', body: { prompt: 'do it' }, orchestratorMethod: 'editTaskPrompt', expectTopup: true },
    { name: 'POST /api/tasks/:id/edit-agent', method: 'POST', path: '/api/tasks/task-1/edit-agent', body: { agent: 'codex' }, orchestratorMethod: 'editTaskAgent', expectTopup: true },
    { name: 'POST /api/tasks/:id/cancel', method: 'POST', path: '/api/tasks/task-1/cancel', orchestratorMethod: 'cancelTask', expectTopup: true },
    { name: 'POST /api/workflows/:id/cancel', method: 'POST', path: '/api/workflows/wf-1/cancel', orchestratorMethod: 'cancelWorkflow', expectTopup: true },
    { name: 'POST /api/workflows/:id/fork', method: 'POST', path: '/api/workflows/wf-1/fork', orchestratorMethod: 'forkWorkflow', expectTopup: true },
  ];

  for (const { name, method, path, body, orchestratorMethod, expectTopup } of apiWriteCases) {
    it(`${name}: routes through facade to ${orchestratorMethod}, triggers dispatch+topup`, async () => {
      const res = await httpRequest(port, method, path, body);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect((mocks.orchestrator as any)[orchestratorMethod]).toHaveBeenCalled();
      if (expectTopup) {
        expect(mocks.orchestrator.startExecution).toHaveBeenCalled();
      }
    });
  }

  it('POST /api/tasks/:id/approve routes through facade approveTask', async () => {
    const res = await httpRequest(port, 'POST', '/api/tasks/task-1/approve');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mocks.orchestrator.approve).toHaveBeenCalledWith('task-1');
    expect(mocks.orchestrator.startExecution).toHaveBeenCalled();
  });

  it('POST /api/tasks/:id/reject routes through facade rejectTask', async () => {
    const res = await httpRequest(port, 'POST', '/api/tasks/task-1/reject', { reason: 'bad' });
    expect(res.status).toBe(200);
    expect(mocks.orchestrator.reject).toHaveBeenCalledWith('task-1', 'bad');
  });

  it('POST /api/tasks/:id/input routes through facade provideInput', async () => {
    const res = await httpRequest(port, 'POST', '/api/tasks/task-1/input', { text: 'yes' });
    expect(res.status).toBe(200);
    expect(mocks.orchestrator.provideInput).toHaveBeenCalledWith('task-1', 'yes');
  });

  it('POST /api/workflows/:id/restart routes through facade recreateWorkflow', async () => {
    const res = await httpRequest(port, 'POST', '/api/workflows/wf-1/restart');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mocks.persistence.loadWorkflow).toHaveBeenCalledWith('wf-1');
    expect(mocks.persistence.updateWorkflow).toHaveBeenCalled();
    expect(mocks.orchestrator.recreateWorkflow).toHaveBeenCalled();
  });
});

// ── 4. CommandService → orchestrator parity ─────────────────

describe('Parity: CommandService routes to correct orchestrator primitives', () => {
  let orchestrator: Record<string, ReturnType<typeof vi.fn>>;
  let commandService: CommandService;

  beforeEach(() => {
    orchestrator = {
      getTask: vi.fn(() => makeTask()),
      approve: vi.fn(async () => [makeTask()]),
      resumeTaskAfterFixApproval: vi.fn(async () => []),
      reject: vi.fn(),
      revertFixSession: vi.fn(),
      provideInput: vi.fn(),
      retryTask: vi.fn(() => [makeTask()]),
      recreateTask: vi.fn(() => [makeTask()]),
      retryWorkflow: vi.fn(() => [makeTask()]),
      recreateWorkflow: vi.fn(() => [makeTask()]),
      recreateWorkflowFromFreshBase: vi.fn(() => []),
      cancelTask: vi.fn(() => ({ cancelled: ['task-1'], runningCancelled: [] })),
      cancelWorkflow: vi.fn(() => ({ cancelled: ['task-1'], runningCancelled: ['task-1'] })),
      deleteWorkflow: vi.fn(),
      detachWorkflow: vi.fn(),
      editTaskCommand: vi.fn(() => [makeTask()]),
      editTaskPrompt: vi.fn(() => [makeTask()]),
      editTaskAgent: vi.fn(() => [makeTask()]),
      editTaskMergeMode: vi.fn(() => [makeTask()]),
      editTaskFixContext: vi.fn(() => [makeTask()]),
      selectExperiment: vi.fn(() => [makeTask()]),
      setTaskExternalGatePolicies: vi.fn(() => []),
      replaceTask: vi.fn(() => []),
      cascadeInvalidationToDownstream: vi.fn(() => []),
      autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      forkWorkflow: vi.fn(() => ({ started: [] })),
    };
    commandService = new CommandService(orchestrator as any);
  });

  function envelope<T>(payload: T): CommandEnvelope<T> {
    return {
      commandId: 'test-cmd',
      source: 'headless',
      scope: 'task',
      idempotencyKey: 'test-key',
      payload,
    };
  }

  const commandCases: Array<{
    name: string;
    invoke: (cs: CommandService) => Promise<any>;
    orchestratorMethod: string;
    args?: any[];
  }> = [
    { name: 'approve', invoke: (cs) => cs.approve(envelope({ taskId: 'task-1' })), orchestratorMethod: 'approve' },
    { name: 'retryTask', invoke: (cs) => cs.retryTask(envelope({ taskId: 'task-1' })), orchestratorMethod: 'retryTask' },
    { name: 'recreateTask', invoke: (cs) => cs.recreateTask(envelope({ taskId: 'task-1' })), orchestratorMethod: 'recreateTask' },
    { name: 'retryWorkflow', invoke: (cs) => cs.retryWorkflow(envelope({ workflowId: 'wf-1' })), orchestratorMethod: 'retryWorkflow' },
    { name: 'recreateWorkflow', invoke: (cs) => cs.recreateWorkflow(envelope({ workflowId: 'wf-1' })), orchestratorMethod: 'recreateWorkflow' },
    { name: 'recreateWorkflowFromFreshBase', invoke: (cs) => cs.recreateWorkflowFromFreshBase(envelope({ workflowId: 'wf-1' })), orchestratorMethod: 'recreateWorkflowFromFreshBase' },
    { name: 'cancelTask', invoke: (cs) => cs.cancelTask(envelope({ taskId: 'task-1' })), orchestratorMethod: 'cancelTask' },
    { name: 'cancelWorkflow', invoke: (cs) => cs.cancelWorkflow(envelope({ workflowId: 'wf-1' })), orchestratorMethod: 'cancelWorkflow' },
    { name: 'deleteWorkflow', invoke: (cs) => cs.deleteWorkflow(envelope({ workflowId: 'wf-1' })), orchestratorMethod: 'deleteWorkflow' },
    { name: 'detachWorkflow', invoke: (cs) => cs.detachWorkflow(envelope({ workflowId: 'wf-1', upstreamWorkflowId: 'wf-0' })), orchestratorMethod: 'detachWorkflow' },
    { name: 'editTaskCommand', invoke: (cs) => cs.editTaskCommand(envelope({ taskId: 'task-1', newCommand: 'echo ok' })), orchestratorMethod: 'editTaskCommand' },
    { name: 'editTaskPrompt', invoke: (cs) => cs.editTaskPrompt(envelope({ taskId: 'task-1', newPrompt: 'do it' })), orchestratorMethod: 'editTaskPrompt' },
    { name: 'editTaskAgent', invoke: (cs) => cs.editTaskAgent(envelope({ taskId: 'task-1', agentName: 'codex' })), orchestratorMethod: 'editTaskAgent' },
    { name: 'editTaskMergeMode', invoke: (cs) => cs.editTaskMergeMode(envelope({ taskId: 'task-1', mergeMode: 'automatic' as const })), orchestratorMethod: 'editTaskMergeMode' },
    { name: 'selectExperiment', invoke: (cs) => cs.selectExperiment(envelope({ taskId: 'task-1', experimentId: 'exp-1' })), orchestratorMethod: 'selectExperiment' },
    { name: 'setTaskExternalGatePolicies', invoke: (cs) => cs.setTaskExternalGatePolicies(envelope({ taskId: 'task-1', updates: [] })), orchestratorMethod: 'setTaskExternalGatePolicies' },
  ];

  for (const { name, invoke, orchestratorMethod } of commandCases) {
    it(`${name}: routes to orchestrator.${orchestratorMethod} and returns { ok: true }`, async () => {
      const result = await invoke(commandService);

      expect(result.ok).toBe(true);
      expect(orchestrator[orchestratorMethod]).toHaveBeenCalled();
    });
  }

  it('reject routes to orchestrator.reject when no pendingFixError', async () => {
    orchestrator.getTask.mockReturnValue(makeTask({ execution: {} }));
    const result = await commandService.reject(envelope({ taskId: 'task-1', reason: 'bad' }));

    expect(result.ok).toBe(true);
    expect(orchestrator.reject).toHaveBeenCalledWith('task-1', 'bad');
    expect(orchestrator.revertFixSession).not.toHaveBeenCalled();
  });

  it('reject routes to revertFixSession when pendingFixError exists', async () => {
    orchestrator.getTask.mockReturnValue(
      makeTask({ execution: { pendingFixError: 'merge conflict' } }),
    );
    const result = await commandService.reject(envelope({ taskId: 'task-1' }));

    expect(result.ok).toBe(true);
    expect(orchestrator.revertFixSession).toHaveBeenCalledWith('task-1', { savedError: 'merge conflict' });
    expect(orchestrator.reject).not.toHaveBeenCalled();
  });

  it('restartTask (deprecated) delegates to recreateTask', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await commandService.restartTask(envelope({ taskId: 'task-1' }));

    expect(result.ok).toBe(true);
    expect(orchestrator.recreateTask).toHaveBeenCalledWith('task-1');
    expect(orchestrator.retryTask).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('all commands wrap OrchestratorError into { ok: false }', async () => {
    const { OrchestratorError, OrchestratorErrorCode } = await import('@invoker/workflow-core');
    orchestrator.retryTask.mockImplementation(() => {
      throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, 'Task not found');
    });

    const result = await commandService.retryTask(envelope({ taskId: 'missing' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('not found');
    }
  });
});

// ── 5. Cross-surface isolation ──────────────────────────────

describe('Parity: cross-surface mutation isolation', () => {
  let deps: WorkflowMutationFacadeDeps;
  let facade: WorkflowMutationFacade;

  beforeEach(() => {
    deps = makeFacadeDeps();
    // Add extra methods to detect cross-contamination
    (deps.orchestrator as any).recreateTask = vi.fn(() => []);
    (deps.orchestrator as any).recreateWorkflow = vi.fn(() => []);
    (deps.orchestrator as any).recreateWorkflowFromFreshBase = vi.fn(async () => []);
    facade = new WorkflowMutationFacade(deps);
  });

  it('retryTask does not trigger recreateTask or recreateWorkflow', async () => {
    await facade.retryTask('task-1');

    expect(deps.orchestrator.retryTask).toHaveBeenCalled();
    expect((deps.orchestrator as any).recreateTask).not.toHaveBeenCalled();
    expect((deps.orchestrator as any).recreateWorkflow).not.toHaveBeenCalled();
    expect(deps.orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(deps.orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('recreateTask does not trigger retryTask or cancelTask', async () => {
    await facade.recreateTask('task-1');

    expect((deps.orchestrator as any).recreateTask).toHaveBeenCalled();
    expect(deps.orchestrator.retryTask).not.toHaveBeenCalled();
    expect(deps.orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(deps.orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('cancelTask does not trigger retryTask or recreateTask', async () => {
    await facade.cancelTask('task-1');

    expect(deps.orchestrator.cancelTask).toHaveBeenCalled();
    expect(deps.orchestrator.retryTask).not.toHaveBeenCalled();
    expect((deps.orchestrator as any).recreateTask).not.toHaveBeenCalled();
    expect((deps.orchestrator as any).recreateWorkflow).not.toHaveBeenCalled();
  });

  it('forkWorkflow does not trigger retryWorkflow or recreateWorkflow', async () => {
    await facade.forkWorkflow('wf-1');

    expect(deps.orchestrator.forkWorkflow).toHaveBeenCalled();
    expect(deps.orchestrator.retryWorkflow).not.toHaveBeenCalled();
    expect((deps.orchestrator as any).recreateWorkflow).not.toHaveBeenCalled();
    expect(deps.orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('editTaskCommand does not trigger editTaskPrompt or editTaskAgent', async () => {
    await facade.editTaskCommand('task-1', 'echo ok');

    expect(deps.orchestrator.editTaskCommand).toHaveBeenCalled();
    expect(deps.orchestrator.editTaskPrompt).not.toHaveBeenCalled();
    expect(deps.orchestrator.editTaskAgent).not.toHaveBeenCalled();
  });

  it('editTaskPrompt does not trigger editTaskCommand or editTaskAgent', async () => {
    await facade.editTaskPrompt('task-1', 'do it');

    expect(deps.orchestrator.editTaskPrompt).toHaveBeenCalled();
    expect(deps.orchestrator.editTaskCommand).not.toHaveBeenCalled();
    expect(deps.orchestrator.editTaskAgent).not.toHaveBeenCalled();
  });

  it('approveTask does not trigger reject, retry, or cancel', async () => {
    await facade.approveTask('task-1');

    expect(deps.orchestrator.approve).toHaveBeenCalled();
    expect(deps.orchestrator.reject).not.toHaveBeenCalled();
    expect(deps.orchestrator.retryTask).not.toHaveBeenCalled();
    expect((deps.orchestrator as any).recreateTask).not.toHaveBeenCalled();
    expect(deps.orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(deps.orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('rejectTask does not trigger approve, retry, or cancel', () => {
    facade.rejectTask('task-1', 'bad output');

    expect(deps.orchestrator.reject).toHaveBeenCalled();
    expect(deps.orchestrator.approve).not.toHaveBeenCalled();
    expect(deps.orchestrator.retryTask).not.toHaveBeenCalled();
    expect((deps.orchestrator as any).recreateTask).not.toHaveBeenCalled();
    expect(deps.orchestrator.cancelTask).not.toHaveBeenCalled();
  });
});

// ── 6. CommandService mutex serialization ───────────────────

describe('Parity: CommandService serializes concurrent mutations', () => {
  function testEnvelope<T>(payload: T): CommandEnvelope<T> {
    return {
      commandId: 'test-cmd',
      source: 'headless',
      scope: 'task',
      idempotencyKey: `key-${Math.random()}`,
      payload,
    };
  }

  it('serializes two mutations on the same workflow sequentially', async () => {
    const callOrder: string[] = [];
    const orchestrator = {
      getTask: vi.fn(() => makeTask()),
      retryTask: vi.fn(async () => {
        callOrder.push('retry-start');
        await new Promise((r) => setTimeout(r, 50));
        callOrder.push('retry-end');
        return [makeTask()];
      }),
      editTaskCommand: vi.fn(async () => {
        callOrder.push('edit-start');
        callOrder.push('edit-end');
        return [makeTask()];
      }),
      cancelTask: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      cascadeInvalidationToDownstream: vi.fn(() => []),
    };
    const cs = new CommandService(orchestrator as any);

    const [r1, r2] = await Promise.all([
      cs.retryTask(testEnvelope({ taskId: 'task-1' })),
      cs.editTaskCommand(testEnvelope({ taskId: 'task-1', newCommand: 'echo' })),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // The second mutation should start AFTER the first finishes
    expect(callOrder.indexOf('retry-end')).toBeLessThan(callOrder.indexOf('edit-start'));
  });

  it('allows mutations on different workflows to interleave', async () => {
    const callOrder: string[] = [];
    const orchestrator = {
      getTask: vi.fn((id: string) =>
        makeTask({ id, config: { workflowId: id.split('/')[0] || 'wf-unknown' } }),
      ),
      retryTask: vi.fn(async (taskId: string) => {
        const wf = taskId.split('/')[0];
        callOrder.push(`${wf}-retry-start`);
        await new Promise((r) => setTimeout(r, 50));
        callOrder.push(`${wf}-retry-end`);
        return [makeTask({ id: taskId, config: { workflowId: wf } })];
      }),
      cancelTask: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      cascadeInvalidationToDownstream: vi.fn(() => []),
    };
    const cs = new CommandService(orchestrator as any);

    await Promise.all([
      cs.retryTask(testEnvelope({ taskId: 'wf-1/task-1' })),
      cs.retryTask(testEnvelope({ taskId: 'wf-2/task-1' })),
    ]);

    // Both should start before either finishes (parallel execution)
    const wf1Start = callOrder.indexOf('wf-1-retry-start');
    const wf2Start = callOrder.indexOf('wf-2-retry-start');
    const wf1End = callOrder.indexOf('wf-1-retry-end');
    const wf2End = callOrder.indexOf('wf-2-retry-end');

    // Both start indices should exist before both end indices
    expect(Math.max(wf1Start, wf2Start)).toBeLessThan(Math.min(wf1End, wf2End));
  });
});

// ── 7. deleteWorkflow + detachWorkflow surface parity ───────

describe('Parity: deleteWorkflow kills active tasks before delete', () => {
  it('facade deleteWorkflow kills running tasks then calls orchestrator.deleteWorkflow', async () => {
    const killFn = vi.fn();
    const deps = makeFacadeDeps({
      killRunningTask: killFn,
      orchestrator: {
        ...makeFacadeDeps().orchestrator,
        getAllTasks: vi.fn(() => [
          makeTask({ id: 'task-a', config: { workflowId: 'wf-1' } }),
          makeTask({ id: 'task-b', status: 'completed', config: { workflowId: 'wf-1' } }),
          makeTask({ id: 'task-c', status: 'fixing_with_ai', config: { workflowId: 'wf-1' } }),
        ]),
        deleteWorkflow: vi.fn(),
      } as any,
    });
    const facade = new WorkflowMutationFacade(deps);

    await facade.deleteWorkflow('wf-1');

    // Kills running and fixing_with_ai, not completed
    expect(killFn).toHaveBeenCalledWith('task-a');
    expect(killFn).toHaveBeenCalledWith('task-c');
    expect(killFn).not.toHaveBeenCalledWith('task-b');
    expect(deps.orchestrator.deleteWorkflow).toHaveBeenCalledWith('wf-1');
  });
});

describe('Parity: detachWorkflow passes through to orchestrator', () => {
  it('facade detachWorkflow calls orchestrator.detachWorkflow with both ids', async () => {
    const deps = makeFacadeDeps();
    const facade = new WorkflowMutationFacade(deps);

    await facade.detachWorkflow('wf-child', 'wf-parent');

    expect(deps.orchestrator.detachWorkflow).toHaveBeenCalledWith('wf-child', 'wf-parent');
  });
});
