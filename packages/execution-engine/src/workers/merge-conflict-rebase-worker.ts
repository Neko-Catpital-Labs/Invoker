import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
} from '@invoker/data-store';

import type {
  WorkerGitHubClient,
  WorkerGitHubPullRequest,
  WorkerHeadlessClient,
  WorkerStateStore,
} from '../worker-types.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import {
  DEFAULT_CODERABBIT_AUTHOR,
  DEFAULT_CODERABBIT_TARGET_REPO,
} from './coderabbit-update-worker.js';

export const MERGE_CONFLICT_REBASE_WORKER_KIND = 'merge-conflict-rebase';
export const DEFAULT_MERGE_CONFLICT_REBASE_WORKER_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MERGE_CONFLICT_REBASE_MAX_ATTEMPTS = 3;
export const DEFAULT_MERGE_CONFLICT_REBASE_CONFIRM_TIMEOUT_MS = 120_000;
export const DEFAULT_MERGE_CONFLICT_REBASE_CONFIRM_POLL_INTERVAL_MS = 5_000;

const MERGE_CONFLICT_ACTION_TYPE = 'rebase-recreate-conflicting-pr';
const OPEN_OR_DONE_STATUSES = new Set<WorkerActionStatus>([
  'queued',
  'pending',
  'running',
  'needs_input',
  'review_ready',
  'completed',
]);

export interface MergeConflictRebaseWorkerPolicyOptions {
  store: WorkerStateStore;
  github: WorkerGitHubClient;
  headless: WorkerHeadlessClient;
  logger: Logger;
  targetRepo?: string;
  author?: string;
  maxAttempts?: number;
  confirmTimeoutMs?: number;
  confirmPollIntervalMs?: number;
}

export interface MergeConflictRebaseWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  mergeConflict?: Omit<MergeConflictRebaseWorkerPolicyOptions, 'logger'>;
  onTick?: WorkerTick;
}

interface RepoParts {
  owner: string;
  repo: string;
}

interface ConflictMapping {
  workflowId: string;
  mergeTaskId: string;
  workflowGeneration: number;
}

function parseTargetRepo(targetRepo: string): RepoParts {
  const [owner, repo] = targetRepo.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid targetRepo "${targetRepo}". Expected owner/repo.`);
  }
  return { owner, repo };
}

function isConflictingPullRequest(pr: WorkerGitHubPullRequest): boolean {
  return pr.mergeStateStatus === 'DIRTY' || pr.mergeable === 'CONFLICTING';
}

export function mergeConflictRebaseActionKey(args: {
  targetRepo: string;
  workflowId: string;
  generation: number;
}): string {
  return [
    MERGE_CONFLICT_REBASE_WORKER_KIND,
    args.targetRepo,
    args.workflowId,
    `generation-${args.generation}`,
  ].join(':');
}

function actionIdForKey(externalKey: string): string {
  return `${MERGE_CONFLICT_REBASE_WORKER_KIND}:${externalKey}`;
}

function getExistingAction(
  options: MergeConflictRebaseWorkerPolicyOptions,
  externalKey: string,
): WorkerActionRecord | undefined {
  return options.store.getWorkerAction(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey);
}

function logWorkerAction(
  options: MergeConflictRebaseWorkerPolicyOptions,
  action: WorkerActionRecord | WorkerActionWrite,
  phase: string,
): void {
  const taskId = action.taskId;
  if (!taskId) return;
  options.store.logEvent?.(taskId, 'task.worker_action', {
    phase,
    worker: MERGE_CONFLICT_REBASE_WORKER_KIND,
    workerKind: action.workerKind,
    actionType: action.actionType,
    externalKey: action.externalKey,
    status: action.status,
    attemptCount: action.attemptCount ?? 0,
    summary: action.summary ?? null,
    payload: action.payload ?? null,
  });
}

function recordMergeConflictAction(
  options: MergeConflictRebaseWorkerPolicyOptions,
  args: {
    externalKey: string;
    status: WorkerActionStatus;
    pullNumber: number;
    mapping: ConflictMapping;
    summary: string;
    payload?: Record<string, unknown>;
    consumeAttempt?: boolean;
    intentId?: string | number;
  },
): WorkerActionRecord {
  const existing = getExistingAction(options, args.externalKey);
  const now = new Date().toISOString();
  const attemptCount = args.consumeAttempt
    ? (existing?.attemptCount ?? 0) + 1
    : existing?.attemptCount ?? 0;
  const write: WorkerActionWrite = {
    id: existing?.id ?? actionIdForKey(args.externalKey),
    workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    actionType: MERGE_CONFLICT_ACTION_TYPE,
    workflowId: args.mapping.workflowId,
    taskId: args.mapping.mergeTaskId,
    subjectType: 'pull_request',
    subjectId: String(args.pullNumber),
    externalKey: args.externalKey,
    status: args.status,
    attemptCount,
    intentId: args.intentId === undefined ? undefined : String(args.intentId),
    summary: args.summary,
    payload: {
      pullNumber: args.pullNumber,
      targetRepo: options.targetRepo ?? DEFAULT_CODERABBIT_TARGET_REPO,
      workflowId: args.mapping.workflowId,
      mergeTaskId: args.mapping.mergeTaskId,
      workflowGeneration: args.mapping.workflowGeneration,
      maxAttempts: options.maxAttempts ?? DEFAULT_MERGE_CONFLICT_REBASE_MAX_ATTEMPTS,
      ...(args.payload ?? {}),
    },
    updatedAt: now,
    ...(args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
      ? { completedAt: now }
      : {}),
  };
  const saved = options.store.upsertWorkerAction(write);
  logWorkerAction(options, saved, `merge-conflict-rebase-${args.status}`);
  return saved;
}

function normalizeMaxAttempts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MERGE_CONFLICT_REBASE_MAX_ATTEMPTS;
  if (!Number.isFinite(value)) return DEFAULT_MERGE_CONFLICT_REBASE_MAX_ATTEMPTS;
  return Math.max(0, Math.floor(value));
}

function readMapping(
  store: WorkerStateStore,
  pullNumber: number,
): ConflictMapping | undefined {
  const record = store.findReviewGateByPr?.(String(pullNumber));
  if (!record?.workflowId || !record.mergeTaskId) return undefined;
  return {
    workflowId: record.workflowId,
    mergeTaskId: record.mergeTaskId,
    workflowGeneration: record.workflowGeneration ?? 0,
  };
}

function readWorkflowGeneration(store: WorkerStateStore, workflowId: string): number | undefined {
  const generation = store.loadWorkflow?.(workflowId)?.generation;
  return typeof generation === 'number' && Number.isFinite(generation) ? generation : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGenerationAdvance(
  options: MergeConflictRebaseWorkerPolicyOptions,
  workflowId: string,
  previousGeneration: number,
): Promise<number | undefined> {
  const timeoutMs = Math.max(0, options.confirmTimeoutMs ?? DEFAULT_MERGE_CONFLICT_REBASE_CONFIRM_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.confirmPollIntervalMs ?? DEFAULT_MERGE_CONFLICT_REBASE_CONFIRM_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const generation = readWorkflowGeneration(options.store, workflowId);
    if (generation !== undefined && generation > previousGeneration) return generation;
    if (Date.now() >= deadline) return undefined;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

function manualAttentionAlreadyPosted(action: WorkerActionRecord | undefined): boolean {
  const payload = action?.payload;
  return Boolean(
    payload
      && typeof payload === 'object'
      && 'manualAttentionCommented' in payload
      && (payload as { manualAttentionCommented?: unknown }).manualAttentionCommented === true,
  );
}

async function flagManualAttention(
  options: MergeConflictRebaseWorkerPolicyOptions,
  repo: RepoParts,
  pr: WorkerGitHubPullRequest,
  mapping: ConflictMapping,
  externalKey: string,
): Promise<void> {
  const existing = getExistingAction(options, externalKey);
  if (manualAttentionAlreadyPosted(existing)) return;

  if (!options.github.createPullRequestComment) {
    recordMergeConflictAction(options, {
      externalKey,
      status: 'skipped',
      pullNumber: pr.number,
      mapping,
      summary: 'Skipped manual attention comment because GitHub comments are unavailable',
      payload: {
        reason: 'github-comment-unavailable',
        manualAttentionCommented: false,
      },
    });
    return;
  }

  await options.github.createPullRequestComment({
    ...repo,
    pullNumber: pr.number,
    body: `Invoker conflict-rebase worker gave up after ${options.maxAttempts ?? DEFAULT_MERGE_CONFLICT_REBASE_MAX_ATTEMPTS} rebase-recreate attempts; this PR still conflicts and needs manual attention.`,
  });
  recordMergeConflictAction(options, {
    externalKey,
    status: 'skipped',
    pullNumber: pr.number,
    mapping,
    summary: 'Posted manual attention comment after conflict rebase attempts were exhausted',
    payload: {
      reason: 'attempt-cap-exhausted',
      manualAttentionCommented: true,
    },
  });
}

async function handleConflictingPullRequest(
  options: MergeConflictRebaseWorkerPolicyOptions,
  repo: RepoParts,
  pr: WorkerGitHubPullRequest,
): Promise<boolean> {
  const targetRepo = options.targetRepo ?? DEFAULT_CODERABBIT_TARGET_REPO;
  const mapping = readMapping(options.store, pr.number);
  if (!mapping) {
    options.logger.debug?.(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] skip PR with no Invoker workflow mapping`, {
      module: 'merge-conflict-rebase-worker',
      pullNumber: pr.number,
    });
    return false;
  }

  const externalKey = mergeConflictRebaseActionKey({
    targetRepo,
    workflowId: mapping.workflowId,
    generation: mapping.workflowGeneration,
  });
  const existing = getExistingAction(options, externalKey);
  if (existing && OPEN_OR_DONE_STATUSES.has(existing.status)) {
    options.logger.debug?.(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] skip already recorded rebase-recreate`, {
      module: 'merge-conflict-rebase-worker',
      pullNumber: pr.number,
      workflowId: mapping.workflowId,
      generation: mapping.workflowGeneration,
      status: existing.status,
    });
    return false;
  }

  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
  if ((existing?.attemptCount ?? 0) >= maxAttempts) {
    await flagManualAttention(options, repo, pr, mapping, externalKey);
    return false;
  }

  const headlessResult = await options.headless.exec(
    ['rebase-recreate', mapping.workflowId],
    { noTrack: true },
  );
  if (headlessResult && headlessResult.ok === false) {
    recordMergeConflictAction(options, {
      externalKey,
      status: 'failed',
      pullNumber: pr.number,
      mapping,
      consumeAttempt: true,
      summary: 'headless.exec rebase-recreate dispatch failed',
      payload: {
        reason: 'headless-dispatch-failed',
        error: headlessResult.error ?? null,
      },
    });
    return true;
  }

  recordMergeConflictAction(options, {
    externalKey,
    status: 'running',
    pullNumber: pr.number,
    mapping,
    consumeAttempt: true,
    summary: 'Submitted headless.exec rebase-recreate for conflicting PR',
    payload: {
      channel: 'headless.exec',
      args: ['rebase-recreate', mapping.workflowId],
      previousGeneration: mapping.workflowGeneration,
    },
  });

  const newGeneration = await waitForGenerationAdvance(
    options,
    mapping.workflowId,
    mapping.workflowGeneration,
  );
  if (newGeneration === undefined) {
    recordMergeConflictAction(options, {
      externalKey,
      status: 'failed',
      pullNumber: pr.number,
      mapping,
      summary: 'rebase-recreate did not advance workflow generation before timeout',
      payload: {
        reason: 'generation-not-confirmed',
        previousGeneration: mapping.workflowGeneration,
      },
    });
    return true;
  }

  recordMergeConflictAction(options, {
    externalKey,
    status: 'completed',
    pullNumber: pr.number,
    mapping,
    summary: 'Confirmed rebase-recreate advanced workflow generation',
    payload: {
      previousGeneration: mapping.workflowGeneration,
      newGeneration,
    },
  });
  return true;
}

export function createMergeConflictRebaseTick(options: MergeConflictRebaseWorkerPolicyOptions): WorkerTick {
  return async () => {
    if (!options.github.listPullRequests) {
      options.logger.debug?.(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] GitHub listPullRequests unavailable`, {
        module: 'merge-conflict-rebase-worker',
      });
      return;
    }

    const targetRepo = options.targetRepo ?? DEFAULT_CODERABBIT_TARGET_REPO;
    const repo = parseTargetRepo(targetRepo);
    const prs = await options.github.listPullRequests({
      ...repo,
      author: options.author ?? DEFAULT_CODERABBIT_AUTHOR,
      state: 'open',
      limit: 100,
    });

    for (const pr of prs.filter(isConflictingPullRequest)) {
      const handled = await handleConflictingPullRequest(options, repo, pr);
      if (handled) return;
    }
  };
}

export function createMergeConflictRebaseWorker(options: MergeConflictRebaseWorkerOptions): WorkerRuntime {
  const onTick = options.onTick ?? (
    options.mergeConflict
      ? createMergeConflictRebaseTick({ ...options.mergeConflict, logger: options.logger })
      : (() => {})
  );
  return createWorkerRuntime({
    kind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_MERGE_CONFLICT_REBASE_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });
}

export function registerMergeConflictRebaseWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    note: 'Submits headless rebase-recreate for conflicting Invoker-mapped review-gate PRs.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createMergeConflictRebaseWorker({
        logger: deps.logger,
        intervalMs: deps.prMaintenance?.mergeConflict?.pollIntervalMs,
        mergeConflict: deps.github && deps.headless
          ? {
              store: deps.store,
              github: deps.github,
              headless: deps.headless,
              targetRepo: deps.prMaintenance?.targetRepo,
              author: deps.prMaintenance?.author,
              maxAttempts: deps.prMaintenance?.mergeConflict?.maxAttempts,
              confirmTimeoutMs: deps.prMaintenance?.mergeConflict?.confirmTimeoutMs,
              confirmPollIntervalMs: deps.prMaintenance?.mergeConflict?.confirmPollIntervalMs,
            }
          : undefined,
      }),
  });
  return registry;
}
