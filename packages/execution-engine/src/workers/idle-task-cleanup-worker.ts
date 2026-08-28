import type { Logger } from '@invoker/contracts';
import type { WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type { PrMaintenanceGitHub } from './pr-maintenance-github.js';
import { isCleanupEligibleWorkflow } from './idle-task-cleanup-policy.js';

export const IDLE_TASK_CLEANUP_WORKER_KIND = 'idle-task-cleanup';
export const CLOSE_IDLE_TASK_CHANNEL = 'invoker:close-idle-task';

const DEFAULT_IDLE_TASK_CLEANUP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_IDLE_THRESHOLD_MS = 15 * 60_000;
const CLOSABLE_STATUSES = new Set(['failed', 'completed', 'review_ready']);
const ADMIN_BYPASS_REPAIR_PR_NUMBER = /^repair-pr-(\d+)-.+$/;

/**
 * Hardcoded, not env-gated: this ships dry-run only. Flipping to live is a
 * separate, explicitly-reviewed follow-up that removes this constant — no
 * config toggle can accidentally turn on real PR/branch/task mutation.
 */
const FORCE_DRY_RUN = true;

export interface IdleTaskCleanupWorkflowRow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface IdleTaskCleanupWorkerStore {
  listWorkflows(): ReadonlyArray<IdleTaskCleanupWorkflowRow>;
  loadTasks(workflowId: string): TaskState[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface IdleTaskCleanupWorkerSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof CLOSE_IDLE_TASK_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface CloseIdleTaskMutationArgs {
  readonly taskId: string;
}

export function buildCloseIdleTaskMutationArgs(taskId: string): unknown[] {
  return [{ taskId } satisfies CloseIdleTaskMutationArgs];
}

export function parseCloseIdleTaskMutationArgs(args: unknown[]): CloseIdleTaskMutationArgs {
  const [raw] = args;
  if (!raw || typeof raw !== 'object' || typeof (raw as { taskId?: unknown }).taskId !== 'string') {
    throw new Error('invoker:close-idle-task mutation requires { taskId: string }');
  }
  return { taskId: (raw as CloseIdleTaskMutationArgs).taskId };
}

export type CleanupAction =
  | { kind: 'close-task-only'; taskId: string; workflowId: string; reason: string }
  | {
      kind: 'close-task-and-pr';
      taskId: string;
      workflowId: string;
      prNumber: number;
      deleteBranch: boolean;
      reason: string;
    };

/**
 * Resolve the PR this task's family owns, if any:
 *   - admin-bypass-repair: the PR number is embedded directly in the
 *     `repair-pr-<num>-<fingerprint>` workflow name (the PR being repaired).
 *   - e2e-repair: only the workflow's merge-node task carries a PR — its
 *     `execution.reviewId` is the provider identifier set by
 *     `GitHubMergeGateProvider.createReview` (`merge-runner.ts`). A non-merge
 *     task in the same workflow has no PR of its own.
 */
function resolvePrNumber(workflow: IdleTaskCleanupWorkflowRow, task: TaskState): number | undefined {
  const adminBypassMatch = workflow.name.match(ADMIN_BYPASS_REPAIR_PR_NUMBER);
  if (adminBypassMatch) return Number(adminBypassMatch[1]);
  const reviewId = task.execution.reviewId;
  if (reviewId) {
    const n = Number(reviewId);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function idleMinutes(idleMs: number): number {
  return Math.round(idleMs / 60_000);
}

/**
 * Pure decision function: given the candidate workflows/tasks and a
 * merged-PR checker, decide what cleanup (if anything) each idle task needs.
 * No side effects — the worker tick executes (or, in dry-run, only logs)
 * whatever this returns. Kept separate from the tick so the decision logic
 * (scope, idle threshold, unconditional vs merged-only PR teardown) is
 * testable without a real WorkerRuntime.
 */
export async function planIdleTaskCleanup(
  workflows: ReadonlyArray<IdleTaskCleanupWorkflowRow>,
  loadTasks: (workflowId: string) => TaskState[],
  opts: {
    now: number;
    idleThresholdMs: number;
    isPullRequestMerged: (prNumber: number) => Promise<boolean>;
  },
): Promise<CleanupAction[]> {
  const actions: CleanupAction[] = [];

  for (const workflow of workflows) {
    if (!isCleanupEligibleWorkflow(workflow)) continue;

    for (const task of loadTasks(workflow.id)) {
      if (!CLOSABLE_STATUSES.has(task.status)) continue;
      const completedAt = task.execution.completedAt;
      if (!completedAt) continue;
      const idleMs = opts.now - new Date(completedAt).getTime();
      if (idleMs < opts.idleThresholdMs) continue;

      const prNumber = resolvePrNumber(workflow, task);

      if (task.status === 'failed' || task.status === 'review_ready') {
        actions.push(
          prNumber === undefined
            ? {
                kind: 'close-task-only',
                taskId: task.id,
                workflowId: workflow.id,
                reason: `${task.status}, idle ${idleMinutes(idleMs)}m, no associated PR`,
              }
            : {
                kind: 'close-task-and-pr',
                taskId: task.id,
                workflowId: workflow.id,
                prNumber,
                deleteBranch: true,
                reason: `${task.status}, idle ${idleMinutes(idleMs)}m`,
              },
        );
        continue;
      }

      // completed: only close the PR/branch once it's already merged;
      // otherwise task-only bookkeeping, leaving an in-flight PR untouched.
      if (prNumber === undefined) {
        actions.push({
          kind: 'close-task-only',
          taskId: task.id,
          workflowId: workflow.id,
          reason: `completed, idle ${idleMinutes(idleMs)}m, no associated PR`,
        });
        continue;
      }
      const merged = await opts.isPullRequestMerged(prNumber);
      actions.push(
        merged
          ? {
              kind: 'close-task-and-pr',
              taskId: task.id,
              workflowId: workflow.id,
              prNumber,
              deleteBranch: true,
              reason: `completed, idle ${idleMinutes(idleMs)}m, PR already merged`,
            }
          : {
              kind: 'close-task-only',
              taskId: task.id,
              workflowId: workflow.id,
              reason: `completed, idle ${idleMinutes(idleMs)}m, PR not yet merged`,
            },
      );
    }
  }

  return actions;
}

export interface IdleTaskCleanupWorkerConfig {
  github: PrMaintenanceGitHub;
  intervalMs?: number;
  idleThresholdMs?: number;
  tickOnStart?: boolean;
  now?: () => number;
  onTick?: WorkerTick;
}

export interface IdleTaskCleanupWorkerOptions extends IdleTaskCleanupWorkerConfig {
  logger: Logger;
  store: IdleTaskCleanupWorkerStore;
  submitter: IdleTaskCleanupWorkerSubmitter;
}

function describeAction(action: CleanupAction): string {
  return action.kind === 'close-task-and-pr'
    ? `close task + PR #${action.prNumber}${action.deleteBranch ? ' + delete branch' : ''}`
    : 'close task only';
}

export function createIdleTaskCleanupWorker(options: IdleTaskCleanupWorkerOptions): WorkerRuntime {
  const idleThresholdMs = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const now = options.now ?? (() => Date.now());

  return createWorkerRuntime({
    kind: IDLE_TASK_CLEANUP_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_IDLE_TASK_CLEANUP_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    onTick: async (ctx) => {
      ctx.signal?.throwIfAborted();
      await options.onTick?.(ctx);
      ctx.signal?.throwIfAborted();

      const workflows = options.store.listWorkflows();
      const actions = await planIdleTaskCleanup(
        workflows,
        (workflowId) => options.store.loadTasks(workflowId),
        {
          now: now(),
          idleThresholdMs,
          isPullRequestMerged: async (prNumber) => {
            const pr = await options.github.viewPullRequest(prNumber, ['state', 'mergedAt']);
            return pr.state === 'MERGED' || Boolean(pr.mergedAt);
          },
        },
      );

      for (const action of actions) {
        if (ctx.signal?.aborted) return;

        if (FORCE_DRY_RUN) {
          options.logger.info(
            `[idle-task-cleanup] (dry-run) would ${describeAction(action)}: ${action.taskId} (${action.reason})`,
            { module: 'idle-task-cleanup', taskId: action.taskId, workflowId: action.workflowId },
          );
          continue;
        }

        if (action.kind === 'close-task-and-pr') {
          const closed = await options.github.closePullRequest(action.prNumber, {
            deleteBranch: action.deleteBranch,
          });
          options.logger.info(
            `[idle-task-cleanup] ${closed ? 'closed' : 'failed to close'} PR #${action.prNumber} for task ${action.taskId}`,
            {
              module: 'idle-task-cleanup',
              taskId: action.taskId,
              workflowId: action.workflowId,
              prNumber: action.prNumber,
            },
          );
        }

        const intentId = options.submitter.submit(
          action.workflowId,
          'normal',
          CLOSE_IDLE_TASK_CHANNEL,
          buildCloseIdleTaskMutationArgs(action.taskId),
        );
        options.store.logEvent?.(action.taskId, 'idle-task-cleanup.submit', {
          worker: IDLE_TASK_CLEANUP_WORKER_KIND,
          intentId,
          channel: CLOSE_IDLE_TASK_CHANNEL,
          reason: action.reason,
        });
      }
    },
  });
}

/** Register the built-in idle-task-cleanup worker (dry-run only in this version). */
export function registerIdleTaskCleanupWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: IDLE_TASK_CLEANUP_WORKER_KIND,
    note: 'Dry-run: reports failed/completed/review_ready admin-bypass-repair and e2e-repair tasks idle 15+ minutes.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const config = deps.idleTaskCleanup;
      if (!config) {
        throw new Error('idle-task-cleanup worker requires deps.idleTaskCleanup (github client) to be configured');
      }
      return createIdleTaskCleanupWorker({
        logger: deps.logger,
        store: deps.store,
        submitter: deps.submitter,
        github: config.github,
        intervalMs: config.intervalMs,
        idleThresholdMs: config.idleThresholdMs,
        tickOnStart: config.tickOnStart,
        now: config.now,
      });
    },
  });
  return registry;
}
