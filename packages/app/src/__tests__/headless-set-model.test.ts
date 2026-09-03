import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandService, Orchestrator } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import { LocalBus } from '@invoker/transport';
import { runHeadless, type HeadlessDeps } from '../headless.js';
import { HEADLESS_SET_SUBCOMMANDS } from '../headless-command-registry.js';
import {
  acknowledgeNoTrackHeadlessExec,
  createGuiMutationTaskActions,
  type GuiMutationTaskActionsContext,
} from '../ipc/gui-mutation-handlers.js';

function makeLogger() {
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() };
  (logger.child as ReturnType<typeof vi.fn>).mockReturnValue(logger);
  return logger;
}

function makeContext(): GuiMutationTaskActionsContext {
  const logger = makeLogger();
  const persistence = {
    loadWorkflow: vi.fn(() => undefined),
    listWorkflows: vi.fn(() => []),
    loadTasks: vi.fn(() => []),
  };
  return {
    logger,
    persistence,
    messageBus: {},
    executorRegistry: {},
    agentRegistry: {},
    repoRoot: '/fake/repo',
    invokerConfig: {},
    effectiveMaxConcurrency: 1,
    taskHandles: new Map(),
    getOrchestrator: () => ({}) as never,
    setOrchestrator: vi.fn(),
    getCommandService: () => ({}) as never,
    setCommandService: vi.fn(),
    getWorkflowMutationCoordinator: () => null,
    workflowMutationDispatcher: new Map(),
    getActiveMutationContext: () => undefined,
    getRendererTaskFeed: () => ({}) as never,
    getStartupWorkflowId: () => null,
    getLaunchDispatcher: () => null,
    requireTaskExecutor: () => ({}) as never,
    getTaskExecutor: () => null,
    rebuildTaskRunner: vi.fn(),
    initServices: vi.fn(async () => {}),
    requestWorkflowMetadataPublish: vi.fn(),
    cancelDeferredWorkflowLaunch: vi.fn(),
    killRunningTask: vi.fn(async () => {}),
    buildCommandServiceInvalidationDeps: () => ({}) as never,
  } as unknown as GuiMutationTaskActionsContext;
}

const WORKFLOW_SCOPED_SET_SUBCOMMANDS = new Set(['workflow', 'merge-mode']);

describe('delegated edit-task-model (set model) classification', () => {
  it('resolves the task workflow for the translated invoker:edit-task-model payload', () => {
    const actions = createGuiMutationTaskActions(makeContext());
    const translated = actions.translateGuiMutationToHeadless({
      channel: 'invoker:edit-task-model',
      args: ['wf-1/task-1', 'claude-sonnet-5'],
    } as never);
    expect(translated).toEqual({
      channel: 'headless.exec',
      request: { args: ['set', 'model', 'wf-1/task-1', 'claude-sonnet-5'], noTrack: true },
    });

    const classified = actions.classifyHeadlessExecMutation(
      (translated as { request: { args: string[]; noTrack: true } }).request,
    );
    expect(classified).toEqual({ workflowId: 'wf-1', priority: 'high' });
  });

  it('queues the no-track set model mutation instead of rejecting it as workflow-not-resolved', () => {
    const actions = createGuiMutationTaskActions(makeContext());
    const payload = { args: ['set', 'model', 'wf-1/task-1', 'claude-sonnet-5'], noTrack: true as const };
    const { workflowId, priority } = actions.classifyHeadlessExecMutation(payload);
    const submit = vi.fn(() => ({ intentId: 'intent-1', accepted: true }));

    const result = acknowledgeNoTrackHeadlessExec(payload, workflowId, priority, 'gui', {
      ownerId: 'owner-1',
      getWorkflowMutationCoordinator: () => ({ submit }) as never,
      workflowExists: () => true,
      logger: makeLogger() as never,
    });

    expect(result).toBeDefined();
    expect(submit).toHaveBeenCalledWith('wf-1', 'high', 'headless.exec', [payload], expect.anything());
  });

  it('classifies every registered set subcommand to a workflow so no-track delegation can queue it', () => {
    const actions = createGuiMutationTaskActions(makeContext());
    const unresolved: string[] = [];
    for (const subCommand of HEADLESS_SET_SUBCOMMANDS) {
      const target = WORKFLOW_SCOPED_SET_SUBCOMMANDS.has(subCommand) ? 'wf-1' : 'wf-1/task-1';
      const { workflowId } = actions.classifyHeadlessExecMutation({
        args: ['set', subCommand, target, 'value'],
        noTrack: true,
      });
      if (workflowId !== 'wf-1') unresolved.push(subCommand);
    }
    expect(unresolved).toEqual([]);
  });
});

describe('headless set model', () => {
  let deps: HeadlessDeps;

  beforeEach(() => {
    const logger = makeLogger();
    deps = {
      logger: logger as never,
      orchestrator: { syncFromDb: vi.fn() } as unknown as Orchestrator,
      persistence: {
        readOnly: false,
        listWorkflows: vi.fn(() => [{
          id: 'wf-1',
          name: 'test-workflow',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]),
        loadTasks: vi.fn(() => [{
          id: 'wf-1/task-1',
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: {},
        }]),
      } as unknown as SQLiteAdapter,
      commandService: {
        editTaskModel: vi.fn(async () => ({ ok: true as const, data: [] })),
      } as unknown as CommandService,
      executorRegistry: {} as never,
      messageBus: new LocalBus() as MessageBus,
      repoRoot: '/fake/repo',
      invokerConfig: {} as never,
      initServices: vi.fn(async () => {}),
      noTrack: true,
    };
  });

  it('registers model as a set subcommand', () => {
    expect(HEADLESS_SET_SUBCOMMANDS).toContain('model');
  });

  it('routes set model <taskId> <model> through commandService.editTaskModel', async () => {
    await runHeadless(['set', 'model', 'wf-1/task-1', 'claude-sonnet-5'], deps);

    expect(deps.commandService.editTaskModel).toHaveBeenCalledTimes(1);
    const envelope = vi.mocked(deps.commandService.editTaskModel).mock.calls[0]?.[0] as {
      payload: { taskId: string; executionModel: string | null };
    };
    expect(envelope.payload).toEqual({ taskId: 'wf-1/task-1', executionModel: 'claude-sonnet-5' });
  });

  it('clears the model when the value is empty, matching the GUI reset payload', async () => {
    await runHeadless(['set', 'model', 'wf-1/task-1', ''], deps);

    const envelope = vi.mocked(deps.commandService.editTaskModel).mock.calls[0]?.[0] as {
      payload: { taskId: string; executionModel: string | null };
    };
    expect(envelope.payload).toEqual({ taskId: 'wf-1/task-1', executionModel: null });
  });

  it('rejects a missing task id', async () => {
    await expect(runHeadless(['set', 'model'], deps)).rejects.toThrow('Usage: --headless set model');
  });
});
