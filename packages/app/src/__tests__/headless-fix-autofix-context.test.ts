import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { encodeReviewGateCiContext } from '../auto-fix-intents.js';

const { fixWithAgentActionMock, resolveConflictActionMock, finalizeMock } = vi.hoisted(() => ({
  fixWithAgentActionMock: vi.fn(async () => ({ kind: 'fixWithAgent', autoApproved: false, started: [] })),
  resolveConflictActionMock: vi.fn(async () => ({ autoApproved: false, started: [] })),
  finalizeMock: vi.fn(async () => {}),
}));

vi.mock('../workflow-actions.js', async (importActual) => {
  const actual = await importActual<typeof import('../workflow-actions.js')>();
  return { ...actual, fixWithAgentAction: fixWithAgentActionMock, resolveConflictAction: resolveConflictActionMock };
});

vi.mock('../global-topup.js', async (importActual) => {
  const actual = await importActual<typeof import('../global-topup.js')>();
  return { ...actual, finalizeMutationWithGlobalTopup: finalizeMock };
});

function makeDeps(executionOverrides: Record<string, unknown> = {}, configOverrides: Record<string, unknown> = {}) {
  const updateTask = vi.fn();
  const task = {
    id: 'wf-1/task-1',
    status: 'failed',
    description: 'fail',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: 'wf-1' },
    execution: { error: 'boom', ...executionOverrides },
    taskStateVersion: 1,
  };
  const deps = {
    orchestrator: {
      getTask: vi.fn(() => task),
      syncFromDb: vi.fn(),
      getAllTasks: vi.fn(() => [task]),
      getReadyTasks: vi.fn(() => []),
    },
    persistence: {
      listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
      loadTasks: vi.fn(() => [task]),
      updateTask,
    },
    executorRegistry: {},
    messageBus: new LocalBus() as MessageBus,
    repoRoot: '/fake/repo',
    invokerConfig: { autoApproveAIFixes: false, launchOutboxMode: 'active', ...configOverrides },
    ownerTaskRunnerProvider: () => ({ fixWithAgent: vi.fn(), resolveConflict: vi.fn() }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;
  return { deps, updateTask };
}

describe('headless fix auto-fix context', () => {
  afterEach(() => {
    fixWithAgentActionMock.mockClear();
    finalizeMock.mockClear();
    resolveConflictActionMock.mockClear();
  });

  it('does not increment auto-fix attempts for a manual fix', async () => {
    const { runHeadless } = await import('../headless.js');
    const { deps, updateTask } = makeDeps();

    await runHeadless(['fix', 'wf-1/task-1', 'claude'], deps);

    expect(updateTask).not.toHaveBeenCalled();
    expect(fixWithAgentActionMock).toHaveBeenCalledTimes(1);
    expect(fixWithAgentActionMock.mock.calls[0][2]).toMatchObject({ reviewGateContext: undefined });
  });

  it('does not persist retry counts when the request is explicitly --auto-fix', async () => {
    const { runHeadless } = await import('../headless.js');
    const { deps, updateTask } = makeDeps();

    await runHeadless(['fix', 'wf-1/task-1', 'claude', '--auto-fix'], deps);

    expect(updateTask).not.toHaveBeenCalled();
    expect(fixWithAgentActionMock).toHaveBeenCalledTimes(1);
  });

  it('uses configured default agent when manual fix omits an agent', async () => {
    const { runHeadless } = await import('../headless.js');
    const { deps } = makeDeps({}, { defaultExecutionAgent: 'custom-agent' });

    await runHeadless(['fix', 'wf-1/task-1'], deps);

    expect(fixWithAgentActionMock.mock.calls[0][2]).toMatchObject({ agentName: 'custom-agent' });
  });

  it('uses configured default agent when resolve-conflict omits an agent', async () => {
    const { runHeadless } = await import('../headless.js');
    const { deps } = makeDeps({}, { defaultExecutionAgent: 'custom-agent' });

    await runHeadless(['resolve-conflict', 'wf-1/task-1'], deps);

    expect(resolveConflictActionMock).toHaveBeenCalledWith(
      'wf-1/task-1',
      expect.any(Object),
      undefined,
      undefined,
      { pathDefaultAgent: 'custom-agent' },
    );
  });

  it('passes a decoded review-gate CI context through to the fix action', async () => {
    const { runHeadless } = await import('../headless.js');
    const reviewGateContext = { reviewId: 'review-1', generation: 0, fixContext: 'fix checks' };
    const { deps } = makeDeps();

    await runHeadless(
      ['fix', 'wf-1/task-1', '--review-gate-ci', encodeReviewGateCiContext(reviewGateContext)],
      deps,
    );

    expect(fixWithAgentActionMock).toHaveBeenCalledTimes(1);
    expect(fixWithAgentActionMock.mock.calls[0][2]).toMatchObject({ reviewGateContext });
  });
});
