import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { MessageBus } from '@invoker/transport';
import { LocalBus } from '@invoker/transport';

// Keep the rest of workflow-actions/global-topup real; only stub the two
// collaborators headlessFix invokes so we can observe the fix decision path.
vi.mock('../workflow-actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflow-actions.js')>();
  return { ...actual, fixWithAgentAction: vi.fn() };
});
vi.mock('../global-topup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../global-topup.js')>();
  return { ...actual, finalizeMutationWithGlobalTopup: vi.fn(async () => {}) };
});

import { runHeadless } from '../headless.js';
import { fixWithAgentAction } from '../workflow-actions.js';

const fixSpy = fixWithAgentAction as unknown as Mock;

const TASK_ID = 'wf-1/task-1';

function makeDeps(overrides: {
  shouldAutoFix?: boolean;
  autoFixAttempts?: number;
  autoFixAgent?: string;
  openFixIntents?: unknown[];
  currentMutationIntentId?: number;
} = {}) {
  const task = { id: TASK_ID, status: 'failed', execution: { autoFixAttempts: overrides.autoFixAttempts ?? 0 } };
  const updateTask = vi.fn();
  const logEvent = vi.fn();
  const deps = {
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    orchestrator: {
      getTask: vi.fn(() => task),
      shouldAutoFix: vi.fn(() => overrides.shouldAutoFix ?? true),
      syncFromDb: vi.fn(),
    },
    persistence: {
      readOnly: false,
      listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
      loadTasks: vi.fn(() => [{ id: TASK_ID }]),
      listWorkflowMutationIntents: vi.fn(() => overrides.openFixIntents ?? []),
      updateTask,
      logEvent,
    },
    executorRegistry: {},
    messageBus: new LocalBus() as MessageBus,
    repoRoot: '/fake/repo',
    invokerConfig: {
      launchOutboxMode: 'active',
      autoFixAgent: overrides.autoFixAgent,
    },
    ownerTaskRunnerProvider: () => ({}),
    currentMutationIntentId: overrides.currentMutationIntentId,
    initServices: vi.fn(async () => {}),
    wireSlackBot: vi.fn(async () => ({})),
  } as any;
  return { deps, updateTask, logEvent };
}

function fixIntent(id: number, channel: 'invoker:fix-with-agent' | 'headless.exec') {
  return {
    id,
    workflowId: 'wf-1',
    channel,
    args: channel === 'invoker:fix-with-agent' ? [TASK_ID] : [{ args: ['fix', TASK_ID] }],
    priority: 'normal',
    status: 'running',
  };
}

describe('headless fix auto-context', () => {
  beforeEach(() => {
    fixSpy.mockReset();
    fixSpy.mockResolvedValue({ kind: 'fixWithAgent', started: [], autoApproved: false });
  });

  it('manual fix reaches fixWithAgentAction with Fix-with-AI labels and no budget use', async () => {
    // shouldAutoFix=false must NOT block a manual request.
    const { deps, updateTask } = makeDeps({ shouldAutoFix: false });
    await runHeadless(['fix', TASK_ID, 'codex'], deps);

    expect(fixSpy).toHaveBeenCalledTimes(1);
    const opts = fixSpy.mock.calls[0][2];
    expect(opts.agentName).toBe('codex');
    expect(opts.recreateOutputLabel).toBe('Fix with AI');
    expect(updateTask).not.toHaveBeenCalled();
    expect(deps.orchestrator.shouldAutoFix).not.toHaveBeenCalled();
  });

  it('auto-fix submission increments attempts once, selects configured agent, uses auto-fix labels', async () => {
    const { deps, updateTask } = makeDeps({ autoFixAttempts: 1, autoFixAgent: 'codex' });
    await runHeadless(['fix', TASK_ID, '--auto-fix'], deps);

    expect(fixSpy).toHaveBeenCalledTimes(1);
    const opts = fixSpy.mock.calls[0][2];
    expect(opts.agentName).toBe('codex');
    expect(opts.recreateOutputLabel).toBe('Auto-fix');
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { execution: { autoFixAttempts: 2 } });
  });

  it('auto-fix is skipped (no fix, no budget use) when shouldAutoFix is false', async () => {
    const { deps, updateTask } = makeDeps({ shouldAutoFix: false });
    await runHeadless(['fix', TASK_ID, '--auto-fix'], deps);

    expect(fixSpy).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('skips when another open fix intent already targets the task (either shape)', async () => {
    const { deps, updateTask } = makeDeps({ openFixIntents: [fixIntent(99, 'headless.exec')] });
    await runHeadless(['fix', TASK_ID, '--auto-fix'], deps);

    expect(fixSpy).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('does not treat its own coordinator intent as a duplicate', async () => {
    const { deps, updateTask } = makeDeps({
      openFixIntents: [fixIntent(7, 'headless.exec')],
      currentMutationIntentId: 7,
    });
    await runHeadless(['fix', TASK_ID, '--auto-fix'], deps);

    expect(fixSpy).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledTimes(1);
  });
});
