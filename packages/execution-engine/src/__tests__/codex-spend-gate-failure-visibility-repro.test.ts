import { describe, expect, it, vi } from 'vitest';
import { resolveTaskConfig, type FailureClass, type TaskState } from '@invoker/workflow-core';
import type { Logger, WorkResponse } from '@invoker/contracts';

import { TaskRunner } from '../task-runner.js';
import { CodexSpendGateTrippedError, codexSpendGateBlockMessage, type CodexSpendGateTrip } from '../codex-spend-gate.js';
import { collectValidatedAutoFixRecoveryCandidates } from '../auto-fix-recovery.js';
import { createAutoFixAttemptLedger } from '../auto-fix-attempt-ledger.js';

const SPEND_GATE_FAILURE_CLASS: FailureClass = 'agent-spend-gate';

const DO1_TRIP: CodexSpendGateTrip = {
  trippedAt: '2026-09-13T16:35:24.179Z',
  dayKey: '2026-09-13',
  tokenBudget: 600_000_000,
  observedTokens: 610_323_524,
  tokensByHost: { owner: 559_935_118, remote_digital_ocean_3: 31_060_003 },
};

function makeLogger(): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  (logger.child as ReturnType<typeof vi.fn>).mockReturnValue(logger);
  return logger;
}

function runnerWhoseStartThrows(task: TaskState, startError: Error) {
  const executor = {
    type: 'worktree',
    start: vi.fn().mockRejectedValue(startError),
    onComplete: vi.fn().mockReturnValue(() => {}),
    onOutput: vi.fn().mockReturnValue(() => {}),
    onHeartbeat: vi.fn().mockReturnValue(() => {}),
    kill: vi.fn().mockResolvedValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
  };
  const orchestrator = {
    getTask: vi.fn().mockReturnValue(task),
    getAllTasks: vi.fn().mockReturnValue([task]),
    markTaskRunningAfterLaunch: vi.fn().mockReturnValue(true),
    handleWorkerResponse: vi.fn().mockReturnValue([]),
    deferTask: vi.fn(),
  };
  const runner = new TaskRunner({
    orchestrator: orchestrator as any,
    persistence: { updateTask: vi.fn(), loadAttempts: vi.fn().mockReturnValue([]), logEvent: vi.fn(), appendTaskOutput: vi.fn() } as any,
    executorRegistry: {
      get: vi.fn().mockReturnValue(executor),
      getAll: vi.fn().mockReturnValue([['worktree', executor]]),
      getDefault: vi.fn().mockReturnValue(executor),
    } as any,
    cwd: '/tmp/codex-spend-gate-visibility',
    logger: makeLogger(),
  });
  return { runner, orchestrator };
}

describe('Codex spend gate failures are explicit (repro)', () => {
  it('labels a Codex task that could not start because the spend gate is tripped', async () => {
    const task: TaskState = {
      id: 'wf-gate/repair',
      description: 'Rebase PR #12103 onto master',
      status: 'pending',
      dependencies: [],
      createdAt: new Date('2026-09-14T17:57:05.990Z'),
      config: resolveTaskConfig({ workflowId: 'wf-gate', prompt: 'Rebase onto master', executionAgent: 'codex' }),
      execution: { selectedAttemptId: 'wf-gate/repair-a1', generation: 0, phase: 'launching' },
    };
    const gateError = new CodexSpendGateTrippedError(
      codexSpendGateBlockMessage(DO1_TRIP, '/home/invoker/.invoker/codex-spend-gate.json'),
      DO1_TRIP,
    );
    const { runner, orchestrator } = runnerWhoseStartThrows(task, gateError);

    await runner.executeTask(task);

    const response = orchestrator.handleWorkerResponse.mock.calls[0]?.[0] as WorkResponse;
    expect(response.status).toBe('failed');
    expect(response.outputs.failureClass).toBe(SPEND_GATE_FAILURE_CLASS);
  });

  it.fails('keeps auto-fix away from a task that failed because the spend gate is tripped', () => {
    const task = {
      id: 'wf-gate/repair',
      description: 'Rebase PR #12103 onto master',
      status: 'failed',
      dependencies: [],
      createdAt: new Date('2026-09-14T17:57:05.990Z'),
      config: { workflowId: 'wf-gate', prompt: 'Rebase onto master', executionAgent: 'codex' },
      execution: {
        generation: 0,
        selectedAttemptId: 'wf-gate/repair-a1',
        branch: 'experiment/wf-gate/repair',
        error: `Executor startup failed (worktree): ${codexSpendGateBlockMessage(DO1_TRIP, '/home/invoker/.invoker/codex-spend-gate.json')}`,
        failureClass: SPEND_GATE_FAILURE_CLASS,
      },
      taskStateVersion: 3,
    } as unknown as TaskState;
    const store = {
      listWorkflows: vi.fn(() => [{ id: 'wf-gate', repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker.git' }]),
      loadTasks: vi.fn((workflowId: string) => (workflowId === 'wf-gate' ? [task] : [])),
      loadTask: vi.fn((taskId: string) => (taskId === task.id ? task : undefined)),
      listWorkflowMutationIntents: vi.fn(() => []),
      logEvent: vi.fn(),
    };

    const candidates = collectValidatedAutoFixRecoveryCandidates({
      store,
      submitter: { submit: vi.fn(() => 1) },
      logger: makeLogger(),
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
    });

    expect(candidates).toEqual([]);
  });
});
