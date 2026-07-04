import { spawn } from 'node:child_process';

import type { Logger } from '@invoker/contracts';
import type {
  ReviewGateLookup,
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type {
  PrMaintenanceWorkerConfig,
  WorkerGitHubClient,
  WorkerGitHubPullRequest,
  WorkerMutationSubmitter,
  WorkerStateStore,
} from '../worker-types.js';

export const MERGE_CONFLICT_REBASE_WORKER_KIND = 'merge-conflict-rebase';
export const DEFAULT_MERGE_CONFLICT_REBASE_WORKER_INTERVAL_MS = 5 * 60_000;

const REBASE_ACTION_TYPE = 'rebase-recreate-conflicting-pr';
const MANUAL_ATTENTION_ACTION_TYPE = 'manual-attention-conflicting-pr';
const HEADLESS_EXEC_CHANNEL = 'headless.exec';
const DEFAULT_TARGET_REPO = 'Neko-Catpital-Labs/Invoker';
const DEFAULT_PR_AUTHOR = 'EdbertChan';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;
const DEFAULT_CONFIRM_POLL_MS = 5_000;
const DEFAULT_PR_LIMIT = 100;

type GhJsonObject = Record<string, unknown>;

export interface MergeConflictRebaseWorkerStore extends WorkerStateStore {}

export interface MergeConflictRebaseResolvedConfig {
  targetRepo: string;
  author: string;
  maxAttempts: number;
  confirmTimeoutMs: number;
  confirmPollMs: number;
  pollIntervalMs: number;
}

export interface MergeConflictRebaseWorkerPolicyOptions {
  store: MergeConflictRebaseWorkerStore;
  submitter: WorkerMutationSubmitter;
  github?: WorkerGitHubClient;
  logger: Logger;
  config?: PrMaintenanceWorkerConfig;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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

export function registerMergeConflictRebaseWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    note: 'Submits headless rebase-recreate for Invoker-mapped PRs that GitHub reports as conflicting.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createMergeConflictRebaseWorker({
        logger: deps.logger,
        mergeConflict: {
          store: deps.store,
          submitter: deps.submitter,
          github: deps.github,
          config: deps.prMaintenance,
        },
      }),
  });
  return registry;
}

function parsePositiveInteger(value: string | number | undefined, fallback: number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDurationMs(value: string | number | undefined, fallbackMs: number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallbackMs;
  }
  const trimmed = value?.trim();
  if (!trimmed) return fallbackMs;
  const match = trimmed.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) return fallbackMs;
  const amount = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(amount) || amount <= 0) return fallbackMs;
  const unit = (match[2] ?? 'ms').toLowerCase();
  if (unit === 'h') return amount * 60 * 60_000;
  if (unit === 'm') return amount * 60_000;
  if (unit === 's') return amount * 1_000;
  return amount;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function resolveMergeConflictRebaseWorkerConfig(
  config: PrMaintenanceWorkerConfig | undefined = {},
): MergeConflictRebaseResolvedConfig {
  return {
    targetRepo: firstNonEmpty(
      process.env.INVOKER_GITHUB_TARGET_REPO,
      config.targetRepo,
      DEFAULT_TARGET_REPO,
    )!,
    author: firstNonEmpty(
      process.env.INVOKER_PR_CRON_AUTHOR,
      config.author,
      DEFAULT_PR_AUTHOR,
    )!,
    maxAttempts: parsePositiveInteger(
      process.env.INVOKER_PR_REBASE_MAX_ATTEMPTS ?? config.mergeConflictMaxAttempts,
      DEFAULT_MAX_ATTEMPTS,
    ),
    confirmTimeoutMs: parseDurationMs(
      process.env.INVOKER_PR_REBASE_CONFIRM_TIMEOUT
        ? `${process.env.INVOKER_PR_REBASE_CONFIRM_TIMEOUT}s`
        : config.mergeConflictConfirmTimeoutMs,
      DEFAULT_CONFIRM_TIMEOUT_MS,
    ),
    confirmPollMs: parseDurationMs(
      process.env.INVOKER_PR_REBASE_CONFIRM_POLL_MS ?? config.mergeConflictConfirmPollMs,
      DEFAULT_CONFIRM_POLL_MS,
    ),
    pollIntervalMs: parseDurationMs(
      process.env.INVOKER_PR_CONFLICT_REBASE_POLL_INTERVAL_MS ?? config.mergeConflictPollIntervalMs,
      DEFAULT_MERGE_CONFLICT_REBASE_WORKER_INTERVAL_MS,
    ),
  };
}

function splitRepo(targetRepo: string): { owner: string; repo: string } {
  const [owner, repo] = targetRepo.split('/');
  if (!owner || !repo || targetRepo.split('/').length !== 2) {
    throw new Error(`Invalid GitHub target repo "${targetRepo}". Expected owner/repo.`);
  }
  return { owner, repo };
}

function isConflictingPr(pr: WorkerGitHubPullRequest): boolean {
  return pr.mergeStateStatus === 'DIRTY' || pr.mergeable === 'CONFLICTING';
}

export function mergeConflictRebaseActionKey(workflowId: string, generation: number): string {
  return `rebase-recreate:${workflowId}:${generation}`;
}

function manualAttentionActionKey(workflowId: string): string {
  return `manual-attention:${workflowId}`;
}

function actionIdForKey(externalKey: string): string {
  return `${MERGE_CONFLICT_REBASE_WORKER_KIND}:${externalKey}`;
}

function logWorkerActionEvent(
  store: MergeConflictRebaseWorkerStore,
  logger: Logger,
  reviewGate: ReviewGateLookup,
  action: WorkerActionRecord | WorkerActionWrite,
  phase: string,
  payload: Record<string, unknown>,
): void {
  const eventPayload = {
    phase,
    workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    actionType: action.actionType,
    actionId: action.id,
    externalKey: action.externalKey,
    workflowId: action.workflowId ?? reviewGate.workflowId,
    taskId: action.taskId ?? reviewGate.mergeTaskId,
    status: action.status,
    attemptCount: action.attemptCount ?? 0,
    ...payload,
  };
  store.logEvent?.(reviewGate.mergeTaskId, 'task.worker_action', eventPayload);
  logger.info(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] ${phase}`, {
    module: 'merge-conflict-rebase-worker',
    ...eventPayload,
  });
}

function recordMergeConflictAction(
  options: MergeConflictRebaseWorkerPolicyOptions,
  args: {
    pr: WorkerGitHubPullRequest;
    reviewGate: ReviewGateLookup;
    generation: number;
    status: WorkerActionStatus;
    summary: string;
    payload?: Record<string, unknown>;
    attemptCount?: number;
    intentId?: number | string;
  },
): WorkerActionRecord {
  const externalKey = mergeConflictRebaseActionKey(args.reviewGate.workflowId, args.generation);
  const existing = options.store.getWorkerAction(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey);
  const now = new Date().toISOString();
  const write: WorkerActionWrite = {
    id: existing?.id ?? actionIdForKey(externalKey),
    workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    actionType: REBASE_ACTION_TYPE,
    workflowId: args.reviewGate.workflowId,
    taskId: args.reviewGate.mergeTaskId,
    subjectType: 'pull_request',
    subjectId: String(args.pr.number),
    externalKey,
    status: args.status,
    attemptCount: args.attemptCount ?? existing?.attemptCount ?? 0,
    intentId: args.intentId === undefined ? existing?.intentId : String(args.intentId),
    summary: args.summary,
    payload: {
      prNumber: args.pr.number,
      prUrl: args.pr.url,
      workflowId: args.reviewGate.workflowId,
      mergeTaskId: args.reviewGate.mergeTaskId,
      generation: args.generation,
      mergeable: args.pr.mergeable ?? null,
      mergeStateStatus: args.pr.mergeStateStatus ?? null,
      ...args.payload,
    },
    updatedAt: now,
    ...(args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
      ? { completedAt: now }
      : {}),
  };
  const saved = options.store.upsertWorkerAction(write);
  logWorkerActionEvent(options.store, options.logger, args.reviewGate, saved, `merge-conflict-${args.status}`, {
    prNumber: args.pr.number,
    generation: args.generation,
    summary: args.summary,
  });
  return saved;
}

function recordManualAttentionAction(
  options: MergeConflictRebaseWorkerPolicyOptions,
  args: {
    pr: WorkerGitHubPullRequest;
    reviewGate: ReviewGateLookup;
    status: WorkerActionStatus;
    summary: string;
    payload?: Record<string, unknown>;
  },
): WorkerActionRecord {
  const externalKey = manualAttentionActionKey(args.reviewGate.workflowId);
  const existing = options.store.getWorkerAction(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey);
  const now = new Date().toISOString();
  const write: WorkerActionWrite = {
    id: existing?.id ?? actionIdForKey(externalKey),
    workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    actionType: MANUAL_ATTENTION_ACTION_TYPE,
    workflowId: args.reviewGate.workflowId,
    taskId: args.reviewGate.mergeTaskId,
    subjectType: 'pull_request',
    subjectId: String(args.pr.number),
    externalKey,
    status: args.status,
    attemptCount: existing?.attemptCount ?? 0,
    summary: args.summary,
    payload: {
      prNumber: args.pr.number,
      prUrl: args.pr.url,
      workflowId: args.reviewGate.workflowId,
      ...args.payload,
    },
    updatedAt: now,
    ...(args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
      ? { completedAt: now }
      : {}),
  };
  const saved = options.store.upsertWorkerAction(write);
  logWorkerActionEvent(options.store, options.logger, args.reviewGate, saved, `merge-conflict-manual-attention-${args.status}`, {
    prNumber: args.pr.number,
    summary: args.summary,
  });
  return saved;
}

function isAlreadyHandledStatus(status: WorkerActionStatus): boolean {
  return status === 'queued'
    || status === 'pending'
    || status === 'running'
    || status === 'completed'
    || status === 'needs_input'
    || status === 'review_ready';
}

async function confirmGenerationAdvanced(
  options: MergeConflictRebaseWorkerPolicyOptions,
  workflowId: string,
  generation: number,
  config: MergeConflictRebaseResolvedConfig,
): Promise<number | undefined> {
  const loadWorkflow = options.store.loadWorkflow;
  if (!loadWorkflow) return undefined;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  const deadline = now() + config.confirmTimeoutMs;
  while (now() <= deadline) {
    const currentGeneration = loadWorkflow.call(options.store, workflowId)?.generation ?? 0;
    if (currentGeneration > generation) return currentGeneration;
    await sleep(config.confirmPollMs);
  }
  return undefined;
}

async function postManualAttentionOnce(
  options: MergeConflictRebaseWorkerPolicyOptions,
  config: MergeConflictRebaseResolvedConfig,
  repo: { owner: string; repo: string },
  pr: WorkerGitHubPullRequest,
  reviewGate: ReviewGateLookup,
): Promise<void> {
  const key = manualAttentionActionKey(reviewGate.workflowId);
  const existing = options.store.getWorkerAction(MERGE_CONFLICT_REBASE_WORKER_KIND, key);
  if (existing?.status === 'completed') {
    logWorkerActionEvent(options.store, options.logger, reviewGate, existing, 'merge-conflict-manual-attention-skip', {
      reason: 'already-commented',
      prNumber: pr.number,
    });
    return;
  }
  if (!options.github?.createPullRequestComment) {
    recordManualAttentionAction(options, {
      pr,
      reviewGate,
      status: 'failed',
      summary: 'Could not post manual-attention comment because GitHub comment dependency is unavailable',
      payload: { reason: 'github-comment-unavailable' },
    });
    return;
  }

  const body = `Invoker conflict-rebase worker gave up after ${config.maxAttempts} rebase-recreate attempts; this PR still conflicts and needs manual attention.`;
  await options.github.createPullRequestComment({
    ...repo,
    pullNumber: pr.number,
    body,
  });
  recordManualAttentionAction(options, {
    pr,
    reviewGate,
    status: 'completed',
    summary: 'Posted one-time manual-attention comment for exhausted conflict rebase',
    payload: {
      maxAttempts: config.maxAttempts,
      body,
    },
  });
}

async function handleConflictingPr(
  options: MergeConflictRebaseWorkerPolicyOptions,
  config: MergeConflictRebaseResolvedConfig,
  repo: { owner: string; repo: string },
  pr: WorkerGitHubPullRequest,
): Promise<'attempted' | 'skipped'> {
  const reviewGate = options.store.findReviewGateByPr?.(String(pr.number));
  if (!reviewGate) {
    options.logger.info(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] skipped unmapped PR`, {
      module: 'merge-conflict-rebase-worker',
      prNumber: pr.number,
      reason: 'no-invoker-workflow-mapping',
    });
    return 'skipped';
  }

  const generation = reviewGate.workflowGeneration ?? 0;
  const externalKey = mergeConflictRebaseActionKey(reviewGate.workflowId, generation);
  const existing = options.store.getWorkerAction(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey);
  if (existing && isAlreadyHandledStatus(existing.status)) {
    logWorkerActionEvent(options.store, options.logger, reviewGate, existing, 'merge-conflict-skip', {
      reason: 'already-recorded',
      prNumber: pr.number,
      generation,
      existingStatus: existing.status,
    });
    return 'skipped';
  }
  if ((existing?.attemptCount ?? 0) >= config.maxAttempts) {
    recordMergeConflictAction(options, {
      pr,
      reviewGate,
      generation,
      status: 'skipped',
      summary: 'Skipped rebase-recreate because retry budget is exhausted',
      attemptCount: existing?.attemptCount ?? config.maxAttempts,
      payload: {
        reason: 'retry-budget-exhausted',
        maxAttempts: config.maxAttempts,
      },
    });
    await postManualAttentionOnce(options, config, repo, pr, reviewGate);
    return 'skipped';
  }

  const attemptCount = (existing?.attemptCount ?? 0) + 1;
  const mutationArgs = [{
    args: ['rebase-recreate', reviewGate.workflowId],
    noTrack: true,
  }];
  const intentId = options.submitter.submit(
    reviewGate.workflowId,
    'high' satisfies WorkflowMutationPriority,
    HEADLESS_EXEC_CHANNEL,
    mutationArgs,
  );
  recordMergeConflictAction(options, {
    pr,
    reviewGate,
    generation,
    status: 'queued',
    summary: 'Queued headless rebase-recreate for conflicting PR',
    attemptCount,
    intentId,
    payload: {
      channel: HEADLESS_EXEC_CHANNEL,
      mutationArgs,
      maxAttempts: config.maxAttempts,
    },
  });

  const newGeneration = await confirmGenerationAdvanced(options, reviewGate.workflowId, generation, config);
  if (newGeneration !== undefined) {
    recordMergeConflictAction(options, {
      pr,
      reviewGate,
      generation,
      status: 'completed',
      summary: `Confirmed rebase-recreate advanced generation ${generation} -> ${newGeneration}`,
      attemptCount,
      intentId,
      payload: {
        confirmedGeneration: newGeneration,
      },
    });
  } else {
    recordMergeConflictAction(options, {
      pr,
      reviewGate,
      generation,
      status: 'failed',
      summary: 'Rebase-recreate did not advance workflow generation before timeout',
      attemptCount,
      intentId,
      payload: {
        confirmTimeoutMs: config.confirmTimeoutMs,
      },
    });
  }
  return 'attempted';
}

export function createMergeConflictRebaseTick(options: MergeConflictRebaseWorkerPolicyOptions): WorkerTick {
  const config = resolveMergeConflictRebaseWorkerConfig(options.config);
  const repo = splitRepo(config.targetRepo);
  const github = options.github ?? new GhCliMergeConflictGitHubClient(config.targetRepo);
  return async () => {
    if (!github.listOpenPullRequests) {
      options.logger.warn(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] GitHub dependency unavailable`, {
        module: 'merge-conflict-rebase-worker',
      });
      return;
    }
    if (!options.store.findReviewGateByPr) {
      options.logger.warn(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] review-gate lookup unavailable`, {
        module: 'merge-conflict-rebase-worker',
      });
      return;
    }
    const policyOptions = { ...options, github };
    const prs = await github.listOpenPullRequests({
      ...repo,
      author: config.author,
      limit: DEFAULT_PR_LIMIT,
    });
    for (const pr of prs.filter(isConflictingPr)) {
      const result = await handleConflictingPr(policyOptions, config, repo, pr);
      if (result === 'attempted') return;
    }
    options.logger.info(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] no actionable conflicting PRs this tick`, {
      module: 'merge-conflict-rebase-worker',
    });
  };
}

export function createMergeConflictRebaseWorker(options: MergeConflictRebaseWorkerOptions): WorkerRuntime {
  const config = resolveMergeConflictRebaseWorkerConfig(options.mergeConflict?.config);
  return createWorkerRuntime({
    kind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? config.pollIntervalMs,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? (
      options.mergeConflict
        ? createMergeConflictRebaseTick({
          ...options.mergeConflict,
          logger: options.logger,
        })
        : (() => {})
    ),
  });
}

function isJsonObject(value: unknown): value is GhJsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseGhJsonArray(raw: string): GhJsonObject[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.filter(isJsonObject) : [];
  } catch {
    const values: GhJsonObject[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const item = line.trim();
      if (!item) continue;
      const parsed = JSON.parse(item);
      if (Array.isArray(parsed)) {
        values.push(...parsed.filter(isJsonObject));
      } else if (isJsonObject(parsed)) {
        values.push(parsed);
      }
    }
    return values;
  }
}

async function runProcess(
  cmd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });
}

async function runRequiredProcess(cmd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess(cmd, args);
  if (result.exitCode !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

function ghPrFromJson(owner: string, repo: string, item: GhJsonObject): WorkerGitHubPullRequest {
  return {
    owner,
    repo,
    number: Number(item.number),
    url: String(item.url ?? item.html_url ?? ''),
    state: String(item.state ?? 'OPEN'),
    title: typeof item.title === 'string' ? item.title : undefined,
    headSha: typeof item.headRefOid === 'string' ? item.headRefOid : undefined,
    branch: typeof item.headRefName === 'string' ? item.headRefName : undefined,
    baseBranch: typeof item.baseRefName === 'string' ? item.baseRefName : undefined,
    mergeable: typeof item.mergeable === 'string' ? item.mergeable : undefined,
    mergeStateStatus: typeof item.mergeStateStatus === 'string' ? item.mergeStateStatus : undefined,
  };
}

class GhCliMergeConflictGitHubClient implements WorkerGitHubClient {
  constructor(private readonly targetRepo: string) {}

  async listOpenPullRequests(args: {
    owner: string;
    repo: string;
    author: string;
    limit?: number;
  }): Promise<WorkerGitHubPullRequest[]> {
    const raw = await runRequiredProcess('gh', [
      'pr', 'list',
      '--repo', this.targetRepo,
      '--author', args.author,
      '--state', 'open',
      '--json', 'number,url,headRefName,headRefOid,baseRefName,title,mergeable,mergeStateStatus',
      '--limit', String(args.limit ?? DEFAULT_PR_LIMIT),
    ]);
    return parseGhJsonArray(raw)
      .map((item) => ghPrFromJson(args.owner, args.repo, item))
      .filter((pr) => Number.isFinite(pr.number) && pr.number > 0);
  }

  async getPullRequest(args: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<WorkerGitHubPullRequest | undefined> {
    const raw = await runRequiredProcess('gh', [
      'pr', 'view', String(args.pullNumber),
      '--repo', this.targetRepo,
      '--json', 'number,url,state,headRefName,headRefOid,baseRefName,title,mergeable,mergeStateStatus',
    ]);
    return ghPrFromJson(args.owner, args.repo, JSON.parse(raw) as GhJsonObject);
  }

  async createPullRequestComment(args: {
    pullNumber: number;
    body: string;
  }): Promise<void> {
    await runRequiredProcess('gh', [
      'pr', 'comment', String(args.pullNumber),
      '--repo', this.targetRepo,
      '--body', args.body,
    ]);
  }
}
