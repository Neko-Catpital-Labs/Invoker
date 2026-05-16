import { describe, expect, it, vi } from 'vitest';
import { preemptWorkflowBeforeMutation } from '../workflow-preemption.js';

describe('preemptWorkflowBeforeMutation', () => {
  it('passes the mutation AbortSignal to workflow preemption', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;

    await preemptWorkflowBeforeMutation('wf-1', {
      preemptWorkflowExecution: async (_workflowId, signal) => {
        observedSignal = signal;
        return { cancelled: [], runningCancelled: [] };
      },
      context: 'test.preempt',
      signal: controller.signal,
    });

    expect(observedSignal).toBe(controller.signal);
  });

  it('does not run preemption when the mutation signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('superseded');
    controller.abort(reason);
    const preemptWorkflowExecution = vi.fn();

    await expect(preemptWorkflowBeforeMutation('wf-1', {
      preemptWorkflowExecution,
      context: 'test.preempt',
      signal: controller.signal,
    })).rejects.toThrow('superseded');
    expect(preemptWorkflowExecution).not.toHaveBeenCalled();
  });
});
