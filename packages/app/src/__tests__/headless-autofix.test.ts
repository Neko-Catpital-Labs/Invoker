import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import {
  AUTO_FIX_RECOVERY_CHANNEL,
  createAutoFixRecoveryScan,
  createAutoFixRecoveryWorker,
  type AutoFixRecoveryDeps,
  type AutoFixRecoverySubmission,
} from '../auto-fix-recovery.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeTask(overrides: Partial<TaskState> & { execution?: Partial<TaskState['execution']> } = {}): TaskState {
  const { execution, config, ...rest } = overrides;
  return {
    id: 'wf-1/task-1',
    description: 'fail',
    status: 'failed',
    dependencies: [],
    createdAt: new Date(0),
    taskStateVersion: 1,
    config: { workflowId: 'wf-1', ...(config as object) } as TaskState['config'],
    execution: {
      error: 'non-zero exit',
      autoFixAttempts: 0,
      generation: 1,
      ...execution,
    } as TaskState['execution'],
    ...rest,
  } as TaskState;
}

function makeRecoveryDeps(
  task: TaskState,
  overrides: Partial<AutoFixRecoveryDeps> = {},
): { deps: AutoFixRecoveryDeps; submit: ReturnType<typeof vi.fn>; skips: Array<{ taskId: string; reason: string }> } {
  const submit = vi.fn(async (_submission: AutoFixRecoverySubmission) => {});
  const skips: Array<{ taskId: string; reason: string }> = [];
  const deps: AutoFixRecoveryDeps = {
    orchestrator: {
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => task),
      syncFromDb: vi.fn(),
    },
    persistence: {
      listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
      loadTasks: vi.fn(() => [task]),
    },
    submit,
    logSkip: (taskId, reason) => {
      skips.push({ taskId, reason });
    },
    ...overrides,
  };
  return { deps, submit, skips };
}

describe('auto-fix recovery worker policy', () => {
  it('startup scan submits eligible failed tasks through the fix command route', async () => {
    const task = makeTask();
    const { deps, submit } = makeRecoveryDeps(task);
    const scan = createAutoFixRecoveryScan(deps);

    const report = await scan.scan();

    // Reconcile is governed by the database, not the in-memory hint.
    expect(deps.orchestrator.syncFromDb).toHaveBeenCalled();
    expect(report.submitted).toEqual(['wf-1/task-1']);
    expect(submit).toHaveBeenCalledTimes(1);

    // Command-route submission: same channel + args a manual `fix --auto-fix` uses.
    const submission = submit.mock.calls[0][0] as AutoFixRecoverySubmission;
    expect(submission.channel).toBe(AUTO_FIX_RECOVERY_CHANNEL);
    expect(submission.taskId).toBe('wf-1/task-1');
    expect(submission.workflowId).toBe('wf-1');
    expect(submission.args).toEqual(['wf-1/task-1', undefined, { autoFix: true }]);
  });

  it('passes the configured auto-fix agent through the command route', async () => {
    const task = makeTask();
    const { deps, submit } = makeRecoveryDeps(task, { getAutoFixAgent: () => 'codex' });
    const scan = createAutoFixRecoveryScan(deps);

    await scan.scan();

    const submission = submit.mock.calls[0][0] as AutoFixRecoverySubmission;
    expect(submission.agentName).toBe('codex');
    expect(submission.args).toEqual(['wf-1/task-1', 'codex', { autoFix: true }]);
  });

  it('does not resubmit on a duplicate wakeup for unchanged persisted state', async () => {
    const task = makeTask();
    const { deps, submit, skips } = makeRecoveryDeps(task);
    const scan = createAutoFixRecoveryScan(deps);

    await scan.scan();
    const second = await scan.scan();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(second.submitted).toEqual([]);
    expect(second.skipped).toEqual([{ taskId: 'wf-1/task-1', reason: 'duplicate' }]);
    expect(skips).toContainEqual({ taskId: 'wf-1/task-1', reason: 'duplicate' });
  });

  it('skips a stale-generation wakeup and never submits', async () => {
    const task = makeTask({ execution: { generation: 5 } });
    const { deps, submit, skips } = makeRecoveryDeps(task);
    const scan = createAutoFixRecoveryScan(deps);

    const report = await scan.scan({
      event: { taskId: 'wf-1/task-1', generation: 2, taskStateVersion: 1 },
    });

    expect(submit).not.toHaveBeenCalled();
    expect(report.submitted).toEqual([]);
    expect(report.skipped).toEqual([{ taskId: 'wf-1/task-1', reason: 'stale-event' }]);
    expect(skips).toContainEqual({ taskId: 'wf-1/task-1', reason: 'stale-event' });
  });

  it('skips ineligible and non-failed tasks without submitting', async () => {
    const failed = makeTask();
    const { deps, submit } = makeRecoveryDeps(failed, {
      orchestrator: {
        shouldAutoFix: vi.fn(() => false),
        getTask: vi.fn(() => failed),
        syncFromDb: vi.fn(),
      },
    });
    const scan = createAutoFixRecoveryScan(deps);

    const report = await scan.scan();

    expect(submit).not.toHaveBeenCalled();
    expect(report.skipped).toEqual([{ taskId: 'wf-1/task-1', reason: 'not-eligible' }]);
  });

  it('runs a startup scan when the worker starts', async () => {
    const task = makeTask();
    const { deps, submit } = makeRecoveryDeps(task);
    const runtime = createAutoFixRecoveryWorker({
      ...deps,
      logger,
      instanceId: 'rec-startup',
      installSignalHandlers: false,
    });

    runtime.start();
    // Await the in-flight startup tick (and any coalesced follow-up) to settle.
    await runtime.tick();
    await runtime.stop();

    // Dedup keeps it to a single submission even though the worker scanned twice.
    expect(submit).toHaveBeenCalledTimes(1);
    expect((submit.mock.calls[0][0] as AutoFixRecoverySubmission).channel).toBe(AUTO_FIX_RECOVERY_CHANNEL);
  });
});
