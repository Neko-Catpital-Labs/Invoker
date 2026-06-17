import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type { Logger } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowMutationIntent } from '@invoker/data-store';

import {
  buildHeadlessFixArgs,
  hasOpenFixIntentForTask,
  isReviewGateCiContextStale,
  type ReviewGateCiContext,
} from './auto-fix-intents.js';
import { shouldSkipAutoFixForError } from './auto-fix-gating.js';
import {
  type ReviewGateCiFailedLifecycleEvent,
  type WorkflowLifecycleEvent,
} from './lifecycle-events.js';
import {
  startWorkerRuntime,
  type WorkerRuntime,
} from './worker-runtime.js';

/**
 * Lifecycle event kinds that wake the auto-fix worker.
 *
 * `task.failed` covers the ordinary "task failed, retry it with an agent"
 * recovery path; `review_gate.ci_failed` covers a failed CI run on an
 * Invoker-created review-gate PR. Both are *wakeups only* — the worker never
 * trusts the event payload as the source of truth for a fix decision. The
 * authoritative state always comes from a fresh read of persisted
 * workflow/task/review state at scan time.
 */
export const AUTO_FIX_WORKER_EVENT_KINDS = ['task.failed', 'review_gate.ci_failed'] as const;

const REVIEW_GATE_FIXABLE_STATUSES = new Set<TaskState['status']>([
  'review_ready',
  'awaiting_approval',
  'failed',
]);

/**
 * Read-only view of orchestrator/persistence state the worker consults to
 * decide what to fix. Kept structural so the worker stays decoupled from the
 * concrete `Orchestrator` and is trivially faked in tests.
 */
export interface AutoFixWorkerStateView {
  getAllTasks(): readonly TaskState[];
  getTask(taskId: string): TaskState | undefined;
  /** True when the task is a failed, auto-fix-eligible task within its retry budget. */
  shouldAutoFix(taskId: string): boolean;
  /** Per-task auto-fix retry budget (0 disables auto-fix). */
  getAutoFixRetryBudget(taskId: string): number;
}

/** Auto-fix-relevant config slice (mirrors {@link InvokerConfig}). */
export interface AutoFixWorkerConfig {
  /** Preferred fix agent; empty/undefined lets the fix path pick its default. */
  readonly autoFixAgent?: string;
  /** When true, failed review-gate CI runs are also recovered. */
  readonly autoFixCi?: boolean;
}

/** A single fix the worker has decided to submit. */
export interface AutoFixCandidate {
  readonly taskId: string;
  readonly workflowId: string;
  /** Headless `fix` command argument vector (tagged `--auto-fix`). */
  readonly args: string[];
  /** What triggered this candidate, for logging/telemetry. */
  readonly source: 'task_failed' | 'review_gate_ci';
}

export interface AutoFixWorkerOptions {
  /** Bus carrying `Channels.WORKFLOW_LIFECYCLE` events. */
  readonly messageBus: MessageBus;
  /** Authoritative state the worker scans for fixable work. */
  readonly state: AutoFixWorkerStateView;
  /**
   * Open (queued/running) workflow mutation intents, read fresh each call.
   * Used to suppress a redundant fix when one is already in flight for a task.
   */
  readonly listOpenFixIntents: () => readonly WorkflowMutationIntent[];
  readonly config: AutoFixWorkerConfig;
  /**
   * Submit one discovered fix. The worker never runs the fix itself: it hands
   * the built `fix` command to the accepted-command boundary, which owns
   * attempt accounting and the actual Fix-with-AI route — exactly the path a
   * user action takes.
   */
  readonly submit: (candidate: AutoFixCandidate) => Promise<void> | void;
  readonly logger?: Logger;
  /** Poll fallback interval; forwarded to the runtime. */
  readonly pollIntervalMs?: number;
  /** Run one scan on startup. Default: true. */
  readonly scanOnStartup?: boolean;
  /** Register SIGINT/SIGTERM handlers. Default: true. */
  readonly handleSignals?: boolean;
}

// ── Review-gate CI fix context formatting ────────────────────
//
// A review-gate CI failure carries its detail in the lifecycle event, not in
// `task.execution.error`. The worker formats that detail into the fix context
// that rides along the normal `fix` command so the agent sees which checks
// failed and where — the same information the legacy callback path produced.

function formatReviewGateCiFixContext(event: ReviewGateCiFailedLifecycleEvent): string {
  const checkLines = event.failedChecks.map((check) => {
    const details = [
      check.conclusion ? `conclusion=${check.conclusion}` : undefined,
      check.detailsUrl ? `details=${check.detailsUrl}` : undefined,
    ].filter(Boolean).join(' ');
    return `- ${check.name}${details ? `: ${details}` : ''}`;
  });
  return [
    'This auto-fix was triggered by failed CI on an external review gate PR.',
    `PR: ${event.reviewUrl}`,
    `Review ID: ${event.reviewId}`,
    event.headRef ? `PR head ref: ${event.headRef}` : undefined,
    event.headSha ? `PR head SHA: ${event.headSha}` : undefined,
    event.branch ? `Invoker branch: ${event.branch}` : undefined,
    '',
    'Fix the code on this task branch so the failed PR checks pass.',
    'Preserve the original task intent and do not recreate the PR manually.',
    '',
    'Failed checks:',
    ...checkLines,
  ].filter((line): line is string => line !== undefined).join('\n');
}

/**
 * Build the review-gate context snapshot the fix command carries. Lineage
 * fields (`generation`, `selectedAttemptId`, `branch`) come from the *live*
 * task so the accepted-command boundary can reject a stale retry; the failing
 * review detail comes from the event.
 */
export function buildReviewGateCiContext(
  event: ReviewGateCiFailedLifecycleEvent,
  task: TaskState,
): ReviewGateCiContext {
  return {
    reviewId: event.reviewId,
    generation: task.execution.generation ?? event.generation ?? 0,
    ...(task.execution.selectedAttemptId !== undefined
      ? { selectedAttemptId: task.execution.selectedAttemptId }
      : {}),
    ...(task.execution.branch ?? event.branch
      ? { branch: task.execution.branch ?? event.branch }
      : {}),
    ...(event.headSha ? { headSha: event.headSha } : {}),
    fixContext: formatReviewGateCiFixContext(event),
  };
}

// ── Candidate scanning + eligibility ─────────────────────────

function fixAgent(config: AutoFixWorkerConfig): string | undefined {
  const trimmed = config.autoFixAgent?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function workflowIdForTask(task: TaskState): string | undefined {
  return task.config.workflowId?.trim() || undefined;
}

/**
 * True when a captured review-gate CI failure is still actionable against the
 * live task: an eligible status, retry budget remaining, attempts not
 * exhausted, and lineage unchanged since the failure was captured.
 */
export function isReviewGateCiCandidateEligible(
  task: TaskState,
  context: ReviewGateCiContext,
  state: AutoFixWorkerStateView,
): boolean {
  if (!REVIEW_GATE_FIXABLE_STATUSES.has(task.status)) return false;
  const max = state.getAutoFixRetryBudget(task.id);
  if (max <= 0) return false;
  if ((task.execution.autoFixAttempts ?? 0) >= max) return false;
  if (isReviewGateCiContextStale(context, task.execution)) return false;
  return true;
}

/**
 * Inputs for a pure scan: snapshots taken at scan entry so the policy is
 * deterministic and unit-testable.
 */
export interface AutoFixScanInputs {
  readonly state: AutoFixWorkerStateView;
  readonly openIntents: readonly WorkflowMutationIntent[];
  readonly reviewGateContexts: ReadonlyMap<string, ReviewGateCiContext>;
  readonly config: AutoFixWorkerConfig;
}

/**
 * Discover the batch of fixes to submit. Pure over its inputs: same snapshots
 * in, same candidates out. Review-gate candidates take precedence over a plain
 * failed-task candidate for the same task (they carry richer fix context).
 */
export function scanAutoFixCandidates(inputs: AutoFixScanInputs): AutoFixCandidate[] {
  const { state, openIntents, reviewGateContexts, config } = inputs;
  const agent = fixAgent(config);
  const candidates: AutoFixCandidate[] = [];
  const seen = new Set<string>();

  // Review-gate CI failures first so they win the per-task dedupe.
  if (config.autoFixCi) {
    for (const [taskId, context] of reviewGateContexts) {
      const task = state.getTask(taskId);
      if (!task) continue;
      if (!isReviewGateCiCandidateEligible(task, context, state)) continue;
      const workflowId = workflowIdForTask(task);
      if (!workflowId) continue;
      if (hasOpenFixIntentForTask(openIntents as WorkflowMutationIntent[], taskId)) continue;
      seen.add(taskId);
      candidates.push({
        taskId,
        workflowId,
        source: 'review_gate_ci',
        args: buildHeadlessFixArgs(taskId, agent, { autoFix: true, reviewGateContext: context }),
      });
    }
  }

  // Ordinary failed-task auto-fix.
  for (const task of state.getAllTasks()) {
    if (seen.has(task.id)) continue;
    if (!state.shouldAutoFix(task.id)) continue;
    if (shouldSkipAutoFixForError(task.execution.error)) continue;
    const workflowId = workflowIdForTask(task);
    if (!workflowId) continue;
    if (hasOpenFixIntentForTask(openIntents as WorkflowMutationIntent[], task.id)) continue;
    seen.add(task.id);
    candidates.push({
      taskId: task.id,
      workflowId,
      source: 'task_failed',
      args: buildHeadlessFixArgs(task.id, agent, { autoFix: true }),
    });
  }

  return candidates;
}

function isReviewGateCiFailedEvent(
  event: WorkflowLifecycleEvent,
): event is ReviewGateCiFailedLifecycleEvent {
  return event.kind === 'review_gate.ci_failed';
}

/**
 * Start the headless auto-fix worker.
 *
 * The worker converts failed tasks and failed review-gate CI runs into the
 * same `fix --auto-fix` command a user action issues, then submits it through
 * the accepted-command boundary. It owns *policy* only — which tasks are
 * eligible and what the fix command should be — and delegates *mechanics*
 * (wakeups, coalescing, polling, shutdown) to the shared worker runtime.
 *
 * Lifecycle events are wakeups; the only event payload the worker retains is a
 * review-gate CI failure's detail, which it stashes until a scan can validate
 * it against live task lineage and turn it into a fix.
 */
export function startAutoFixWorker(options: AutoFixWorkerOptions): WorkerRuntime {
  const logger = options.logger;
  const logModule = 'autofix-worker';
  const reviewGateContexts = new Map<string, ReviewGateCiContext>();

  // Record review-gate CI failure detail before the runtime's own wakeup
  // subscription fires. Subscribing here first guarantees the context is
  // present by the time the resulting scan runs.
  const unsubscribeReviewGate: Unsubscribe = options.messageBus.subscribe<WorkflowLifecycleEvent>(
    Channels.WORKFLOW_LIFECYCLE,
    (event) => {
      if (!isReviewGateCiFailedEvent(event)) return;
      const task = options.state.getTask(event.taskId);
      if (!task) return;
      reviewGateContexts.set(event.taskId, buildReviewGateCiContext(event, task));
      logger?.info(`recorded review-gate CI failure for ${event.taskId} review=${event.reviewId}`, {
        module: logModule,
      });
    },
  );

  const runtime = startWorkerRuntime<AutoFixCandidate>({
    name: 'autofix-worker',
    messageBus: options.messageBus,
    logger,
    pollIntervalMs: options.pollIntervalMs,
    scanOnStartup: options.scanOnStartup,
    handleSignals: options.handleSignals,
    eventKinds: AUTO_FIX_WORKER_EVENT_KINDS,
    scan: () =>
      scanAutoFixCandidates({
        state: options.state,
        openIntents: options.listOpenFixIntents(),
        reviewGateContexts,
        config: options.config,
      }),
    submit: async (candidate) => {
      // A review-gate context is consumed once: the accepted-command boundary
      // now owns the retry, so re-submitting on the next poll would duplicate.
      if (candidate.source === 'review_gate_ci') {
        reviewGateContexts.delete(candidate.taskId);
      }
      logger?.info(
        `submitting auto-fix for ${candidate.taskId} source=${candidate.source}`,
        { module: logModule },
      );
      await options.submit(candidate);
    },
  });

  return {
    ...runtime,
    stop: () => {
      unsubscribeReviewGate();
      runtime.stop();
    },
  };
}
