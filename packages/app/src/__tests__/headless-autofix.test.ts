import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessAutoFix } from '../headless.js';

describe('wireHeadlessAutoFix', () => {
  // Failed-task and review-gate CI recovery are now owned by the dedicated
  // auto-fix worker (`worker autofix`), which reacts to workflow lifecycle
  // events bridged from task deltas. Headless command processes no longer
  // recover failed tasks in-process, so wiring auto-fix must NOT install a
  // hidden TASK_DELTA recovery subscription that duplicates the worker.
  it('does not schedule fixes off failed deltas; recovery is owned by the worker', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const subscribe = vi.spyOn(messageBus, 'subscribe');
    const shouldAutoFix = vi.fn(() => true);
    const fixWithAgent = vi.fn(async () => {});
    const resolveConflict = vi.fn(async () => {});

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: { shouldAutoFix, getTask: vi.fn() } as any,
        persistence: {} as any,
      },
      { executeTasks: vi.fn(), fixWithAgent, resolveConflict } as any,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    await Promise.resolve();
    await Promise.resolve();

    // No hidden recovery subscription, and no fix executed in-process.
    expect(subscribe).not.toHaveBeenCalled();
    expect(shouldAutoFix).not.toHaveBeenCalled();
    expect(fixWithAgent).not.toHaveBeenCalled();
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it('returns an inert controller with no background work to drive or await', () => {
    const controller = wireHeadlessAutoFix(
      {
        messageBus: new LocalBus() as MessageBus,
        orchestrator: {} as any,
        persistence: {} as any,
      },
      {} as any,
    );

    expect(controller.isBusy()).toBe(false);
    expect(() => controller.unsubscribe()).not.toThrow();
  });
});
