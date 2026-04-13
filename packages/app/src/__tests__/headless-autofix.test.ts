import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessAutoFix } from '../headless.js';

describe('wireHeadlessAutoFix', () => {
  it('subscribes auto-fix for failed deltas in generic headless execution paths', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const shouldAutoFix = vi.fn((taskId: string) => taskId === 'wf-1/task-1');
    const invokeAutoFix = vi.fn(async () => {});
    const onError = vi.fn();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: { shouldAutoFix } as any,
        persistence: {} as any,
      },
      {} as any,
      invokeAutoFix,
      onError,
    );

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
    await Promise.resolve();

    expect(shouldAutoFix).toHaveBeenCalledWith('wf-1/task-1');
    expect(shouldAutoFix).toHaveBeenCalledWith('wf-1/task-2');
    expect(invokeAutoFix).toHaveBeenCalledTimes(1);
    expect(invokeAutoFix).toHaveBeenCalledWith('wf-1/task-1');
    expect(onError).not.toHaveBeenCalled();
  });
});
