import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { ReviewGateLookup, WorkerActionRecord, WorkerActionStatus } from '@invoker/data-store';

import { cleanElectronEnv, killProcessGroup } from '../process-utils.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type { WorkerGitHubPullRequest, WorkerMutationSubmitter, WorkerStateStore } from '../worker-types.js';
import {
  DEFAULT_CODERABBIT_AUTHOR,
  DEFAULT_CODERABBIT_TARGET_REPO,
  splitTargetRepo,
} from './coderabbit-update-worker.js';

export const MERGE_CONFLICT_REBASE_WORKER_KIND = 'merge-conflict-rebase';
export const DEFAULT_MERGE_CONFLICT_REBASE_WORKER_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MERGE_CONFLICT_REBASE_MAX_ATTEMPTS = 3;
export const DEFAULT_MERGE_CONFLICT_REBASE_CONFIRM_TIMEOUT_MS = 120_000;
export const DEFAULT_MERGE_CONFLICT_REBASE_CONFIRM_POLL_MS = 5_000;

const REBASE_ACTION_TYPE = 'rebase-recreate';
const MANUAL_ATTENTION_ACTION_TYPE = 'manual-attention-comment';
const HEADLESS_EXEC_CHANNEL = 'headless.exec';

export interface MergeConflictRebaseWorkerConfig {
  enabled?: boolean;
  targetRepo?: string;
  author?: string;
  maxAttempts?: number;
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
  pollIntervalMs?: number;
}

export interface ResolvedMergeConflictRebaseWorkerConfig {
  enabled: boolean;
  targetRepo: string;
  author: string;
  maxAttempts: number;
  confirmTimeoutMs: number;
  confirmPollMs: number;
  pollIntervalMs: number;
}

export interface MergeConflictRebaseGitHubClient {
  listOpenPullRequests(args: {
    owner: string;
    repo: string;
    author: string;
    limit?: number;
  }): Promise<WorkerGitHubPullRequest[]>;
  createPullRequestComment(args: {
    owner: string;
    repo: string;
    pullNumber: number;
    body: string;
  }): Promise<void>;
}

export interface MergeConflictRebaseWorkerPolicyOptions {
  store: WorkerStateStore;
  submitter: WorkerMutationSubmitter;
  logger: Logger;
  github?: MergeConflictRebaseGitHubClient;
  config?: MergeConflictRebaseWorkerConfig;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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

interface ProcessResult {
  stdout: string;
  stderr: string;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function resolveMergeConflictRebaseWorkerRuntimeConfig(
  config: MergeConflictRebaseWorkerConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMergeConflictRebaseWorkerConfig {
  const confirmSeconds = parsePositiveInteger(env.INVOKER_PR_REBASE_CONFIRM_TIMEOUT);
  return {
    enabled: envFlag(env.INVOKER_PR_REBASE_ENABLED, config.enabled ?? true),
    targetRepo: env.INVOKER_GITHUB_TARGET_REPO ?? config.targetRepo ?? DEFAULT_CODERABBIT_TARGET_REPO,
    author: env.INVOKER_PR_CRON_AUTHOR ?? config.author ?? DEFAULT_CODERABBIT_AUTHOR,
    maxAttempts: parsePositiveInteger(env.INVOKER_PR_REBASE_MAX_ATTEMPTS)
      ?? config.maxAttempts
      ?? DEFAULT_MERGE_CONFLICT_REBASE_MAX_ATTEMPTS,
    confirmTimeoutMs: confirmSeconds !== undefined
      ? confirmSeconds * 1_000
      : (config.confirmTimeoutMs ?? DEFAULT_MERGE_CONFLICT_REBASE_CONFIRM_TIMEOUT_MS),
    confirmPollMs: config.confirmPollMs ?? DEFAULT_MERGE_CONFLICT_REBASE_CONFIRM_POLL_MS,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_MERGE_CONFLICT_REBASE_WORKER_INTERVAL_MS,
  };
}

export function mergeConflictRebaseActionKey(
  targetRepo: string,
  workflowId: string,
  generation: number,
): string {
  return `merge-conflict-rebase:${targetRepo}:${workflowId}:${generation}`;
}

export function mergeConflictManualAttentionActionKey(targetRepo: string, workflowId: string): string {
  return `merge-conflict-rebase-manual:${targetRepo}:${workflowId}`;
}

export function isMergeConflictingPullRequest(pr: Pick<WorkerGitHubPullRequest, 'mergeable' | 'mergeStateStatus'>): boolean {
  return pr.mergeStateStatus === 'DIRTY' || pr.mergeable === 'CONFLICTING';
}

function actionIdForKey(kind: string, externalKey: string): string {
  const hash = createHash('sha256').update(externalKey).digest('hex').slice(0, 16);
  return `${kind}:${hash}`;
}

function recordRebaseAction(
  options: MergeConflictRebaseWorkerPolicyOptions,
  config: ResolvedMergeConflictRebaseWorkerConfig,
  args: {
    workflow: ReviewGateLookup;
    pullRequest: WorkerGitHubPullRequest;
    generation: number;
    status: WorkerActionStatus;
    summary: string;
    payload?: Record<string, unknown>;
    countAttempt?: boolean;
    intentId?: string | number;
  },
): WorkerActionRecord {
  const externalKey = mergeConflictRebaseActionKey(config.targetRepo, args.workflow.workflowId, args.generation);
  const existing = options.store.getWorkerAction(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey);
  const now = new Date().toISOString();
  return options.store.upsertWorkerAction({
    id: existing?.id ?? actionIdForKey(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey),
    workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    actionType: REBASE_ACTION_TYPE,
    workflowId: args.workflow.workflowId,
    taskId: args.workflow.mergeTaskId,
    subjectType: 'pull_request',
    subjectId: String(args.pullRequest.number),
    externalKey,
    status: args.status,
    attemptCount: (existing?.attemptCount ?? 0) + (args.countAttempt ? 1 : 0),
    ...(args.intentId !== undefined ? { intentId: String(args.intentId) } : {}),
    summary: args.summary,
    payload: {
      targetRepo: config.targetRepo,
      prNumber: args.pullRequest.number,
      prUrl: args.pullRequest.url,
      workflowId: args.workflow.workflowId,
      workflowGeneration: args.generation,
      mergeTaskId: args.workflow.mergeTaskId,
      mergeable: args.pullRequest.mergeable ?? null,
      mergeStateStatus: args.pullRequest.mergeStateStatus ?? null,
      ...args.payload,
    },
    updatedAt: now,
    ...(args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
      ? { completedAt: now }
      : {}),
  });
}

function recordManualAttentionAction(
  options: MergeConflictRebaseWorkerPolicyOptions,
  config: ResolvedMergeConflictRebaseWorkerConfig,
  args: {
    workflow: ReviewGateLookup;
    pullRequest: WorkerGitHubPullRequest;
    status: WorkerActionStatus;
    summary: string;
    payload?: Record<string, unknown>;
  },
): WorkerActionRecord {
  const externalKey = mergeConflictManualAttentionActionKey(config.targetRepo, args.workflow.workflowId);
  const existing = options.store.getWorkerAction(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey);
  const now = new Date().toISOString();
  return options.store.upsertWorkerAction({
    id: existing?.id ?? actionIdForKey(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey),
    workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    actionType: MANUAL_ATTENTION_ACTION_TYPE,
    workflowId: args.workflow.workflowId,
    taskId: args.workflow.mergeTaskId,
    subjectType: 'pull_request',
    subjectId: String(args.pullRequest.number),
    externalKey,
    status: args.status,
    attemptCount: existing?.attemptCount ?? 0,
    summary: args.summary,
    payload: {
      targetRepo: config.targetRepo,
      prNumber: args.pullRequest.number,
      prUrl: args.pullRequest.url,
      workflowId: args.workflow.workflowId,
      mergeTaskId: args.workflow.mergeTaskId,
      ...args.payload,
    },
    updatedAt: now,
    ...(args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
      ? { completedAt: now }
      : {}),
  });
}

function logMergeConflictWorkerAction(
  options: MergeConflictRebaseWorkerPolicyOptions,
  args: {
    workflow: ReviewGateLookup;
    pullRequest: WorkerGitHubPullRequest;
    phase: string;
    action?: WorkerActionRecord;
    details?: Record<string, unknown>;
  },
): void {
  const payload = {
    worker: MERGE_CONFLICT_REBASE_WORKER_KIND,
    actionType: args.action?.actionType ?? REBASE_ACTION_TYPE,
    phase: args.phase,
    workflowId: args.workflow.workflowId,
    workflowGeneration: args.workflow.workflowGeneration,
    prNumber: args.pullRequest.number,
    prUrl: args.pullRequest.url,
    actionId: args.action?.id ?? null,
    status: args.action?.status ?? null,
    ...args.details,
  };
  options.store.logEvent?.(args.workflow.mergeTaskId, 'task.worker_action', payload);
  options.logger.debug?.(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] ${args.phase}`, {
    module: 'merge-conflict-rebase-worker',
    taskId: args.workflow.mergeTaskId,
    ...payload,
  });
}

async function runProcess(command: string, args: string[], timeoutMs = 60_000): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, {
      detached: true,
      env: cleanElectronEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };
    const timeout = setTimeout(() => {
      killProcessGroup(child, 'SIGTERM');
      finish(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timeout.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(`${command} ${args.join(' ')} exited ${code ?? signal ?? 'unknown'}: ${stderr || stdout}`));
      });
    });
  });
}

async function runJson(command: string, args: string[]): Promise<unknown> {
  const { stdout } = await runProcess(command, args);
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function createGhMergeConflictRebaseGitHubClient(): MergeConflictRebaseGitHubClient {
  return {
    async listOpenPullRequests(args) {
      const raw = await runJson('gh', [
        'pr',
        'list',
        '--repo',
        `${args.owner}/${args.repo}`,
        '--author',
        args.author,
        '--state',
        'open',
        '--json',
        'number,url,headRefName,baseRefName,title,mergeable,mergeStateStatus',
        '--limit',
        String(args.limit ?? 100),
      ]);
      if (!Array.isArray(raw)) return [];
      return raw
        .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : undefined)
        .filter((item): item is Record<string, unknown> => !!item)
        .map((item) => ({
          owner: args.owner,
          repo: args.repo,
          number: numberField(item, 'number') ?? 0,
          url: stringField(item, 'url') ?? '',
          state: 'open',
          title: stringField(item, 'title'),
          branch: stringField(item, 'headRefName'),
          baseBranch: stringField(item, 'baseRefName'),
          mergeable: stringField(item, 'mergeable'),
          mergeStateStatus: stringField(item, 'mergeStateStatus'),
        }))
        .filter((pr) => pr.number > 0);
    },
    async createPullRequestComment(args) {
      await runProcess('gh', [
        'pr',
        'comment',
        String(args.pullNumber),
        '--repo',
        `${args.owner}/${args.repo}`,
        '--body',
        args.body,
      ]);
    },
  };
}

function workflowGeneration(
  options: MergeConflictRebaseWorkerPolicyOptions,
  workflow: ReviewGateLookup,
  pullNumber?: number,
): number {
  return options.store.loadWorkflow?.(workflow.workflowId)?.generation
    ?? options.store.findReviewGateByPr?.(String(pullNumber ?? workflow.reviewId ?? ''))?.workflowGeneration
    ?? workflow.workflowGeneration
    ?? 0;
}

async function waitForWorkflowGenerationAdvance(
  options: MergeConflictRebaseWorkerPolicyOptions,
  config: ResolvedMergeConflictRebaseWorkerConfig,
  workflow: ReviewGateLookup,
  generation: number,
  pullNumber: number,
): Promise<number | undefined> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadline = now() + config.confirmTimeoutMs;
  while (true) {
    const currentGeneration = workflowGeneration(options, workflow, pullNumber);
    if (currentGeneration > generation) return currentGeneration;
    const remaining = deadline - now();
    if (remaining <= 0) return undefined;
    await sleep(Math.min(config.confirmPollMs, remaining));
  }
}

function manualAttentionBody(maxAttempts: number): string {
  return `Invoker conflict-rebase worker gave up after ${maxAttempts} rebase-recreate attempts; this PR still conflicts and needs manual attention.`;
}

async function flagManualAttentionOnce(
  options: MergeConflictRebaseWorkerPolicyOptions,
  config: ResolvedMergeConflictRebaseWorkerConfig,
  github: MergeConflictRebaseGitHubClient,
  workflow: ReviewGateLookup,
  pr: WorkerGitHubPullRequest,
): Promise<void> {
  const externalKey = mergeConflictManualAttentionActionKey(config.targetRepo, workflow.workflowId);
  const existing = options.store.getWorkerAction(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey);
  if (existing?.status === 'completed') {
    logMergeConflictWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-merge-conflict-manual-attention-skip',
      action: existing,
      details: { reason: 'already-commented' },
    });
    return;
  }

  const { owner, repo } = splitTargetRepo(config.targetRepo);
  try {
    await github.createPullRequestComment({
      owner,
      repo,
      pullNumber: pr.number,
      body: manualAttentionBody(config.maxAttempts),
    });
    const action = recordManualAttentionAction(options, config, {
      workflow,
      pullRequest: pr,
      status: 'completed',
      summary: 'Posted manual attention comment for exhausted conflict rebase attempts',
      payload: { maxAttempts: config.maxAttempts },
    });
    logMergeConflictWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-merge-conflict-manual-attention-commented',
      action,
      details: { maxAttempts: config.maxAttempts },
    });
  } catch (err) {
    const action = recordManualAttentionAction(options, config, {
      workflow,
      pullRequest: pr,
      status: 'failed',
      summary: `Failed to post manual attention comment: ${err instanceof Error ? err.message : String(err)}`,
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
    logMergeConflictWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-merge-conflict-manual-attention-failed',
      action,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

async function processConflictingPullRequest(
  options: MergeConflictRebaseWorkerPolicyOptions,
  config: ResolvedMergeConflictRebaseWorkerConfig,
  github: MergeConflictRebaseGitHubClient,
  pr: WorkerGitHubPullRequest,
): Promise<boolean> {
  const workflow = options.store.findReviewGateByPr?.(String(pr.number));
  if (!workflow) {
    options.logger.debug?.(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] PR #${pr.number} has no Invoker workflow mapping; skip`, {
      module: 'merge-conflict-rebase-worker',
      prNumber: pr.number,
    });
    return false;
  }
  const generation = workflow.workflowGeneration ?? 0;
  const externalKey = mergeConflictRebaseActionKey(config.targetRepo, workflow.workflowId, generation);
  const existing = options.store.getWorkerAction(MERGE_CONFLICT_REBASE_WORKER_KIND, externalKey);
  if (existing?.status === 'completed') {
    logMergeConflictWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-merge-conflict-skip',
      action: existing,
      details: { reason: 'already-confirmed', generation },
    });
    return false;
  }

  if ((existing?.attemptCount ?? 0) >= config.maxAttempts) {
    const action = recordRebaseAction(options, config, {
      workflow,
      pullRequest: pr,
      generation,
      status: 'skipped',
      summary: 'Skipped conflict rebase because retry budget is exhausted',
      payload: { reason: 'retry-budget-exhausted', maxAttempts: config.maxAttempts },
    });
    logMergeConflictWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-merge-conflict-skip',
      action,
      details: { reason: 'retry-budget-exhausted', maxAttempts: config.maxAttempts },
    });
    await flagManualAttentionOnce(options, config, github, workflow, pr);
    return false;
  }

  let intentId: number;
  try {
    intentId = options.submitter.submit(workflow.workflowId, 'high', HEADLESS_EXEC_CHANNEL, [{
      args: ['rebase-recreate', workflow.workflowId],
      noTrack: true,
    }]);
  } catch (err) {
    const action = recordRebaseAction(options, config, {
      workflow,
      pullRequest: pr,
      generation,
      status: 'failed',
      summary: `Failed to submit rebase-recreate: ${err instanceof Error ? err.message : String(err)}`,
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
    logMergeConflictWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-merge-conflict-submit-failed',
      action,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
    return true;
  }

  const running = recordRebaseAction(options, config, {
    workflow,
    pullRequest: pr,
    generation,
    status: 'running',
    summary: 'Submitted rebase-recreate for conflicting PR',
    payload: { channel: HEADLESS_EXEC_CHANNEL },
    countAttempt: true,
    intentId,
  });
  logMergeConflictWorkerAction(options, {
    workflow,
    pullRequest: pr,
    phase: 'worker-merge-conflict-submitted',
    action: running,
    details: { intentId, generation },
  });

  const advancedTo = await waitForWorkflowGenerationAdvance(options, config, workflow, generation, pr.number);
  if (advancedTo !== undefined) {
    const action = recordRebaseAction(options, config, {
      workflow,
      pullRequest: pr,
      generation,
      status: 'completed',
      summary: 'Confirmed rebase-recreate advanced workflow generation',
      payload: { generation, advancedTo },
      intentId,
    });
    logMergeConflictWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-merge-conflict-confirmed',
      action,
      details: { generation, advancedTo },
    });
    return true;
  }

  const action = recordRebaseAction(options, config, {
    workflow,
    pullRequest: pr,
    generation,
    status: 'failed',
    summary: 'Rebase-recreate did not advance workflow generation before timeout',
    payload: { generation, confirmTimeoutMs: config.confirmTimeoutMs },
    intentId,
  });
  logMergeConflictWorkerAction(options, {
    workflow,
    pullRequest: pr,
    phase: 'worker-merge-conflict-confirm-timeout',
    action,
    details: { generation, confirmTimeoutMs: config.confirmTimeoutMs },
  });
  return true;
}

export function createMergeConflictRebaseTick(options: MergeConflictRebaseWorkerPolicyOptions): WorkerTick {
  return async () => {
    const config = resolveMergeConflictRebaseWorkerRuntimeConfig(options.config);
    if (!config.enabled) return;
    const { owner, repo } = splitTargetRepo(config.targetRepo);
    const github = options.github ?? createGhMergeConflictRebaseGitHubClient();
    let prs: WorkerGitHubPullRequest[];
    try {
      prs = await github.listOpenPullRequests({ owner, repo, author: config.author, limit: 100 });
    } catch (err) {
      options.logger.warn?.(`[worker:${MERGE_CONFLICT_REBASE_WORKER_KIND}] could not list PRs: ${err instanceof Error ? err.message : String(err)}`, {
        module: 'merge-conflict-rebase-worker',
      });
      return;
    }

    for (const pr of prs.filter(isMergeConflictingPullRequest)) {
      const processed = await processConflictingPullRequest(options, config, github, pr);
      if (processed) return;
    }
  };
}

export function createMergeConflictRebaseWorker(options: MergeConflictRebaseWorkerOptions): WorkerRuntime {
  const policy = options.mergeConflictRebase
    ? createMergeConflictRebaseTick({
      ...options.mergeConflictRebase,
      logger: options.logger,
    })
    : (() => {});
  const config = resolveMergeConflictRebaseWorkerRuntimeConfig(options.mergeConflictRebase?.config);
  return createWorkerRuntime({
    kind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? config.pollIntervalMs,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? policy,
  });
}
