import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessAutoFix } from '../headless.js';
import type { RecoveryContext, RecoveryResult } from '../external-failure-recovery.js';

function makeDeps(messageBus: MessageBus, overrides: Record<string, unknown> = {}) {
  return {
    messageBus,
    orchestrator: {
      getTask: vi.fn((taskId: string) => ({ config: { workflowId: 'wf-1' }, id: taskId })),
    } as any,
    persistence: { logEvent: vi.fn() } as any,
    repoRoot: '/repo/root',
    invokerConfig: {} as any,
    ...overrides,
  };
}

describe('wireHeadlessAutoFix (external failure recovery routing)', () => {
  it('routes failed deltas to the external recovery launcher with workflow/task context', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const launchRecovery = vi.fn<[RecoveryContext], RecoveryResult>(() => ({
      status: 'launched',
      pid: 4242,
    }));
    const onError = vi.fn();
    const deps = makeDeps(messageBus);

    wireHeadlessAutoFix(deps, {} as any, launchRecovery, onError);

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed', execution: { error: 'exit code 1' } },
    });

    await Promise.resolve();

    expect(launchRecovery).toHaveBeenCalledTimes(1);
    expect(launchRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'wf-1/task-1',
        workflowId: 'wf-1',
        repoRoot: '/repo/root',
        reason: 'exit code 1',
        dbDir: expect.any(String),
      }),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(deps.persistence.logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'launched', pid: 4242 }),
    );
  });

  it('does not launch recovery for non-failed deltas', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const launchRecovery = vi.fn<[RecoveryContext], RecoveryResult>(() => ({ status: 'disabled' }));
    wireHeadlessAutoFix(makeDeps(messageBus), {} as any, launchRecovery);

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'running' },
    });

    await Promise.resolve();
    expect(launchRecovery).not.toHaveBeenCalled();
  });

  it('skips cancellation failures without launching, and logs the skip', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const launchRecovery = vi.fn<[RecoveryContext], RecoveryResult>(() => ({ status: 'launched', pid: 1 }));
    const deps = makeDeps(messageBus);
    wireHeadlessAutoFix(deps, {} as any, launchRecovery);

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed', execution: { error: 'Cancelled by user' } },
    });

    await Promise.resolve();
    expect(launchRecovery).not.toHaveBeenCalled();
    expect(deps.persistence.logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skip', reason: 'cancelled' }),
    );
  });

  it('logs skipped outcomes returned by the launcher (disabled / cooldown)', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const results: RecoveryResult[] = [
      { status: 'disabled' },
      { status: 'cooldown', remainingMs: 5000 },
    ];
    const launchRecovery = vi.fn<[RecoveryContext], RecoveryResult>(() => results.shift()!);
    const deps = makeDeps(messageBus);
    wireHeadlessAutoFix(deps, {} as any, launchRecovery);

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });
    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-2',
      changes: { status: 'failed' },
    });

    await Promise.resolve();

    expect(launchRecovery).toHaveBeenCalledTimes(2);
    expect(deps.persistence.logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skip', reason: 'disabled' }),
    );
    expect(deps.persistence.logEvent).toHaveBeenCalledWith(
      'wf-1/task-2',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skip', reason: 'cooldown', remainingMs: 5000 }),
    );
  });

  it('reports spawn errors through onError and logs the skip', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const spawnError = new Error('ENOENT');
    const launchRecovery = vi.fn<[RecoveryContext], RecoveryResult>(() => ({
      status: 'spawn-error',
      error: spawnError,
    }));
    const onError = vi.fn();
    const deps = makeDeps(messageBus);
    wireHeadlessAutoFix(deps, {} as any, launchRecovery, onError);

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('wf-1/task-1', spawnError);
    expect(deps.persistence.logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skip', reason: 'spawn-error' }),
    );
  });
});
