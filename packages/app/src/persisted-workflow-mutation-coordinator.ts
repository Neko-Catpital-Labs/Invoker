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

type InvalidationSignal = {
  promise: Promise<never>;
  reject: (error: unknown) => void;
};

class WorkflowMutationInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowMutationInvalidatedError';
  }
}

export class PersistedWorkflowMutationCoordinator {
  private readonly inFlightPromises = new Map<number, Deferred<unknown>>();
  private readonly runningIntentInvalidations = new Map<number, InvalidationSignal>();
  private readonly enqueueStartedAtMs = new Map<number, number>();
  private readonly drainingWorkflows = new Set<string>();
  private readonly pendingDrainWorkflows = new Set<string>();
  private readonly leaseHeartbeatMs = Math.max(1_000, Math.floor(WORKFLOW_MUTATION_LEASE_MS / 3));
  private readonly maxConcurrentWorkflowDrains: number;
  private readonly enableTraceLogs: boolean;
  private activeWorkflowDrains = 0;
  private deferredDrainTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly persistence: SQLiteAdapter,
    private readonly ownerId: string,
    private readonly dispatch: (channel: string, args: unknown[]) => Promise<unknown>,
    options?: { maxConcurrentWorkflowDrains?: number },
  ) {
    this.maxConcurrentWorkflowDrains = Math.max(1, options?.maxConcurrentWorkflowDrains ?? 1);
    this.enableTraceLogs = process.env.INVOKER_TRACE_MUTATION_QUEUE === '1';
  }

  async enqueue<T>(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
  ): Promise<T> {
    const intentId = this.persistence.enqueueWorkflowMutationIntent(workflowId, channel, args, priority);
    this.enqueueStartedAtMs.set(intentId, Date.now());
    this.invalidateSupersededRunningIntent(workflowId, intentId, channel, args);
    this.trace(
      `enqueue intent=${intentId} workflow=${workflowId} priority=${priority} channel=${channel} activeDrains=${this.activeWorkflowDrains} pendingWorkflows=${this.pendingDrainWorkflows.size}`,
    );
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
    this.enqueueStartedAtMs.set(intentId, Date.now());
    this.invalidateSupersededRunningIntent(workflowId, intentId, channel, args);
    this.trace(
      `submit intent=${intentId} workflow=${workflowId} priority=${priority} channel=${channel} defer=${Boolean(options?.deferDrain)} activeDrains=${this.activeWorkflowDrains} pendingWorkflows=${this.pendingDrainWorkflows.size}`,
    );
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
        const waitMs = this.intentQueueWaitMs(intent.id);
        this.trace(`drain-start workflow=${workflowId} intent=${intent.id} channel=${intent.channel} queueWaitMs=${waitMs}`);
        this.persistence.renewWorkflowMutationLease(workflowId, this.ownerId, {
          activeIntentId: intent.id,
          activeMutationKind: intent.channel,
        });
        await this.executeIntent(workflowId, intent);
        this.trace(`drain-finished workflow=${workflowId} intent=${intent.id} channel=${intent.channel}`);
        intent = this.persistence.claimNextWorkflowMutationIntent(workflowId, this.ownerId);
      }
      this.persistence.releaseWorkflowMutationLease(workflowId, this.ownerId);
    } finally {
      this.drainingWorkflows.delete(workflowId);
    }
  }

  private async executeIntent(workflowId: string, intent: WorkflowMutationIntent): Promise<void> {
    const deferred = this.inFlightPromises.get(intent.id);
    const invalidation = this.createRunningIntentInvalidation(intent.id);
    const leaseHeartbeat = setInterval(() => {
      this.persistence.renewWorkflowMutationLease(workflowId, this.ownerId, {
        activeIntentId: intent.id,
        activeMutationKind: intent.channel,
      });
    }, this.leaseHeartbeatMs);
    try {
      this.evictQueuedWorkflowIntentsForFence(workflowId, intent);
      const dispatchPromise = Promise.resolve(this.dispatch(intent.channel, intent.args));
      void dispatchPromise.catch(() => {});
      const result = await Promise.race([
        dispatchPromise,
        invalidation.promise,
      ]);
      const latestIntent = this.persistence.loadWorkflowMutationIntent(intent.id);
      if (latestIntent?.status === 'running') {
        this.persistence.completeWorkflowMutationIntent(intent.id);
      }
      deferred?.resolve(result);
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      const latestIntent = this.persistence.loadWorkflowMutationIntent(intent.id);
      if (latestIntent?.status === 'running') {
        this.persistence.failWorkflowMutationIntent(intent.id, message);
      }
      deferred?.reject(error);
    } finally {
      clearInterval(leaseHeartbeat);
      this.runningIntentInvalidations.delete(intent.id);
      this.persistence.renewWorkflowMutationLease(workflowId, this.ownerId);
      this.inFlightPromises.delete(intent.id);
      this.enqueueStartedAtMs.delete(intent.id);
    }
  }

  private intentQueueWaitMs(intentId: number): number {
    const startedAt = this.enqueueStartedAtMs.get(intentId);
    if (!startedAt) {
      return -1;
    }
    return Date.now() - startedAt;
  }

  private trace(message: string): void {
    if (!this.enableTraceLogs) {
      return;
    }
    process.stderr.write(`[workflow-mutation-coordinator][trace] ${message}\n`);
  }

  private evictQueuedWorkflowIntentsForFence(workflowId: string, intent: WorkflowMutationIntent): void {
    if (!this.isWorkflowQueueFenceIntent(intent)) {
      return;
    }
    const evictedIds = this.persistence.evictQueuedWorkflowMutationIntentsBefore(
      workflowId,
      intent.id,
      `Evicted by workflow queue fence: ${intent.channel}#${intent.id}`,
    );
    if (evictedIds.length > 0) {
      for (const evictedId of evictedIds) {
        const deferred = this.inFlightPromises.get(evictedId);
        if (!deferred) continue;
        deferred.reject(new Error(`Workflow mutation intent ${evictedId} was evicted by ${intent.channel}#${intent.id}`));
        this.inFlightPromises.delete(evictedId);
      }
      process.stderr.write(
        `[workflow-mutation-coordinator] evicted ${evictedIds.length} queued intent(s) before fence ${intent.channel}#${intent.id} for ${workflowId}\n`,
      );
    }
  }

  private createRunningIntentInvalidation(intentId: number): InvalidationSignal {
    const existing = this.runningIntentInvalidations.get(intentId);
    if (existing) {
      return existing;
    }
    let reject!: (error: unknown) => void;
    const promise = new Promise<never>((_, r) => {
      reject = r;
    });
    const entry: InvalidationSignal = {
      reject,
      promise,
    };
    this.runningIntentInvalidations.set(intentId, entry);
    return entry;
  }

  private invalidateSupersededRunningIntent(
    workflowId: string,
    newIntentId: number,
    channel: string,
    args: unknown[],
  ): void {
    if (!this.isHardPreemptingRecreateIntent(channel, args)) {
      return;
    }
    const activeLease = this.persistence.listWorkflowMutationLeases()
      .find((lease) => lease.workflowId === workflowId);
    const activeIntentId = activeLease?.activeIntentId;
    if (!activeIntentId || activeIntentId >= newIntentId) {
      return;
    }
    const activeIntent = this.persistence.loadWorkflowMutationIntent(activeIntentId);
    if (!activeIntent || activeIntent.status !== 'running') {
      return;
    }
    const reason = `Superseded by recreate intent #${newIntentId}`;
    this.persistence.failWorkflowMutationIntent(activeIntentId, reason);
    const invalidation = this.runningIntentInvalidations.get(activeIntentId);
    invalidation?.reject(new WorkflowMutationInvalidatedError(reason));
    process.stderr.write(
      `[workflow-mutation-coordinator] invalidated running intent ${activeIntentId} for ${workflowId} via recreate#${newIntentId}\n`,
    );
  }

  private isHardPreemptingRecreateIntent(channel: string, args: unknown[]): boolean {
    if (channel === 'invoker:recreate-workflow' || channel === 'invoker:recreate-task') {
      return true;
    }
    if (channel !== 'headless.exec') {
      return false;
    }
    const payload = args[0] as { args?: unknown[] } | undefined;
    const rawArgs = Array.isArray(payload?.args) ? payload.args : [];
    return rawArgs[0] === 'recreate' || rawArgs[0] === 'recreate-task';
  }

  private isWorkflowQueueFenceIntent(intent: WorkflowMutationIntent): boolean {
    if (
      intent.channel === 'invoker:retry-workflow'
      || intent.channel === 'invoker:recreate-workflow'
      || intent.channel === 'invoker:recreate-task'
    ) {
      return true;
    }
    if (intent.channel !== 'headless.exec') {
      return false;
    }
    const payload = intent.args[0] as { args?: unknown[] } | undefined;
    const rawArgs = Array.isArray(payload?.args) ? payload.args : [];
    const command = typeof rawArgs[0] === 'string' ? rawArgs[0] : '';
    const target = typeof rawArgs[1] === 'string' ? rawArgs[1] : '';
    if (command === 'recreate-task') {
      return true;
    }
    const isWorkflowId = /^wf-[^/]+$/.test(target);
    if (!isWorkflowId) {
      return false;
    }
    return command === 'recreate' || command === 'retry';
  }
}
