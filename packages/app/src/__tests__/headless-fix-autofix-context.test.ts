import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { encodeReviewGateCiContext } from '../auto-fix-intents.js';

const { fixWithAgentActionMock, finalizeMock } = vi.hoisted(() => ({
  fixWithAgentActionMock: vi.fn(async () => ({ kind: 'fixWithAgent', autoApproved: false, started: [] })),
  finalizeMock: vi.fn(async () => {}),
}));

vi.mock('../workflow-actions.js', async (importActual) => {
  const actual = await importActual<typeof import('../workflow-actions.js')>();
  return { ...actual, fixWithAgentAction: fixWithAgentActionMock };
});

vi.mock('../global-topup.js', async (importActual) => {
  const actual = await importActual<typeof import('../global-topup.js')>();
  return { ...actual, finalizeMutationWithGlobalTopup: finalizeMock };
});

function makeDeps(autoFixAttempts: number | null, executionOverrides: Record<string, unknown> = {}) {
  const updateTask = vi.fn();
  const task = {
    id: 'wf-1/task-1',
    status: 'failed',
    description: 'fail',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: 'wf-1' },
    execution: { error: 'boom', autoFixAttempts, ...executionOverrides },
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
    invokerConfig: { autoApproveAIFixes: false, launchOutboxMode: 'active' },
    ownerTaskRunnerProvider: () => ({ fixWithAgent: vi.fn(), resolveConflict: vi.fn() }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;
  return { deps, updateTask };
}

describe('headless fix auto-fix accounting', () => {
  afterEach(() => {
    fixWithAgentActionMock.mockClear();
    finalizeMock.mockClear();
  });

  it('does not consume the auto-fix retry budget for a manual fix', async () => {
    const { runHeadless } = await import('../headless.js');
    const { deps, updateTask } = makeDeps(2);

    await runHeadless(['fix', 'wf-1/task-1', 'claude'], deps);

    // No autoFixAttempts write happened on the manual path.
    expect(updateTask).not.toHaveBeenCalled();
    expect(fixWithAgentActionMock).toHaveBeenCalledTimes(1);
    expect(fixWithAgentActionMock.mock.calls[0][2]).toMatchObject({ reviewGateContext: undefined });
  });

  it('consumes exactly one retry when the request is explicitly --auto-fix', async () => {
    const { runHeadless } = await import('../headless.js');
    const { deps, updateTask } = makeDeps(2);

    await runHeadless(['fix', 'wf-1/task-1', 'claude', '--auto-fix'], deps);

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith('wf-1/task-1', { execution: { autoFixAttempts: 3 } });
  });

  it('starts the budget at one when no attempts have been recorded yet', async () => {
    const { runHeadless } = await import('../headless.js');
    const { deps, updateTask } = makeDeps(null);

    await runHeadless(['fix', 'wf-1/task-1', '--auto-fix'], deps);

    expect(updateTask).toHaveBeenCalledWith('wf-1/task-1', { execution: { autoFixAttempts: 1 } });
  });

  it('passes a decoded review-gate CI context through to the fix action', async () => {
    const { runHeadless } = await import('../headless.js');
    const reviewGateContext = { reviewId: 'review-1', generation: 0, fixContext: 'fix checks' };
    const { deps } = makeDeps(0);

    await runHeadless(
      ['fix', 'wf-1/task-1', '--review-gate-ci', encodeReviewGateCiContext(reviewGateContext)],
      deps,
    );

    expect(fixWithAgentActionMock).toHaveBeenCalledTimes(1);
    expect(fixWithAgentActionMock.mock.calls[0][2]).toMatchObject({ reviewGateContext });
  });
});
