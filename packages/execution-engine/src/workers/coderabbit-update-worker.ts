import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';
import type {
  ReviewGateLookup,
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type {
  PrMaintenanceWorkerConfig,
  WorkerGitHubClient,
  WorkerGitHubComment,
  WorkerGitHubPullRequest,
  WorkerStateStore,
} from '../worker-types.js';

export const CODERABBIT_UPDATE_WORKER_KIND = 'coderabbit-update';
export const DEFAULT_CODERABBIT_UPDATE_WORKER_INTERVAL_MS = 5 * 60_000;

const CODERABBIT_ACTION_TYPE = 'address-coderabbit-feedback';
const DEFAULT_TARGET_REPO = 'Neko-Catpital-Labs/Invoker';
const DEFAULT_PR_AUTHOR = 'EdbertChan';
const DEFAULT_CODERABBIT_LOGIN = 'coderabbitai[bot]';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_EXECUTION_AGENT = 'omp';
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_PR_LIMIT = 100;

type GhJsonObject = Record<string, unknown>;

export interface CodeRabbitUpdateWorkerStore extends WorkerStateStore {
  loadTasks(workflowId: string): TaskState[];
}

export interface CodeRabbitAgentRunArgs {
  targetRepo: string;
  pr: WorkerGitHubPullRequest;
  expectedHeadSha: string;
  comments: CodeRabbitComment[];
  latestCommentUpdatedAt: string;
  reviewGate: ReviewGateLookup;
  invokerTasks: TaskState[];
  workDir: string;
  executionAgent: string;
  executionModel?: string;
  timeoutMs: number;
}

export interface CodeRabbitAgentRunResult {
  status: 'completed' | 'failed';
  summary?: string;
  sessionId?: string;
  exitCode?: number;
}

export interface CodeRabbitAgentRunner {
  run(args: CodeRabbitAgentRunArgs): Promise<CodeRabbitAgentRunResult>;
}

export interface CodeRabbitComment {
  body: string;
  updatedAt: string;
  path?: string;
  htmlUrl?: string;
}

export interface CodeRabbitUpdateResolvedConfig {
  targetRepo: string;
  author: string;
  login: string;
  maxAttempts: number;
  workDir: string;
  executionAgent: string;
  executionModel?: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface CodeRabbitUpdateWorkerPolicyOptions {
  store: CodeRabbitUpdateWorkerStore;
  github?: WorkerGitHubClient;
  runner?: CodeRabbitAgentRunner;
  logger: Logger;
  config?: PrMaintenanceWorkerConfig;
}

export interface CodeRabbitUpdateWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  coderabbit?: Omit<CodeRabbitUpdateWorkerPolicyOptions, 'logger'>;
  onTick?: WorkerTick;
}

export function registerCodeRabbitUpdateWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CODERABBIT_UPDATE_WORKER_KIND,
    note: 'Addresses new CodeRabbit bot feedback on Invoker-mapped review-gate PRs.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createCodeRabbitUpdateWorker({
        logger: deps.logger,
        coderabbit: {
          store: deps.store,
          github: deps.github,
          runner: deps.codeRabbitRunner,
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

export function resolveCodeRabbitUpdateWorkerConfig(
  config: PrMaintenanceWorkerConfig | undefined = {},
): CodeRabbitUpdateResolvedConfig {
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
    login: firstNonEmpty(
      process.env.INVOKER_CODERABBIT_LOGIN,
      config.coderabbitLogin,
      DEFAULT_CODERABBIT_LOGIN,
    )!,
    maxAttempts: parsePositiveInteger(
      process.env.INVOKER_PR_CODERABBIT_MAX_ATTEMPTS ?? config.coderabbitMaxAttempts,
      DEFAULT_MAX_ATTEMPTS,
    ),
    workDir: expandHome(firstNonEmpty(
      process.env.INVOKER_PR_CRON_WORKDIR,
      config.coderabbitWorkDir,
      join(homedir(), '.invoker', 'pr-cron-work'),
    )!),
    executionAgent: firstNonEmpty(
      process.env.INVOKER_PR_CODERABBIT_EXECUTION_AGENT,
      config.coderabbitExecutionAgent,
      DEFAULT_EXECUTION_AGENT,
    )!,
    executionModel: firstNonEmpty(
      process.env.INVOKER_PR_CRON_OMP_MODEL,
      config.coderabbitExecutionModel,
    ),
    timeoutMs: parseDurationMs(
      process.env.INVOKER_PR_CRON_OMP_TIMEOUT ?? config.coderabbitTimeoutMs,
      DEFAULT_TIMEOUT_MS,
    ),
    pollIntervalMs: parseDurationMs(
      process.env.INVOKER_PR_CODERABBIT_POLL_INTERVAL_MS ?? config.coderabbitPollIntervalMs,
      DEFAULT_CODERABBIT_UPDATE_WORKER_INTERVAL_MS,
    ),
  };
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function splitRepo(targetRepo: string): { owner: string; repo: string } {
  const [owner, repo] = targetRepo.split('/');
  if (!owner || !repo || targetRepo.split('/').length !== 2) {
    throw new Error(`Invalid GitHub target repo "${targetRepo}". Expected owner/repo.`);
  }
  return { owner, repo };
}

function maxUpdatedAt(comments: readonly CodeRabbitComment[]): string | undefined {
  let latest: string | undefined;
  for (const comment of comments) {
    if (!comment.updatedAt) continue;
    if (!latest || comment.updatedAt > latest) latest = comment.updatedAt;
  }
  return latest;
}

function normalizeComment(comment: WorkerGitHubComment): CodeRabbitComment {
  return {
    body: comment.body,
    updatedAt: comment.updatedAt,
    path: comment.path,
    htmlUrl: comment.htmlUrl,
  };
}

async function collectCodeRabbitComments(
  github: WorkerGitHubClient,
  repo: { owner: string; repo: string },
  pullNumber: number,
  login: string,
): Promise<CodeRabbitComment[]> {
  const reviewComments = await github.listPullRequestReviewComments?.({
    ...repo,
    pullNumber,
  }) ?? [];
  const issueComments = await github.listIssueComments?.({
    ...repo,
    issueNumber: pullNumber,
  }) ?? [];
  return [...reviewComments, ...issueComments]
    .filter((comment) => comment.authorLogin === login)
    .map(normalizeComment);
}

export function coderabbitUpdateActionKey(prNumber: number, latestCommentUpdatedAt: string): string {
  return `coderabbit:${prNumber}:${latestCommentUpdatedAt}`;
}

function coderabbitActionId(externalKey: string): string {
  return `${CODERABBIT_UPDATE_WORKER_KIND}:${externalKey}`;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function latestMarkerFromAction(action: WorkerActionRecord): string | undefined {
  const marker = payloadRecord(action.payload).latestCommentUpdatedAt;
  return typeof marker === 'string' ? marker : undefined;
}

function hasCompletedAtOrAfter(
  store: CodeRabbitUpdateWorkerStore,
  prNumber: number,
  latestCommentUpdatedAt: string,
): boolean {
  const actions = store.listWorkerActions({
    workerKind: CODERABBIT_UPDATE_WORKER_KIND,
    limit: 1_000,
  });
  return actions.some((action) => (
    action.actionType === CODERABBIT_ACTION_TYPE
    && action.subjectId === String(prNumber)
    && action.status === 'completed'
    && (latestMarkerFromAction(action) ?? '') >= latestCommentUpdatedAt
  ));
}

function isOpenActionStatus(status: WorkerActionStatus): boolean {
  return status === 'queued'
    || status === 'pending'
    || status === 'running'
    || status === 'needs_input'
    || status === 'review_ready';
}

function logWorkerActionEvent(
  store: CodeRabbitUpdateWorkerStore,
  logger: Logger,
  reviewGate: ReviewGateLookup | undefined,
  action: WorkerActionRecord | WorkerActionWrite,
  phase: string,
  payload: Record<string, unknown>,
): void {
  const taskId = reviewGate?.mergeTaskId;
  const eventPayload = {
    phase,
    workerKind: CODERABBIT_UPDATE_WORKER_KIND,
    actionType: action.actionType,
    actionId: action.id,
    externalKey: action.externalKey,
    workflowId: action.workflowId ?? reviewGate?.workflowId,
    taskId: action.taskId ?? taskId,
    status: action.status,
    attemptCount: action.attemptCount ?? 0,
    ...payload,
  };
  if (taskId) {
    store.logEvent?.(taskId, 'task.worker_action', eventPayload);
  }
  logger.info(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] ${phase}`, {
    module: 'coderabbit-update-worker',
    ...eventPayload,
  });
}

function recordCodeRabbitAction(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  args: {
    pr: WorkerGitHubPullRequest;
    latestCommentUpdatedAt: string;
    status: WorkerActionStatus;
    summary: string;
    reviewGate?: ReviewGateLookup;
    payload?: Record<string, unknown>;
    attemptCount?: number;
    sessionId?: string;
  },
): WorkerActionRecord {
  const externalKey = coderabbitUpdateActionKey(args.pr.number, args.latestCommentUpdatedAt);
  const existing = options.store.getWorkerAction(CODERABBIT_UPDATE_WORKER_KIND, externalKey);
  const now = new Date().toISOString();
  const write: WorkerActionWrite = {
    id: existing?.id ?? coderabbitActionId(externalKey),
    workerKind: CODERABBIT_UPDATE_WORKER_KIND,
    actionType: CODERABBIT_ACTION_TYPE,
    workflowId: args.reviewGate?.workflowId,
    taskId: args.reviewGate?.mergeTaskId,
    subjectType: 'pull_request',
    subjectId: String(args.pr.number),
    externalKey,
    status: args.status,
    attemptCount: args.attemptCount ?? existing?.attemptCount ?? 0,
    agentName: args.payload?.executionAgent as string | undefined,
    executionModel: args.payload?.executionModel as string | undefined,
    sessionId: args.sessionId,
    summary: args.summary,
    payload: {
      prNumber: args.pr.number,
      prUrl: args.pr.url,
      headSha: args.pr.headSha ?? null,
      headBranch: args.pr.branch ?? null,
      baseBranch: args.pr.baseBranch ?? null,
      latestCommentUpdatedAt: args.latestCommentUpdatedAt,
      ...args.payload,
    },
    updatedAt: now,
    ...(args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
      ? { completedAt: now }
      : {}),
  };
  const saved = options.store.upsertWorkerAction(write);
  logWorkerActionEvent(options.store, options.logger, args.reviewGate, saved, `coderabbit-${args.status}`, {
    prNumber: args.pr.number,
    latestCommentUpdatedAt: args.latestCommentUpdatedAt,
    summary: args.summary,
  });
  return saved;
}

function skipExistingAction(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  pr: WorkerGitHubPullRequest,
  latestCommentUpdatedAt: string,
  maxAttempts: number,
  reviewGate: ReviewGateLookup,
): boolean {
  const externalKey = coderabbitUpdateActionKey(pr.number, latestCommentUpdatedAt);
  const existing = options.store.getWorkerAction(CODERABBIT_UPDATE_WORKER_KIND, externalKey);
  if (!existing) return false;
  if (existing.status === 'completed' || isOpenActionStatus(existing.status)) {
    logWorkerActionEvent(options.store, options.logger, reviewGate, existing, 'coderabbit-skip', {
      reason: 'already-recorded',
      prNumber: pr.number,
      latestCommentUpdatedAt,
      existingStatus: existing.status,
    });
    return true;
  }
  if (existing.attemptCount >= maxAttempts) {
    recordCodeRabbitAction(options, {
      pr,
      latestCommentUpdatedAt,
      status: 'skipped',
      summary: 'Skipped CodeRabbit update because retry budget is exhausted',
      reviewGate,
      attemptCount: existing.attemptCount,
      payload: {
        reason: 'retry-budget-exhausted',
        maxAttempts,
        existingStatus: existing.status,
      },
    });
    return true;
  }
  return false;
}

async function handleCodeRabbitPr(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  config: CodeRabbitUpdateResolvedConfig,
  repo: { owner: string; repo: string },
  pr: WorkerGitHubPullRequest,
): Promise<'attempted' | 'skipped'> {
  const comments = await collectCodeRabbitComments(options.github!, repo, pr.number, config.login);
  const latestCommentUpdatedAt = maxUpdatedAt(comments);
  if (!latestCommentUpdatedAt) return 'skipped';

  if (hasCompletedAtOrAfter(options.store, pr.number, latestCommentUpdatedAt)) {
    options.logger.debug?.(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] no new CodeRabbit comments`, {
      module: 'coderabbit-update-worker',
      prNumber: pr.number,
      latestCommentUpdatedAt,
    });
    return 'skipped';
  }

  const reviewGate = options.store.findReviewGateByPr?.(String(pr.number));
  if (!reviewGate) {
    options.logger.info(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] skipped unmapped PR`, {
      module: 'coderabbit-update-worker',
      prNumber: pr.number,
      latestCommentUpdatedAt,
      reason: 'no-invoker-workflow-mapping',
    });
    return 'skipped';
  }

  if (skipExistingAction(options, pr, latestCommentUpdatedAt, config.maxAttempts, reviewGate)) {
    return 'skipped';
  }

  const current = await options.github!.getPullRequest({
    ...repo,
    pullNumber: pr.number,
  });
  const expectedHeadSha = current?.headSha;
  if (!current || !expectedHeadSha) {
    recordCodeRabbitAction(options, {
      pr,
      latestCommentUpdatedAt,
      status: 'skipped',
      summary: 'Skipped CodeRabbit update because current PR head SHA is unavailable',
      reviewGate,
      payload: { reason: 'missing-current-head-sha' },
    });
    return 'attempted';
  }
  if (pr.headSha && pr.headSha !== expectedHeadSha) {
    recordCodeRabbitAction(options, {
      pr,
      latestCommentUpdatedAt,
      status: 'skipped',
      summary: 'Skipped CodeRabbit update because PR head changed before launch',
      reviewGate,
      payload: {
        reason: 'head-sha-changed-before-launch',
        listedHeadSha: pr.headSha,
        currentHeadSha: expectedHeadSha,
      },
    });
    return 'attempted';
  }

  const existing = options.store.getWorkerAction(
    CODERABBIT_UPDATE_WORKER_KIND,
    coderabbitUpdateActionKey(pr.number, latestCommentUpdatedAt),
  );
  const attemptCount = (existing?.attemptCount ?? 0) + 1;
  recordCodeRabbitAction(options, {
    pr: { ...pr, headSha: expectedHeadSha },
    latestCommentUpdatedAt,
    status: 'running',
    summary: 'Running CodeRabbit update agent',
    reviewGate,
    attemptCount,
    payload: {
      commentCount: comments.length,
      executionAgent: config.executionAgent,
      executionModel: config.executionModel ?? null,
      timeoutMs: config.timeoutMs,
    },
  });

  const invokerTasks = options.store.loadTasks(reviewGate.workflowId);
  let result: CodeRabbitAgentRunResult;
  try {
    result = await options.runner!.run({
      targetRepo: config.targetRepo,
      pr: { ...current, headSha: expectedHeadSha },
      expectedHeadSha,
      comments,
      latestCommentUpdatedAt,
      reviewGate,
      invokerTasks,
      workDir: config.workDir,
      executionAgent: config.executionAgent,
      executionModel: config.executionModel,
      timeoutMs: config.timeoutMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      status: 'failed',
      summary: `CodeRabbit update agent failed: ${message}`,
    };
  }
  recordCodeRabbitAction(options, {
    pr: { ...current, headSha: expectedHeadSha },
    latestCommentUpdatedAt,
    status: result.status,
    summary: result.summary ?? (
      result.status === 'completed'
        ? 'CodeRabbit update agent completed'
        : 'CodeRabbit update agent failed'
    ),
    reviewGate,
    attemptCount,
    sessionId: result.sessionId,
    payload: {
      commentCount: comments.length,
      executionAgent: config.executionAgent,
      executionModel: config.executionModel ?? null,
      timeoutMs: config.timeoutMs,
      exitCode: result.exitCode ?? null,
      expectedHeadSha,
    },
  });
  return 'attempted';
}

export function createCodeRabbitUpdateTick(options: CodeRabbitUpdateWorkerPolicyOptions): WorkerTick {
  const config = resolveCodeRabbitUpdateWorkerConfig(options.config);
  const repo = splitRepo(config.targetRepo);
  const github = options.github ?? new GhCliWorkerGitHubClient(config.targetRepo);
  const runner = options.runner ?? new GhCliCodeRabbitAgentRunner();
  return async () => {
    if (!github.listOpenPullRequests || !github.getPullRequest) {
      options.logger.warn(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] GitHub dependency unavailable`, {
        module: 'coderabbit-update-worker',
      });
      return;
    }
    if (!github.listPullRequestReviewComments || !github.listIssueComments) {
      options.logger.warn(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] GitHub comment dependency unavailable`, {
        module: 'coderabbit-update-worker',
      });
      return;
    }
    if (!options.store.findReviewGateByPr) {
      options.logger.warn(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] review-gate lookup unavailable`, {
        module: 'coderabbit-update-worker',
      });
      return;
    }
    const policyOptions = { ...options, github, runner };
    const prs = await github.listOpenPullRequests({
      ...repo,
      author: config.author,
      limit: DEFAULT_PR_LIMIT,
    });
    for (const pr of prs) {
      const result = await handleCodeRabbitPr(policyOptions, config, repo, pr);
      if (result === 'attempted') return;
    }
    options.logger.info(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] no PRs with new CodeRabbit feedback this tick`, {
      module: 'coderabbit-update-worker',
    });
  };
}

export function createCodeRabbitUpdateWorker(options: CodeRabbitUpdateWorkerOptions): WorkerRuntime {
  const config = resolveCodeRabbitUpdateWorkerConfig(options.coderabbit?.config);
  return createWorkerRuntime({
    kind: CODERABBIT_UPDATE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? config.pollIntervalMs,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? (
      options.coderabbit
        ? createCodeRabbitUpdateTick({
          ...options.coderabbit,
          logger: options.logger,
        })
        : (() => {})
    ),
  });
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

function isJsonObject(value: unknown): value is GhJsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function runProcess(
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
        if (child.pid && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
        } else {
          child.kill('SIGTERM');
        }
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 10_000).unref?.();
      }, options.timeoutMs)
      : undefined;
    timer?.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => finish(code ?? 0));
  });
}

async function runRequiredProcess(
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const result = await runProcess(cmd, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

function ghPrFromJson(owner: string, repo: string, item: GhJsonObject): WorkerGitHubPullRequest {
  const number = Number(item.number);
  return {
    owner,
    repo,
    number,
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

function ghCommentFromJson(item: GhJsonObject): WorkerGitHubComment | undefined {
  const user = isJsonObject(item.user) ? item.user : {};
  const authorLogin = typeof user.login === 'string' ? user.login : '';
  const body = typeof item.body === 'string' ? item.body : '';
  const updatedAt = typeof item.updated_at === 'string'
    ? item.updated_at
    : typeof item.updatedAt === 'string'
      ? item.updatedAt
      : '';
  if (!authorLogin || !updatedAt) return undefined;
  return {
    authorLogin,
    body,
    updatedAt,
    path: typeof item.path === 'string' ? item.path : undefined,
    htmlUrl: typeof item.html_url === 'string' ? item.html_url : undefined,
  };
}

class GhCliWorkerGitHubClient implements WorkerGitHubClient {
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
    const parsed = JSON.parse(raw) as GhJsonObject;
    return ghPrFromJson(args.owner, args.repo, parsed);
  }

  async listPullRequestReviewComments(args: {
    pullNumber: number;
  }): Promise<WorkerGitHubComment[]> {
    const raw = await runRequiredProcess('gh', [
      'api', `repos/${this.targetRepo}/pulls/${args.pullNumber}/comments`,
      '--paginate',
    ]);
    return parseGhJsonArray(raw).map(ghCommentFromJson).filter(Boolean) as WorkerGitHubComment[];
  }

  async listIssueComments(args: {
    issueNumber: number;
  }): Promise<WorkerGitHubComment[]> {
    const raw = await runRequiredProcess('gh', [
      'api', `repos/${this.targetRepo}/issues/${args.issueNumber}/comments`,
      '--paginate',
    ]);
    return parseGhJsonArray(raw).map(ghCommentFromJson).filter(Boolean) as WorkerGitHubComment[];
  }
}

function serializeTaskForContext(task: TaskState): Record<string, unknown> {
  return {
    id: task.id,
    description: task.description,
    status: task.status,
    dependencies: task.dependencies,
    config: task.config,
    execution: {
      branch: task.execution.branch,
      reviewId: task.execution.reviewId,
      reviewUrl: task.execution.reviewUrl,
      generation: task.execution.generation,
      selectedAttemptId: task.execution.selectedAttemptId,
      headSha: task.execution.reviewGate?.artifacts.find((artifact) =>
        artifact.generation === task.execution.reviewGate?.activeGeneration
        && artifact.status !== 'discarded',
      )?.headSha,
    },
  };
}

function buildCodeRabbitPrompt(args: CodeRabbitAgentRunArgs, contextFile: string): string {
  const base = args.pr.baseBranch ?? args.reviewGate.baseBranch ?? 'HEAD';
  const head = args.pr.branch ?? args.reviewGate.branch ?? 'PR head';
  return [
    `You are addressing CodeRabbit review feedback on GitHub PR #${args.pr.number} in repository ${args.targetRepo}.`,
    `You are running inside a fresh checkout of the PR head branch (${head}); HEAD is already on that branch.`,
    `Context for this PR is in JSON file: ${contextFile}.`,
    '',
    `Before any git push, confirm the live PR head SHA is still ${args.expectedHeadSha}.`,
    `Use: gh pr view ${args.pr.number} --repo ${args.targetRepo} --json headRefOid --jq .headRefOid`,
    'If the live head SHA differs, exit without committing or pushing.',
    '',
    'Do this:',
    `1. Read the CodeRabbit comments in ${contextFile}, plus git log origin/${base}..HEAD and git diff origin/${base}...HEAD.`,
    '2. For each distinct CodeRabbit concern, decide whether it is a real correctness or safety issue.',
    `3. For each valid concern, add a focused bash repro at scripts/repro/repro-coderabbit-pr${args.pr.number}-<slug>.sh and implement the minimal fix.`,
    '4. For invalid concerns, take no code action.',
    '5. Commit only the repro/fix files that valid concerns require, then push to the PR head branch.',
    '',
    'If no concern is valid, make no commit and exit without pushing.',
  ].join('\n');
}

class GhCliCodeRabbitAgentRunner implements CodeRabbitAgentRunner {
  async run(args: CodeRabbitAgentRunArgs): Promise<CodeRabbitAgentRunResult> {
    await mkdir(args.workDir, { recursive: true });
    const checkoutDir = join(args.workDir, String(args.pr.number));
    if (!existsSync(join(checkoutDir, '.git'))) {
      await rm(checkoutDir, { recursive: true, force: true });
      await runRequiredProcess('gh', ['repo', 'clone', args.targetRepo, checkoutDir, '--', '--quiet']);
    } else {
      await runRequiredProcess('git', ['reset', '--hard'], { cwd: checkoutDir });
      await runRequiredProcess('git', ['clean', '-fd'], { cwd: checkoutDir });
    }
    await runRequiredProcess('git', ['fetch', '--quiet', '--all'], { cwd: checkoutDir });
    await runRequiredProcess('gh', ['pr', 'checkout', String(args.pr.number), '--repo', args.targetRepo], { cwd: checkoutDir });
    await runRequiredProcess('git', ['reset', '--hard'], { cwd: checkoutDir });
    await runRequiredProcess('git', ['clean', '-fd'], { cwd: checkoutDir });

    const contextFile = join(tmpdir(), `invoker-coderabbit-${process.pid}-${args.pr.number}-${Date.now()}.json`);
    const context = {
      pr: args.pr.number,
      prTitle: args.pr.title ?? '',
      prUrl: args.pr.url,
      expectedHeadSha: args.expectedHeadSha,
      headBranch: args.pr.branch ?? null,
      baseBranch: args.pr.baseBranch ?? args.reviewGate.baseBranch ?? null,
      coderabbitComments: args.comments,
      invokerReviewGate: args.reviewGate,
      invokerTasks: args.invokerTasks.map(serializeTaskForContext),
    };
    await writeFile(contextFile, `${JSON.stringify(context, null, 2)}\n`, 'utf8');
    try {
      const prompt = buildCodeRabbitPrompt(args, contextFile);
      const command = args.executionAgent;
      const commandArgs = command === 'omp'
        ? [
          '--no-title',
          '--auto-approve',
          ...(args.executionModel ? ['--model', args.executionModel] : []),
          '-p',
          prompt,
        ]
        : [
          ...(args.executionModel ? ['--model', args.executionModel] : []),
          '-p',
          prompt,
        ];
      const result = await runProcess(command, commandArgs, {
        cwd: checkoutDir,
        timeoutMs: args.timeoutMs,
      });
      return {
        status: result.exitCode === 0 ? 'completed' : 'failed',
        summary: result.exitCode === 0
          ? 'CodeRabbit update agent completed'
          : `CodeRabbit update agent exited ${result.exitCode}`,
        exitCode: result.exitCode,
      };
    } finally {
      await rm(contextFile, { force: true });
    }
  }
}
