import {
  WORKFLOW_MUTATION_LEASE_MS,
  type SQLiteAdapter,
  type WorkflowMutationIntent,
  type WorkflowMutationPriority,
} from '@invoker/data-store';

type Deferred<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class PersistedWorkflowMutationCoordinator {
  private readonly inFlightPromises = new Map<number, Deferred<unknown>>();
  private readonly drainingWorkflows = new Set<string>();
  private readonly pendingDrainWorkflows = new Set<string>();
  private readonly leaseHeartbeatMs = Math.max(1_000, Math.floor(WORKFLOW_MUTATION_LEASE_MS / 3));
  private readonly maxConcurrentWorkflowDrains: number;
  private activeWorkflowDrains = 0;
  private deferredDrainTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly persistence: SQLiteAdapter,
    private readonly ownerId: string,
    private readonly dispatch: (channel: string, args: unknown[]) => Promise<unknown>,
    options?: { maxConcurrentWorkflowDrains?: number },
  ) {
    this.maxConcurrentWorkflowDrains = Math.max(1, options?.maxConcurrentWorkflowDrains ?? 1);
  }

  async enqueue<T>(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
  ): Promise<T> {
    const intentId = this.persistence.enqueueWorkflowMutationIntent(workflowId, channel, args, priority);
    const result = new Promise<T>((resolve, reject) => {
      this.inFlightPromises.set(intentId, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.scheduleWorkflowDrain(workflowId);
    return result;
  }

  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number {
    const intentId = this.persistence.enqueueWorkflowMutationIntent(workflowId, channel, args, priority);
    if (options?.deferDrain) {
      this.scheduleWorkflowDrainDeferred(workflowId);
    } else {
      this.scheduleWorkflowDrain(workflowId);
    }
    return intentId;
  }

  async resumePending(): Promise<void> {
    this.persistence.requeueExpiredWorkflowMutationLeases();
    const workflowIds = Array.from(
      new Set(
      this.persistence.listWorkflowMutationIntents(undefined, ['queued']).map((intent) => intent.workflowId),
      ),
    );
    if (workflowIds.length === 0) {
      return;
    }
    await Promise.all(workflowIds.map((workflowId) => this.drainWorkflowWhenScheduled(workflowId)));
  }

  private scheduleWorkflowDrain(workflowId: string): void {
    if (this.drainingWorkflows.has(workflowId)) {
      return;
    }
    this.pendingDrainWorkflows.add(workflowId);
    void this.processPendingDrains();
  }

  private scheduleWorkflowDrainDeferred(workflowId: string): void {
    if (this.drainingWorkflows.has(workflowId)) {
      return;
    }
    this.pendingDrainWorkflows.add(workflowId);
    if (this.deferredDrainTimer) {
      return;
    }
    this.deferredDrainTimer = setTimeout(() => {
      this.deferredDrainTimer = null;
      void this.processPendingDrains();
    }, 25);
    this.deferredDrainTimer.unref?.();
  }

  private async drainWorkflowWhenScheduled(workflowId: string): Promise<void> {
    this.pendingDrainWorkflows.add(workflowId);
    await this.processPendingDrains();
    while (this.pendingDrainWorkflows.has(workflowId) || this.drainingWorkflows.has(workflowId)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private async processPendingDrains(): Promise<void> {
    while (this.activeWorkflowDrains < this.maxConcurrentWorkflowDrains) {
      const nextWorkflowId = Array.from(this.pendingDrainWorkflows).find(
        (workflowId) => !this.drainingWorkflows.has(workflowId),
      );
      if (!nextWorkflowId) {
        return;
      }
      this.pendingDrainWorkflows.delete(nextWorkflowId);
      this.activeWorkflowDrains += 1;
      void this.runWorkflowDrain(nextWorkflowId)
        .catch((error) => {
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          process.stderr.write(`[workflow-mutation-coordinator] drain failed for ${nextWorkflowId}: ${message}\n`);
        })
        .finally(() => {
          this.activeWorkflowDrains = Math.max(0, this.activeWorkflowDrains - 1);
          void this.processPendingDrains();
        });
    }
  }

  private async runWorkflowDrain(workflowId: string): Promise<void> {
    if (this.drainingWorkflows.has(workflowId)) {
      return;
    }
    this.drainingWorkflows.add(workflowId);
    try {
      if (!this.persistence.claimWorkflowMutationLease(workflowId, this.ownerId)) {
        return;
      }
      let intent = this.persistence.claimNextWorkflowMutationIntent(workflowId, this.ownerId);
      while (intent) {
        this.persistence.renewWorkflowMutationLease(workflowId, this.ownerId, {
          activeIntentId: intent.id,
          activeMutationKind: intent.channel,
        });
        await this.executeIntent(workflowId, intent);
        intent = this.persistence.claimNextWorkflowMutationIntent(workflowId, this.ownerId);
      }
      this.persistence.releaseWorkflowMutationLease(workflowId, this.ownerId);
    } finally {
      this.drainingWorkflows.delete(workflowId);
    }
  }

  private async executeIntent(workflowId: string, intent: WorkflowMutationIntent): Promise<void> {
    const deferred = this.inFlightPromises.get(intent.id);
    const leaseHeartbeat = setInterval(() => {
      this.persistence.renewWorkflowMutationLease(workflowId, this.ownerId, {
        activeIntentId: intent.id,
        activeMutationKind: intent.channel,
      });
    }, this.leaseHeartbeatMs);
    try {
      const result = await this.dispatch(intent.channel, intent.args);
      this.persistence.completeWorkflowMutationIntent(intent.id);
      deferred?.resolve(result);
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.persistence.failWorkflowMutationIntent(intent.id, message);
      deferred?.reject(error);
    } finally {
      clearInterval(leaseHeartbeat);
      this.persistence.renewWorkflowMutationLease(workflowId, this.ownerId);
      this.inFlightPromises.delete(intent.id);
    }
  }
}
