import type { Logger } from '@invoker/contracts';
import type {
  ReviewGateLookup,
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  Workflow,
} from '@invoker/data-store';

import type { WorkerMutationSubmitter } from '../worker-types.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type {
  PrMaintenanceCommandRunner,
  WorkerGitHubClient,
  WorkerGitHubPullRequest,
} from '../worker-types.js';
import {
  createGhCliWorkerGitHubClient,
  parseTargetRepo,
  runPrMaintenanceCommand,
} from './coderabbit-update-worker.js';

export const MERGE_CONFLICT_REBASE_WORKER_KIND = 'merge-conflict-rebase';
export const DEFAULT_MERGE_CONFLICT_TARGET_REPO = 'Neko-Catpital-Labs/Invoker';
export const DEFAULT_MERGE_CONFLICT_AUTHOR = 'EdbertChan';
export const DEFAULT_MERGE_CONFLICT_MAX_ATTEMPTS = 3;
export const DEFAULT_MERGE_CONFLICT_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MERGE_CONFLICT_CONFIRM_TIMEOUT_MS = 120_000;
export const DEFAULT_MERGE_CONFLICT_CONFIRM_POLL_INTERVAL_MS = 5_000;

const REBASE_ACTION_TYPE = 'rebase-recreate-conflicting-pr';
const MANUAL_ATTENTION_ACTION_TYPE = 'merge-conflict-manual-attention';
const TASK_WORKER_ACTION_EVENT = 'task.worker_action';
const HEADLESS_EXEC_CHANNEL = 'headless.exec';

export interface MergeConflictRebaseWorkerStore {
  findReviewGateByPr?(pr: string): ReviewGateLookup | undefined;
  loadWorkflow?(workflowId: string): Workflow | undefined;
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface MergeConflictRebaseWorkerPolicyOptions {
  store: MergeConflictRebaseWorkerStore;
  submitter: WorkerMutationSubmitter;
  logger: Logger;
  github?: WorkerGitHubClient;
  commandRunner?: PrMaintenanceCommandRunner;
  targetRepo?: string;
  author?: string;
  maxAttempts?: number;
  confirmTimeoutMs?: number;
  confirmPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface MergeConflictRebaseWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  mergeConflictRebase?: Omit<MergeConflictRebaseWorkerPolicyOptions, 'logger'>;
  onTick?: WorkerTick;
}

export function registerMergeConflictRebaseWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    note: 'Rebase-recreates mapped Invoker workflows when their GitHub PR is merge-conflicting.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const configured = deps.prMaintenance?.mergeConflictRebase;
      return createMergeConflictRebaseWorker({
        logger: deps.logger,
        mergeConflictRebase: {
          store: deps.store,
          submitter: deps.submitter,
          targetRepo: configured?.targetRepo ?? deps.prMaintenance?.targetRepo,
          author: configured?.author ?? deps.prMaintenance?.author,
          maxAttempts: configured?.maxAttempts,
          confirmTimeoutMs: configured?.confirmTimeoutMs,
          confirmPollIntervalMs: configured?.confirmPollIntervalMs,
        },
        intervalMs: configured?.pollIntervalMs,
      });
    },
  });
  return registry;
}

export function mergeConflictRebaseActionKey(workflowId: string, generation: number): string {
  return ['merge-conflict-rebase', workflowId, generation].join(':');
}

export function mergeConflictManualAttentionKey(workflowId: string): string {
  return ['merge-conflict-manual-attention', workflowId].join(':');
}

export function createMergeConflictRebaseTick(options: MergeConflictRebaseWorkerPolicyOptions): WorkerTick {
  return async () => {
    const targetRepo = options.targetRepo ?? DEFAULT_MERGE_CONFLICT_TARGET_REPO;
    const repo = parseTargetRepo(targetRepo);
    const github = options.github ?? createGhCliWorkerGitHubClient(options.commandRunner ?? runPrMaintenanceCommand);
    if (!github.listPullRequests) {
      throw new Error('Merge-conflict rebase worker requires GitHub pull-request listing support.');
    }

    const prs = await github.listPullRequests({
      ...repo,
      author: options.author ?? DEFAULT_MERGE_CONFLICT_AUTHOR,
      state: 'open',
      limit: 100,
    });

    for (const pr of prs.filter(isConflictingPr)) {
      const mapping = options.store.findReviewGateByPr?.(String(pr.number));
      if (!mapping) {
        options.logger.info(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] PR #${pr.number} conflicts but has no Invoker mapping; skipping`, {
          module: 'merge-conflict-rebase-worker',
          prNumber: pr.number,
        });
        continue;
      }

      const consumed = await handleConflictingPr({
        options,
        github,
        repo,
        pr,
        mapping,
      });
      if (consumed) return;
    }

    options.logger.debug?.(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] no actionable conflicting PRs this tick`, {
      module: 'merge-conflict-rebase-worker',
    });
  };
}

export function createMergeConflictRebaseWorker(options: MergeConflictRebaseWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_MERGE_CONFLICT_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? (
      options.mergeConflictRebase
        ? createMergeConflictRebaseTick({ ...options.mergeConflictRebase, logger: options.logger })
        : (() => {})
    ),
  });
}

async function handleConflictingPr(args: {
  options: MergeConflictRebaseWorkerPolicyOptions;
  github: WorkerGitHubClient;
  repo: { owner: string; repo: string };
  pr: WorkerGitHubPullRequest;
  mapping: ReviewGateLookup;
}): Promise<boolean> {
  const { options, github, repo, pr, mapping } = args;
  const generation = mapping.workflowGeneration ?? 0;
  const externalKey = mergeConflictRebaseActionKey(mapping.workflowId, generation);
  const existing = options.store.getWorkerAction?.(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey);

  if (existing?.status === 'completed') {
    logTaskWorkerAction(options, mapping, existing, 'skip', {
      reason: 'already-confirmed',
      generation,
      prNumber: pr.number,
    });
    return false;
  }

  const currentGeneration = options.store.loadWorkflow?.(mapping.workflowId)?.generation ?? mapping.workflowGeneration;
  if (currentGeneration > generation) {
    recordRebaseAction(options, mapping, pr, generation, 'completed', 'Rebase-recreate already advanced workflow generation', {
      reason: 'generation-already-advanced',
      currentGeneration,
    }, false, existing);
    return false;
  }

  const maxAttempts = normalizePositiveInteger(options.maxAttempts, DEFAULT_MERGE_CONFLICT_MAX_ATTEMPTS);
  if ((existing?.attemptCount ?? 0) >= maxAttempts) {
    return await ensureManualAttentionComment(options, github, repo, pr, mapping, maxAttempts);
  }

  let intentId: number;
  try {
    intentId = options.submitter.submit(mapping.workflowId, 'high', HEADLESS_EXEC_CHANNEL, [{
      args: ['rebase-recreate', mapping.workflowId],
      noTrack: true,
    }]);
  } catch (err) {
    recordRebaseAction(options, mapping, pr, generation, 'failed', `Rebase-recreate dispatch failed: ${errorMessage(err)}`, {
      reason: 'dispatch-failed',
      error: errorMessage(err),
    }, false, existing);
    throw err;
  }

  const queued = recordRebaseAction(options, mapping, pr, generation, 'queued', 'Queued rebase-recreate for conflicting PR', {
    channel: HEADLESS_EXEC_CHANNEL,
    intentId,
  }, true, existing, intentId);

  const advanced = await waitForGenerationAdvanced(options, mapping.workflowId, generation);
  if (advanced.advanced) {
    recordRebaseAction(options, mapping, pr, generation, 'completed', 'Rebase-recreate confirmed', {
      previousGeneration: generation,
      currentGeneration: advanced.currentGeneration,
      intentId,
    }, false, queued, intentId);
    return true;
  }

  recordRebaseAction(options, mapping, pr, generation, 'failed', 'Rebase-recreate did not advance workflow generation before timeout', {
    reason: 'generation-confirm-timeout',
    previousGeneration: generation,
    currentGeneration: advanced.currentGeneration,
    intentId,
  }, false, queued, intentId);
  return true;
}

async function ensureManualAttentionComment(
  options: MergeConflictRebaseWorkerPolicyOptions,
  github: WorkerGitHubClient,
  repo: { owner: string; repo: string },
  pr: WorkerGitHubPullRequest,
  mapping: ReviewGateLookup,
  maxAttempts: number,
): Promise<boolean> {
  if (!github.createPullRequestComment) {
    throw new Error('Merge-conflict rebase worker requires GitHub PR commenting support.');
  }
  const externalKey = mergeConflictManualAttentionKey(mapping.workflowId);
  const existing = options.store.getWorkerAction?.(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey);
  if (existing?.status === 'completed') {
    logTaskWorkerAction(options, mapping, existing, 'skip', {
      reason: 'manual-attention-already-commented',
      prNumber: pr.number,
    });
    return false;
  }

  const body = `Invoker conflict-rebase worker gave up after ${maxAttempts} rebase-recreate attempts; this PR still conflicts and needs manual attention.`;
  try {
    await github.createPullRequestComment({
      ...repo,
      pullNumber: pr.number,
      body,
    });
    const record = upsertAction(options, {
      existing,
      externalKey,
      actionType: MANUAL_ATTENTION_ACTION_TYPE,
      mapping,
      pr,
      generation: mapping.workflowGeneration,
      status: 'completed',
      summary: 'Posted manual-attention comment for merge conflict',
      payload: {
        reason: 'attempt-cap',
        maxAttempts,
        commentBody: body,
      },
      incrementAttempt: false,
    });
    if (record) logTaskWorkerAction(options, mapping, record, 'manual-attention-commented', { maxAttempts, prNumber: pr.number });
    return true;
  } catch (err) {
    const record = upsertAction(options, {
      existing,
      externalKey,
      actionType: MANUAL_ATTENTION_ACTION_TYPE,
      mapping,
      pr,
      generation: mapping.workflowGeneration,
      status: 'failed',
      summary: `Manual-attention comment failed: ${errorMessage(err)}`,
      payload: {
        reason: 'manual-attention-comment-failed',
        error: errorMessage(err),
        maxAttempts,
      },
      incrementAttempt: false,
    });
    if (record) logTaskWorkerAction(options, mapping, record, 'manual-attention-comment-failed', { maxAttempts, prNumber: pr.number });
    throw err;
  }
}

async function waitForGenerationAdvanced(
  options: MergeConflictRebaseWorkerPolicyOptions,
  workflowId: string,
  previousGeneration: number,
): Promise<{ advanced: boolean; currentGeneration: number }> {
  const timeoutMs = options.confirmTimeoutMs ?? DEFAULT_MERGE_CONFLICT_CONFIRM_TIMEOUT_MS;
  const pollMs = options.confirmPollIntervalMs ?? DEFAULT_MERGE_CONFLICT_CONFIRM_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  const startedAt = Date.now();
  while (true) {
    const currentGeneration = options.store.loadWorkflow?.(workflowId)?.generation ?? previousGeneration;
    if (currentGeneration > previousGeneration) {
      return { advanced: true, currentGeneration };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { advanced: false, currentGeneration };
    }
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
  }
}

function recordRebaseAction(
  options: MergeConflictRebaseWorkerPolicyOptions,
  mapping: ReviewGateLookup,
  pr: WorkerGitHubPullRequest,
  generation: number,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown>,
  incrementAttempt: boolean,
  base?: WorkerActionRecord,
  intentId?: number,
): WorkerActionRecord | undefined {
  const externalKey = mergeConflictRebaseActionKey(mapping.workflowId, generation);
  const record = upsertAction(options, {
    existing: base ?? options.store.getWorkerAction?.(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey),
    externalKey,
    actionType: REBASE_ACTION_TYPE,
    mapping,
    pr,
    generation,
    status,
    summary,
    payload,
    incrementAttempt,
    intentId,
  });
  if (record) logTaskWorkerAction(options, mapping, record, status, { generation, prNumber: pr.number, ...payload });
  return record;
}

function upsertAction(
  options: MergeConflictRebaseWorkerPolicyOptions,
  args: {
    existing?: WorkerActionRecord;
    externalKey: string;
    actionType: string;
    mapping: ReviewGateLookup;
    pr: WorkerGitHubPullRequest;
    generation: number;
    status: WorkerActionStatus;
    summary: string;
    payload: Record<string, unknown>;
    incrementAttempt: boolean;
    intentId?: number;
  },
): WorkerActionRecord | undefined {
  const now = (options.now?.() ?? new Date()).toISOString();
  return options.store.upsertWorkerAction?.({
    id: args.existing?.id ?? `${MERGE_CONFLICT_REBASE_WORKER_KIND}:${args.externalKey}`,
    workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    actionType: args.actionType,
    workflowId: args.mapping.workflowId,
    taskId: args.mapping.mergeTaskId,
    subjectType: 'pull_request',
    subjectId: String(args.pr.number),
    externalKey: args.externalKey,
    status: args.status,
    attemptCount: args.incrementAttempt ? (args.existing?.attemptCount ?? 0) + 1 : args.existing?.attemptCount ?? 0,
    ...(args.intentId !== undefined ? { intentId: String(args.intentId) } : {}),
    summary: args.summary,
    payload: {
      prNumber: args.pr.number,
      prUrl: args.pr.url,
      workflowGeneration: args.generation,
      mergeStateStatus: args.pr.mergeStateStatus ?? null,
      mergeable: args.pr.mergeable ?? null,
      ...args.payload,
    },
    updatedAt: now,
    ...(args.status === 'completed' || args.status === 'failed' || args.status === 'skipped' ? { completedAt: now } : {}),
  });
}

function logTaskWorkerAction(
  options: MergeConflictRebaseWorkerPolicyOptions,
  mapping: ReviewGateLookup,
  action: WorkerActionRecord,
  phase: string,
  details: Record<string, unknown>,
): void {
  options.store.logEvent?.(mapping.mergeTaskId, TASK_WORKER_ACTION_EVENT, {
    worker: MERGE_CONFLICT_REBASE_WORKER_KIND,
    phase,
    actionId: action.id,
    actionType: action.actionType,
    status: action.status,
    workflowId: mapping.workflowId,
    prNumber: action.subjectId,
    summary: action.summary ?? null,
    ...details,
  });
}

function isConflictingPr(pr: WorkerGitHubPullRequest): boolean {
  return pr.mergeStateStatus === 'DIRTY' || pr.mergeable === 'CONFLICTING';
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
