import { describe, expect, it } from 'vitest';
import { WorkflowMutationCoordinator } from '../workflow-mutation-coordinator.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('WorkflowMutationCoordinator', () => {
  it('passes cancellation context metadata to running jobs', async () => {
    const c = new WorkflowMutationCoordinator();
    let signalAbortedDuringRun = true;
    let observedContext:
      | {
        intentId: number;
        workflowId: string;
        channel: string;
        args: readonly unknown[];
      }
      | undefined;

    await c.enqueue(
      'wf-context',
      'normal',
      async (context) => {
        signalAbortedDuringRun = context.signal.aborted;
        observedContext = {
          intentId: context.intentId,
          workflowId: context.workflowId,
          channel: context.channel,
          args: context.args,
        };
      },
      {
        intentId: 42,
        channel: 'invoker:fix-with-agent',
        args: ['wf-context/task-a', 'codex'],
      },
    );

    expect(signalAbortedDuringRun).toBe(false);
    expect(observedContext).toEqual({
      intentId: 42,
      workflowId: 'wf-context',
      channel: 'invoker:fix-with-agent',
      args: ['wf-context/task-a', 'codex'],
    });
  });

  it('repro: normal-priority retry can leave old state visible until queued work finishes', async () => {
    const c = new WorkflowMutationCoordinator();
    const wf = 'wf-repro';
    let status = 'fixing_with_ai';
    const gate = deferred();

    const normalInFlight = c.enqueue(wf, 'normal', async () => {
      await gate.promise;
    });
    const retry = c.enqueue(wf, 'normal', async () => {
      status = 'pending';
    });

    await Promise.resolve();
    expect(status).toBe('fixing_with_ai');

    gate.resolve();
    await normalInFlight;
    await retry;
    expect(status).toBe('pending');
  });

  it('high-priority retry preempts queued normal work for same workflow', async () => {
    const c = new WorkflowMutationCoordinator();
    const wf = 'wf-priority';
    const order: string[] = [];

    const runningGate = deferred();
    const releaseRunning = c.enqueue(wf, 'normal', async () => {
      order.push('running-normal');
      await runningGate.promise;
    });

    const queuedNormal = c.enqueue(wf, 'normal', async () => {
      order.push('queued-normal');
    });
    const queuedHigh = c.enqueue(wf, 'high', async () => {
      order.push('queued-high');
    });

    await Promise.resolve();
    runningGate.resolve();
    await releaseRunning;
    await queuedHigh;
    await queuedNormal;

    expect(order).toEqual(['running-normal', 'queued-high', 'queued-normal']);
  });

  it('recreate fences abort a running fix-like mutation before taking authority', async () => {
    const c = new WorkflowMutationCoordinator();
    const wf = 'wf-cancel';
    const fixStarted = deferred();
    const allowFixToReturn = deferred();
    const fixStopped = deferred();
    const order: string[] = [];
    let staleWrite = false;

    const runningFix = c.enqueue(
      wf,
      'normal',
      async (context) => {
        order.push('fix-started');
        fixStarted.resolve();
        await allowFixToReturn.promise;
        if (context.signal.aborted) {
          order.push('fix-aborted');
          fixStopped.resolve();
          return;
        }
        staleWrite = true;
        order.push('fix-late-write');
        fixStopped.resolve();
      },
      {
        channel: 'invoker:fix-with-agent',
        args: [`${wf}/task-a`, 'codex'],
      },
    );
    void runningFix.catch(() => {});

    await fixStarted.promise;
    const recreate = c.enqueue(
      wf,
      'high',
      async (context) => {
        order.push(`${context.channel}:${String(context.args[0])}`);
      },
      {
        channel: 'invoker:recreate-task',
        args: [`${wf}/task-a`],
      },
    );

    await recreate;
    allowFixToReturn.resolve();
    await fixStopped.promise;

    await expect(runningFix).rejects.toThrow(/superseded by recreate mutation/i);
    expect(staleWrite).toBe(false);
    expect(order).toEqual([
      'fix-started',
      `invoker:recreate-task:${wf}/task-a`,
      'fix-aborted',
    ]);
  });

  it('non-hard-preempt high-priority work does not abort the running job', async () => {
    const c = new WorkflowMutationCoordinator();
    const wf = 'wf-no-cancel';
    const runningGate = deferred();
    const order: string[] = [];
    let runningSignalAborted = false;

    const runningFix = c.enqueue(
      wf,
      'normal',
      async (context) => {
        order.push('fix-started');
        await runningGate.promise;
        runningSignalAborted = context.signal.aborted;
        order.push('fix-finished');
      },
      {
        channel: 'invoker:fix-with-agent',
        args: [`${wf}/task-a`, 'codex'],
      },
    );
    const retry = c.enqueue(
      wf,
      'high',
      async () => {
        order.push('retry-workflow');
      },
      {
        channel: 'invoker:retry-workflow',
        args: [wf],
      },
    );

    await Promise.resolve();
    expect(order).toEqual(['fix-started']);
    runningGate.resolve();
    await runningFix;
    await retry;

    expect(runningSignalAborted).toBe(false);
    expect(order).toEqual(['fix-started', 'fix-finished', 'retry-workflow']);
  });
});
