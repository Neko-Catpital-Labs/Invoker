import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessAutoFix } from '../headless.js';
import type {
  ExternalFailureRecoveryLauncher,
  ExternalFailureRecoveryResult,
} from '../external-failure-recovery.js';

function makeLauncher(
  result: ExternalFailureRecoveryResult = { launched: true },
): { trigger: ReturnType<typeof vi.fn>; launcher: ExternalFailureRecoveryLauncher } {
  const trigger = vi.fn().mockReturnValue(result);
  return { trigger, launcher: { trigger } };
}

describe('wireHeadlessAutoFix (external recovery routing)', () => {
  it('routes failed deltas to the external recovery launcher with the failed task and workflow context', () => {
    const messageBus = new LocalBus() as MessageBus;
    const logEvent = vi.fn();
    const { trigger, launcher } = makeLauncher();
    const loadTask = vi.fn().mockImplementation((id: string) =>
      id === 'wf-1/task-1' ? { config: { workflowId: 'wf-1' } } : undefined,
    );

    wireHeadlessAutoFix(
      {
        messageBus,
        persistence: { logEvent, loadTask } as any,
        repoRoot: '/home/op/repo',
        invokerConfig: {} as any,
      },
      undefined,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    expect(trigger).toHaveBeenCalledTimes(1);
    const call = trigger.mock.calls[0]![0] as {
      failedTaskId: string;
      failedWorkflowId: string;
      repoRoot: string;
      dbDir: string;
    };
    expect(call.failedTaskId).toBe('wf-1/task-1');
    expect(call.failedWorkflowId).toBe('wf-1');
    expect(call.repoRoot).toBe('/home/op/repo');
    expect(typeof call.dbDir).toBe('string');
    expect(call.dbDir.length).toBeGreaterThan(0);

    expect(logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'delta-failed', failedWorkflowId: 'wf-1' }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'launched' }),
    );
  });

  it('does not enqueue invoker:fix-with-agent or call any autoFixOnFailure helper', () => {
    const messageBus = new LocalBus() as MessageBus;
    const logEvent = vi.fn();
    const { trigger, launcher } = makeLauncher();
    const loadTask = vi.fn().mockReturnValue({ config: { workflowId: 'wf-1' } });

    wireHeadlessAutoFix(
      {
        messageBus,
        persistence: { logEvent, loadTask } as any,
        repoRoot: '/repo',
        invokerConfig: {} as any,
      },
      undefined,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    expect(trigger).toHaveBeenCalledTimes(1);
    const recordedEvents = logEvent.mock.calls.map(([, eventType]) => eventType);
    expect(recordedEvents).not.toContain('debug.auto-fix');
  });

  it('skips deltas whose error indicates user cancellation', () => {
    const messageBus = new LocalBus() as MessageBus;
    const logEvent = vi.fn();
    const { trigger, launcher } = makeLauncher();

    wireHeadlessAutoFix(
      {
        messageBus,
        persistence: { logEvent } as any,
        repoRoot: '/repo',
        invokerConfig: {} as any,
      },
      undefined,
      launcher,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: {
        status: 'failed',
        execution: { error: 'Cancelled by user (workflow)' },
      },
    });

    expect(trigger).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      'wf-1/task-1',
      'debug.external-recovery',
      expect.objectContaining({ phase: 'skip', reason: 'cancellation' }),
    );
  });

  it('does not subscribe past unsubscribe', () => {
    const messageBus = new LocalBus() as MessageBus;
    const logEvent = vi.fn();
    const { trigger, launcher } = makeLauncher();
    const loadTask = vi.fn().mockReturnValue({ config: { workflowId: 'wf-1' } });

    const controller = wireHeadlessAutoFix(
      {
        messageBus,
        persistence: { logEvent, loadTask } as any,
        repoRoot: '/repo',
        invokerConfig: {} as any,
      },
      undefined,
      launcher,
    );

    controller.unsubscribe();
    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });
    expect(trigger).not.toHaveBeenCalled();
  });
});
