import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import {
  registerGuiMutationIpcHandlers,
  type RegisterGuiMutationIpcHandlersContext,
} from '../ipc/gui-mutation-handlers.js';
import { createRendererUiPerfCounters } from '../renderer-ui-perf.js';

type HandleHandler = (_event: unknown, ...args: unknown[]) => Promise<unknown>;
type OnHandler = (event: { returnValue?: unknown }) => void;

type TestTask = {
  id: string;
  description: string;
  status: string;
  dependencies: unknown[];
  createdAt: Date;
  config: Record<string, unknown>;
  execution: Record<string, unknown>;
};

type TestWorkflow = {
  id: string;
  name: string;
  status: string;
};


function createFakeIpcMain() {
  const handleHandlers = new Map<string, HandleHandler>();
  const onHandlers = new Map<string, OnHandler>();
  const ipcMain = {
    handle: (channel: string, handler: HandleHandler) => {
      handleHandlers.set(channel, handler);
    },
    on: (channel: string, handler: OnHandler) => {
      onHandlers.set(channel, handler);
    },
  } as unknown as IpcMain;
  return { ipcMain, handleHandlers, onHandlers };
}

function makeTask(id: string): TestTask {
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

function makeProxy<T extends object>(overrides: Partial<T> = {}): T {
  const target = { ...overrides } as Record<PropertyKey, unknown>;
  return new Proxy(target as T, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      const fn = vi.fn();
      obj[prop] = fn;
      return fn;
    },
  });
}

function makeContext(
  overrides: {
    ownerMode?: boolean;
    tasks?: TestTask[];
    workflows?: TestWorkflow[];
    request?: HandleHandler;
  } = {},
) {
  const { ipcMain, handleHandlers } = createFakeIpcMain();
  const tasks = overrides.tasks ?? [makeTask('wf-1/task-1')];
  const workflows = overrides.workflows ?? [{ id: 'wf-1', name: 'Workflow 1', status: 'running' }];
  const ownerMode = overrides.ownerMode ?? true;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const persistence = makeProxy({
    listWorkflows: vi.fn(() => workflows),
    writeActivityLog: vi.fn(),
    loadWorkflow: vi.fn(() => undefined),
    loadTasks: vi.fn(() => []),
    getActivityLogs: vi.fn(() => []),
    listInAppPlanningSessions: vi.fn(() => []),
  });
  const orchestrator = makeProxy({
    syncAllFromDb: vi.fn(),
    getAllTasks: vi.fn(() => tasks),
  });
  const messageBus = makeProxy({
    request:
      overrides.request ??
      vi.fn(async () => {
        throw new Error('delegation unavailable');
      }),
    subscribe: vi.fn(),
    publish: vi.fn(),
  });
  const taskGraphEventPublisher = {
    publishSnapshot: vi.fn(),
    publishDelta: vi.fn(),
  };
  const recordStartupDuration = vi.fn();
  const actions = {
    submitWorkflowMutation: vi.fn(),
    workflowIdForTaskArg: vi.fn(),
    workflowIdForTargetArg: vi.fn(),
    performDeleteTask: vi.fn(),
    performCancelTask: vi.fn(),
    performCancelWorkflow: vi.fn(),
    preemptTaskSubgraph: vi.fn(),
    preemptWorkflowExecution: vi.fn(),
    performDeleteWorkflow: vi.fn(),
    performDetachWorkflow: vi.fn(),
    performSharedApproveTask: vi.fn(),
    executeFixWithAgentMutation: vi.fn(),
    executeSpawnRepairWorkflowMutation: vi.fn(),
    workflowIdForRepairWorkflowPayload: vi.fn(),
    refreshRuntime: vi.fn(),
  };
  const rendererTaskFeed = makeProxy({
    listKnownTaskIds: vi.fn(() => []),
    clearTaskSnapshots: vi.fn(),
    replaceWorkflowRollups: vi.fn(),
    upsertTaskSnapshot: vi.fn(),
    deleteTaskSnapshot: vi.fn(),
    resetSnapshotState: vi.fn(),
  });

  const context = {
    ipcMain,
    app: { getVersion: () => '1.0.0', isPackaged: false },
    logger,
    persistence,
    messageBus,
    executorRegistry: {
      get: vi.fn(() => ({ getRepoPool: vi.fn(() => null) })),
    },
    agentRegistry: {},
    repoRoot: '/repo',
    invokerConfig: {},
    effectiveMaxConcurrency: 1,
    taskHandles: new Map(),
    getOrchestrator: () => orchestrator,
    setOrchestrator: vi.fn(),
    getCommandService: () => makeProxy({}),
    setCommandService: vi.fn(),
    getWorkflowMutationCoordinator: () => null,
    workflowMutationDispatcher: new Map(),
    getActiveMutationContext: () => undefined,
    getRendererTaskFeed: () => rendererTaskFeed,
    getStartupWorkflowId: () => null,
    getLaunchDispatcher: () => null,
    requireTaskExecutor: vi.fn(() => makeProxy({})),
    getTaskExecutor: () => null,
    rebuildTaskRunner: vi.fn(),
    initServices: vi.fn(async () => undefined),
    requestWorkflowMetadataPublish: vi.fn(),
    cancelDeferredWorkflowLaunch: vi.fn(),
    killRunningTask: vi.fn(async () => undefined),
    buildCommandServiceInvalidationDeps: vi.fn(() => ({})),
    getMainWindow: () => null,
    getOwnerMode: () => ownerMode,
    getWorkerRuntimeController: () => null,
    registrars: {
      registerGuiMutationHandler: vi.fn(),
      registerWorkflowScopedGuiMutationHandler: vi.fn(),
    },
    actions,
    planningChatSessions: makeProxy({}),
    planningCommandBuilder: makeProxy({}),
    emitPlanningChatStream: vi.fn(),
    taskGraphEventPublisher,
    loadTaskByIdFromPersistence: vi.fn(() => undefined),
    markDaemonOwnerUnavailable: vi.fn(),
    recordStartupDuration,
    getTaskDeltaStreamSequence: () => 17,
    computeRuntimeStatus: vi.fn(() => ({})),
    getUiPerfStats: vi.fn(() => ({})),
    uiPerfStats: createRendererUiPerfCounters(),
    createRegisteredWorkerRegistry: vi.fn(() => makeProxy({})),
    buildCliInstallerContext: vi.fn(() => ({})),
    resolveSetupCliPath: vi.fn(() => '/tmp/setup-cli'),
    getBundledSkillsStatus: vi.fn(() => undefined),
    installPackagedSkills: vi.fn(),
  } as unknown as RegisterGuiMutationIpcHandlersContext;

  return {
    context,
    handleHandlers,
    logger,
    persistence,
    messageBus,
    taskGraphEventPublisher,
    recordStartupDuration,
  };
}

describe('registerGuiMutationIpcHandlers refresh-task-graph', () => {
  it('publishes a forced owner snapshot for the desktop refresh handler', async () => {
    const { context, handleHandlers, taskGraphEventPublisher, recordStartupDuration } = makeContext({
      ownerMode: true,
    });

    await registerGuiMutationIpcHandlers(context);

    await expect(handleHandlers.get('invoker:refresh-task-graph')?.({})).resolves.toBeUndefined();
    expect(taskGraphEventPublisher.publishSnapshot).toHaveBeenCalledWith(
      'refresh-task-graph',
      [makeTask('wf-1/task-1')],
      [{ id: 'wf-1', name: 'Workflow 1', status: 'running' }],
      undefined,
      true,
    );
    expect(recordStartupDuration).toHaveBeenCalledWith('refresh-task-graph.return', expect.any(Number), {
      taskCount: 1,
      workflowCount: 1,
      streamSequence: 17,
    });
  });

  it('publishes a forced delegated refresh snapshot after delegation fallback', async () => {
    const localTask = makeTask('wf-2/task-1');
    const localWorkflow = { id: 'wf-2', name: 'Workflow 2', status: 'failed' };
    const { context, handleHandlers, logger, messageBus, taskGraphEventPublisher } = makeContext({
      ownerMode: false,
      tasks: [localTask],
      workflows: [localWorkflow],
    });

    await registerGuiMutationIpcHandlers(context);

    await expect(handleHandlers.get('invoker:refresh-task-graph')?.({})).resolves.toBeUndefined();
    expect(messageBus.request).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(taskGraphEventPublisher.publishSnapshot).toHaveBeenCalledWith(
      'refresh-task-graph-delegated',
      [localTask],
      [localWorkflow],
      undefined,
      true,
    );
  });
});

describe('registerGuiMutationIpcHandlers report-ui-perf', () => {
  it('mirrors stale snapshot ignores to the main ui-state logger', async () => {
    const { context, handleHandlers, logger, persistence } = makeContext();

    await registerGuiMutationIpcHandlers(context);
    handleHandlers.get('invoker:report-ui-perf')?.({}, 'ui_task_graph_stale_snapshot_ignored', {
      current: 10,
      snapshot: 5,
      reason: 'refresh-task-graph',
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('ui_task_graph_stale_snapshot_ignored'),
      { module: 'ui-state' },
    );
    expect(persistence.writeActivityLog).toHaveBeenCalledWith(
      'ui-perf',
      'info',
      expect.stringContaining('"metric":"ui_task_graph_stale_snapshot_ignored"'),
    );
  });
});
