import { createHash } from 'node:crypto';

import type {
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { Logger } from '@invoker/contracts';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';
import {
  buildFixWithAgentMutationArgs,
  parseFixWithAgentMutationArgs,
  parseHeadlessFixArgs,
  type ReviewGateCiContext,
} from '../auto-fix-intents.js';
import type { ReviewGateCiFailedLifecycleEvent, ReviewGateFailedCheck, WorkflowLifecycleEvent } from '../lifecycle-events.js';
import { createWorkerRuntime, type WorkerRuntime } from '../worker-runtime.js';

export const CI_FAILURE_WORKER_KIND = 'ci-failure';
const FIX_WITH_AGENT_CHANNEL = 'invoker:fix-with-agent';

export interface CiFailureWorkerStore {
  loadTask?(taskId: string): TaskState | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkflowMutationIntents(
    workflowId?: string,
    statuses?: WorkflowMutationIntentStatus[],
  ): WorkflowMutationIntent[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface CiFailureWorkerSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof FIX_WITH_AGENT_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface CiFailureWorkerOptions {
  logger: Logger;
  store: CiFailureWorkerStore;
  submitter: CiFailureWorkerSubmitter;
  messageBus?: MessageBus;
  getAutoFixAgent?: () => string | undefined;
  instanceId?: string;
  tickOnStart?: boolean;
  installSignalHandlers?: boolean;
}

function checkFingerprint(checks: readonly ReviewGateFailedCheck[]): string {
  const sorted = checks
    .map((check) => [check.name, check.conclusion ?? '', check.detailsUrl ?? ''].join('\0'))
    .sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

export function buildCiFailureDedupeKey(input: {
  taskId: string;
  reviewId: string;
  headSha?: string;
  failedChecks: readonly ReviewGateFailedCheck[];
}): string {
  return [
    'ci-failure',
    input.taskId,
    input.reviewId,
    input.headSha ?? 'no-head',
    checkFingerprint(input.failedChecks),
  ].join(':');
}

function loadLatestTask(store: CiFailureWorkerStore, workflowId: string, taskId: string): TaskState | undefined {
  return store.loadTask?.(taskId) ?? store.loadTasks(workflowId).find((task) => task.id === taskId);
}

function currentReviewGateArtifact(task: TaskState, reviewId: string) {
  const gate = task.execution.reviewGate;
  if (!gate) return undefined;
  return gate.artifacts.find((candidate) => (
    candidate.generation === gate.activeGeneration
    && candidate.status !== 'discarded'
    && !candidate.discardedAt
    && candidate.providerId === reviewId
  ));
}

function eventStillMatchesTask(event: ReviewGateCiFailedLifecycleEvent, task: TaskState): boolean {
  if (task.config.workflowId && task.config.workflowId !== event.workflowId) return false;
  if ((task.execution.generation ?? 0) !== event.generation) return false;
  if ((task.execution.selectedAttemptId ?? undefined) !== (event.attemptId ?? undefined)) return false;
  const artifact = currentReviewGateArtifact(task, event.reviewId);
  const currentReviewId = artifact?.providerId ?? task.execution.reviewId ?? task.execution.reviewProviderId;
  if (currentReviewId !== event.reviewId) return false;
  if ((artifact?.headSha ?? undefined) !== (event.headSha ?? undefined)) return false;
  return true;
}

function findExistingCiFailureIntent(
  intents: readonly WorkflowMutationIntent[],
  taskId: string,
  dedupeKey: string,
): WorkflowMutationIntent | undefined {
  return intents.find((intent) => {
    if (intent.channel !== FIX_WITH_AGENT_CHANNEL && intent.channel !== 'headless.exec') return false;
    if (intent.channel === 'headless.exec') {
      const parsed = parseHeadlessFixArgs((intent.args[0] as { args?: unknown[] } | undefined)?.args?.filter((arg): arg is string => typeof arg === 'string') ?? []);
      return parsed.taskId === taskId && parsed.reviewGateContext?.dedupeKey === dedupeKey;
    }
    const parsed = parseFixWithAgentMutationArgs(intent.args);
    if (parsed.taskId !== taskId) return false;
    return parsed.context.reviewGateContext?.dedupeKey === dedupeKey;
  });
}

function formatFixContext(event: ReviewGateCiFailedLifecycleEvent): string {
  const checks = event.failedChecks
    .map((check) => `- ${check.name}${check.conclusion ? ` (${check.conclusion})` : ''}${check.detailsUrl ? `: ${check.detailsUrl}` : ''}`)
    .join('\n');
  return [
    `Review-gate PR ${event.reviewId} has failing CI checks.`,
    `PR: ${event.reviewUrl}`,
    event.headSha ? `Head SHA: ${event.headSha}` : undefined,
    `Status: ${event.statusText}`,
    'Failed checks:',
    checks,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function createCiFailureWorker(options: CiFailureWorkerOptions): WorkerRuntime {
  const pendingEvents: ReviewGateCiFailedLifecycleEvent[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;

  const runtime = createWorkerRuntime({
    kind: CI_FAILURE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: 0,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: async () => {
      const events = pendingEvents.splice(0);
      for (const event of events) {
        const task = loadLatestTask(options.store, event.workflowId, event.taskId);
        if (!task) {
          options.store.logEvent?.(event.taskId, 'debug.ci-failure-worker', { phase: 'skip', reason: 'task-not-found' });
          continue;
        }
        if (!eventStillMatchesTask(event, task)) {
          options.store.logEvent?.(event.taskId, 'debug.ci-failure-worker', { phase: 'skip', reason: 'stale-event' });
          continue;
        }

        const dedupeKey = buildCiFailureDedupeKey({
          taskId: event.taskId,
          reviewId: event.reviewId,
          headSha: event.headSha,
          failedChecks: event.failedChecks,
        });
        const existing = findExistingCiFailureIntent(
          options.store.listWorkflowMutationIntents(event.workflowId),
          event.taskId,
          dedupeKey,
        );
        if (existing) {
          options.store.logEvent?.(event.taskId, 'debug.ci-failure-worker', {
            phase: 'skip',
            reason: 'duplicate-intent',
            dedupeKey,
            existingIntentId: existing.id,
          });
          continue;
        }

        const configuredAgent = options.getAutoFixAgent?.()?.trim();
        const selectedAgent = configuredAgent && configuredAgent.length > 0 ? configuredAgent : undefined;
        const context: ReviewGateCiContext = {
          reviewId: event.reviewId,
          generation: event.generation,
          selectedAttemptId: event.attemptId,
          branch: event.branch,
          headSha: event.headSha,
          dedupeKey,
          fixContext: formatFixContext(event),
        };
        const intentId = options.submitter.submit(
          event.workflowId,
          'normal',
          FIX_WITH_AGENT_CHANNEL,
          buildFixWithAgentMutationArgs(event.taskId, selectedAgent, { autoFix: true, reviewGateContext: context }),
        );
        options.store.logEvent?.(event.taskId, 'debug.ci-failure-worker', {
          phase: 'submitted',
          dedupeKey,
          intentId,
          agent: selectedAgent ?? null,
        });
      }
    },
  });

  if (!options.messageBus) return runtime;

  return {
    identity: runtime.identity,
    start: (): void => {
      if (!lifecycleUnsubscribe) {
        lifecycleUnsubscribe = options.messageBus?.subscribe<WorkflowLifecycleEvent>(
          Channels.WORKFLOW_LIFECYCLE,
          (event) => {
            if (event.kind !== 'review_gate.ci_failed') return;
            pendingEvents.push(event);
            runtime.wake('wake');
          },
        );
      }
      runtime.start();
    },
    wake: runtime.wake,
    tick: runtime.tick,
    stop: async (): Promise<void> => {
      lifecycleUnsubscribe?.();
      lifecycleUnsubscribe = undefined;
      await runtime.stop();
    },
    isRunning: runtime.isRunning,
  };
}
