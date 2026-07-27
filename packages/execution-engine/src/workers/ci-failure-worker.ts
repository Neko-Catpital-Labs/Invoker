import type { Logger } from '@invoker/contracts';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';

import {
  createAutoFixAttemptLedger,
  type AutoFixAttemptLedger,
} from '../auto-fix-attempt-ledger.js';
import { createFailedCheckLogFetcher } from '../ci-failure-infra-classifier.js';
import type {
  ReviewGateCiFailedLifecycleEvent,
  WorkflowLifecycleEvent,
} from '../lifecycle-events.js';
import { detectStack, fetchOpenStackPrs } from '../pr-stack-detection.js';
import {
  ciFailureActionKey,
  queueReviewGateCiRepair,
  type ReviewGateCiRepairPolicyOptions,
  type ReviewGateCiRepairStore,
  type ReviewGateCiRepairSubmitter,
  type StackRepairCandidate,
} from '../review-gate-ci-repair.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const CI_FAILURE_WORKER_KIND = 'ci-failure';
export const DEFAULT_CI_FAILURE_WORKER_INTERVAL_MS = 60_000;
export { ciFailureActionKey };

const CI_REPAIR_STACK_MODE_ENV = 'INVOKER_CI_REPAIR_STACK_MODE';
const GITHUB_TARGET_REPO_ENV = 'INVOKER_GITHUB_TARGET_REPO';

/** On by default: batches a failing PR's whole Mergify stack into one
 *  PlanDefinition instead of firing a separate single-PR plan per member.
 *  Set INVOKER_CI_REPAIR_STACK_MODE=0 (or "false") as a kill switch to fall
 *  back to the single-PR path if stack mode misbehaves against real traffic. */
export function isCiRepairStackModeEnabled(): boolean {
  const raw = process.env[CI_REPAIR_STACK_MODE_ENV]?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

/** Wires pr-stack-detection.ts's live gh-backed stack walk into the
 *  ReviewGateCiRepairPolicyOptions.detectStackForEvent hook. Returns
 *  undefined (falling back to the single-PR path) whenever the target repo
 *  isn't configured, the event's PR can't be resolved as currently open, or
 *  it isn't part of a multi-PR stack. */
export function createDetectStackForEvent(options: {
  cwd: string;
  repo?: string;
  trunk?: string;
}): (event: ReviewGateCiFailedLifecycleEvent) => Promise<StackRepairCandidate | undefined> {
  return async (event) => {
    const repo = options.repo ?? process.env[GITHUB_TARGET_REPO_ENV]?.trim();
    if (!repo) return undefined;
    const prNumber = Number(event.reviewId);
    if (!Number.isFinite(prNumber)) return undefined;

    const allOpenPrs = await fetchOpenStackPrs({ repo, cwd: options.cwd });
    const failingPr = allOpenPrs.find((pr) => pr.number === prNumber);
    if (!failingPr) return undefined;

    const { stackId, members } = detectStack(failingPr, allOpenPrs, { trunk: options.trunk });
    return members.length > 1 ? { stackId, members } : undefined;
  };
}

export type CiFailureWorkerStore = ReviewGateCiRepairStore;

export type CiFailureWorkerSubmitter = ReviewGateCiRepairSubmitter;

export interface CiFailureWorkerPolicyOptions extends ReviewGateCiRepairPolicyOptions {
  drainEvents?: () => ReviewGateCiFailedLifecycleEvent[];
}

export interface CiFailureWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  ciFailure?: Omit<CiFailureWorkerPolicyOptions, 'logger' | 'drainEvents' | 'attemptLedger'> & { readonly attemptLedger?: AutoFixAttemptLedger };
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  onTick?: WorkerTick;
}

/** Register the built-in CI-failure repair worker. */
export function registerCiFailureWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CI_FAILURE_WORKER_KIND,
    note: 'Submits head-SHA guarded CI repair intents for failed review-gate checks.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createCiFailureWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        ciFailure: {
          store: deps.store,
          submitter: deps.submitter,
          defaultAutoFixRetries: deps.autoFix?.defaultAutoFixRetries,
          getAutoFixAgent: deps.autoFix?.getAutoFixAgent,
          attemptLedger: deps.autoFix?.attemptLedger,
          getAutoFixExecutionModel: deps.autoFix?.getAutoFixExecutionModel,
          fetchFailedCheckLogs: createFailedCheckLogFetcher({
            cwd: deps.prMaintenance?.repoRoot,
          }),
          isStackRepairEnabled: isCiRepairStackModeEnabled,
          detectStackForEvent: createDetectStackForEvent({
            cwd: deps.prMaintenance?.repoRoot ?? process.cwd(),
          }),
        },
      }),
  });
  return registry;
}

export function createCiFailureTick(options: CiFailureWorkerPolicyOptions): WorkerTick {
  return async () => {
    const events = options.drainEvents?.() ?? [];
    const seen = new Set<string>();
    for (const event of events) {
      const externalKey = ciFailureActionKey(event);
      if (seen.has(externalKey)) continue;
      seen.add(externalKey);
      try {
        await queueReviewGateCiRepair(options, event);
      } catch (error) {
        options.logger.error(`[worker:${CI_FAILURE_WORKER_KIND}] worker-ci-failure-tick-error`, {
          module: 'ci-failure-worker',
          externalKey,
          taskId: event.taskId,
          workflowId: event.workflowId,
          reviewId: event.reviewId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}

function isReviewGateCiFailedEvent(event: WorkflowLifecycleEvent): event is ReviewGateCiFailedLifecycleEvent {
  return event.kind === 'review_gate.ci_failed';
}

export function createCiFailureWorker(options: CiFailureWorkerOptions): WorkerRuntime {
  const pendingEvents: ReviewGateCiFailedLifecycleEvent[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const fallbackAttemptLedger = options.ciFailure && !options.ciFailure.attemptLedger
    ? createAutoFixAttemptLedger()
    : undefined;
  const onTick = options.onTick ?? (
    options.ciFailure
      ? createCiFailureTick({
        ...options.ciFailure,
        attemptLedger: options.ciFailure.attemptLedger ?? fallbackAttemptLedger!,
        logger: options.logger,
        drainEvents: () => pendingEvents.splice(0),
      })
      : (() => {})
  );
  const runtime = createWorkerRuntime({
    kind: CI_FAILURE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_CI_FAILURE_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });

  if (!options.messageBus || !options.ciFailure || options.onTick) {
    return runtime;
  }

  const start = (): void => {
    if (!lifecycleUnsubscribe) {
      lifecycleUnsubscribe = options.messageBus?.subscribe<WorkflowLifecycleEvent>(
        Channels.WORKFLOW_LIFECYCLE,
        (event) => {
          if (!isReviewGateCiFailedEvent(event)) return;
          pendingEvents.push(event);
          runtime.wake('wake');
        },
      );
    }
    runtime.start();
  };
  const stop = async (): Promise<void> => {
    lifecycleUnsubscribe?.();
    lifecycleUnsubscribe = undefined;
    await runtime.stop();
  };

  return {
    identity: runtime.identity,
    start,
    wake: runtime.wake,
    tick: runtime.tick,
    stop,
    isRunning: runtime.isRunning,
  };
}
