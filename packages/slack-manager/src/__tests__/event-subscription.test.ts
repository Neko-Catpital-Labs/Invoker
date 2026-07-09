import { describe, it, expect, vi } from 'vitest';
import { Channels } from '@invoker/transport';
import { startEventSubscription } from '../event-subscription.js';

function setup() {
  const handlers = new Map<string, (message: unknown) => void>();
  const client = {
    subscribe: vi.fn((channel: string, handler: (message: unknown) => void) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    }),
  };
  const slack = { handleEvent: vi.fn(async () => {}) };
  const stop = startEventSubscription({ client, slack, log: () => {} });
  return { handlers, client, slack, stop };
}

describe('startEventSubscription', () => {
  it('forwards a surface.event workflow_progress card straight to the surface', () => {
    const { handlers, slack } = setup();
    const event = {
      type: 'workflow_progress',
      progress: {
        workflowId: 'wf-1',
        name: 'demo',
        counts: { total: 1, completed: 0, failed: 0, closed: 0, running: 1, pending: 0 },
        percentComplete: 0,
        tasks: [],
      },
    };
    handlers.get(Channels.SURFACE_EVENT)!(event);
    expect(slack.handleEvent).toHaveBeenCalledWith(event);
  });

  it('wraps a raw task.delta into a task_delta event (awaiting_approval → surface renders buttons)', () => {
    const { handlers, slack } = setup();
    const delta = { type: 'updated', taskId: 'wf-1/task-a', changes: { status: 'awaiting_approval' } };
    handlers.get(Channels.TASK_DELTA)!(delta);
    expect(slack.handleEvent).toHaveBeenCalledWith({ type: 'task_delta', delta });
  });

  it('subscribes to both channels and tears them down on stop', () => {
    const { client, handlers, stop } = setup();
    expect(client.subscribe).toHaveBeenCalledTimes(2);
    expect(handlers.has(Channels.SURFACE_EVENT)).toBe(true);
    expect(handlers.has(Channels.TASK_DELTA)).toBe(true);
    stop();
    expect(handlers.size).toBe(0);
  });
});
