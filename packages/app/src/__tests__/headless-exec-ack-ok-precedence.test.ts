import { describe, expect, it, vi } from 'vitest';

vi.mock('../headless.js', () => ({
  runHeadless: vi.fn(),
  resolveAgentSession: vi.fn(),
}));

import { runHeadless } from '../headless.js';
import { createGuiMutationTaskActions, type GuiMutationTaskActionsContext } from '../ipc/gui-mutation-handlers.js';

function makeContext(): GuiMutationTaskActionsContext {
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() };
  (logger.child as ReturnType<typeof vi.fn>).mockReturnValue(logger);
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

describe('executeHeadlessExec no-workflow acknowledgment', () => {
  it('keeps ok: true after merging a runner result that reports ok: false', async () => {
    vi.mocked(runHeadless).mockResolvedValue({ ok: false, error: 'boom' });
    const actions = createGuiMutationTaskActions(makeContext());

    const result = await actions.executeHeadlessExec({ args: ['start-ready'], noTrack: false } as never);

    expect(result).toEqual({ ok: true, error: 'boom' });
  });

  it('still merges non-ok runner fields through', async () => {
    vi.mocked(runHeadless).mockResolvedValue({ started: 3 });
    const actions = createGuiMutationTaskActions(makeContext());

    const result = await actions.executeHeadlessExec({ args: ['start-ready'], noTrack: false } as never);

    expect(result).toEqual({ ok: true, started: 3 });
  });
});
