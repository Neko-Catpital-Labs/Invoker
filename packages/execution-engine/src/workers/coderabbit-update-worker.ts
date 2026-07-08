import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
  PrMaintenanceCommandOptions,
  PrMaintenanceCommandResult,
  PrMaintenanceCommandRunner,
  WorkerGitHubClient,
  WorkerGitHubComment,
  WorkerGitHubPullRequest,
} from '../worker-types.js';

export const CODERABBIT_UPDATE_WORKER_KIND = 'coderabbit-update';
export const DEFAULT_CODERABBIT_TARGET_REPO = 'Neko-Catpital-Labs/Invoker';
export const DEFAULT_CODERABBIT_AUTHOR = 'EdbertChan';
export const DEFAULT_CODERABBIT_LOGIN = 'coderabbitai[bot]';
export const DEFAULT_CODERABBIT_MAX_ATTEMPTS = 3;
export const DEFAULT_CODERABBIT_WORK_DIR = join(homedir(), '.invoker', 'pr-cron-work');
export const DEFAULT_CODERABBIT_EXECUTION_AGENT = 'omp';
export const DEFAULT_CODERABBIT_TIMEOUT_MS = 45 * 60_000;
export const DEFAULT_CODERABBIT_INTERVAL_MS = 5 * 60_000;

const CODERABBIT_ACTION_TYPE = 'address-coderabbit-feedback';
const TASK_WORKER_ACTION_EVENT = 'task.worker_action';

interface ParsedTargetRepo {
  owner: string;
  repo: string;
}

export interface CoderabbitUpdateWorkerStore {
  findReviewGateByPr?(pr: string): ReviewGateLookup | undefined;
  loadTasks(workflowId: string): TaskState[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface CoderabbitUpdateWorkerPolicyOptions {
  store: CoderabbitUpdateWorkerStore;
  logger: Logger;
  github?: WorkerGitHubClient;
  commandRunner?: PrMaintenanceCommandRunner;
  targetRepo?: string;
  author?: string;
  login?: string;
  maxAttempts?: number;
  workDir?: string;
  executionAgent?: string;
  executionModel?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export interface CoderabbitUpdateWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  coderabbit?: Omit<CoderabbitUpdateWorkerPolicyOptions, 'logger'>;
  onTick?: WorkerTick;
}

export function parseTargetRepo(targetRepo: string): ParsedTargetRepo {
  const [owner, repo, extra] = targetRepo.split('/');
  if (!owner || !repo || extra) {
    throw new Error(`Invalid GitHub target repo "${targetRepo}". Expected "owner/repo".`);
  }
  return { owner, repo };
}

export function runPrMaintenanceCommand(
  command: string,
  args: string[],
  options: PrMaintenanceCommandOptions = {},
): Promise<PrMaintenanceCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        killTimer.unref?.();
      }, options.timeoutMs)
      : undefined;
    timeout?.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      rejectPromise(err);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (code === 0 && !timedOut) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const suffix = timedOut
        ? `timed out after ${options.timeoutMs}ms`
        : `exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`;
      const err = new Error(`${command} ${args.join(' ')} ${suffix}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
      rejectPromise(err);
    });
  });
}

export function createGhCliWorkerGitHubClient(
  commandRunner: PrMaintenanceCommandRunner = runPrMaintenanceCommand,
): WorkerGitHubClient {
  const ghJson = async (args: string[]): Promise<unknown> => {
    const { stdout } = await commandRunner('gh', args);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? JSON.parse(trimmed) : undefined;
  };
  const ghJsonItems = async (args: string[]): Promise<unknown[]> => {
    const { stdout } = await commandRunner('gh', args);
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    }
    return trimmed.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line);
        return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      });
  };
  const toPullRequest = (
    raw: Record<string, unknown>,
    owner: string,
    repo: string,
    fallbackState = 'open',
  ): WorkerGitHubPullRequest => {
    const head = isRecord(raw.head) ? raw.head : undefined;
    const base = isRecord(raw.base) ? raw.base : undefined;
    return {
      owner,
      repo,
      number: Number(raw.number),
      url: String(raw.url ?? raw.html_url ?? ''),
      state: String(raw.state ?? fallbackState).toLowerCase(),
      headSha: stringValue(raw.headRefOid ?? head?.sha),
      branch: stringValue(raw.headRefName ?? head?.ref),
      baseBranch: stringValue(raw.baseRefName ?? base?.ref),
      title: stringValue(raw.title),
      body: stringValue(raw.body),
      mergeable: stringValue(raw.mergeable),
      mergeStateStatus: stringValue(raw.mergeStateStatus),
    };
  };
  const toComment = (raw: Record<string, unknown>): WorkerGitHubComment => ({
    body: String(raw.body ?? ''),
    updatedAt: String(raw.updated_at ?? raw.updatedAt ?? ''),
    path: stringValue(raw.path),
    url: stringValue(raw.html_url ?? raw.url),
    authorLogin: stringValue((raw.user as Record<string, unknown> | undefined)?.login),
  });

  return {
    async listPullRequests(args) {
      const listArgs = [
        'pr', 'list',
        '--repo', `${args.owner}/${args.repo}`,
        '--state', args.state ?? 'open',
        '--json', 'number,url,headRefName,baseRefName,title,headRefOid,mergeable,mergeStateStatus',
        '--limit', String(args.limit ?? 100),
      ];
      if (args.author) listArgs.push('--author', args.author);
      const raw = await ghJson(listArgs);
      const pulls = Array.isArray(raw) ? raw : [];
      return pulls.map((item) => toPullRequest(item as Record<string, unknown>, args.owner, args.repo, args.state ?? 'open'));
    },
    async getPullRequest(args) {
      const raw = await ghJson([
        'pr', 'view', String(args.pullNumber),
        '--repo', `${args.owner}/${args.repo}`,
        '--json', 'number,url,state,headRefOid,headRefName,baseRefName,title,body,mergeable,mergeStateStatus',
      ]);
      if (!raw || typeof raw !== 'object') return undefined;
      return toPullRequest(raw as Record<string, unknown>, args.owner, args.repo);
    },
    async listPullRequestReviewComments(args) {
      const items = await ghJsonItems([
        'api', `repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/comments`,
        '--paginate',
        '--jq', '.[] | @json',
      ]);
      return items.map((item) => toComment(item as Record<string, unknown>));
    },
    async listIssueComments(args) {
      const items = await ghJsonItems([
        'api', `repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/comments`,
        '--paginate',
        '--jq', '.[] | @json',
      ]);
      return items.map((item) => toComment(item as Record<string, unknown>));
    },
    async createPullRequestComment(args) {
      await commandRunner('gh', [
        'pr', 'comment', String(args.pullNumber),
        '--repo', `${args.owner}/${args.repo}`,
        '--body', args.body,
      ]);
    },
  };
}

export function registerCoderabbitUpdateWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CODERABBIT_UPDATE_WORKER_KIND,
    note: 'Addresses new CodeRabbit feedback on mapped Invoker PRs with a head-SHA guarded push.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const configured = deps.prMaintenance?.coderabbit;
      return createCoderabbitUpdateWorker({
        logger: deps.logger,
        coderabbit: {
          store: deps.store,
          targetRepo: configured?.targetRepo ?? deps.prMaintenance?.targetRepo,
          author: configured?.author ?? deps.prMaintenance?.author,
          login: configured?.login,
          maxAttempts: configured?.maxAttempts,
          workDir: configured?.workDir,
          executionAgent: configured?.executionAgent,
          executionModel: configured?.executionModel,
          timeoutMs: configured?.timeoutMs,
        },
        intervalMs: configured?.pollIntervalMs,
      });
    },
  });
  return registry;
}

export function coderabbitActionKey(prNumber: number, latestMarker: string): string {
  return ['coderabbit', prNumber, latestMarker].join(':');
}

export async function collectCoderabbitComments(
  github: WorkerGitHubClient,
  repo: ParsedTargetRepo,
  pullNumber: number,
  login: string,
): Promise<WorkerGitHubComment[]> {
  if (!github.listPullRequestReviewComments || !github.listIssueComments) {
    throw new Error('CodeRabbit worker requires GitHub comment listing support.');
  }
  const [reviewComments, issueComments] = await Promise.all([
    github.listPullRequestReviewComments({ ...repo, pullNumber }),
    github.listIssueComments({ ...repo, issueNumber: pullNumber }),
  ]);
  return [...reviewComments, ...issueComments]
    .filter((comment) => comment.authorLogin === login)
    .filter((comment) => comment.updatedAt.length > 0)
    .map((comment) => ({
      body: comment.body,
      updatedAt: comment.updatedAt,
      path: comment.path,
      url: comment.url,
      authorLogin: comment.authorLogin,
    }));
}

export function createCoderabbitUpdateTick(options: CoderabbitUpdateWorkerPolicyOptions): WorkerTick {
  return async () => {
    const targetRepo = options.targetRepo ?? DEFAULT_CODERABBIT_TARGET_REPO;
    const repo = parseTargetRepo(targetRepo);
    const github = options.github ?? createGhCliWorkerGitHubClient(options.commandRunner);
    if (!github.listPullRequests) {
      throw new Error('CodeRabbit worker requires GitHub pull-request listing support.');
    }
    const prs = await github.listPullRequests({
      ...repo,
      author: options.author ?? DEFAULT_CODERABBIT_AUTHOR,
      state: 'open',
      limit: 100,
    });

    for (const pr of prs) {
      const comments = await collectCoderabbitComments(
        github,
        repo,
        pr.number,
        options.login ?? DEFAULT_CODERABBIT_LOGIN,
      );
      const latestMarker = latestUpdatedAt(comments);
      if (!latestMarker) continue;

      const mapping = options.store.findReviewGateByPr?.(String(pr.number));
      if (!mapping) {
        options.logger.info(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] PR #${pr.number} has CodeRabbit feedback but no Invoker mapping; skipping`, {
          module: 'coderabbit-update-worker',
          prNumber: pr.number,
        });
        continue;
      }

      const consumed = await handleCoderabbitPr({
        options,
        github,
        repo,
        pr,
        comments,
        latestMarker,
        mapping,
      });
      if (consumed) return;
    }

    options.logger.debug?.(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] no PRs with new CodeRabbit feedback this tick`, {
      module: 'coderabbit-update-worker',
    });
  };
}

export function createCoderabbitUpdateWorker(options: CoderabbitUpdateWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: CODERABBIT_UPDATE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_CODERABBIT_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? (
      options.coderabbit
        ? createCoderabbitUpdateTick({ ...options.coderabbit, logger: options.logger })
        : (() => {})
    ),
  });
}

async function handleCoderabbitPr(args: {
  options: CoderabbitUpdateWorkerPolicyOptions;
  github: WorkerGitHubClient;
  repo: ParsedTargetRepo;
  pr: WorkerGitHubPullRequest;
  comments: WorkerGitHubComment[];
  latestMarker: string;
  mapping: ReviewGateLookup;
}): Promise<boolean> {
  const { options, github, repo, pr, comments, latestMarker, mapping } = args;
  const externalKey = coderabbitActionKey(pr.number, latestMarker);
  const existing = options.store.getWorkerAction?.(CODERABBIT_UPDATE_WORKER_KIND, externalKey);
  if (existing && (existing.status === 'completed' || existing.status === 'queued' || existing.status === 'running')) {
    logTaskWorkerAction(options, mapping, existing, 'skip', {
      reason: 'already-recorded',
      latestMarker,
    });
    return false;
  }
  if (existing?.status === 'skipped') {
    return false;
  }

  const maxAttempts = normalizePositiveInteger(options.maxAttempts, DEFAULT_CODERABBIT_MAX_ATTEMPTS);
  if ((existing?.attemptCount ?? 0) >= maxAttempts) {
    recordCoderabbitAction(options, mapping, pr, latestMarker, 'skipped', 'CodeRabbit update attempt cap reached', {
      reason: 'attempt-cap',
      maxAttempts,
      latestMarker,
    }, false);
    return false;
  }

  const current = await github.getPullRequest({ ...repo, pullNumber: pr.number });
  const startingHeadSha = current?.headSha ?? pr.headSha;
  if (!startingHeadSha) {
    recordCoderabbitAction(options, mapping, pr, latestMarker, 'skipped', 'Skipped CodeRabbit update because PR head SHA is unknown', {
      reason: 'missing-head-sha',
      latestMarker,
    }, false);
    return false;
  }

  const running = recordCoderabbitAction(options, mapping, pr, latestMarker, 'running', 'Addressing CodeRabbit feedback', {
    latestMarker,
    headSha: startingHeadSha,
    commentCount: comments.length,
  }, true);

  try {
    const checkoutDir = await prepareCoderabbitCheckout(options, repo, pr.number);
    const startingLocalHead = await readGitHead(options, checkoutDir);
    const contextFile = writeCoderabbitContext(options, checkoutDir, {
      pr,
      mapping,
      comments,
      latestMarker,
    });
    const prompt = buildCoderabbitPrompt({
      targetRepo: `${repo.owner}/${repo.repo}`,
      pr,
      baseBranch: pr.baseBranch ?? mapping.baseBranch ?? 'main',
      contextFile,
    });
    await runCoderabbitAgent(options, checkoutDir, prompt);

    const currentLocalHead = await readGitHead(options, checkoutDir);
    const dirty = await hasWorktreeChanges(options, checkoutDir);
    if (currentLocalHead === startingLocalHead && !dirty) {
      recordCoderabbitAction(options, mapping, pr, latestMarker, 'completed', 'CodeRabbit feedback required no code changes', {
        latestMarker,
        headSha: startingHeadSha,
        pushed: false,
      }, false, running);
      return true;
    }
    if (dirty) {
      recordCoderabbitAction(options, mapping, pr, latestMarker, 'failed', 'CodeRabbit agent left uncommitted changes; refusing to push', {
        reason: 'uncommitted-changes',
        latestMarker,
        startingLocalHead,
        currentLocalHead,
      }, false, running);
      return true;
    }

    const beforePush = await github.getPullRequest({ ...repo, pullNumber: pr.number });
    if (beforePush?.headSha !== startingHeadSha) {
      recordCoderabbitAction(options, mapping, pr, latestMarker, 'failed', 'Skipped CodeRabbit push because PR head changed', {
        reason: 'head-sha-changed',
        expectedHeadSha: startingHeadSha,
        currentHeadSha: beforePush?.headSha ?? null,
        latestMarker,
      }, false, running);
      return true;
    }

    const pushBranch = pr.branch ?? mapping.branch;
    if (!pushBranch) {
      recordCoderabbitAction(options, mapping, pr, latestMarker, 'failed', 'Skipped CodeRabbit push because PR branch is unknown', {
        reason: 'missing-head-branch',
        latestMarker,
      }, false, running);
      return true;
    }

    await commandRunner(options)('git', [
      'push',
      'origin',
      `HEAD:refs/heads/${pushBranch}`,
    ], { cwd: checkoutDir });
    recordCoderabbitAction(options, mapping, pr, latestMarker, 'completed', 'CodeRabbit feedback addressed and pushed', {
      latestMarker,
      previousHeadSha: startingHeadSha,
      startingLocalHead,
      pushedHead: currentLocalHead,
      pushed: true,
    }, false, running);
    return true;
  } catch (err) {
    recordCoderabbitAction(options, mapping, pr, latestMarker, 'failed', `CodeRabbit update failed: ${errorMessage(err)}`, {
      latestMarker,
      error: errorMessage(err),
    }, false, running);
    options.logger.error(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] PR #${pr.number} update failed`, {
      module: 'coderabbit-update-worker',
      prNumber: pr.number,
      err,
    });
    return true;
  }
}

async function prepareCoderabbitCheckout(
  options: CoderabbitUpdateWorkerPolicyOptions,
  repo: ParsedTargetRepo,
  prNumber: number,
): Promise<string> {
  const root = resolve(options.workDir ?? DEFAULT_CODERABBIT_WORK_DIR);
  const dir = join(root, String(prNumber));
  mkdirSync(root, { recursive: true });
  const run = commandRunner(options);
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    await run('gh', ['repo', 'clone', `${repo.owner}/${repo.repo}`, dir, '--', '--quiet']);
  } else {
    await run('git', ['reset', '--hard'], { cwd: dir });
    await run('git', ['clean', '-fd'], { cwd: dir });
  }
  await run('git', ['fetch', '--quiet', '--all'], { cwd: dir });
  await run('gh', ['pr', 'checkout', String(prNumber), '--repo', `${repo.owner}/${repo.repo}`], { cwd: dir });
  await run('git', ['reset', '--hard'], { cwd: dir });
  await run('git', ['clean', '-fd'], { cwd: dir });
  return dir;
}

function writeCoderabbitContext(
  options: CoderabbitUpdateWorkerPolicyOptions,
  checkoutDir: string,
  context: {
    pr: WorkerGitHubPullRequest;
    mapping: ReviewGateLookup;
    comments: WorkerGitHubComment[];
    latestMarker: string;
  },
): string {
  const tasks = options.store.loadTasks(context.mapping.workflowId);
  const contextFile = join(checkoutDir, '.invoker-coderabbit-context.json');
  writeFileSync(contextFile, JSON.stringify({
    pr: context.pr.number,
    prTitle: context.pr.title ?? '',
    prBody: context.pr.body ?? '',
    headBranch: context.pr.branch ?? '',
    baseBranch: context.pr.baseBranch ?? context.mapping.baseBranch ?? '',
    latestMarker: context.latestMarker,
    coderabbitComments: context.comments.map((comment) => ({
      body: comment.body,
      updated_at: comment.updatedAt,
      path: comment.path ?? null,
      html_url: comment.url ?? null,
    })),
    invokerWorkflow: context.mapping,
    invokerTasks: tasks,
  }, null, 2));
  return contextFile;
}

function buildCoderabbitPrompt(args: {
  targetRepo: string;
  pr: WorkerGitHubPullRequest;
  baseBranch: string;
  contextFile: string;
}): string {
  return [
    `You are addressing CodeRabbit review feedback on GitHub PR #${args.pr.number} in repository ${args.targetRepo}.`,
    `You are running inside a fresh checkout of the PR head branch (${args.pr.branch ?? 'unknown'}).`,
    `Context for this PR is in the JSON file: ${args.contextFile}.`,
    '',
    'Do this:',
    `1. Read the CodeRabbit comments in ${args.contextFile}. Also inspect git log origin/${args.baseBranch}..HEAD and git diff origin/${args.baseBranch}...HEAD.`,
    '2. For each distinct CodeRabbit concern, decide whether it is a genuine correctness or safety issue.',
    '3. For each valid concern, add a focused bash repro under scripts/repro and implement the minimal fix so it passes.',
    '4. Commit any repros and fixes with a clear message.',
    '5. Do not push. The worker will verify the PR head SHA and push only if it is still current.',
    '',
    'Constraints: change only what valid CodeRabbit concerns require. Do not reformat unrelated code, bump versions, or touch unrelated files.',
  ].join('\n');
}

async function runCoderabbitAgent(
  options: CoderabbitUpdateWorkerPolicyOptions,
  checkoutDir: string,
  prompt: string,
): Promise<void> {
  const agent = options.executionAgent?.trim() || DEFAULT_CODERABBIT_EXECUTION_AGENT;
  const args = ['--no-title', '--auto-approve'];
  if (options.executionModel?.trim()) {
    args.push('--model', options.executionModel.trim());
  }
  args.push('-p', prompt);
  await commandRunner(options)(agent, args, {
    cwd: checkoutDir,
    timeoutMs: options.timeoutMs ?? DEFAULT_CODERABBIT_TIMEOUT_MS,
  });
}

async function hasWorktreeChanges(
  options: CoderabbitUpdateWorkerPolicyOptions,
  checkoutDir: string,
): Promise<boolean> {
  const result = await commandRunner(options)('git', ['status', '--porcelain'], { cwd: checkoutDir });
  return result.stdout.trim().length > 0;
}

async function readGitHead(
  options: CoderabbitUpdateWorkerPolicyOptions,
  checkoutDir: string,
): Promise<string> {
  const result = await commandRunner(options)('git', ['rev-parse', 'HEAD'], { cwd: checkoutDir });
  return result.stdout.trim();
}

function recordCoderabbitAction(
  options: CoderabbitUpdateWorkerPolicyOptions,
  mapping: ReviewGateLookup,
  pr: WorkerGitHubPullRequest,
  latestMarker: string,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown>,
  incrementAttempt: boolean,
  base?: WorkerActionRecord,
): WorkerActionRecord | undefined {
  const externalKey = coderabbitActionKey(pr.number, latestMarker);
  const existing = base ?? options.store.getWorkerAction?.(CODERABBIT_UPDATE_WORKER_KIND, externalKey);
  const now = (options.now?.() ?? new Date()).toISOString();
  const record = options.store.upsertWorkerAction?.({
    id: existing?.id ?? `${CODERABBIT_UPDATE_WORKER_KIND}:${externalKey}`,
    workerKind: CODERABBIT_UPDATE_WORKER_KIND,
    actionType: CODERABBIT_ACTION_TYPE,
    workflowId: mapping.workflowId,
    taskId: mapping.mergeTaskId,
    subjectType: 'pull_request',
    subjectId: String(pr.number),
    externalKey,
    status,
    attemptCount: incrementAttempt ? (existing?.attemptCount ?? 0) + 1 : existing?.attemptCount ?? 0,
    agentName: options.executionAgent?.trim() || DEFAULT_CODERABBIT_EXECUTION_AGENT,
    executionModel: options.executionModel,
    summary,
    payload: {
      prNumber: pr.number,
      prUrl: pr.url,
      latestMarker,
      headBranch: pr.branch ?? null,
      baseBranch: pr.baseBranch ?? mapping.baseBranch ?? null,
      ...payload,
    },
    updatedAt: now,
    ...(status === 'completed' || status === 'failed' || status === 'skipped' ? { completedAt: now } : {}),
  });
  if (record) {
    logTaskWorkerAction(options, mapping, record, status, payload);
  }
  return record;
}

function logTaskWorkerAction(
  options: CoderabbitUpdateWorkerPolicyOptions,
  mapping: ReviewGateLookup,
  action: WorkerActionRecord,
  phase: string,
  details: Record<string, unknown>,
): void {
  options.store.logEvent?.(mapping.mergeTaskId, TASK_WORKER_ACTION_EVENT, {
    worker: CODERABBIT_UPDATE_WORKER_KIND,
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

function latestUpdatedAt(comments: WorkerGitHubComment[]): string | undefined {
  return comments.reduce<string | undefined>((latest, comment) => {
    if (!comment.updatedAt) return latest;
    return !latest || comment.updatedAt > latest ? comment.updatedAt : latest;
  }, undefined);
}

function commandRunner(options: CoderabbitUpdateWorkerPolicyOptions): PrMaintenanceCommandRunner {
  return options.commandRunner ?? runPrMaintenanceCommand;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
