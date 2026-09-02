import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import {
  buildWorkflowInvalidationDeps,
  CommandService,
  Orchestrator,
} from '@invoker/workflow-core';
import { InMemoryBus, InMemoryPersistence } from '@invoker/test-kit';
import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless.js';
import {
  registerGuiMutationIpcHandlers,
  type GuiMutationTaskActions,
  type RegisterGuiMutationIpcHandlersContext,
} from '../ipc/gui-mutation-handlers.js';
import { createRendererUiPerfCounters } from '../renderer-ui-perf.js';

type Fixture = ReturnType<typeof createGatedWorkflowFixture>;

function createGatedWorkflowFixture() {
  const persistence = new InMemoryPersistence();
  const messageBus = new InMemoryBus();
  const orchestrator = new Orchestrator({
    persistence,
    messageBus,
    maxConcurrency: 8,
    resolveRepoDefaultBranch: () => 'main',
  } as never);

  orchestrator.loadPlan({
    name: 'upstream',
    repoUrl: 'memory://restart-gate-test',
    baseBranch: 'main',
    featureBranch: 'feature/upstream',
    tasks: [{ id: 'upstream-task', description: 'upstream task' }],
  });
  const upstreamTask = orchestrator.getAllTasks().find((task) => task.id.endsWith('/upstream-task'))!;
  const upstreamWorkflowId = upstreamTask.config.workflowId!;

  orchestrator.loadPlan({
    name: 'downstream',
    repoUrl: 'memory://restart-gate-test',
    baseBranch: 'feature/upstream',
    featureBranch: 'feature/downstream',
    externalDependencies: [{
      workflowId: upstreamWorkflowId,
      taskId: '__merge__',
      requiredStatus: 'completed',
      gatePolicy: 'completed',
    }],
    tasks: [{ id: 'downstream-task', description: 'gated downstream task' }],
  });
  const downstreamTask = orchestrator.getAllTasks().find((task) => task.id.endsWith('/downstream-task'))!;
  const downstreamWorkflowId = downstreamTask.config.workflowId!;
  const killActiveExecution = vi.fn(async () => undefined);
  const invalidationDeps = buildWorkflowInvalidationDeps({
    orchestrator,
    requireWorkflow: (workflowId) => {
      const workflow = persistence.loadWorkflow(workflowId);
      if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
      return workflow;
    },
    killActiveExecution,
  });
  const commandService = new CommandService(orchestrator, invalidationDeps);

  orchestrator.startExecution();
  expect(orchestrator.getTask(upstreamTask.id)?.status).toBe('running');
  expect(orchestrator.getTask(downstreamTask.id)?.status).toBe('pending');

  return {
    persistence,
    messageBus,
    orchestrator,
    commandService,
    killActiveExecution,
    upstreamTaskId: upstreamTask.id,
    upstreamWorkflowId,
    downstreamTaskId: downstreamTask.id,
    downstreamWorkflowId,
  };
}

function expectDownstreamPendingAndAttached(fixture: Fixture): void {
  expect(fixture.orchestrator.getTask(fixture.downstreamTaskId)?.status).toBe('pending');
  expect(
    fixture.persistence.loadWorkflow(fixture.downstreamWorkflowId)?.externalDependencies,
  ).toContainEqual({
    workflowId: fixture.upstreamWorkflowId,
    taskId: '__merge__',
    requiredStatus: 'completed',
    gatePolicy: 'completed',
  });
}

function createLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
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

async function runDirectGuiRecreate(fixture: Fixture): Promise<void> {
  Object.assign(fixture.persistence, {
    listInAppPlanningSessions: vi.fn(() => []),
  });
  const logger = createLogger();
  const workflowMutationDispatcher = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const taskRunner = makeProxy({
    executeTasks: vi.fn(async () => undefined),
    killActiveExecution: fixture.killActiveExecution,
  });
  const rendererTaskFeed = makeProxy({
    listKnownTaskIds: vi.fn(() => []),
    clearTaskSnapshots: vi.fn(),
    replaceWorkflowRollups: vi.fn(),
  });
  const actions = makeProxy<GuiMutationTaskActions>({
    submitWorkflowMutation: vi.fn(),
    workflowIdForTaskArg: vi.fn((taskId: unknown) => fixture.orchestrator.getTask(String(taskId))?.config.workflowId),
    workflowIdForTargetArg: vi.fn(() => fixture.upstreamWorkflowId),
    workflowIdForRepairWorkflowPayload: vi.fn(),
    performCancelTask: vi.fn(),
    performDeleteTask: vi.fn(),
    performCancelWorkflow: vi.fn(),
    preemptTaskSubgraph: vi.fn(),
    preemptWorkflowExecution: vi.fn(async (workflowId: string) => {
      const result = await fixture.commandService.cancelWorkflow({
        commandId: `outer-preempt-${workflowId}`,
        source: 'ui',
        scope: 'workflow',
        idempotencyKey: `outer-preempt-${workflowId}`,
        payload: { workflowId },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    }),
  });
  const ipcMain = {
    handle: vi.fn(),
    on: vi.fn(),
  } as unknown as IpcMain;
  const context = {
    ipcMain,
    app: { getVersion: () => 'test', isPackaged: false },
    logger,
    persistence: fixture.persistence,
    messageBus: fixture.messageBus,
    executorRegistry: { get: vi.fn(() => ({ getRepoPool: vi.fn(() => null) })) },
    agentRegistry: {},
    repoRoot: '/repo',
    invokerConfig: {},
    effectiveMaxConcurrency: 8,
    taskHandles: new Map(),
    getOrchestrator: () => fixture.orchestrator,
    setOrchestrator: vi.fn(),
    getCommandService: () => fixture.commandService,
    setCommandService: vi.fn(),
    getWorkflowMutationCoordinator: () => null,
    workflowMutationDispatcher,
    getActiveMutationContext: () => undefined,
    getRendererTaskFeed: () => rendererTaskFeed,
    getStartupWorkflowId: () => null,
    getLaunchDispatcher: () => null,
    requireTaskExecutor: () => taskRunner,
    getTaskExecutor: () => taskRunner,
    rebuildTaskRunner: vi.fn(),
    initServices: vi.fn(async () => undefined),
    requestWorkflowMetadataPublish: vi.fn(),
    cancelDeferredWorkflowLaunch: vi.fn(),
    killRunningTask: fixture.killActiveExecution,
    buildCommandServiceInvalidationDeps: vi.fn(),
    getMainWindow: () => null,
    getOwnerMode: () => true,
    getWorkerRuntimeController: () => null,
    registrars: {
      registerGuiMutationHandler: vi.fn(),
      registerWorkflowScopedGuiMutationHandler: vi.fn(
        (channel: string, _resolveWorkflowId: unknown, _priority: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
          workflowMutationDispatcher.set(channel, handler);
        },
      ),
    },
    actions,
    planningChatSessions: makeProxy({}),
    planningCommandBuilder: makeProxy({}),
    emitPlanningChatStream: vi.fn(),
    taskGraphEventPublisher: makeProxy({}),
    loadTaskByIdFromPersistence: vi.fn(),
    markDaemonOwnerUnavailable: vi.fn(),
    recordStartupDuration: vi.fn(),
    getTaskDeltaStreamSequence: () => 0,
    computeRuntimeStatus: vi.fn(() => ({})),
    getUiPerfStats: vi.fn(() => ({})),
    uiPerfStats: createRendererUiPerfCounters(),
    createRegisteredWorkerRegistry: vi.fn(() => makeProxy({})),
    buildCliInstallerContext: vi.fn(() => ({})),
    resolveSetupCliPath: vi.fn(() => '/tmp/invoker'),
    getBundledSkillsStatus: vi.fn(),
    installPackagedSkills: vi.fn(),
  } as unknown as RegisterGuiMutationIpcHandlersContext;

  await registerGuiMutationIpcHandlers(context);
  const recreate = workflowMutationDispatcher.get('invoker:recreate-workflow');
  expect(recreate).toBeDefined();
  await recreate!(fixture.upstreamWorkflowId);
}

async function runDelegatedHeadlessRecreate(fixture: Fixture): Promise<void> {
  const taskRunner = makeProxy({
    executeTasks: vi.fn(async () => undefined),
    killActiveExecution: fixture.killActiveExecution,
  });
  const preemptWorkflowExecution = vi.fn(async (workflowId: string) => {
    const result = await fixture.commandService.cancelWorkflow({
      commandId: `delegated-preempt-${workflowId}`,
      source: 'headless',
      scope: 'workflow',
      idempotencyKey: `delegated-preempt-${workflowId}`,
      payload: { workflowId },
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  });

  await runHeadless(['recreate', fixture.upstreamWorkflowId], {
    logger: createLogger(),
    orchestrator: fixture.orchestrator,
    persistence: fixture.persistence,
    commandService: fixture.commandService,
    executorRegistry: {} as never,
    messageBus: fixture.messageBus,
    repoRoot: '/repo',
    invokerConfig: {},
    initServices: vi.fn(async () => undefined),
    noTrack: true,
    preemptWorkflowExecution,
    ownerTaskRunnerProvider: () => taskRunner,
  } as unknown as HeadlessDeps);
}

describe('restart-class workflow mutations preserve downstream gates', () => {
  it('keeps a downstream workflow pending and attached through direct GUI recreate', async () => {
    const fixture = createGatedWorkflowFixture();

    await runDirectGuiRecreate(fixture);

    expectDownstreamPendingAndAttached(fixture);
    expect(fixture.killActiveExecution).toHaveBeenCalledWith(fixture.upstreamTaskId);
  });

  it('keeps a downstream workflow pending and attached through delegated headless recreate', async () => {
    const fixture = createGatedWorkflowFixture();

    await runDelegatedHeadlessRecreate(fixture);

    expectDownstreamPendingAndAttached(fixture);
    expect(fixture.killActiveExecution).toHaveBeenCalledWith(fixture.upstreamTaskId);
  });

  it.fails('cancels dependents for explicit Cancel Workflow without detaching their gate', async () => {
    const fixture = createGatedWorkflowFixture();

    const result = await fixture.commandService.cancelWorkflow({
      commandId: 'explicit-cancel',
      source: 'ui',
      scope: 'workflow',
      idempotencyKey: 'explicit-cancel',
      payload: { workflowId: fixture.upstreamWorkflowId },
    });

    expect(result.ok).toBe(true);
    expect(fixture.orchestrator.getTask(fixture.downstreamTaskId)?.status).toBe('failed');
    expect(
      fixture.persistence.loadWorkflow(fixture.downstreamWorkflowId)?.externalDependencies,
    ).toContainEqual({
      workflowId: fixture.upstreamWorkflowId,
      taskId: '__merge__',
      requiredStatus: 'completed',
      gatePolicy: 'completed',
    });
  });
});
