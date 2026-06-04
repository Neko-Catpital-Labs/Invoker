import type { Logger } from '@invoker/contracts';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import { TransportError, TransportErrorCode, type MessageBus } from '@invoker/transport';

import type { InvokerConfig } from './config.js';
import {
  encodeAutoFixReviewGateArg,
  listOpenFixIntentsForTask,
  type AutoFixReviewGateContext,
} from './auto-fix-intents.js';
import { shouldSkipAutoFixForError } from './auto-fix-gating.js';
import {
  startWorkerRuntime,
  type WorkerRuntimeController,
  type WorkerRuntimeOptions,
  type WorkerRuntimeScanContext,
  type WorkerRuntimeSubmitContext,
} from './worker-runtime.js';
import type { ReviewGateCiFailedLifecycleEvent } from './lifecycle-events.js';

type AutoFixWorkerPersistence = {
  listWorkflows(): Array<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  listWorkflowMutationIntents(workflowId?: string, statuses?: Array<'queued' | 'running'>): WorkflowMutationIntent[];
  getEvents?(taskId: string): Array<{ eventType: string; payload?: string }>;
  enqueueWorkflowMutationIntent?(
    workflowId: string,
    channel: string,
    args: unknown[],
    priority: 'normal',
  ): number;
};

export interface AutoFixWorkerCandidate {
  readonly workflowId: string;
  readonly taskId: string;
  readonly agentName: string;
  readonly reviewGate?: AutoFixReviewGateContext;
}

export interface AutoFixWorkerOptions {
  readonly logger: Logger;
  readonly messageBus: MessageBus;
  readonly persistence: AutoFixWorkerPersistence;
  readonly orchestrator?: Pick<Orchestrator, 'syncFromDb'>;
  readonly getConfig: () => InvokerConfig;
  readonly submitFixCommand?: (
    args: string[],
    context: WorkerRuntimeSubmitContext<AutoFixWorkerCandidate>,
  ) => void | Promise<void>;
  readonly pollIntervalMs?: number;
  readonly startImmediately?: boolean;
  readonly signalTarget?: WorkerRuntimeOptions<AutoFixWorkerCandidate>['signalTarget'];
  readonly signalNames?: WorkerRuntimeOptions<AutoFixWorkerCandidate>['signalNames'];
}

const AUTO_FIX_WORKER_NAME = 'autofix';
const DEFAULT_AUTO_FIX_AGENT = 'claude';
const OWNER_REQUEST_TIMEOUT_MS = 5_000;

export function startAutoFixWorker(options: AutoFixWorkerOptions): WorkerRuntimeController {
  return startWorkerRuntime<AutoFixWorkerCandidate>({
    name: AUTO_FIX_WORKER_NAME,
    messageBus: options.messageBus,
    logger: options.logger,
    pollIntervalMs: options.pollIntervalMs ?? options.getConfig().workerPollIntervalMs,
    startImmediately: options.startImmediately,
    signalTarget: options.signalTarget,
    signalNames: options.signalNames,
    relevantLifecycleEvents: (event) => (
      event.kind === 'task.failed'
      || event.kind === 'review_gate.ci_failed'
      || event.kind === 'workflow.wakeup'
    ),
    scan: (context) => scanAutoFixCandidates(options, context),
    submit: (candidate, context) => submitAutoFixCandidate(options, candidate, context),
  });
}

export function scanAutoFixCandidates(
  options: Pick<AutoFixWorkerOptions, 'logger' | 'persistence' | 'orchestrator' | 'getConfig'>,
  context: WorkerRuntimeScanContext,
): AutoFixWorkerCandidate[] {
  const config = options.getConfig();
  const agentName = resolveAutoFixAgent(config.autoFixAgent);
  const candidates: AutoFixWorkerCandidate[] = [];
  const reviewGateEvent = context.trigger.kind === 'lifecycle' && context.trigger.event.kind === 'review_gate.ci_failed'
    ? context.trigger.event
    : undefined;

  for (const workflow of options.persistence.listWorkflows()) {
    options.orchestrator?.syncFromDb(workflow.id);
    const tasks = options.persistence.loadTasks(workflow.id);
    const openIntents = options.persistence.listWorkflowMutationIntents(workflow.id, ['queued', 'running']);

    for (const task of tasks) {
      const reviewGate = reviewGateEvent && reviewGateEvent.taskId === task.id
        ? reviewGateContextFromEvent(reviewGateEvent)
        : latestPersistedReviewGateContext(options.persistence, task);
      if (!isAutoFixWorkerEligibleTask(task, config, openIntents, reviewGate)) continue;
      candidates.push({
        workflowId: workflow.id,
        taskId: task.id,
        agentName,
        ...(reviewGate ? { reviewGate } : {}),
      });
    }
  }

  if (candidates.length > 0) {
    options.logger.info('auto-fix worker found eligible task(s)', {
      module: 'auto-fix-worker',
      triggerKind: context.trigger.kind,
      count: candidates.length,
    });
  }
  return candidates;
}

function isAutoFixWorkerEligibleTask(
  task: TaskState,
  config: InvokerConfig,
  openIntents: WorkflowMutationIntent[],
  reviewGate?: AutoFixReviewGateContext,
): boolean {
  if (listOpenFixIntentsForTask(openIntents, task.id).length > 0) return false;
  if (task.config.isReconciliation || task.config.parentTask) return false;

  const maxAttempts = config.autoFixRetries ?? 0;
  if (maxAttempts <= 0) return false;
  if ((task.execution.autoFixAttempts ?? 0) >= maxAttempts) return false;

  if (reviewGate) {
    return config.autoFixCi === true
      && (task.status === 'review_ready' || task.status === 'awaiting_approval' || task.status === 'failed')
      && task.config.workflowId === reviewGate.workflowId
      && task.execution.reviewId === reviewGate.reviewId
      && task.execution.selectedAttemptId === reviewGate.selectedAttemptId
      && (task.execution.generation ?? 0) === reviewGate.generation
      && task.execution.branch === reviewGate.branch;
  }

  return task.status === 'failed' && !shouldSkipAutoFixForError(task.execution.error);
}

function reviewGateContextFromEvent(event: ReviewGateCiFailedLifecycleEvent): AutoFixReviewGateContext {
  return {
    taskId: event.taskId,
    workflowId: event.workflowId,
    reviewId: event.reviewId,
    reviewUrl: event.reviewUrl,
    ...(event.headSha ? { headSha: event.headSha } : {}),
    ...(event.headRef ? { headRef: event.headRef } : {}),
    ...(event.branch ? { branch: event.branch } : {}),
    ...(event.attemptId ? { selectedAttemptId: event.attemptId } : {}),
    generation: event.generation,
    failedChecks: event.failedChecks.map((check) => ({ ...check })),
    statusText: event.statusText,
  };
}

function latestPersistedReviewGateContext(
  persistence: Pick<AutoFixWorkerPersistence, 'getEvents'>,
  task: TaskState,
): AutoFixReviewGateContext | undefined {
  if (!persistence.getEvents) return undefined;
  const events = persistence.getEvents(task.id).filter((event) => event.eventType === 'review_gate.ci_failed');
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const context = parseReviewGateEventPayload(events[index]?.payload);
    if (!context) continue;
    if (context.taskId !== task.id) continue;
    if (context.reviewId !== task.execution.reviewId) continue;
    if (context.selectedAttemptId !== task.execution.selectedAttemptId) continue;
    if (context.generation !== (task.execution.generation ?? 0)) continue;
    if (context.branch !== task.execution.branch) continue;
    return context;
  }
  return undefined;
}

function parseReviewGateEventPayload(payload: string | undefined): AutoFixReviewGateContext | undefined {
  if (!payload) return undefined;
  try {
    const value = JSON.parse(payload) as AutoFixReviewGateContext;
    if (
      typeof value.taskId !== 'string'
      || typeof value.workflowId !== 'string'
      || typeof value.reviewId !== 'string'
      || typeof value.reviewUrl !== 'string'
      || typeof value.generation !== 'number'
      || !Array.isArray(value.failedChecks)
      || value.failedChecks.length === 0
      || typeof value.statusText !== 'string'
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

async function submitAutoFixCandidate(
  options: AutoFixWorkerOptions,
  candidate: AutoFixWorkerCandidate,
  context: WorkerRuntimeSubmitContext<AutoFixWorkerCandidate>,
): Promise<void> {
  const args = buildAutoFixCommandArgs(candidate);
  if (options.submitFixCommand) {
    await options.submitFixCommand(args, context);
    return;
  }

  const acceptedByOwner = await requestOwnerFix(options.messageBus, args);
  if (acceptedByOwner) return;

  if (!options.persistence.enqueueWorkflowMutationIntent) {
    throw new Error(`No reachable owner and persistence cannot enqueue auto-fix command for ${candidate.taskId}`);
  }

  options.persistence.enqueueWorkflowMutationIntent(
    candidate.workflowId,
    'headless.exec',
    [{ args, waitForApproval: false, noTrack: true }],
    'normal',
  );
  options.logger.info('auto-fix worker enqueued fix command for owner drain', {
    module: 'auto-fix-worker',
    taskId: candidate.taskId,
    workflowId: candidate.workflowId,
  });
}

export function buildAutoFixCommandArgs(candidate: AutoFixWorkerCandidate): string[] {
  return [
    'fix',
    candidate.taskId,
    candidate.agentName,
    '--auto-fix',
    ...(candidate.reviewGate ? [encodeAutoFixReviewGateArg(candidate.reviewGate)] : []),
  ];
}

function resolveAutoFixAgent(configuredAgent: string | undefined): string {
  const trimmed = configuredAgent?.trim();
  return trimmed || DEFAULT_AUTO_FIX_AGENT;
}

async function requestOwnerFix(messageBus: MessageBus, args: string[]): Promise<boolean> {
  const traceId = `auto-fix-worker:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
  const timeout = Symbol('auto-fix-owner-timeout');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof timeout>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(timeout), OWNER_REQUEST_TIMEOUT_MS);
    timeoutHandle.unref?.();
  });

  try {
    const response = await Promise.race([
      messageBus.request('headless.exec', { args, waitForApproval: false, noTrack: true, traceId }),
      timeoutPromise,
    ]);
    return response !== timeout;
  } catch (err) {
    if (err instanceof TransportError && err.code === TransportErrorCode.NO_HANDLER) {
      return false;
    }
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
