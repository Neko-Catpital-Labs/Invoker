import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { wireHeadlessAutoFix } from '../headless.js';

describe('wireHeadlessAutoFix', () => {
  it('subscribes auto-fix for failed deltas in generic headless execution paths', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const shouldAutoFix = vi.fn((taskId: string) => taskId === 'wf-1/task-1');
    const getTask = vi.fn((taskId: string) =>
      taskId === 'wf-1/task-1'
        ? {
            id: taskId,
            status: 'failed',
            execution: { autoFixAttempts: 0, error: 'narrow fixable failure' },
            config: { command: 'pnpm test' },
          }
        : undefined,
    );
    const invokeAutoFix = vi.fn(async () => {});
    const onError = vi.fn();

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: { shouldAutoFix, getTask } as any,
        persistence: { logEvent: vi.fn(), appendTaskOutput: vi.fn() } as any,
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
    expect(getTask).toHaveBeenCalledWith('wf-1/task-2');
    expect(invokeAutoFix).toHaveBeenCalledTimes(1);
    expect(invokeAutoFix).toHaveBeenCalledWith('wf-1/task-1');
    expect(onError).not.toHaveBeenCalled();
  });

  it('emits a task-output skip message for fail-fast auto-fix decisions', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const appendTaskOutput = vi.fn();
    const getTask = vi.fn(() => ({
      id: 'wf-1/task-1',
      status: 'failed',
      execution: {
        error: '✖ 1696 problems\nno-explicit-any\nno-undef',
        autoFixAttempts: 0,
      },
      config: {
        command: 'eslint packages/',
      },
    }));
    const shouldAutoFix = vi.fn(() => true);
    const invokeAutoFix = vi.fn(async () => {});

    wireHeadlessAutoFix(
      {
        messageBus,
        orchestrator: { shouldAutoFix, getTask } as any,
        persistence: { appendTaskOutput, logEvent: vi.fn() } as any,
      },
      {} as any,
      invokeAutoFix,
    );

    messageBus.publish(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(invokeAutoFix).not.toHaveBeenCalled();
    expect(appendTaskOutput).toHaveBeenCalledWith(
      'wf-1/task-1',
      expect.stringContaining('[Auto-fix] Skipped: the task failed with a broad lint error set.'),
    );
    expect(appendTaskOutput).toHaveBeenCalledWith(
      'wf-1/task-1',
      expect.stringContaining('[Auto-fix] Primary failure: ✖ 1696 problems'),
    );
  });
});
