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

function extractRequiredKey(stdoutLine: unknown, requiredKey: string): Record<string, unknown> | null {
  if (!stdoutLine || typeof stdoutLine !== 'object') return null;
  const parsed = stdoutLine as Record<string, unknown>;
  if (requiredKey in parsed) return parsed;
  const response = parsed.response;
  if (response && typeof response === 'object' && requiredKey in (response as Record<string, unknown>)) {
    return response as Record<string, unknown>;
  }
  return null;
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

  it('forwards repair-filing insert through the owner ack so the claimer can see inserted', async () => {
    const liveRow = {
      id: 2955,
      kind: 'admin-requeue:check:pr-body',
      subject: '10242',
      stateSha: 'd8458e9d528132a59ba4d6f3dbea81c83db9c212',
    };
    vi.mocked(runHeadless).mockResolvedValue({ inserted: true, row: liveRow });
    const ctx = makeContext();
    const actions = createGuiMutationTaskActions(ctx);
    ctx.workflowMutationDispatcher.set(
      'headless.exec',
      (payload) => actions.executeHeadlessExec(payload as never),
    );

    const args = [
      'repair-filing',
      'insert',
      '--kind',
      'admin-requeue:check:pr-body',
      '--subject',
      '10242',
      '--state-sha',
      liveRow.stateSha,
    ];
    const handler = ctx.workflowMutationDispatcher.get('headless.exec');
    expect(handler).toBeDefined();
    const response = await handler!({ args, waitForApproval: false, noTrack: true });
    const envelope = { args, ok: true, response };

    expect(extractRequiredKey({ args, ok: true, response: { ok: true } }, 'inserted')).toBeNull();
    expect(extractRequiredKey(envelope, 'inserted')).toEqual({
      inserted: true,
      row: liveRow,
      ok: true,
    });
  });
});
