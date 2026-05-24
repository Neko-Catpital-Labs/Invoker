import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessAutoFix } from '../headless.js';
import type {
  ExternalFailureRecoveryContext,
  ExternalFailureRecoveryLauncher,
  ExternalFailureRecoveryOutcome,
} from '../external-failure-recovery.js';

function makeOrchestratorStub(taskMap: Record<string, { workflowId?: string }>) {
  return {
    getTask: vi.fn((taskId: string) => {
      const entry = taskMap[taskId];
      if (!entry) return undefined;
      return { config: { workflowId: entry.workflowId } } as any;
    }),
  };
}

function makeLauncher(outcome: ExternalFailureRecoveryOutcome = { launched: true }): {
  launcher: ExternalFailureRecoveryLauncher;
  calls: ExternalFailureRecoveryContext[];
} {
  const calls: ExternalFailureRecoveryContext[] = [];
  return {
    calls,
    launcher: {
      launch: vi.fn((context: ExternalFailureRecoveryContext) => {
        calls.push(context);
        return outcome;
      }),
    },
  };
}

describe('wireHeadlessAutoFix', () => {
  it('does not invoke autoFixOnFailure on failed deltas', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const importSpy = vi.fn();
    const orchestrator = makeOrchestratorStub({
      'wf-1/task-1': { workflowId: 'wf-1' },
    });

    vi.doMock('../workflow-actions.js', () => {
      importSpy();
      return { autoFixOnFailure: importSpy };
    });

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: {} as any,
        invokerConfig: {} as any,
        repoRoot: '/repo',
      },
      {} as any,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(importSpy).not.toHaveBeenCalled();
    vi.doUnmock('../workflow-actions.js');
  });

  it('launches external recovery with workflow context on failed deltas', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const logEvent = vi.fn();
    const orchestrator = makeOrchestratorStub({
      'wf-1/task-1': { workflowId: 'wf-1' },
    });
    const { launcher, calls } = makeLauncher();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: { logEvent } as any,
        invokerConfig: {} as any,
        repoRoot: '/repo',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      taskId: 'wf-1/task-1',
      workflowId: 'wf-1',
      repoRoot: '/repo',
    });
    expect(typeof calls[0]!.dbDir).toBe('string');
    expect(logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'launched', workflowId: 'wf-1' }),
    );
  });

  it('skips when launcher reports the recovery is disabled', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const logEvent = vi.fn();
    const orchestrator = makeOrchestratorStub({
      'wf-1/task-1': { workflowId: 'wf-1' },
    });
    const { launcher, calls } = makeLauncher({ launched: false, reason: 'disabled' });

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: { logEvent } as any,
        invokerConfig: {} as any,
        repoRoot: '/repo',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skip', reason: 'disabled' }),
    );
  });

  it('skips when the task has no workflow id (and never calls the launcher)', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const logEvent = vi.fn();
    const orchestrator = makeOrchestratorStub({
      'wf-1/task-1': {},
    });
    const { launcher, calls } = makeLauncher();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: { logEvent } as any,
        invokerConfig: {} as any,
        repoRoot: '/repo',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    await Promise.resolve();

    expect(calls).toHaveLength(0);
    expect(logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skip', reason: 'no-workflow' }),
    );
  });

  it('forwards the documented INVOKER_* env vars when invoking the real launcher contract', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const orchestrator = makeOrchestratorStub({
      'wf-1/task-1': { workflowId: 'wf-1' },
    });
    const launchProcess = vi.fn();

    const { createExternalFailureRecoveryLauncher } = await import('../external-failure-recovery.js');
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '/bin/true' },
      { launchProcess, baseEnv: { PATH: '/usr/bin' }, now: () => 0 },
    );

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: {} as any,
        invokerConfig: {} as any,
        repoRoot: '/repo',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    await Promise.resolve();

    expect(launchProcess).toHaveBeenCalledTimes(1);
    const args = launchProcess.mock.calls[0][0];
    expect(args.command).toBe('/bin/true');
    expect(args.env).toMatchObject({
      INVOKER_FAILED_TASK_ID: 'wf-1/task-1',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-1',
      INVOKER_REPO_ROOT: '/repo',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
    expect(typeof args.env.INVOKER_DB_DIR).toBe('string');
  });

  it('does not call the launcher for non-failed deltas (manual fix paths preserved)', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const orchestrator = makeOrchestratorStub({
      'wf-1/task-1': { workflowId: 'wf-1' },
    });
    const { launcher, calls } = makeLauncher();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: orchestrator as any,
        persistence: {} as any,
        invokerConfig: {} as any,
        repoRoot: '/repo',
      },
      {} as any,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'running' },
    });
    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'fixing_with_ai' },
    });
    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'completed' },
    });

    await Promise.resolve();

    expect(calls).toHaveLength(0);
  });
});
