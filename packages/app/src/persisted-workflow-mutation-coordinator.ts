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
  private readonly leaseHeartbeatMs = Math.max(1_000, Math.floor(WORKFLOW_MUTATION_LEASE_MS / 3));

  constructor(
    private readonly persistence: SQLiteAdapter,
    private readonly ownerId: string,
    private readonly dispatch: (channel: string, args: unknown[]) => Promise<unknown>,
  ) {}

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
    void this.drainWorkflow(workflowId);
    return result;
  }

  async resumePending(): Promise<void> {
    this.persistence.requeueExpiredWorkflowMutationLeases();
    const workflowIds = new Set(
      this.persistence.listWorkflowMutationIntents(undefined, ['queued']).map((intent) => intent.workflowId),
    );
    await Promise.all(Array.from(workflowIds).map((workflowId) => this.drainWorkflow(workflowId)));
  }

  private async drainWorkflow(workflowId: string): Promise<void> {
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
