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

const REGISTERED_SET_SUBCOMMAND_NAMES = HEADLESS_SET_SUBCOMMANDS.map((definition) => definition.name);

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
    for (const { name, scope } of HEADLESS_SET_SUBCOMMANDS) {
      const target = scope === 'workflow' ? 'wf-1' : 'wf-1/task-1';
      const { workflowId } = actions.classifyHeadlessExecMutation({
        args: ['set', name, target, 'value'],
        noTrack: true,
      });
      if (workflowId !== 'wf-1') unresolved.push(name);
    }
    expect(unresolved).toEqual([]);
  });

  it.each([
    ['invoker:edit-task-command', ['wf-1/task-1', 'pnpm test']],
    ['invoker:edit-task-prompt', ['wf-1/task-1', 'do the thing']],
    ['invoker:edit-task-type', ['wf-1/task-1', 'docker']],
    ['invoker:edit-task-agent', ['wf-1/task-1', 'codex']],
    ['invoker:edit-task-model', ['wf-1/task-1', 'claude-sonnet-5']],
    ['invoker:set-task-external-gate-policies', ['wf-1/task-1', [{ workflowId: 'wf-0', gatePolicy: 'completed' }]]],
  ])('%s translates to a registered set sub-command that classifies to its workflow', (channel, args) => {
    const actions = createGuiMutationTaskActions(makeContext());
    const translated = actions.translateGuiMutationToHeadless({ channel, args } as never) as {
      channel: string;
      request: { args: string[]; noTrack: true };
    } | null;
    expect(translated?.channel).toBe('headless.exec');
    const [command, subCommand] = translated!.request.args;
    expect(command).toBe('set');
    expect(REGISTERED_SET_SUBCOMMAND_NAMES).toContain(subCommand);
    expect(actions.classifyHeadlessExecMutation(translated!.request).workflowId).toBe('wf-1');
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
    expect(REGISTERED_SET_SUBCOMMAND_NAMES).toContain('model');
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

describe('coordinator task scoping for set sub-commands', () => {
  it('scopes every task-scoped registry entry to its task id', async () => {
    const { PersistedWorkflowMutationCoordinator } = await import('../persisted-workflow-mutation-coordinator.js');
    const targetArg = (PersistedWorkflowMutationCoordinator.prototype as unknown as {
      headlessTaskTargetArg: (rawArgs: unknown[]) => unknown;
    }).headlessTaskTargetArg;
    expect(typeof targetArg).toBe('function');
    const wrong: string[] = [];
    for (const { name, scope } of HEADLESS_SET_SUBCOMMANDS) {
      const scoped = targetArg.call(null, ['set', name, 'wf-1/task-1', 'value']);
      const expected = scope === 'task' ? 'wf-1/task-1' : undefined;
      if (scoped !== expected) wrong.push(`${name}=${String(scoped)}`);
    }
    expect(wrong).toEqual([]);
  });
});
