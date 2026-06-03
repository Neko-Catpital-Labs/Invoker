import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';
import { hardPreemptFenceKind, isFixLikeWorkflowMutation } from './workflow-preemption.js';

export type WorkflowMutationPriority = 'high' | 'normal';

export type WorkflowMutationContext = {
  signal: AbortSignal;
  intentId: number;
  workflowId: string;
  channel: string;
  args: readonly unknown[];
  mutationTiming?: WorkflowMutationTiming;
};

export type WorkflowMutationEnqueueOptions = {
  intentId?: number;
  channel?: string;
  args?: readonly unknown[];
  mutationTiming?: WorkflowMutationTiming;
};

export class WorkflowMutationInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowMutationInvalidatedError';
  }
}

type Job<T> = {
  run: (context: WorkflowMutationContext) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  context: WorkflowMutationContext;
  abortController: AbortController;
  invalidation: Promise<never>;
  rejectInvalidation: (error: unknown) => void;
};

type WorkflowQueues = {
  running?: Job<unknown>;
  high: Job<unknown>[];
  normal: Job<unknown>[];
};

/**
 * Per-workflow async mutation coordinator.
 *
 * High-priority jobs run before normal queued jobs for the same workflow.
 * Recreate/delete-class fences abort a running fix-like job via the job's
 * context signal before the fence takes authority.
 */
export class WorkflowMutationCoordinator {
  private readonly queues = new Map<string, WorkflowQueues>();
  private nextIntentId = 1;

  enqueue<T>(
    workflowId: string,
    priority: WorkflowMutationPriority,
    run: (context: WorkflowMutationContext) => Promise<T>,
    options: WorkflowMutationEnqueueOptions = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const state = this.queues.get(workflowId) ?? { high: [], normal: [] };
      this.queues.set(workflowId, state);
      const abortController = new AbortController();
      let rejectInvalidation!: (error: unknown) => void;
      const invalidation = new Promise<never>((_, r) => {
        rejectInvalidation = r;
      });
      const context: WorkflowMutationContext = {
        signal: abortController.signal,
        intentId: options.intentId ?? this.nextIntentId++,
        workflowId,
        channel: options.channel ?? 'workflow-mutation',
        args: options.args ?? [],
        mutationTiming: options.mutationTiming,
      };
      const job: Job<T> = {
        run,
        resolve,
        reject,
        context,
        abortController,
        invalidation,
        rejectInvalidation,
      };
      if (priority === 'high') {
        state.high.push(job as Job<unknown>);
      } else {
        state.normal.push(job as Job<unknown>);
      }
      this.invalidateSupersededRunningFixLikeJob(state, job as Job<unknown>);
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

    state.running = next;
    const runPromise = Promise.resolve().then(() => next.run(next.context));
    void runPromise.catch(() => {});
    void Promise.race([runPromise, next.invalidation])
      .then((value) => next.resolve(value))
      .catch((err) => next.reject(err))
      .finally(() => {
        const s = this.queues.get(workflowId);
        if (!s) return;
        if (s.running === next) {
          s.running = undefined;
        }
        next.abortController.abort();
        this.drain(workflowId);
      });
  }

  private invalidateSupersededRunningFixLikeJob(
    state: WorkflowQueues,
    newJob: Job<unknown>,
  ): void {
    const fenceKind = hardPreemptFenceKind(newJob.context.channel, newJob.context.args);
    if (!fenceKind) {
      return;
    }
    const running = state.running;
    if (!running || running.context.intentId >= newJob.context.intentId) {
      return;
    }
    if (!isFixLikeWorkflowMutation(running.context.channel, running.context.args)) {
      return;
    }
    if (running.context.signal.aborted) {
      return;
    }
    const reason = new WorkflowMutationInvalidatedError(
      `Superseded by ${fenceKind} mutation #${newJob.context.intentId}`,
    );
    running.abortController.abort(reason);
    running.rejectInvalidation(reason);
  }
}
