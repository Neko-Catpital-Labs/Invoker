import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessExternalRecovery } from '../headless.js';
import {
  ExternalFailureRecoveryLauncher,
  type RecoverySpawnFn,
} from '../external-failure-recovery.js';
import type { InvokerConfig } from '../config.js';

function makeDeps(overrides: {
  workflowIdByTask?: Record<string, string>;
  invokerConfig?: Partial<InvokerConfig>;
} = {}) {
  const messageBus = new LocalBus() as MessageBus;
  const getTask = vi.fn((taskId: string) => {
    const workflowId = overrides.workflowIdByTask?.[taskId];
    return workflowId === undefined ? undefined : { config: { workflowId } };
  });
  const shouldAutoFix = vi.fn(() => true);
  const logEvent = vi.fn();
  const persistence = { logEvent } as any;
  const orchestrator = { getTask, shouldAutoFix } as any;
  const invokerConfig: InvokerConfig = {
    ...overrides.invokerConfig,
  };
  return {
    messageBus,
    deps: {
      messageBus,
      orchestrator,
      persistence,
      repoRoot: '/repo',
      invokerConfig,
    },
    shouldAutoFix,
    logEvent,
  };
}

describe('wireHeadlessExternalRecovery', () => {
  it('does NOT invoke autoFixOnFailure when a task fails', async () => {
    const { messageBus, deps } = makeDeps({
      workflowIdByTask: { 'wf-1/task-1': 'wf-1' },
    });
    const spy = vi.fn<Parameters<RecoverySpawnFn>, void>();
    const launcher = new ExternalFailureRecoveryLauncher({
      spawn: spy as unknown as RecoverySpawnFn,
    });
    const workflowActions = await import('../workflow-actions.js');
    const autoFixSpy = vi.spyOn(workflowActions, 'autoFixOnFailure');

    wireHeadlessExternalRecovery(deps, launcher);

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(autoFixSpy).not.toHaveBeenCalled();
    autoFixSpy.mockRestore();
  });

  it('does nothing when externalFailureRecovery is not configured', async () => {
    const { messageBus, deps, logEvent } = makeDeps({
      workflowIdByTask: { 'wf-1/task-1': 'wf-1' },
    });
    const spy = vi.fn<Parameters<RecoverySpawnFn>, void>();
    const launcher = new ExternalFailureRecoveryLauncher({
      spawn: spy as unknown as RecoverySpawnFn,
    });

    wireHeadlessExternalRecovery(deps, launcher);

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });
    await Promise.resolve();

    expect(spy).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skipped', reason: 'disabled' }),
    );
  });

  it('launches the configured external recovery command with INVOKER_ env vars', async () => {
    const { messageBus, deps, logEvent } = makeDeps({
      workflowIdByTask: { 'wf-7/task-42': 'wf-7' },
      invokerConfig: {
        externalFailureRecovery: {
          enabled: true,
          command: 'recover.sh',
        },
      },
    });
    const spy = vi.fn<Parameters<RecoverySpawnFn>, void>();
    const launcher = new ExternalFailureRecoveryLauncher({
      spawn: spy as unknown as RecoverySpawnFn,
      now: () => 5_000,
      baseEnv: { PATH: '/usr/bin' },
    });

    wireHeadlessExternalRecovery(deps, launcher);

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-7/task-42',
      changes: { status: 'failed' },
    });
    await Promise.resolve();

    expect(spy).toHaveBeenCalledTimes(1);
    const [command, options] = spy.mock.calls[0]!;
    expect(command).toBe('recover.sh');
    expect(options.env).toMatchObject({
      INVOKER_FAILED_TASK_ID: 'wf-7/task-42',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-7',
      INVOKER_REPO_ROOT: '/repo',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
    expect(typeof options.env.INVOKER_DB_DIR).toBe('string');
    expect(logEvent).toHaveBeenCalledWith(
      'wf-7/task-42',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'launched', launchedAtMs: 5_000 }),
    );
  });

  it('skips launching when the failure was a cancellation', async () => {
    const { messageBus, deps, logEvent } = makeDeps({
      workflowIdByTask: { 'wf-1/task-1': 'wf-1' },
      invokerConfig: {
        externalFailureRecovery: { enabled: true, command: 'recover.sh' },
      },
    });
    const spy = vi.fn<Parameters<RecoverySpawnFn>, void>();
    const launcher = new ExternalFailureRecoveryLauncher({
      spawn: spy as unknown as RecoverySpawnFn,
    });

    wireHeadlessExternalRecovery(deps, launcher);

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: {
        status: 'failed',
        execution: { error: 'Cancelled by user' },
      },
    });
    await Promise.resolve();

    expect(spy).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'delta-failed', skipped: 'cancellation' }),
    );
  });

  it('does not subscribe a busy controller (isBusy is always false)', () => {
    const { deps } = makeDeps();
    const launcher = new ExternalFailureRecoveryLauncher({
      spawn: vi.fn() as unknown as RecoverySpawnFn,
    });
    const controller = wireHeadlessExternalRecovery(deps, launcher);
    expect(controller.isBusy()).toBe(false);
    controller.unsubscribe();
  });
});
