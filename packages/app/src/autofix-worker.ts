/**
 * Auto-fix submitter worker.
 *
 * Opt-in worker that observes failed tasks and submits ordinary
 * `fix <taskId> [agent] --auto-fix` requests through the existing
 * mutation surfaces. It is a controller, not an executor: it never calls
 * `autoFixOnFailure` or `TaskRunner` directly, and it never bypasses the
 * owner's normal mutation queue.
 *
 * Polling is authoritative. TASK_DELTA wakeups are an optional acceleration
 * when a message bus is available; if events are missed the next tick
 * recovers them. When no writable owner is reachable the worker skips
 * submission and waits for the next tick — it does not silently take
 * ownership.
 */
import type { Logger } from '@invoker/contracts';
import { Channels, type MessageBus } from '@invoker/transport';
import type { TaskDelta, TaskState } from '@invoker/workflow-core';

import { AUTO_FIX_FLAG } from './auto-fix-intents.js';
import { tryDelegateExec, type DelegationOutcome } from './headless-delegation.js';
import { discoverOwner, isStandaloneCapable, type OwnerDiscoveryResult } from './owner-endpoint.js';

/** Default polling cadence; recovers missed TASK_DELTA wakeups. */
export const DEFAULT_AUTOFIX_WORKER_INTERVAL_MS = 5_000;

/** Hard floor/ceiling on the env-driven override to keep the worker sane. */
const MIN_AUTOFIX_WORKER_INTERVAL_MS = 250;
const MAX_AUTOFIX_WORKER_INTERVAL_MS = 5 * 60_000;

/** Env var that overrides the default poll cadence. */
export const AUTOFIX_WORKER_INTERVAL_ENV = 'INVOKER_AUTOFIX_WORKER_INTERVAL_MS';

export interface AutoFixWorkerConfigSource {
  /** Configured auto-fix agent (e.g. "claude", "codex"); empty/whitespace → no agent arg. */
  autoFixAgent?: string;
  /**
   * When true, the worker submits an auto-fix for review-gate merge tasks
   * whose persisted CI failure snapshot indicates failed checks. Mirrors the
   * old `onReviewGateCiFailure` gate, but evaluated per-tick from persisted
   * state instead of fired from a TaskRunner callback.
   */
  autoFixCi?: boolean;
}

export interface AutoFixWorkerOptions {
  readonly logger: Logger;
  /**
   * Predicate borrowed from the orchestrator. Used to check retry budget
   * and runtime eligibility (same rules manual fix uses).
   */
  readonly shouldAutoFix: (taskId: string) => boolean;
  /**
   * Auto-fix retry budget for a task. Used to gate review-gate CI auto-fix
   * submissions because `shouldAutoFix` only handles `status === 'failed'`.
   * Defaults to a permissive `() => Number.POSITIVE_INFINITY` so existing
   * tests stay unaffected; production wires it to
   * `orchestrator.getAutoFixRetryBudget`.
   */
  readonly getAutoFixRetryBudget?: (taskId: string) => number;
  /**
   * Read-side surface: returns the current task snapshot the worker
   * scans on each tick. The headless wrapper provides a function that
   * syncs the orchestrator from the database first; tests inject a
   * static list.
   */
  readonly loadTasks: () => readonly TaskState[];
  /**
   * Optional message bus. When provided, the worker subscribes to
   * `TASK_DELTA` for early wakeups on `failed` transitions. Polling
   * remains authoritative — missed events are recovered next tick.
   */
  readonly messageBus?: MessageBus;
  readonly loadConfig: () => AutoFixWorkerConfigSource;
  /** Defaults to {@link DEFAULT_AUTOFIX_WORKER_INTERVAL_MS}. */
  readonly intervalMs?: number;
  /**
   * Submit a single `fix <taskId> [agent] --auto-fix` request to the
   * writable owner. Defaults to {@link tryDelegateExec}; tests inject a fake.
   */
  readonly delegateExec?: (args: string[]) => Promise<DelegationOutcome>;
  /**
   * Discover whether a writable owner is currently reachable. Defaults to
   * {@link discoverOwner}; tests inject a fake. The returned value is fed
   * through {@link isStandaloneCapable} to decide whether to submit.
   */
  readonly discoverOwner?: () => Promise<OwnerDiscoveryResult>;
  /**
   * Excludes reconciliation/child tasks in the same spirit as
   * `orchestrator.shouldAutoFix`. Defaults to checking
   * `config.isReconciliation` and `config.parentTask`.
   */
  readonly isReconciliationLike?: (task: TaskState) => boolean;
}

export interface AutoFixWorker {
  /** Run a single scan immediately and submit eligible work. */
  tick(): Promise<void>;
  /** Stop the worker's interval and event subscription; idempotent. */
  stop(): void;
  /** True once {@link stop} has been called. */
  isStopped(): boolean;
}

export function resolveAutoFixWorkerIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[AUTOFIX_WORKER_INTERVAL_ENV];
  if (!raw) return DEFAULT_AUTOFIX_WORKER_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AUTOFIX_WORKER_INTERVAL_MS;
  return Math.min(MAX_AUTOFIX_WORKER_INTERVAL_MS, Math.max(MIN_AUTOFIX_WORKER_INTERVAL_MS, parsed));
}

function defaultIsReconciliationLike(task: TaskState): boolean {
  return Boolean(task.config.isReconciliation) || Boolean(task.config.parentTask);
}

function selectAgentArgs(autoFixAgent: string | undefined): string[] {
  const trimmed = autoFixAgent?.trim();
  return trimmed && trimmed.length > 0 ? [trimmed] : [];
}

/**
 * Start the auto-fix submitter worker.
 *
 * Each tick:
 *   1. Discover a writable (standalone-capable) owner. If none is
 *      reachable, log once per transition and skip submission.
 *   2. Walk `loadTasks()` and pick eligible tasks:
 *        - `failed` tasks that pass `shouldAutoFix(...)`, OR
 *        - merge-gate tasks in `review_ready`/`awaiting_approval` with a
 *          persisted `reviewCiFailure` snapshot, when `autoFixCi` is true
 *          and the retry budget is not exhausted.
 *      Reconciliation/child tasks are excluded.
 *   3. For each eligible task, submit `fix <taskId> [agent] --auto-fix`
 *      via `tryDelegateExec`. Duplicate suppression at the mutation
 *      boundary discards repeats from the same task; the owner handler
 *      routes review-gate submissions to the shared review-gate auto-fix
 *      path by inspecting persisted state.
 */
export function startAutoFixWorker(options: AutoFixWorkerOptions): AutoFixWorker {
  const intervalMs = options.intervalMs ?? resolveAutoFixWorkerIntervalMs();
  const isReconciliationLike = options.isReconciliationLike ?? defaultIsReconciliationLike;
  const messageBus = options.messageBus;
  const delegate = options.delegateExec
    ?? ((args) => {
      if (!messageBus) {
        return Promise.resolve<DelegationOutcome>({ kind: 'no-handler' });
      }
      return tryDelegateExec(args, messageBus);
    });
  const discover = options.discoverOwner
    ?? (() => {
      if (!messageBus) return Promise.resolve<OwnerDiscoveryResult>(null);
      return discoverOwner(messageBus, 1_000);
    });

  let stopped = false;
  let tickInFlight = false;
  let tickQueued = false;
  let lastOwnerAvailable: boolean | undefined;
  // In-flight submissions for this worker process; the mutation queue is
  // still the canonical source of truth (it suppresses duplicates across
  // processes), but tracking locally avoids spamming the IPC delegate
  // before its response lands.
  const submitting = new Set<string>();

  const logger = options.logger;

  const submitOne = async (taskId: string): Promise<void> => {
    if (submitting.has(taskId)) return;
    const cfg = options.loadConfig();
    const args = ['fix', taskId, ...selectAgentArgs(cfg.autoFixAgent), AUTO_FIX_FLAG];
    submitting.add(taskId);
    try {
      const outcome = await delegate(args);
      switch (outcome.kind) {
        case 'delegated':
          logger.info(`auto-fix worker submitted task=${taskId}`, { module: 'auto-fix-worker' });
          break;
        case 'no-handler':
        case 'timeout':
          logger.info(
            `auto-fix worker deferred task=${taskId} outcome=${outcome.kind}`,
            { module: 'auto-fix-worker' },
          );
          break;
        case 'protocol-error':
          logger.error(
            `auto-fix worker protocol error task=${taskId} message=${outcome.message}`,
            { module: 'auto-fix-worker' },
          );
          break;
      }
    } catch (err) {
      logger.error(`auto-fix worker submit failed task=${taskId}`, { module: 'auto-fix-worker', err });
    } finally {
      submitting.delete(taskId);
    }
  };

  const getRetryBudget = options.getAutoFixRetryBudget ?? ((): number => Number.POSITIVE_INFINITY);

  const isReviewGateCiEligible = (task: TaskState, autoFixCi: boolean): boolean => {
    if (!autoFixCi) return false;
    if (!task.execution.reviewCiFailure) return false;
    if (!task.config.workflowId || !task.execution.reviewId) return false;
    if (task.status !== 'review_ready' && task.status !== 'awaiting_approval') return false;
    const budget = getRetryBudget(task.id);
    if (budget <= 0) return false;
    return (task.execution.autoFixAttempts ?? 0) < budget;
  };

  const eligibleTasks = (): TaskState[] => {
    const candidates = options.loadTasks();
    const cfg = options.loadConfig();
    const autoFixCi = cfg.autoFixCi === true;
    const out: TaskState[] = [];
    for (const task of candidates) {
      if (isReconciliationLike(task)) continue;
      if (task.status === 'failed') {
        if (!options.shouldAutoFix(task.id)) continue;
        out.push(task);
        continue;
      }
      if (isReviewGateCiEligible(task, autoFixCi)) {
        out.push(task);
      }
    }
    return out;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (tickInFlight) {
      // Coalesce concurrent wakeups: one queued retry after the current
      // tick finishes is enough; further wakeups are absorbed.
      tickQueued = true;
      return;
    }
    tickInFlight = true;
    try {
      const owner = await discover();
      const ownerAvailable = isStandaloneCapable(owner);
      if (lastOwnerAvailable !== ownerAvailable) {
        if (!ownerAvailable) {
          logger.info('auto-fix worker: no writable owner reachable; will retry on next tick', {
            module: 'auto-fix-worker',
          });
        } else {
          logger.info(`auto-fix worker: writable owner reachable ownerId=${owner?.ownerId ?? '<missing>'}`, {
            module: 'auto-fix-worker',
          });
        }
        lastOwnerAvailable = ownerAvailable;
      }
      if (!ownerAvailable) return;

      const tasks = eligibleTasks();
      if (tasks.length === 0) return;

      for (const task of tasks) {
        if (stopped) break;
        await submitOne(task.id);
      }
    } catch (err) {
      logger.error('auto-fix worker tick failed', { module: 'auto-fix-worker', err });
    } finally {
      tickInFlight = false;
      if (tickQueued && !stopped) {
        tickQueued = false;
        void tick();
      }
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  interval.unref?.();

  const unsubscribe = messageBus
    ? messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
        if (stopped) return;
        if (delta.type !== 'updated') return;
        if (delta.changes.status !== 'failed') return;
        void tick();
      })
    : (): void => {};

  logger.info(`auto-fix worker started intervalMs=${intervalMs}`, { module: 'auto-fix-worker' });

  return {
    tick,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      try { unsubscribe(); } catch { /* bus may already be torn down */ }
      logger.info('auto-fix worker stopped', { module: 'auto-fix-worker' });
    },
    isStopped: () => stopped,
  };
}
