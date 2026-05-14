export type WorkflowMutationPriority = 'high' | 'normal';

import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';

export type WorkflowMutationContext = {
  signal: AbortSignal;
  workflowId: string;
  priority: WorkflowMutationPriority;
  channel?: string;
  args?: unknown[];
  intentId?: number;
  mutationTiming?: WorkflowMutationTiming;
};

type Job<T> = {
  context: WorkflowMutationContext;
  run: (context: WorkflowMutationContext) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type WorkflowQueues = {
  running: boolean;
  high: Job<unknown>[];
  normal: Job<unknown>[];
};

/**
 * Per-workflow async mutation coordinator.
 *
 * High-priority jobs run before normal queued jobs for the same workflow.
 * Running jobs are never interrupted.
 */
export class WorkflowMutationCoordinator {
  private readonly queues = new Map<string, WorkflowQueues>();

  enqueue<T>(
    workflowId: string,
    priority: WorkflowMutationPriority,
    run: (context: WorkflowMutationContext) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const state = this.queues.get(workflowId) ?? { running: false, high: [], normal: [] };
      this.queues.set(workflowId, state);
      const job: Job<T> = {
        context: {
          signal: new AbortController().signal,
          workflowId,
          priority,
        },
        run,
        resolve,
        reject,
      };
      if (priority === 'high') {
        state.high.push(job as Job<unknown>);
      } else {
        state.normal.push(job as Job<unknown>);
      }
      this.drain(workflowId);
    });
  }

  private drain(workflowId: string): void {
    const state = this.queues.get(workflowId);
    if (!state || state.running) return;

    const next = state.high.shift() ?? state.normal.shift();
    if (!next) {
      this.queues.delete(workflowId);
      return;
    }

    state.running = true;
    void next.run(next.context)
      .then((value) => next.resolve(value))
      .catch((err) => next.reject(err))
      .finally(() => {
        const s = this.queues.get(workflowId);
        if (!s) return;
        s.running = false;
        this.drain(workflowId);
      });
  }
}
