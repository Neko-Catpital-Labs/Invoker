import {
  WORKFLOW_MUTATION_LEASE_MS,
  type SQLiteAdapter,
  type WorkflowMutationIntent,
  type WorkflowMutationPriority,
} from '@invoker/data-store';
import type { Logger } from '@invoker/contracts';
import { createWorkflowMutationTiming, type WorkflowMutationTiming } from './workflow-mutation-timing.js';

type Deferred<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type InvalidationSignal = {
  promise: Promise<never>;
  reject: (error: unknown) => void;
  abortController: AbortController;
};

export type WorkflowMutationContext = {
  signal: AbortSignal;
  intentId: number;
  workflowId: string;
  mutationTiming?: WorkflowMutationTiming;
};

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

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
  private readonly leaseRenewMinIntervalMs = Math.max(
    500,
    envMs('INVOKER_MUTATION_LEASE_RENEW_MIN_INTERVAL_MS', 2_000),
  );
  private readonly leaseRenewMinExpiryLeadMs = Math.max(
    this.leaseHeartbeatMs,
    envMs('INVOKER_MUTATION_LEASE_RENEW_MIN_EXPIRY_LEAD_MS', 12_000),
  );
  private readonly enableTraceLogs: boolean;
  private deferredDrainTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly persistence: SQLiteAdapter,
    private readonly ownerId: string,
    private readonly dispatch: (channel: string, args: unknown[], context: WorkflowMutationContext) => Promise<unknown>,
    private readonly options?: { logger?: Logger },
  ) {
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
    this.createTiming(workflowId, channel, intentId, args)
      .mark('PersistedWorkflowMutationCoordinator.enqueue', 'queued', { priority });
    this.invalidateSupersededRunningIntent(workflowId, intentId, channel, args);
    this.trace(
      `enqueue intent=${intentId} workflow=${workflowId} priority=${priority} channel=${channel} pendingWorkflows=${this.pendingDrainWorkflows.size}`,
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
    const coalesced = this.findOpenCoalescibleRetryIntent(workflowId, channel, args);
    if (coalesced) {
      this.trace(
        `submit coalesced workflow=${workflowId} channel=${channel} into intent=${coalesced.id} status=${coalesced.status}`,
      );
      if (options?.deferDrain) {
        this.scheduleWorkflowDrainDeferred(workflowId);
      } else {
        this.scheduleWorkflowDrain(workflowId);
      }
      return coalesced.id;
    }

    const intentId = this.persistence.enqueueWorkflowMutationIntent(workflowId, channel, args, priority);
    this.enqueueStartedAtMs.set(intentId, Date.now());
    this.createTiming(workflowId, channel, intentId, args)
      .mark('PersistedWorkflowMutationCoordinator.submit', 'queued', {
        priority,
        deferDrain: Boolean(options?.deferDrain),
      });
    this.invalidateSupersededRunningIntent(workflowId, intentId, channel, args);
    this.trace(
      `submit intent=${intentId} workflow=${workflowId} priority=${priority} channel=${channel} defer=${Boolean(options?.deferDrain)} pendingWorkflows=${this.pendingDrainWorkflows.size}`,
    );
    if (options?.deferDrain) {
      this.scheduleWorkflowDrainDeferred(workflowId);
    } else {
      this.scheduleWorkflowDrain(workflowId);
    }
    return intentId;
  }

  private findOpenCoalescibleRetryIntent(
    workflowId: string,
    channel: string,
    args: unknown[],
  ): WorkflowMutationIntent | undefined {
    const key = this.coalescibleRetryKey(channel, args);
    if (!key) return undefined;
    const open = this.persistence.listWorkflowMutationIntents(workflowId, ['queued', 'running']);
    return open.find((intent) => this.coalescibleRetryKey(intent.channel, intent.args) === key);
  }

  private coalescibleRetryKey(channel: string, args: unknown[]): string | null {
    if (channel === 'invoker:retry-workflow') {
      const target = typeof args[0] === 'string' ? args[0] : '';
      return /^wf-[^/]+$/.test(target) ? `retry-workflow:${target}` : null;
    }
    if (channel !== 'headless.exec') {
      return null;
    }
    const payload = args[0] as { args?: unknown[] } | undefined;
    const rawArgs = Array.isArray(payload?.args) ? payload.args : [];
    const command = typeof rawArgs[0] === 'string' ? rawArgs[0] : '';
    const target = typeof rawArgs[1] === 'string' ? rawArgs[1] : '';
    if (command !== 'retry' || !/^wf-[^/]+$/.test(target)) {
      return null;
    }
    return `retry-workflow:${target}`;
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
    while (true) {
      const nextWorkflowId = Array.from(this.pendingDrainWorkflows).find(
        (workflowId) => !this.drainingWorkflows.has(workflowId),
      );
      if (!nextWorkflowId) {
        return;
      }
      this.pendingDrainWorkflows.delete(nextWorkflowId);
      void this.runWorkflowDrain(nextWorkflowId)
        .catch((error) => {
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          process.stderr.write(`[workflow-mutation-coordinator] drain failed for ${nextWorkflowId}: ${message}\n`);
        })
        .finally(() => {
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
      this.createTiming(workflowId, 'workflow-mutation-drain')
        .mark('PersistedWorkflowMutationCoordinator.runWorkflowDrain.claimLease', 'completed', {
          ownerId: this.ownerId,
        });
      let intent = this.persistence.claimNextWorkflowMutationIntent(workflowId, this.ownerId);
      while (intent) {
        const waitMs = this.intentQueueWaitMs(intent.id);
        this.createTiming(workflowId, intent.channel, intent.id, intent.args)
          .mark('PersistedWorkflowMutationCoordinator.runWorkflowDrain.claimNextIntent', 'started', {
            queueWaitMs: waitMs,
          });
        this.trace(`drain-start workflow=${workflowId} intent=${intent.id} channel=${intent.channel} queueWaitMs=${waitMs}`);
        this.persistence.renewWorkflowMutationLease(workflowId, this.ownerId, {
          activeIntentId: intent.id,
          activeMutationKind: intent.channel,
          minHeartbeatIntervalMs: this.leaseRenewMinIntervalMs,
          minExpiryLeadMs: this.leaseRenewMinExpiryLeadMs,
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
    const timing = this.createTiming(workflowId, intent.channel, intent.id, intent.args);
    const intentStartedAtMs = Date.now();
    const leaseHeartbeat = setInterval(() => {
      this.persistence.renewWorkflowMutationLease(workflowId, this.ownerId, {
        activeIntentId: intent.id,
        activeMutationKind: intent.channel,
        minHeartbeatIntervalMs: this.leaseRenewMinIntervalMs,
        minExpiryLeadMs: this.leaseRenewMinExpiryLeadMs,
      });
    }, this.leaseHeartbeatMs);
    try {
      this.evictQueuedWorkflowIntentsForFence(workflowId, intent);
      timing.mark('PersistedWorkflowMutationCoordinator.executeIntent', 'started', {
        queueWaitMs: this.intentQueueWaitMs(intent.id),
      });
      const mutationContext: WorkflowMutationContext = {
        signal: invalidation.abortController.signal,
        intentId: intent.id,
        workflowId,
        mutationTiming: timing,
      };
      const dispatchPromise = timing.span(
        'PersistedWorkflowMutationCoordinator.dispatch',
        undefined,
        () => this.dispatch(intent.channel, intent.args, mutationContext),
      );
      void dispatchPromise.catch(() => {});
      const result = await Promise.race([
        dispatchPromise,
        invalidation.promise,
      ]);
      const latestIntent = this.persistence.loadWorkflowMutationIntent(intent.id);
      if (latestIntent?.status === 'running') {
        this.persistence.completeWorkflowMutationIntent(intent.id);
      }
      timing.mark('PersistedWorkflowMutationCoordinator.executeIntent', 'completed', {
        durationMs: Date.now() - intentStartedAtMs,
      });
      deferred?.resolve(result);
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      const latestIntent = this.persistence.loadWorkflowMutationIntent(intent.id);
      if (latestIntent?.status === 'running') {
        this.persistence.failWorkflowMutationIntent(intent.id, message);
      }
      timing.mark('PersistedWorkflowMutationCoordinator.executeIntent', 'failed', {
        durationMs: Date.now() - intentStartedAtMs,
        error: error instanceof Error ? error.message : String(error),
      });
      deferred?.reject(error);
    } finally {
      clearInterval(leaseHeartbeat);
      invalidation.abortController.abort();
      this.runningIntentInvalidations.delete(intent.id);
      this.persistence.renewWorkflowMutationLease(workflowId, this.ownerId, {
        minHeartbeatIntervalMs: this.leaseRenewMinIntervalMs,
        minExpiryLeadMs: this.leaseRenewMinExpiryLeadMs,
      });
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
        const evictedIntent = this.persistence.loadWorkflowMutationIntent(evictedId);
        this.createTiming(
          workflowId,
          evictedIntent?.channel ?? 'unknown',
          evictedId,
          evictedIntent?.args,
        ).mark('PersistedWorkflowMutationCoordinator.evictQueuedWorkflowIntentsForFence', 'evicted', {
          fenceIntentId: intent.id,
          fenceChannel: intent.channel,
        });
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
    const abortController = new AbortController();
    const entry: InvalidationSignal = {
      reject,
      promise,
      abortController,
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
    const fenceKind = this.hardPreemptFenceKind(channel, args);
    if (!fenceKind) {
      return;
    }
    const activeLease = this.persistence.listWorkflowMutationLeases()
      .find((lease) => lease.workflowId === workflowId);
    const activeIntentIds = new Set<number>();
    if (activeLease?.activeIntentId && activeLease.activeIntentId < newIntentId) {
      activeIntentIds.add(activeLease.activeIntentId);
    }
    for (const runningIntent of this.persistence.listWorkflowMutationIntents(workflowId, ['running'])) {
      if (runningIntent.id < newIntentId) {
        activeIntentIds.add(runningIntent.id);
      }
    }
    if (activeIntentIds.size === 0) {
      return;
    }
    for (const activeIntentId of activeIntentIds) {
      const activeIntent = this.persistence.loadWorkflowMutationIntent(activeIntentId);
      if (!activeIntent || activeIntent.status !== 'running') {
        continue;
      }
      const reason = `Superseded by ${fenceKind} intent #${newIntentId}`;
      this.persistence.failWorkflowMutationIntent(activeIntentId, reason);
      this.createTiming(workflowId, activeIntent.channel, activeIntent.id, activeIntent.args)
        .mark('PersistedWorkflowMutationCoordinator.invalidateSupersededRunningIntent', 'invalidated', {
          newIntentId,
          channel,
          reason,
        });
      const invalidation = this.runningIntentInvalidations.get(activeIntentId);
      invalidation?.abortController.abort(new WorkflowMutationInvalidatedError(reason));
      invalidation?.reject(new WorkflowMutationInvalidatedError(reason));
      process.stderr.write(
        `[workflow-mutation-coordinator] invalidated running intent ${activeIntentId} for ${workflowId} via ${fenceKind}#${newIntentId}\n`,
      );
    }
  }

  private hardPreemptFenceKind(channel: string, args: unknown[]): string | null {
    if (
      channel === 'invoker:recreate-workflow'
      || channel === 'invoker:recreate-task'
      || channel === 'invoker:rebase-recreate'
    ) {
      return 'recreate';
    }
    if (channel === 'invoker:delete-workflow' || channel === 'invoker:delete-all-workflows' || channel === 'invoker:delete-all-workflows-bulk') {
      return 'delete';
    }
    if (channel !== 'headless.exec') {
      return null;
    }
    const payload = args[0] as { args?: unknown[] } | undefined;
    const rawArgs = Array.isArray(payload?.args) ? payload.args : [];
    if (rawArgs[0] === 'recreate' || rawArgs[0] === 'recreate-task' || rawArgs[0] === 'rebase-recreate') {
      return 'recreate';
    }
    if (rawArgs[0] === 'delete' || rawArgs[0] === 'delete-workflow' || rawArgs[0] === 'delete-all') {
      return 'delete';
    }
    return null;
  }

  private isWorkflowQueueFenceIntent(intent: WorkflowMutationIntent): boolean {
    if (
      intent.channel === 'invoker:retry-workflow'
      || intent.channel === 'invoker:recreate-workflow'
      || intent.channel === 'invoker:recreate-task'
      || intent.channel === 'invoker:rebase-retry'
      || intent.channel === 'invoker:rebase-recreate'
      || intent.channel === 'invoker:delete-workflow'
      || intent.channel === 'invoker:delete-all-workflows'
      || intent.channel === 'invoker:delete-all-workflows-bulk'
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
    if (command === 'delete' || command === 'delete-workflow' || command === 'delete-all') {
      return true;
    }
    const isWorkflowId = /^wf-[^/]+$/.test(target);
    if (!isWorkflowId) {
      return false;
    }
    return command === 'recreate' || command === 'rebase-retry' || command === 'rebase-recreate' || command === 'retry';
  }

  private createTiming(
    workflowId: string,
    channel: string,
    intentId?: number,
    args?: unknown[],
  ): WorkflowMutationTiming {
    return createWorkflowMutationTiming({
      persistence: this.persistence,
      logger: this.options?.logger,
      workflowId,
      channel,
      intentId,
      args,
    });
  }
}
