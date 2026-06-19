/**
 * TaskRunner — Shared task execution logic for CLI and Electron.
 *
 * Extracted from CLI Runner to eliminate duplication between
 * the CLI runner and Electron app execution paths.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { scopePlanTaskId } from '@invoker/workflow-core';
import type { Orchestrator, TaskState, ExperimentVariant, RunnerKind } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { WorkRequest, WorkResponse, ActionType, Logger } from '@invoker/contracts';
import { ATTEMPT_LEASE_MS } from '@invoker/contracts';
import type { Executor, ExecutorHandle } from './executor.js';
import type { TaskRunnerCallbacks } from './task-runner-callbacks.js';
import { BaseExecutor } from './base-executor.js';
import { RESTART_TO_BRANCH_TRACE, traceExecution } from './exec-trace.js';
import { createExecutionBench } from './execution-bench.js';
import { ResourceLimitError, type RepoPoolTiming } from './repo-pool.js';
import type { ExecutorRegistry } from './registry.js';
import type { AgentRegistry } from './agent-registry.js';
import type { MergeGateProvider, MergeGateApprovalStatus } from './merge-gate-provider.js';
import type { ReviewProviderRegistry } from './review-provider-registry.js';
import { DockerExecutor } from './docker-executor.js';
import { WorktreeExecutor } from './worktree-executor.js';
import { MergeGateExecutor } from './merge-gate-executor.js';
import { isInvokerManagedPoolBranch } from './plan-base-remote.js';
import { formatLifecycleTag, extractAttemptSuffix } from './branch-utils.js';
import { SshExecutor } from './ssh-executor.js';
import {
  executeMergeNodeImpl,
  approveMergeImpl,
  publishAfterFixImpl,
  buildMergeSummaryImpl,
  consolidateAndMergeImpl,
  ensureLocalBranchForMerge,
  collectTransitiveNonMergeTaskIds,
} from './merge-runner.js';
import { normalizeBranchForGithubCli } from './github-branch-ref.js';
import {
  resolveConflictImpl,
  fixWithAgentImpl,
  spawnAgentFixViaRegistry,
  resolveRemoteBranchOwnerPath,
  resolveSelectedRemoteTargetId,
} from './conflict-resolver.js';
import { DEFAULT_EXECUTION_AGENT } from './agent.js';
import {
  buildCanonicalPrBody,
  buildMakePrPrompt,
  resolveSkillPathViaAgent,
  spawnAgentPrAuthorViaRegistry,
  validateCanonicalPrBody,
  type PrAuthoringContext,
} from './pr-authoring.js';
import { assertNotGitConfigMutation, ensureRemoteUrl } from './git-config-mutation.js';
import { killProcessGroup, SIGKILL_TIMEOUT_MS } from './process-utils.js';

export type { TaskHeartbeatEvent, TaskRunnerCallbacks } from './task-runner-callbacks.js';

/** Keeps launch metadata fresh while `executor.start()` is awaited (SSH remote setup/provision can take minutes). */
const PRE_START_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_EXECUTOR_START_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_GIT_OPERATION_TIMEOUT_MS = 15 * 60 * 1000;

type StartupFailureMetadata = {
  workspacePath?: string;
  branch?: string;
  agentSessionId?: string;
  containerId?: string;
};

type ActiveExecutionHandle = ExecutorHandle & { attemptId?: string };
type ActiveExecutionEntry = {
  handle: ActiveExecutionHandle;
  executor: Executor;
  taskId: string;
  poolId?: string;
  poolMemberKey?: string;
  leaseResourceKey?: string;
  leaseHolderId?: string;
};

type ExecutionPoolMember =
  | { type: 'ssh'; id: string; maxConcurrentTasks?: number }
  | { type: 'worktree'; id: string; maxConcurrentTasks?: number };

type ExecutionPoolConfig = {
  members: ExecutionPoolMember[];
  selectionStrategy?: 'roundRobin' | 'leastLoaded';
  maxConcurrentTasksPerMember?: number;
};

type PoolSelection = {
  poolId: string;
  member: ExecutionPoolMember;
  memberKey: string;
  selectionStrategy: 'roundRobin' | 'leastLoaded';
  leaseResourceKey?: string;
  leaseHolderId?: string;
};

function isRetryableSshStartupTransportError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  const lower = message.toLowerCase();
  return lower.includes('exit=255')
    || lower.includes('ssh transport failed')
    || lower.includes('connection timed out')
    || lower.includes('operation timed out')
    || lower.includes('connection reset')
    || lower.includes('broken pipe')
    || lower.includes('banner exchange')
    || lower.includes('kex_exchange_identification')
    || lower.includes('remote session terminated unexpectedly');
}

type FreshBaseCommit = {
  branch: string;
  commit: string;
};

type RemoteTargetDisplay = {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  managedWorkspaces?: boolean;
  remoteInvokerHome?: string;
  provisionCommand?: string;
  use_api_key?: boolean;
  secretsFile?: string;
  remoteHeartbeatIntervalSeconds?: number;
};

export interface ReviewGateCiFailureTrigger {
  taskId: string;
  workflowId: string;
  reviewId: string;
  reviewUrl: string;
  headSha?: string;
  headRef?: string;
  branch?: string;
  selectedAttemptId?: string;
  generation: number;
  failedChecks: NonNullable<MergeGateApprovalStatus['checks']>['failed'];
  statusText: string;
}

function nextLeaseExpiry(from: Date): Date {
  return new Date(from.getTime() + ATTEMPT_LEASE_MS);
}

function getExecutorStartTimeoutMs(): number {
  const raw = process.env.INVOKER_EXECUTOR_START_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_EXECUTOR_START_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EXECUTOR_START_TIMEOUT_MS;
  return parsed;
}

function getGitOperationTimeoutMs(): number {
  const raw = process.env.INVOKER_GIT_NETWORK_TIMEOUT_MS?.trim();
  if (raw === '0') return 0;
  if (!raw) return DEFAULT_GIT_OPERATION_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_GIT_OPERATION_TIMEOUT_MS;
  return parsed;
}

function execGitWithTimeout(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const timeoutMs = getGitOperationTimeoutMs();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        killProcessGroup(child, 'SIGTERM');
        const forceKill = setTimeout(() => {
          killProcessGroup(child, 'SIGKILL');
        }, SIGKILL_TIMEOUT_MS);
        forceKill.unref?.();
        finish(() => reject(new Error(
          `git ${args.join(' ')} exceeded git operation timeout (${timeoutMs}ms) in ${cwd}. ` +
          'Set INVOKER_GIT_NETWORK_TIMEOUT_MS to adjust (0 = unbounded).',
        )));
      }, timeoutMs);
      timeout.unref?.();
    }

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      finish(() => reject(new Error(`Failed to spawn git: ${err.message}`)));
    });
    child.on('close', (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolvePromise(stdout.trim());
          return;
        }
        reject(new Error(
          `git ${args.join(' ')} failed (code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}): ` +
          `${stderr.trim()}${stdout.trim() ? '\n' + stdout.trim() : ''}`,
        ));
      });
    });
  });
}

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

// ── Launch outbox ─────────────────────────────────────────

/**
 * Narrow interface for the launch-handoff outbox surface that
 * `executeTask` calls into. Defined here (rather than imported from
 * `@invoker/app`) to avoid a layering cycle: the execution engine
 * never depends on the app shell, the app provides this implementation
 * via the LaunchDispatcher.
 *
 * Each method MUST be safe to call even if the dispatch row was
 * reaped between the dispatcher's lease and the runner's call — the
 * persistence layer returns false in that case and the runner treats
 * it as a benign race.
 */
export interface LaunchOutboxAck {
  completeDispatch(dispatchId: number): boolean;
  failDispatch(dispatchId: number, error: unknown): boolean;
}

export interface LaunchDispatchOptions {
  dispatchId: number;
  launchOutbox: LaunchOutboxAck;
}

// ── Config ────────────────────────────────────────────────

export interface TaskRunnerConfig {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  executorRegistry: ExecutorRegistry;
  /** Repo root / working directory for git commands and task execution. */
  cwd: string;
  /** Max worktrees per repo for WorktreeExecutor. Default: 3. */
  maxWorktreesPerRepo?: number;
  /** Default branch from config (e.g. "master"). Falls back to git heuristic if unset. */
  defaultBranch?: string;
  callbacks?: TaskRunnerCallbacks;
  mergeGateProvider?: MergeGateProvider;
  reviewProviderRegistry?: ReviewProviderRegistry;
  onReviewGateCiFailure?: (trigger: ReviewGateCiFailureTrigger) => Promise<void>;
  /**
   * Provider that returns remote SSH targets keyed by target ID.
   * Called at task-execution time so config file changes take effect on retry.
   */
  remoteTargetsProvider?: () => Record<string, {
    host: string;
    user: string;
    sshKeyPath: string;
    port?: number;
    managedWorkspaces?: boolean;
    remoteInvokerHome?: string;
    provisionCommand?: string;
    use_api_key?: boolean;
    secretsFile?: string;
    remoteHeartbeatIntervalSeconds?: number;
  }>;
  executionPoolsProvider?: () => Record<string, {
    members: Array<
      | { type: 'ssh'; id: string; maxConcurrentTasks?: number }
      | { type: 'worktree'; id: string; maxConcurrentTasks?: number }
    >;
    selectionStrategy?: 'roundRobin' | 'leastLoaded';
    maxConcurrentTasksPerMember?: number;
  }>;
  /** Docker execution environment configuration from .invoker.json. */
  dockerConfig?: {
    imageName?: string;
    secretsFile?: string;
  };
  /** Shared execution agents (Claude, Codex). Passed into lazily constructed executors. */
  executionAgentRegistry?: AgentRegistry;
  logger?: Logger;
}

// ── TaskRunner ──────────────────────────────────────────

export class TaskRunner {
  private static readonly BRANCH_REMOTE_NAME = 'invoker-branches';
  /** @internal */ orchestrator: Orchestrator;
  /** @internal */ persistence: SQLiteAdapter;
  private executorRegistry: ExecutorRegistry;
  /** @internal */ cwd: string;
  private maxWorktreesPerRepo: number;
  /** @internal */ defaultBranch: string | undefined;
  /** @internal */ callbacks: TaskRunnerCallbacks;
  /** @internal */ mergeGateProvider?: MergeGateProvider;
  /** @internal */ reviewProviderRegistry?: ReviewProviderRegistry;
  private onReviewGateCiFailure?: (trigger: ReviewGateCiFailureTrigger) => Promise<void>;
  private reviewGateCiFixInFlight = new Set<string>();
  private getRemoteTargets: () => Record<string, RemoteTargetDisplay>;
  private getExecutionPools: () => Record<string, ExecutionPoolConfig>;
  private dockerConfig: { imageName?: string; secretsFile?: string };
  private executionAgentRegistry?: AgentRegistry;
  private logger: Logger;
  private readonly runnerInstanceId = randomUUID();
  /** Cache for SSH executors, keyed by poolMemberId. One instance per target for correct git locking. */
  private sshExecutorCache = new Map<string, SshExecutor>();
  private poolRoundRobinCursor = new Map<string, number>();
  private pendingPoolSelections = new Map<string, PoolSelection>();
  private freshBaseCommits = new Map<string, FreshBaseCommit>();

  /** In-flight executions keyed by attemptId (with taskId retained for external kill resolution). */
  private activeExecutions = new Map<string, ActiveExecutionEntry>();
  private launchingAttemptIds = new Set<string>();

  /** Serializes async onComplete handlers so orchestrator mutations never overlap. */
  private completionChain: Promise<void> = Promise.resolve();

  /** Config default branch (e.g. master) for workflows without baseBranch. */
  getDefaultBranchHint(): string | undefined {
    return this.defaultBranch;
  }

  /**
   * Before rebase-and-retry: refresh pool mirror + origin base, remove managed branches for this workflow.
   */
  async preparePoolForRebaseRetry(
    workflowId: string,
    repoUrl: string | undefined,
    baseBranchHint: string | undefined,
    timing?: RepoPoolTiming,
  ): Promise<{ branch: string; commit: string } | undefined> {
    if (!repoUrl) return undefined;
    const executor = this.executorRegistry.get('worktree');
    if (!(executor instanceof WorktreeExecutor)) return undefined;
    const pool = executor.getRepoPool();
    const baseBranch = baseBranchHint?.trim() || this.defaultBranch || 'master';
    await pool.refreshMirrorForRebase(repoUrl, baseBranch, timing);
    const commit = await pool.resolveBaseCommit(repoUrl, baseBranch, timing);
    this.freshBaseCommits.set(workflowId, { branch: baseBranch, commit });
    const collectStartedAtMs = Date.now();
    timing?.mark('TaskRunner.preparePoolForRebaseRetry.collectManagedWorkflowBranches', 'started', {
      workflowId,
    });
    const branches = this.collectManagedWorkflowBranches(workflowId);
    timing?.mark('TaskRunner.preparePoolForRebaseRetry.collectManagedWorkflowBranches', 'completed', {
      workflowId,
      branchCount: branches.length,
      durationMs: Date.now() - collectStartedAtMs,
    });
    await pool.removeManagedBranchesInMirror(repoUrl, branches, timing);
    return { branch: baseBranch, commit };
  }

  /**
   * Ensure the pool mirror clone exists for merge resolution (branch may exist only there).
   */
  /** @internal */ async ensureRepoMirrorPath(repoUrl: string): Promise<string | undefined> {
    const trimmed = repoUrl.trim();
    if (!trimmed) return undefined;
    const executor = this.executorRegistry.get('worktree');
    if (!(executor instanceof WorktreeExecutor)) return undefined;
    try {
      return await executor.getRepoPool().ensureCloneThroughRepoQueue(trimmed);
    } catch (err) {
      this.logger.warn(`[merge] ensureRepoMirrorPath failed for ${trimmed}`, { err });
      return undefined;
    }
  }

  private collectManagedWorkflowBranches(workflowId: string): string[] {
    const branches: string[] = [];
    const seen = new Set<string>();
    const addBranch = (branch: string | undefined): void => {
      const trimmed = branch?.trim();
      if (!trimmed || !isInvokerManagedPoolBranch(trimmed) || seen.has(trimmed)) return;
      seen.add(trimmed);
      branches.push(trimmed);
    };

    for (const task of this.orchestrator.getAllTasks()) {
      if (task.config.workflowId !== workflowId || task.config.isMergeNode) continue;
      addBranch(task.execution.branch);
      for (const attempt of this.persistence.loadAttempts?.(task.id) ?? []) {
        addBranch(attempt.branch);
      }
    }

    return branches;
  }

  constructor(config: TaskRunnerConfig) {
    this.orchestrator = config.orchestrator;
    this.persistence = config.persistence;
    this.executorRegistry = config.executorRegistry;
    this.cwd = config.cwd;
    this.maxWorktreesPerRepo = config.maxWorktreesPerRepo ?? 5;
    this.defaultBranch = config.defaultBranch;
    this.callbacks = config.callbacks ?? {};
    this.mergeGateProvider = config.mergeGateProvider;
    this.reviewProviderRegistry = config.reviewProviderRegistry;
    this.onReviewGateCiFailure = config.onReviewGateCiFailure;
    this.getRemoteTargets = config.remoteTargetsProvider ?? (() => ({}));
    this.getExecutionPools = config.executionPoolsProvider ?? (() => ({}));
    this.dockerConfig = config.dockerConfig ?? {};
    this.executionAgentRegistry = config.executionAgentRegistry;
    this.logger = config.logger ?? NOOP_LOGGER;
  }

  /**
   * Stop the executor child for a task that is currently in-flight (after orchestrator.cancelTask).
   */
  async killActiveExecution(taskId: string): Promise<void> {
    const resolved = this.resolveActiveExecution(taskId);
    if (!resolved) return;
    this.activeExecutions.delete(resolved.attemptId);
    if (resolved.entry.leaseResourceKey && resolved.entry.leaseHolderId) {
      this.persistence.releaseExecutionResourceLease?.(resolved.entry.leaseResourceKey, resolved.entry.leaseHolderId);
    }
    try {
      await resolved.entry.executor.kill(resolved.entry.handle);
    } catch {
      /* process may already have exited */
    }
  }

  private loadLatestAttemptId(taskId: string): string | undefined {
    const loadAttempts = this.persistence.loadAttempts?.bind(this.persistence);
    if (!loadAttempts) return undefined;
    try {
      const attempts = loadAttempts(taskId);
      return attempts[attempts.length - 1]?.id;
    } catch {
      return undefined;
    }
  }

  private resolveAttemptIdForStart(task: TaskState): string {
    return task.execution.selectedAttemptId ?? this.loadLatestAttemptId(task.id) ?? task.id;
  }

  private resolveActiveExecution(taskId: string): { attemptId: string; entry: ActiveExecutionEntry } | undefined {
    const selectedAttemptId = this.orchestrator.getTask(taskId)?.execution.selectedAttemptId;
    if (selectedAttemptId) {
      const entry = this.activeExecutions.get(selectedAttemptId);
      if (entry) return { attemptId: selectedAttemptId, entry };
      return undefined;
    }

    const latestAttemptId = this.loadLatestAttemptId(taskId);
    if (latestAttemptId) {
      const entry = this.activeExecutions.get(latestAttemptId);
      if (entry) return { attemptId: latestAttemptId, entry };
    }

    for (const [attemptId, entry] of this.activeExecutions) {
      if (entry.taskId === taskId || entry.handle.taskId === taskId) {
        return { attemptId, entry };
      }
    }

    return undefined;
  }

  private createExecuteTaskBench(taskId: string, attemptId: string): (phase: string, metadata?: Record<string, unknown>) => void {
    return createExecutionBench({
      module: 'execute-task-bench',
      logger: this.logger,
      baseMetadata: {
        taskId,
        attemptId,
      },
    });
  }

  /**
   * Execute multiple tasks concurrently.
   */
  async executeTasks(tasks: TaskState[]): Promise<void> {
    if (tasks.length > 0) {
      traceExecution(
        `${RESTART_TO_BRANCH_TRACE} TaskRunner.executeTasks count=${tasks.length} ids=${tasks.map((t) => t.id).join(', ')}`,
      );
    }
    await Promise.all(tasks.map((task) => this.executeTask(task)));
  }

  private executeNewlyStartedTasks(
    tasks: TaskState[],
    dispatchOpts?: LaunchDispatchOptions,
  ): void {
    if (tasks.length === 0) return;
    if (dispatchOpts) {
      this.logger.debug(
        `[TaskRunner] durable launch outbox owns ${tasks.length} newly-started task(s); skipping recursive executeTasks`,
      );
      return;
    }
    void this.executeTasks(tasks);
  }

  /**
   * Execute a single task through the executor pipeline.
   *
   * 1. Pivot tasks with variants → synthesize spawn_experiments response
   * 2. Build upstream context from completed dependencies
   * 3. Build WorkRequest with workspacePath
   * 4. Start executor → persist agentSessionId + workspacePath immediately
   * 5. Wire output/completion callbacks
   * 6. On completion → feed response to orchestrator → auto-execute newly ready tasks
   */
  /**
   * Check whether the task lineage has moved past the attempt that was
   * captured at launch time.  Returns `true` when the current
   * `selectedAttemptId` or `generation` no longer matches, meaning any
   * persistence from this launch would overwrite a newer attempt's data.
   */
  private isLaunchStale(
    taskId: string,
    attemptId: string,
    startGeneration: number,
  ): boolean {
    const current = this.orchestrator.getTask(taskId);
    // If the task is no longer visible to the orchestrator we cannot
    // confirm the lineage advanced — fall through to the normal failure
    // path rather than silently suppressing the error.
    if (!current) return false;
    const currentAttempt = current.execution.selectedAttemptId;
    const currentGeneration = current.execution.generation ?? 0;
    if (currentAttempt !== undefined && currentAttempt !== attemptId) return true;
    if (currentGeneration !== startGeneration) return true;
    return false;
  }

  async executeTask(task: TaskState, dispatchOpts?: LaunchDispatchOptions): Promise<void> {
    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} TaskRunner.executeTask BEGIN taskId=${task.id} isMergeNode=${Boolean(task.config.isMergeNode)} status=${task.status}`,
    );
    const attemptId = this.resolveAttemptIdForStart(task);
    const startGeneration = task.execution.generation ?? 0;
    const bench = this.createExecuteTaskBench(task.id, attemptId);
    bench('executeTask.accepted', {
      status: task.status,
      phase: task.execution.phase,
      generation: startGeneration,
    });
    if (this.launchingAttemptIds.has(attemptId) || this.activeExecutions.has(attemptId)) {
      traceExecution(
        `[TaskRunner] executeTask skipping duplicate launch for task=${task.id} attempt=${attemptId}`,
      );
      bench('executeTask.duplicateSkipped');
      if (dispatchOpts) {
        // Another runner already owns this attempt — release the dispatch
        // row so the dispatcher can re-queue if needed instead of orphaning.
        dispatchOpts.launchOutbox.failDispatch(
          dispatchOpts.dispatchId,
          new Error('Duplicate launch suppressed in TaskRunner'),
        );
      }
      return;
    }
    this.logger.info(
      `[TaskRunner] launch accepted task=${task.id} attempt=${attemptId} status=${task.status} ` +
        `phase=${task.execution.phase ?? 'none'} generation=${startGeneration} ` +
        `dispatchId=${dispatchOpts?.dispatchId ?? 'none'}`,
    );
    this.launchingAttemptIds.add(attemptId);
    this.callbacks.onLaunchAccepted?.(task.id);
    try {
      await this.executeTaskInner(task, attemptId, bench, dispatchOpts);
      bench('executeTask.innerReturned');
    } catch (err) {
      bench('executeTask.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Resource limit: defer the task instead of failing it
      const cause = err instanceof Error ? err.cause : undefined;
      if (cause instanceof ResourceLimitError) {
        traceExecution(`[TaskRunner] executeTask deferred for task=${task.id}: ${cause.message}`);
        this.orchestrator.deferTask(task.id);
        if (dispatchOpts) {
          const completed = dispatchOpts.launchOutbox.completeDispatch(dispatchOpts.dispatchId);
          bench('executeTask.dispatchCompletedAfterDeferral', { accepted: completed });
          if (!completed) {
            this.logger.warn(
              `[TaskRunner] launch dispatch complete rejected after resource-limit defer for task=${task.id} attempt=${attemptId} dispatchId=${dispatchOpts.dispatchId}`,
            );
          }
        }
        return;
      }

      // Guard: if the task lineage has advanced past this attempt, the
      // startup failure belongs to a superseded launch.  Drop the
      // metadata write and the failed WorkResponse so we don't clobber
      // the live attempt's state.
      if (this.isLaunchStale(task.id, attemptId, startGeneration)) {
        this.logger.warn(
          `[TaskRunner] suppressing stale startup-failure metadata/response for task=${task.id} attemptId=${attemptId}`,
        );
        await this.cleanupPerTaskDockerExecutor(task);
        return;
      }

      this.logger.error(`[TaskRunner] executeTask failed for task=${task.id}`, { err });
      if (dispatchOpts) {
        dispatchOpts.launchOutbox.failDispatch(dispatchOpts.dispatchId, err);
      }
      const launchFailedAt = new Date();
      try {
        const latest = this.orchestrator.getTask(task.id);
        if (
          latest
          && (
            latest.status === 'running'
            || latest.status === 'fixing_with_ai'
            || (latest.status === 'pending' && latest.execution.phase === 'launching')
          )
        ) {
          this.persistence.updateTask(task.id, {
            execution: {
              phase: latest.execution.phase ?? 'launching',
              launchStartedAt: latest.execution.launchStartedAt ?? latest.execution.startedAt ?? launchFailedAt,
              launchCompletedAt: launchFailedAt,
              lastHeartbeatAt: launchFailedAt,
            },
          });
        }
      } catch {
        // best effort; preserve original startup/execution failure flow
      }
      // Clean up per-task Docker executor on startup/execution failure
      await this.cleanupPerTaskDockerExecutor(task);
      const response: WorkResponse = {
        requestId: `err-${task.id}`,
        actionId: task.id,
        attemptId,
        executionGeneration: task.execution.generation ?? 0,
        status: 'failed',
        outputs: {
          exitCode: 1,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        },
      };
      const newlyStarted = this.orchestrator.handleWorkerResponse(response) ?? [];
      try {
        this.callbacks.onComplete?.(task.id, response);
      } catch (callbackErr) {
        this.logger.error(`[TaskRunner] completion callback observer failed for task=${task.id}`, { err: callbackErr });
      }
      this.executeNewlyStartedTasks(newlyStarted, dispatchOpts);
    } finally {
      this.launchingAttemptIds.delete(attemptId);
      bench('executeTask.settled');
    }
  }

  private async executeTaskInner(
    task: TaskState,
    attemptId: string,
    bench: (phase: string, metadata?: Record<string, unknown>) => void = () => {},
    dispatchOpts?: LaunchDispatchOptions,
  ): Promise<void> {
    bench('executeTaskInner.begin', {
      dependencyCount: task.dependencies.length,
      externalDependencyCount: task.config.externalDependencies?.length ?? 0,
      runnerKind: task.config.runnerKind,
      poolId: task.config.poolId,
      isMergeNode: task.config.isMergeNode,
    });
    // Pivot tasks with experimentVariants: synthesize a spawn_experiments
    // response instead of running through the executor.
    if (task.config.pivot && task.config.experimentVariants && task.config.experimentVariants.length > 0) {
      bench('executeTaskInner.pivotResponse');
      const response: WorkResponse = {
        requestId: `req-${task.id}`,
        actionId: task.id,
        attemptId,
        executionGeneration: task.execution.generation ?? 0,
        status: 'spawn_experiments',
        outputs: {},
        dagMutation: {
          spawnExperiments: {
            description: task.description,
            variants: task.config.experimentVariants.map((v: ExperimentVariant) => ({
              id: v.id,
              description: v.description,
              prompt: v.prompt,
              command: v.command,
            })),
          },
        },
      };
      const newlyStarted = this.orchestrator.handleWorkerResponse(response) ?? [];
      this.executeNewlyStartedTasks(newlyStarted, dispatchOpts);
      // CD.1 / Issue 13: terminate the parent pivot task's outbox row.
      // Without this, drainScheduler enqueued a launch-dispatch row for
      // the pivot, but executeTaskInner returns here without ever
      // calling completeDispatch, so the row stays leased and is retried
      // or abandoned. The spawn_experiments path is the terminal state
      // for the pivot itself; only the spawned variants should continue
      // through the outbox.
      if (dispatchOpts) {
        try {
          dispatchOpts.launchOutbox.completeDispatch(dispatchOpts.dispatchId);
        } catch (err) {
          // completeDispatch is best-effort here — if the row has
          // already been failed or completed by another path the
          // failure is benign. Log and continue so the pivot's
          // observable behaviour (spawning variants) is unaffected.
          // eslint-disable-next-line no-console
          console.warn(
            `[task-runner] pivot completeDispatch failed for dispatchId=${dispatchOpts.dispatchId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      bench('executeTaskInner.pivotReturned', {
        newlyStartedCount: newlyStarted.length,
      });
      return;
    }

    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} (past pivot check) → gather upstreams + build WorkRequest`,
    );

    // Gather upstream context from completed dependencies
    bench('buildUpstreamContext.start');
    const upstreamContext = await this.buildUpstreamContext(task);
    bench('buildUpstreamContext.end', {
      upstreamContextCount: upstreamContext.length,
    });
    bench('collectUpstreamBranches.start');
    const upstreamBranches = this.collectUpstreamBranches(task);
    bench('collectUpstreamBranches.end', {
      upstreamBranchCount: upstreamBranches.length,
    });
    bench('buildAlternatives.start');
    const alternatives = this.buildAlternatives(task);
    bench('buildAlternatives.end', {
      alternativeCount: alternatives.length,
    });

    // Guard: every completed dependency (local or external) must have branch metadata.
    // Without it the downstream worktree would run against bare base branch,
    // silently dropping all upstream implementation changes.
    // Skip for merge nodes: they collect branches from the full workflow, not just direct deps.
    if (!task.config.isMergeNode) {
      for (const depId of task.dependencies) {
        const dep = this.orchestrator.getTask(depId);
        if (dep && dep.status === 'completed' && !dep.execution.branch) {
          throw new Error(
            `Task "${task.id}": dependency "${depId}" completed without branch metadata` +
            ` — upstream changes would be silently dropped. The plan may need to be restarted.`,
          );
        }
      }
      for (const depRef of task.config.externalDependencies ?? []) {
        const dep = this.resolveExternalDependencyTask(depRef.workflowId, depRef.taskId);
        if (dep && dep.status === 'completed' && !dep.execution.branch) {
          throw new Error(
            `Task "${task.id}": external dependency "${depRef.workflowId}/${depRef.taskId}" completed without branch metadata` +
            ` — upstream changes would be silently dropped. The plan may need to be restarted.`,
          );
        }
      }
    }
    bench('dependencyBranchGuard.end');

    // Read workflow + task generations to build the visible lifecycle tag that
    // is appended to every experiment branch name. Lifecycle uniqueness lives
    // in the branch *name* (via `formatLifecycleTag`), not in the content hash
    // — so two recreates of the same spec produce the same content fingerprint
    // (cache-equivalent) but distinct branch names (collision-free).
    const workflow = task.config.workflowId ? this.persistence.loadWorkflow?.(task.config.workflowId) : undefined;
    const workflowGeneration = (workflow as any)?.generation ?? 0;
    const taskExecutionGeneration = task.execution.generation ?? 0;
    const lifecycleTag = formatLifecycleTag({
      wfGen: workflowGeneration,
      taskGen: taskExecutionGeneration,
      attemptShort: extractAttemptSuffix(attemptId, task.id),
    });
    const baseBranch = workflow?.baseBranch ?? this.defaultBranch;
    const repoUrl = workflow?.repoUrl;
    const branchRepoUrl = workflow?.intermediateRepoUrl?.trim() || undefined;
    const freshBase = task.config.workflowId ? this.freshBaseCommits.get(task.config.workflowId) : undefined;
    const baseCommit = freshBase && freshBase.branch === baseBranch ? freshBase.commit : undefined;

    // Persist the experiment branch as soon as the executor knows it — well
    // before `git worktree add` could leak a worktree without a recorded branch
    // on the attempt row. Reconciliation paths can then observe the branch
    // even if the executor crashes mid-startup.
    let branchPersistedEarly = false;
    const startGeneration = task.execution.generation ?? 0;
    const onBranchResolved = (branch: string): void => {
      if (!branch || branchPersistedEarly) return;
      // Skip if the task has moved to a newer attempt/generation.
      if (this.isLaunchStale(task.id, attemptId, startGeneration)) return;
      branchPersistedEarly = true;
      try {
        this.persistence.updateAttempt?.(attemptId, { branch } as any);
        this.persistence.updateTask(task.id, {
          execution: { branch } as any,
        });
        traceExecution(
          `${RESTART_TO_BRANCH_TRACE} task=${task.id} attempt=${attemptId} branch persisted early branch=${branch}`,
        );
      } catch (err) {
        // Early persistence is best-effort: the post-start path persists the
        // same field again, so a transient failure here is not fatal.
        traceExecution(
          `${RESTART_TO_BRANCH_TRACE} task=${task.id} attempt=${attemptId} early branch persist failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    const actionType = this.determineActionType(task);
    const executionAgent = task.config.executionAgent?.trim() || DEFAULT_EXECUTION_AGENT;
    const request: WorkRequest = {
      requestId: randomUUID(),
      actionId: task.id,
      attemptId,
      executionGeneration: task.execution.generation ?? 0,
      actionType,
      inputs: {
        description: task.description,
        command: task.config.command,
        prompt: task.config.prompt,
        executionAgent,
        repoUrl,
        branchRepoUrl,
        featureBranch: task.config.featureBranch,
        upstreamContext: upstreamContext.length > 0 ? upstreamContext : undefined,
        alternatives: alternatives.length > 0 ? alternatives : undefined,
        upstreamBranches: upstreamBranches.length > 0 ? upstreamBranches : undefined,
        lifecycleTag,
        baseBranch,
        baseCommit,
        freshWorkspace: this.shouldUseFreshWorkspace(task),
        reusableWorktree: task.execution.branch && task.execution.workspacePath
          ? {
            branch: task.execution.branch,
            workspacePath: task.execution.workspacePath,
          }
          : undefined,
      },
      callbackUrl: '',
      timestamps: {
        createdAt: new Date().toISOString(),
      },
      onBranchResolved,
    };
    bench('workRequest.built', {
      actionType: request.actionType,
      hasRepoUrl: Boolean(request.inputs.repoUrl),
      upstreamBranchCount: upstreamBranches.length,
    });

    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} WorkRequest built actionType=${request.actionType} repoUrl=${request.inputs.repoUrl ?? '(none)'} upstreamBranches=${JSON.stringify(request.inputs.upstreamBranches ?? [])}`,
    );
    const startT0 = Date.now();
    const attemptedPoolMemberKeys = new Set<string>();
    let executor!: Executor;
    let handle!: ExecutorHandle;
    while (true) {
      bench('selectExecutor.start');
      executor = this.selectExecutor(task, attemptedPoolMemberKeys);
      const poolSelectionForStart = this.pendingPoolSelections.get(task.id);
      if (!this.acquirePoolSelectionLease(task, attemptId, poolSelectionForStart)) {
        if (poolSelectionForStart) {
          attemptedPoolMemberKeys.add(poolSelectionForStart.memberKey);
          this.pendingPoolSelections.delete(task.id);
        }
        continue;
      }
      bench('selectExecutor.end', {
        executorType: executor.type,
      });
      traceExecution(
        `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} selectExecutor → type=${executor.type} calling executor.start()`,
      );
      traceExecution(`[trace] TaskRunner: task=${task.id} calling executor.start() type=${executor.type}`);
      this.logger.info(
        `[TaskRunner] executor.start begin task=${task.id} attempt=${attemptId} executor=${executor.type} ` +
          `generation=${task.execution.generation ?? 0}`,
      );
      this.persistence.logEvent?.(task.id, 'task.executor.start_begin', {
        dispatchId: dispatchOpts?.dispatchId,
        attemptId,
        executorType: executor.type,
        poolId: poolSelectionForStart?.poolId,
        poolMemberId: poolSelectionForStart?.member.id,
      });
      bench('onLaunchStart.before', {
        executorType: executor.type,
      });
      this.callbacks.onLaunchStart?.(task.id, executor);
      bench('executor.start.before', {
        executorType: executor.type,
      });
      const startTimeoutMs = getExecutorStartTimeoutMs();
      const preStartHeartbeatTimer = setInterval(() => {
        const now = new Date();
        this.renewPoolSelectionLease(poolSelectionForStart);
        this.persistence.updateAttempt?.(attemptId, {
          lastHeartbeatAt: now,
          leaseExpiresAt: nextLeaseExpiry(now),
        } as any);
        this.callbacks.onHeartbeat?.(task.id, { at: now, source: 'executor' });
      }, PRE_START_HEARTBEAT_INTERVAL_MS);
      let preStartTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        handle = await Promise.race<ExecutorHandle>([
          executor.start(request),
          new Promise<ExecutorHandle>((_resolve, reject) => {
            preStartTimeout = setTimeout(() => {
              reject(new Error(`Executor startup timed out after ${startTimeoutMs}ms (${executor.type})`));
            }, startTimeoutMs);
          }),
        ]);
        break;
      } catch (err) {
        const meta = err as StartupFailureMetadata;
        if (
          executor.type === 'ssh'
          && poolSelectionForStart?.member.type === 'ssh'
          && !meta.workspacePath
          && !meta.branch
          && isRetryableSshStartupTransportError(err)
        ) {
          attemptedPoolMemberKeys.add(poolSelectionForStart.memberKey);
          const pool = this.getExecutionPools()[poolSelectionForStart.poolId];
          const hasAnotherSshMember = pool?.members.some((member) =>
            member.type === 'ssh' && !attemptedPoolMemberKeys.has(this.poolMemberKey(member)),
          ) ?? false;
          if (hasAnotherSshMember) {
            const retryMessage =
              `Executor startup failed (${executor.type}) on pool member ${poolSelectionForStart.member.id}; ` +
              `retrying another SSH pool member: ${err instanceof Error ? err.message : String(err)}\n`;
            this.callbacks.onOutput?.(task.id, retryMessage);
            try {
              this.persistence.appendTaskOutput(task.id, retryMessage);
            } catch {
              // Preserve the original startup failure if output persistence also fails.
            }
            this.persistence.logEvent?.(task.id, 'task.executor.startup-retry', {
              runnerKind: executor.type,
              poolId: poolSelectionForStart.poolId,
              poolMemberId: poolSelectionForStart.member.id,
              reason: 'ssh-startup-transport-failure',
              error: err instanceof Error ? err.message : String(err),
            });
            this.pendingPoolSelections.delete(task.id);
            this.releasePoolSelectionLease(poolSelectionForStart);
            continue;
          }
        }
        const startupErrorMessage = `Executor startup failed (${executor.type}): ${err instanceof Error ? err.message : String(err)}\n`;
        this.callbacks.onOutput?.(task.id, startupErrorMessage);
        try {
          this.persistence.appendTaskOutput(task.id, startupErrorMessage);
        } catch {
          // Preserve the original startup failure if output persistence also fails.
        }
        // Only persist startup-failure metadata when the launch is still
        // current.  If the task has moved to a newer attempt or generation
        // (e.g. via recreate-task), writing old workspace/branch metadata
        // would corrupt the live attempt's state.
        if (
          (meta.workspacePath || meta.branch || meta.agentSessionId || meta.containerId)
          && !this.isLaunchStale(task.id, attemptId, task.execution.generation ?? 0)
        ) {
          const execution: Record<string, string> = {};
          if (meta.workspacePath) execution.workspacePath = meta.workspacePath;
          if (meta.branch) execution.branch = meta.branch;
          if (meta.agentSessionId) {
            execution.agentSessionId = meta.agentSessionId;
            execution.lastAgentSessionId = meta.agentSessionId;
          }
          if (meta.containerId) execution.containerId = meta.containerId;
          const poolSelection = this.pendingPoolSelections.get(task.id);
          const selectedSshTargetId = executor.type === 'ssh'
            ? this.selectedRemoteTargetId(task, poolSelection)
            : undefined;
          this.persistence.updateTask(task.id, {
            config: {
              runnerKind: executor.type as RunnerKind,
              ...(selectedSshTargetId ? { poolMemberId: selectedSshTargetId } : {}),
            },
            execution: execution as any,
          });
        }
        this.pendingPoolSelections.delete(task.id);
        this.releasePoolSelectionLease(poolSelectionForStart);
        const wrapped = new Error(
          `Executor startup failed (${executor.type}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
        this.callbacks.onLaunchFailed?.(task.id, wrapped, executor);
        throw wrapped;
      } finally {
        clearInterval(preStartHeartbeatTimer);
        if (preStartTimeout) clearTimeout(preStartTimeout);
      }
    }
    traceExecution(`[trace] TaskRunner: task=${task.id} executor.start() returned after ${Date.now() - startT0}ms executor=${executor.type} sessionId=${handle.agentSessionId ?? 'none'} workspace=${handle.workspacePath ?? 'default'}`);
    this.logger.info(
      `[TaskRunner] executor.start returned task=${task.id} attempt=${attemptId} executor=${executor.type} ` +
        `elapsedMs=${Date.now() - startT0} executionId=${handle.executionId} ` +
        `workspace=${handle.workspacePath ?? 'none'} branch=${handle.branch ?? 'none'} ` +
        `agentSessionId=${handle.agentSessionId ?? 'none'}`,
    );
    bench('executor.start.after', {
      executorType: executor.type,
      executorStartMs: Date.now() - startT0,
      hasWorkspacePath: Boolean(handle.workspacePath),
      hasAgentSessionId: Boolean(handle.agentSessionId),
    });
    // Lineage guard: `executor.start()` can resolve minutes after the launch was
    // accepted (SSH provisioning, slow clones). `markTaskRunningAfterLaunch`
    // rejects a mismatched `selectedAttemptId` but does NOT validate the
    // generation captured at launch time, so a recreate that bumps the task to a
    // newer generation while keeping the same attempt id would still be accepted
    // — and the post-start writes below would persist this superseded launch's
    // workspace/branch/session/container metadata over the live attempt and
    // register a stale active execution. Reject an advanced generation through
    // the same kill/cleanup path as the stale-attempt rejection, leaving
    // attempt-id rejection to `markTaskRunningAfterLaunch` as before.
    const currentForLineage = this.orchestrator.getTask(task.id);
    const generationAdvanced =
      currentForLineage !== undefined
      && (currentForLineage.execution.generation ?? 0) !== startGeneration;
    const launchAccepted =
      !generationAdvanced && (this.orchestrator.markTaskRunningAfterLaunch?.(task.id, attemptId) ?? true);
    if (!launchAccepted) {
      this.logger.warn(
        `[TaskRunner] launch rejected as stale/non-executable for task=${task.id} attemptId=${attemptId} ` +
          `startGeneration=${startGeneration} generationAdvanced=${generationAdvanced}; killing spawned process`,
      );
      try {
        await executor.kill(handle);
      } catch (killErr) {
        this.logger.warn(`[TaskRunner] failed to kill rejected launch for task=${task.id}`, { killErr });
      }
      this.releasePoolSelectionLease(this.pendingPoolSelections.get(task.id));
      this.pendingPoolSelections.delete(task.id);
      await this.cleanupPerTaskDockerExecutor(task);
      if (dispatchOpts) {
        dispatchOpts.launchOutbox.failDispatch(
          dispatchOpts.dispatchId,
          new Error(
            generationAdvanced
              ? 'Launch rejected: task lineage advanced past launch generation after executor start'
              : 'Launch rejected as stale or non-executable after executor start',
          ),
        );
      }
      bench('markTaskRunningAfterLaunch.rejected', { generationAdvanced });
      return;
    }
    bench('markTaskRunningAfterLaunch.accepted');

    // Persist execution metadata immediately at task start — all fields explicit
    {
      // Fail-fast: workspacePath must be provided by all executors
      if (!handle.workspacePath) {
        this.releasePoolSelectionLease(this.pendingPoolSelections.get(task.id));
        throw new Error(
          `Executor "${executor.type}" did not provide workspacePath for task "${task.id}". ` +
          `All executors must set workspacePath; refusing to fall back to host repo.`,
        );
      }

      this.logExecutorSelected(
        task,
        executor,
        handle,
        attemptId,
        this.pendingPoolSelections.get(task.id),
      );

      const poolSelection = this.pendingPoolSelections.get(task.id);
      const selectedSshTargetId = executor.type === 'ssh'
        ? this.selectedRemoteTargetId(task, poolSelection)
        : undefined;
      const changes = {
        config: {
          runnerKind: executor.type as RunnerKind,
          ...(selectedSshTargetId ? { poolMemberId: selectedSshTargetId } : {}),
        },
        execution: {
          workspacePath: handle.workspacePath,
          branch: handle.branch ?? undefined,  // Explicit undefined when branch is not applicable (e.g., BYO mode)
          agentSessionId: handle.agentSessionId ?? undefined,
          lastAgentSessionId: handle.agentSessionId ?? undefined,
          agentName: actionType === 'ai_task' ? executionAgent : undefined,
          lastAgentName: actionType === 'ai_task' ? executionAgent : undefined,
          containerId: handle.containerId ?? undefined,
        },
      };
      this.persistence.updateTask(task.id, changes);
      // Mirror branch + workspacePath onto the attempt row so reconciliation
      // and post-mortem flows can recover provenance from the attempt without
      // joining back to the task. Pairs with the early `onBranchResolved`
      // persistence; this is the authoritative success-path write.
      try {
        this.persistence.updateAttempt?.(attemptId, {
          branch: handle.branch ?? undefined,
          workspacePath: handle.workspacePath,
        } as any);
      } catch (err) {
        traceExecution(
          `${RESTART_TO_BRANCH_TRACE} task=${task.id} attempt=${attemptId} post-start attempt persist failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      traceExecution(
        `[agent-session-trace] TaskRunner.persistStartMetadata task=${task.id} agentSessionId=${handle.agentSessionId ?? 'null'}`,
      );
      if (task.config.isMergeNode) {
        traceExecution(
          `[merge-gate-workspace] persistStartMetadata mergeNode=${task.id} ` +
            `executor workspacePath=${changes.execution.workspacePath} ` +
            '(gate clone path is written later in executeMergeNode)',
        );
      }
      traceExecution(`[trace] TaskRunner: persisted metadata for task=${task.id} workspacePath=${handle.workspacePath} branch=${handle.branch ?? 'null'}`);
      bench('persistStartMetadata.end', {
        workspacePath: handle.workspacePath,
        branch: handle.branch ?? undefined,
      });
    }

    // Notify consumer about the spawned handle
    const activeHandle = handle as ActiveExecutionHandle;
    activeHandle.attemptId = attemptId;
    const poolSelection = this.pendingPoolSelections.get(task.id);
    this.pendingPoolSelections.delete(task.id);
    this.activeExecutions.set(attemptId, {
      handle: activeHandle,
      executor,
      taskId: task.id,
      poolId: poolSelection?.poolId,
      poolMemberKey: poolSelection?.memberKey,
      leaseResourceKey: poolSelection?.leaseResourceKey,
      leaseHolderId: poolSelection?.leaseHolderId,
    });
    this.logger.info(
      `[TaskRunner] active execution registered task=${task.id} attempt=${attemptId} ` +
        `executor=${executor.type} executionId=${handle.executionId} activeExecutions=${this.activeExecutions.size}`,
    );
    bench('onSpawned.before');
    this.callbacks.onSpawned?.(task.id, handle, executor);
    bench('onSpawned.after');

    // Wire output
    executor.onOutput(handle, (data) => {
      this.callbacks.onOutput?.(task.id, data);
    });

    // Wire heartbeat
    executor.onHeartbeat(handle, () => {
      const now = new Date();
      const isRemoteWorkloadHeartbeat = executor.type === 'ssh';
      if (isRemoteWorkloadHeartbeat) {
        this.logger.info(
          `[TaskRunner] ssh heartbeat received task=${task.id} attempt=${attemptId} executionId=${handle.executionId} ` +
            `at=${now.toISOString()}`,
        );
      }
      const activeLease = this.activeExecutions.get(attemptId);
      if (activeLease?.leaseResourceKey && activeLease.leaseHolderId) {
        this.persistence.renewExecutionResourceLease?.(activeLease.leaseResourceKey, activeLease.leaseHolderId);
      }
      this.persistence.updateAttempt?.(attemptId, {
        lastHeartbeatAt: now,
        leaseExpiresAt: nextLeaseExpiry(now),
      } as any);
      this.callbacks.onHeartbeat?.(task.id, {
        at: now,
        source: isRemoteWorkloadHeartbeat ? 'remote_workload' : 'executor',
      });
    });

    // Wait for completion and feed response to orchestrator.
    // The callback is serialized through completionChain so that concurrent
    // onComplete firings never overlap inside orchestrator mutations.
    const completionPromise = new Promise<void>((resolvePromise) => {
      executor.onComplete(handle, async (response: WorkResponse) => {
        const work = async () => {
          const normalizedResponse = response.attemptId ? response : { ...response, attemptId };
          const activeExecution = this.activeExecutions.get(normalizedResponse.attemptId ?? attemptId);
          if (activeExecution?.leaseResourceKey && activeExecution.leaseHolderId) {
            this.persistence.releaseExecutionResourceLease?.(activeExecution.leaseResourceKey, activeExecution.leaseHolderId);
          }
          this.activeExecutions.delete(normalizedResponse.attemptId ?? attemptId);
          this.logger.info(
            `[TaskRunner] completion callback task=${task.id} attempt=${normalizedResponse.attemptId ?? attemptId} ` +
              `status=${normalizedResponse.status} exitCode=${normalizedResponse.outputs.exitCode ?? 'none'} ` +
              `executionId=${handle.executionId} activeExecutions=${this.activeExecutions.size}`,
          );
          let newlyStarted: TaskState[] = [];
          try {
            try {
              traceExecution(
                `[task-runner] onComplete taskId=${task.id} responseStatus=${response.status} ` +
                  `responseAttemptId=${normalizedResponse.attemptId ?? attemptId} responseGeneration=${response.executionGeneration} executionId=${handle.executionId}`,
              );
              traceExecution(
                `${RESTART_TO_BRANCH_TRACE} resolvePromise | task.config.isMergeNode = ${task.config.isMergeNode}`,
              );
              newlyStarted = this.orchestrator.handleWorkerResponse(normalizedResponse) ?? [];
            } catch (err) {
              this.logger.error(`[TaskRunner] worker response handling failed for task=${task.id}`, { err });
              const errResponse: WorkResponse = {
                requestId: response.requestId,
                actionId: task.id,
                attemptId,
                executionGeneration: task.execution.generation ?? 0,
                status: 'failed',
                outputs: {
                  exitCode: 1,
                  error: err instanceof Error ? (err.stack ?? err.message) : String(err),
                },
              };
              try {
                this.orchestrator.handleWorkerResponse(errResponse);
              } catch (fallbackErr) {
                this.logger.error(`[TaskRunner] fallback failure response handling failed for task=${task.id}`, { err: fallbackErr });
              }
              try {
                this.callbacks.onComplete?.(task.id, errResponse);
              } catch (callbackErr) {
                this.logger.error(`[TaskRunner] completion callback observer failed for task=${task.id}`, { err: callbackErr });
              }
              return;
            }

            try {
              this.callbacks.onComplete?.(task.id, normalizedResponse);
            } catch (err) {
              this.logger.error(`[TaskRunner] completion callback observer failed for task=${task.id}`, { err });
            }

            this.executeNewlyStartedTasks(newlyStarted, dispatchOpts);
          } finally {
            // Clean up per-task Docker executor to avoid resource leaks
            try {
              await this.cleanupPerTaskDockerExecutor(task);
            } catch (cleanupErr) {
              this.logger.warn(`[TaskRunner] completion cleanup failed for task=${task.id}`, { err: cleanupErr });
            }
          }
        };

        const prev = this.completionChain;
        this.completionChain = prev.then(work, work);
        await this.completionChain;
        resolvePromise();
      });
    });
    if (dispatchOpts) {
      dispatchOpts.launchOutbox.completeDispatch(dispatchOpts.dispatchId);
    }
    return completionPromise;
  }

  /**
   * Recreate flows clear both branch and workspacePath before rerun.
   * Restarts preserve them, so this is the executor-facing signal to bypass
   * same-action worktree reuse only for semantically fresh recreates.
   */
  private shouldUseFreshWorkspace(task: TaskState): boolean {
    return (task.execution.generation ?? 0) > 0
      && task.execution.branch === undefined
      && task.execution.workspacePath === undefined;
  }

  /**
   * Select the executor to use for a given task.
   * Uses task.runnerKind to look up in the registry; falls back to default.
   * Merge gate tasks use the dedicated merge executor.
   */
  private poolMemberKey(member: ExecutionPoolMember): string {
    return `${member.type}:${member.id}`;
  }

  private poolMemberLoad(poolId: string, memberKey: string): number {
    let load = 0;
    for (const selection of this.pendingPoolSelections.values()) {
      if (selection.poolId === poolId && selection.memberKey === memberKey) load += 1;
    }
    for (const entry of this.activeExecutions.values()) {
      if (entry.poolId === poolId && entry.poolMemberKey === memberKey) load += 1;
    }
    return load;
  }

  private poolMemberLimit(pool: ExecutionPoolConfig, member: ExecutionPoolMember): number | undefined {
    return member.maxConcurrentTasks ?? pool.maxConcurrentTasksPerMember;
  }

  private poolMemberHasCapacity(poolId: string, pool: ExecutionPoolConfig, member: ExecutionPoolMember): boolean {
    const limit = this.poolMemberLimit(pool, member);
    return limit === undefined || this.poolMemberLoad(poolId, this.poolMemberKey(member)) < limit;
  }

  private selectPoolMember(
    poolId: string,
    pool: ExecutionPoolConfig,
    excludedMemberKeys: Set<string> = new Set(),
  ): ExecutionPoolMember | undefined {
    if (pool.members.length === 0) return undefined;

    if (pool.selectionStrategy === 'roundRobin') {
      const cursor = this.poolRoundRobinCursor.get(poolId) ?? 0;
      for (let offset = 0; offset < pool.members.length; offset += 1) {
        const index = (cursor + offset) % pool.members.length;
        const member = pool.members[index];
        if (excludedMemberKeys.has(this.poolMemberKey(member))) continue;
        if (!this.poolMemberHasCapacity(poolId, pool, member)) continue;
        this.poolRoundRobinCursor.set(poolId, (index + 1) % pool.members.length);
        return member;
      }
      return undefined;
    }

    const scored = pool.members.filter((member) => !excludedMemberKeys.has(this.poolMemberKey(member))).map((member, index) => {
      const memberKey = this.poolMemberKey(member);
      const load = this.poolMemberLoad(poolId, memberKey);
      const limit = this.poolMemberLimit(pool, member);
      return { member, index, load, hasCapacity: limit === undefined || load < limit };
    });
    const candidates = scored.filter((entry) => entry.hasCapacity);
    candidates.sort((a, b) => a.load - b.load || a.index - b.index);
    return candidates[0]?.member;
  }

  private poolCapacitySnapshot(poolId: string, pool: ExecutionPoolConfig): Array<{
    memberId: string;
    memberType: string;
    load: number;
    limit: number | undefined;
  }> {
    return pool.members.map((member) => {
      const memberKey = this.poolMemberKey(member);
      return {
        memberId: member.id,
        memberType: member.type,
        load: this.poolMemberLoad(poolId, memberKey),
        limit: this.poolMemberLimit(pool, member),
      };
    });
  }

  private poolCapacityError(taskId: string, poolId: string, pool: ExecutionPoolConfig, excludedMemberKeys: Set<string>): Error {
    const snapshot = this.poolCapacitySnapshot(poolId, pool);
    const message = `Execution pool "${poolId}" has no member capacity available`;
    const resourceLimit = new ResourceLimitError(message);
    this.persistence.logEvent?.(taskId, 'task.executor.deferred', {
      reason: 'execution-pool-capacity',
      poolId,
      excludedMemberKeys: [...excludedMemberKeys],
      members: snapshot,
    });
    this.logger.info(`[TaskRunner] deferring task: ${message}`, {
      poolId,
      excludedMemberKeys: [...excludedMemberKeys],
      members: snapshot,
    });
    return new Error(message, { cause: resourceLimit });
  }

  private sshResourceKey(target: RemoteTargetDisplay): string {
    return `ssh:${target.user}@${target.host}:${target.port ?? 22}`;
  }

  private leaseHolderId(taskId: string, attemptId: string): string {
    return `${this.runnerInstanceId}:${process.pid}:${taskId}:${attemptId}`;
  }

  private acquirePoolSelectionLease(task: TaskState, attemptId: string, selection: PoolSelection | undefined): boolean {
    if (!selection || selection.member.type !== 'ssh') return true;
    const target = this.getRemoteTargets()[selection.member.id];
    if (!target) return true;
    const resourceKey = this.sshResourceKey(target);
    const holderId = this.leaseHolderId(task.id, attemptId);
    const acquired = this.persistence.claimExecutionResourceLease?.({
      resourceKey,
      resourceType: 'ssh',
      holderId,
      taskId: task.id,
      poolId: selection.poolId,
      poolMemberId: selection.member.id,
      metadata: {
        runnerInstanceId: this.runnerInstanceId,
        pid: process.pid,
      },
    }) ?? true;
    if (!acquired) {
      this.persistence.logEvent?.(task.id, 'task.executor.deferred', {
        reason: 'ssh-resource-lease-held',
        poolId: selection.poolId,
        poolMemberId: selection.member.id,
        resourceKey,
      });
      return false;
    }
    selection.leaseResourceKey = resourceKey;
    selection.leaseHolderId = holderId;
    return true;
  }

  private renewPoolSelectionLease(selection: PoolSelection | undefined): void {
    if (!selection?.leaseResourceKey || !selection.leaseHolderId) return;
    this.persistence.renewExecutionResourceLease?.(selection.leaseResourceKey, selection.leaseHolderId);
  }

  private releasePoolSelectionLease(selection: PoolSelection | undefined): void {
    if (!selection?.leaseResourceKey || !selection.leaseHolderId) return;
    this.persistence.releaseExecutionResourceLease?.(selection.leaseResourceKey, selection.leaseHolderId);
    selection.leaseResourceKey = undefined;
    selection.leaseHolderId = undefined;
  }

  private logExecutorSelected(
    task: TaskState,
    executor: Executor,
    handle: ExecutorHandle,
    attemptId: string,
    poolSelection: PoolSelection | undefined,
  ): void {
    const payload: Record<string, unknown> = {
      runnerKind: executor.type,
      reason: this.executorSelectionReason(task, executor, poolSelection),
      attemptId,
      workspacePath: handle.workspacePath,
      branch: handle.branch ?? undefined,
    };

    if (executor.type === 'ssh') {
      const targetId = this.selectedRemoteTargetId(task, poolSelection);
      const target = targetId ? this.getRemoteTargets()[targetId] : undefined;
      if (targetId) payload.poolMemberId = targetId;
      if (target) {
        payload.remoteHost = target.host;
        payload.remoteUser = target.user;
        payload.port = target.port;
      }
    }

    this.persistence.logEvent?.(task.id, 'task.executor.selected', payload);
  }

  private executorSelectionReason(
    task: TaskState,
    executor: Executor,
    poolSelection: PoolSelection | undefined,
  ): Record<string, unknown> {
    if (executor.type === 'ssh') {
      if (poolSelection) {
        return {
          type: 'poolId',
          poolId: poolSelection.poolId,
          selectionStrategy: poolSelection.selectionStrategy,
          poolMemberId: poolSelection.member.id,
        };
      }
      if ((task.config as { poolMemberId?: string }).poolMemberId) {
        return { type: 'explicitPoolMemberId' };
      }
      if (task.config.poolId) {
        return { type: 'poolId', poolId: task.config.poolId };
      }
    }

    if (executor.type === 'worktree') {
      if (task.config.runnerKind === 'ssh' && task.config.poolId) {
        return { type: 'sshPoolFallbackToWorktree', poolId: task.config.poolId };
      }
      if (task.config.runnerKind === 'worktree') {
        return { type: 'configuredWorktree' };
      }
      return { type: 'defaultWorktree' };
    }

    if (executor.type === 'docker') {
      return { type: 'dockerImage' };
    }

    return { type: 'configuredRunnerKind', runnerKind: executor.type };
  }

  private selectedRemoteTargetId(task: TaskState, poolSelection: PoolSelection | undefined): string | undefined {
    if (poolSelection?.member.type === 'ssh') return poolSelection.member.id;
    return (task.config as { poolMemberId?: string }).poolMemberId
      ?? (task.config.poolId && this.getRemoteTargets()[task.config.poolId] ? task.config.poolId : undefined);
  }

  selectExecutor(task: TaskState, excludedPoolMemberKeys: Set<string> = new Set()): Executor {
    let effectiveType = task.config.runnerKind ?? (task.config.isMergeNode ? 'merge' : undefined);
    let selectedPoolMemberId: string | undefined;
    const explicitPoolMemberId = (task.config as { poolMemberId?: string }).poolMemberId;
    this.pendingPoolSelections.delete(task.id);

    if (task.config.poolId && explicitPoolMemberId) {
      const pool = this.getExecutionPools()[task.config.poolId];
      const member = pool?.members.find((candidate) => candidate.type === 'ssh' && candidate.id === explicitPoolMemberId);
      if (pool && member) {
        if (
          excludedPoolMemberKeys.has(this.poolMemberKey(member))
          || !this.poolMemberHasCapacity(task.config.poolId, pool, member)
        ) {
          throw this.poolCapacityError(task.id, task.config.poolId, pool, excludedPoolMemberKeys);
        }
        effectiveType = member.type;
        selectedPoolMemberId = member.id;
        this.pendingPoolSelections.set(task.id, {
          poolId: task.config.poolId,
          member,
          memberKey: this.poolMemberKey(member),
          selectionStrategy: pool.selectionStrategy ?? 'roundRobin',
        });
      }
    } else if (task.config.poolId) {
      const pool = this.getExecutionPools()[task.config.poolId];
      const member = pool ? this.selectPoolMember(task.config.poolId, pool, excludedPoolMemberKeys) : undefined;
      if (member) {
        effectiveType = member.type;
        selectedPoolMemberId = member.type === 'ssh' ? member.id : undefined;
        this.pendingPoolSelections.set(task.id, {
          poolId: task.config.poolId,
          member,
          memberKey: this.poolMemberKey(member),
          selectionStrategy: pool.selectionStrategy ?? 'roundRobin',
        });
      } else if (pool) {
        throw this.poolCapacityError(task.id, task.config.poolId, pool, excludedPoolMemberKeys);
      }
    }
    if (
      effectiveType === 'ssh'
      && task.config.poolId
      && !selectedPoolMemberId
      && !explicitPoolMemberId
      && !this.getRemoteTargets()[task.config.poolId]
    ) {
      effectiveType = 'worktree';
    }

    if (effectiveType) {
      const registered = this.executorRegistry.get(effectiveType);
      if (registered && (effectiveType !== 'merge' || registered.type === 'merge')) {
        traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=${effectiveType} → ${registered.type}`);
        return registered;
      }

      // Per-task Docker instance (each task gets its own container + execGitSimple routing)
      if (effectiveType === 'docker') {
        const docker = new DockerExecutor({
          imageName: task.config.dockerImage || this.dockerConfig.imageName,
          secretsFile: this.dockerConfig.secretsFile,
          agentRegistry: this.executionAgentRegistry,
        });
        this.executorRegistry.register(`docker:${task.id}`, docker);
        traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=docker → docker (per-task)`);
        return docker;
      }

      // Lazy registration for Worktree
      if (effectiveType === 'worktree') {
        const invokerHome = resolve(homedir(), '.invoker');
        const worktree = new WorktreeExecutor({
          worktreeBaseDir: resolve(invokerHome, 'worktrees'),
          cacheDir: resolve(invokerHome, 'repos'),
          maxWorktrees: this.maxWorktreesPerRepo,
          agentRegistry: this.executionAgentRegistry,
        });
        this.executorRegistry.register('worktree', worktree);
        traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=worktree → worktree (lazy registered)`);
        return worktree;
      }

      if (effectiveType === 'merge') {
        const merge = new MergeGateExecutor(this);
        this.executorRegistry.register?.('merge', merge);
        traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=merge → merge (lazy registered)`);
        return merge;
      }

      // Lazy registration for SSH — resolve poolMemberId from config and cache by targetId.
      // The cache is config-aware: if the underlying remote target config changes (e.g. via
      // remoteTargetsProvider returning new values), we replace the cached executor so the
      // new config takes effect immediately.
      if (effectiveType === 'ssh') {
        const remoteTargets = this.getRemoteTargets();
        const targetId =
          selectedPoolMemberId
          ?? (task.config as { poolMemberId?: string }).poolMemberId
          ?? (task.config.poolId && remoteTargets[task.config.poolId] ? task.config.poolId : undefined);
        if (!targetId) {
          throw new Error(`Task ${task.id} has runnerKind=ssh but no poolMemberId`);
        }

        // Always re-read targets so dynamic provider updates are picked up.
        const target = remoteTargets[targetId];
        if (!target) {
          throw new Error(
            `Task ${task.id} references poolMemberId="${targetId}" but no matching ` +
            `entry exists in remoteTargets config. Available: [${Object.keys(remoteTargets).join(', ')}]`,
          );
        }

        // Build a config fingerprint so cache invalidates when target config changes.
        const configFingerprint = JSON.stringify({
          host: target.host,
          user: target.user,
          sshKeyPath: target.sshKeyPath,
          port: target.port,
          managedWorkspaces: target.managedWorkspaces,
          remoteInvokerHome: target.remoteInvokerHome,
          provisionCommand: target.provisionCommand,
          use_api_key: target.use_api_key === true,
          secretsFile: target.secretsFile ?? this.dockerConfig.secretsFile,
          remoteHeartbeatIntervalSeconds: target.remoteHeartbeatIntervalSeconds,
        });
        const cacheKey = `${targetId}|${configFingerprint}`;

        // Return cached executor if it exists for this target+config combo
        const cached = this.sshExecutorCache.get(cacheKey);
        if (cached) {
          traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=ssh remoteTarget=${targetId} → ssh (cached)`);
          return cached;
        }

        // Drop any stale entries for this targetId so we don't accumulate dead caches.
        for (const key of this.sshExecutorCache.keys()) {
          if (key.startsWith(`${targetId}|`)) {
            this.sshExecutorCache.delete(key);
          }
        }

        const ssh = new SshExecutor({
          host: target.host,
          user: target.user,
          sshKeyPath: target.sshKeyPath,
          port: target.port,
          agentRegistry: this.executionAgentRegistry,
          managedWorkspaces: target.managedWorkspaces,
          remoteInvokerHome: target.remoteInvokerHome,
          provisionCommand: target.provisionCommand,
          useApiKey: target.use_api_key === true,
          secretsFile: target.secretsFile ?? this.dockerConfig.secretsFile,
          remoteHeartbeatIntervalSeconds: target.remoteHeartbeatIntervalSeconds,
        });

        this.sshExecutorCache.set(cacheKey, ssh);
        traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=ssh remoteTarget=${targetId} → ssh (new, cached)`);
        return ssh;
      }
    }

    const defaultExecutor = this.executorRegistry.getDefault();
    traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=${effectiveType ?? 'none'} → ${defaultExecutor.type} (default)`);
    return defaultExecutor;
  }

  /**
   * Determine the correct ActionType for a task based on its fields.
   * Priority: merge gate > isReconciliation > command > prompt > default 'command'.
   */
  determineActionType(task: TaskState): ActionType {
    if (task.config.runnerKind === 'merge' || task.config.isMergeNode) return 'merge_gate';
    if (task.config.isReconciliation) return 'reconciliation';
    if (task.config.command) return 'command';
    if (task.config.prompt) return 'ai_task';
    return 'command';
  }

  // ── Merge Node Execution ─────────────────────────────────

  private async executeMergeNode(task: TaskState): Promise<void> {
    traceExecution(`${RESTART_TO_BRANCH_TRACE} TaskRunner.executeMergeNode taskId=${task.id} → merge-executor.executeMergeNodeImpl`);
    return this.withAttemptHeartbeat(task.id, () => executeMergeNodeImpl(this, task));
  }

  async approveMerge(workflowId: string): Promise<void> {
    return approveMergeImpl(this, workflowId);
  }

  async publishAfterFix(task: TaskState): Promise<void> {
    return publishAfterFixImpl(this, task);
  }

  async commitApprovedFix(task: TaskState): Promise<void> {
    if (task.config.isMergeNode) {
      await this.commitApprovedMergeFix(task);
      return;
    }
    return this.publishApprovedFix(task);
  }

  async publishApprovedFix(task: TaskState): Promise<void> {
    const workspacePath = task.execution.workspacePath?.trim();
    if (!workspacePath) {
      throw new Error(`Task ${task.id} has no workspacePath for approved-fix publish`);
    }
    const branch = task.execution.branch?.trim();
    if (!branch) {
      throw new Error(`Task ${task.id} has no branch for approved-fix publish`);
    }

    const workflow = task.config.workflowId ? this.persistence.loadWorkflow?.(task.config.workflowId) : undefined;
    const request: WorkRequest = {
      requestId: randomUUID(),
      actionId: task.id,
      attemptId: task.execution.selectedAttemptId,
      executionGeneration: task.execution.generation ?? 0,
      actionType: this.determineActionType(task),
      inputs: {
        description: task.description,
        command: task.config.command,
        prompt: task.config.prompt,
        branchRepoUrl: workflow?.intermediateRepoUrl?.trim() || undefined,
      },
      callbackUrl: '',
      timestamps: {
        createdAt: new Date().toISOString(),
      },
    };

    let publishWorkspacePath = workspacePath;
    if (task.config.runnerKind === 'ssh') {
      const poolMemberId = resolveSelectedRemoteTargetId(this, task.id, task);
      const target = poolMemberId ? this.getRemoteTargetConfig(poolMemberId) : undefined;
      if (target) {
        const repairedWorkspacePath = await resolveRemoteBranchOwnerPath(branch, workspacePath, target);
        if (repairedWorkspacePath && repairedWorkspacePath !== workspacePath) {
          publishWorkspacePath = repairedWorkspacePath;
          this.persistence.updateTask(task.id, {
            execution: {
              workspacePath: repairedWorkspacePath,
            },
          });
          this.persistence.logEvent?.(task.id, 'debug.approved-fix', {
            phase: 'publish-approved-fix-remote-path-repaired',
            previousWorkspacePath: workspacePath,
            repairedWorkspacePath,
          });
        }
      }
    }

    const executor = this.selectExecutor(task);
    let result: { commitHash?: string; error?: string };
    if (executor instanceof SshExecutor) {
      result = await executor.publishApprovedFix(publishWorkspacePath, request, branch);
    } else if (executor instanceof BaseExecutor) {
      result = await executor.publishApprovedFix(publishWorkspacePath, request, branch);
    } else {
      throw new Error(
        `Executor ${executor.type} does not support approved-fix publish for task ${task.id}`,
      );
    }

    if (result.error) {
      throw new Error(result.error);
    }
    if (!result.commitHash) {
      throw new Error(`Approved-fix publish produced no commit hash for task ${task.id}`);
    }

    this.persistence.updateTask(task.id, {
      execution: {
        commit: result.commitHash,
      },
    });
    const attemptId = task.execution.selectedAttemptId;
    if (attemptId) {
      this.persistence.updateAttempt(attemptId, {
        branch,
        commit: result.commitHash,
      });
    }
  }

  async buildMergeSummary(workflowId: string): Promise<string> {
    return buildMergeSummaryImpl(this, workflowId);
  }

  private async commitApprovedMergeFix(task: TaskState): Promise<void> {
    const workspacePath = task.execution.workspacePath?.trim();
    if (!workspacePath) {
      throw new Error(`Task ${task.id} has no workspacePath for approved merge-fix commit`);
    }

    const status = (await this.execGitIn(['status', '--porcelain'], workspacePath)).trim();
    if (status) {
      await this.execGitIn(['add', '-A'], workspacePath);
      await this.execGitIn(
        ['commit', '-m', `Apply approved fix for ${task.description || task.id}`],
        workspacePath,
      );
    }

    const fixedIntegrationSha = (await this.execGitIn(['rev-parse', 'HEAD'], workspacePath)).trim();
    this.persistence.updateTask(task.id, {
      execution: {
        fixedIntegrationSha,
        fixedIntegrationRecordedAt: new Date(),
        fixedIntegrationSource: 'approved_fix',
      },
    });
  }

  async runVisualProofCapture(baseBranch: string, featureBranch: string, slug: string, repoUrl?: string): Promise<string | undefined> {
    try {
      const scriptPath = resolve(this.cwd, 'scripts/ui-visual-proof.sh');
      const outputDir = resolve(this.cwd, 'packages/app/e2e/visual-proof');

      const wtDir = await this.createMergeWorktree(baseBranch, 'vp-' + slug, repoUrl);

      const runCapture = (label: string): Promise<string> => {
        return new Promise((resolveP, reject) => {
          const child = spawn('bash', [scriptPath, '--label', label, '--output-dir', outputDir], {
            cwd: wtDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr?.on('data', (d: Buffer) => {
            stderr += d.toString();
            this.logger.info(`[visual-proof] ${d.toString().trimEnd()}`);
          });
          child.on('error', (err) => reject(err));
          child.on('close', (code) => {
            if (code !== 0) reject(new Error(`Visual proof capture failed (exit ${code}): ${stderr}`));
            else resolveP(stdout.trim());
          });
        });
      };

      try {
        await runCapture('before');
        const featureSha = (await this.execGitIn(['rev-parse', featureBranch], wtDir)).trim();
        await this.execGitIn(['checkout', '-f', '--detach', featureSha], wtDir);
        await runCapture('after');
      } finally {
        await this.removeMergeWorktree(wtDir);
      }

      // Upload and build markdown from files that exist in both before/after captures.
      const beforeDir = resolve(outputDir, 'before');
      const afterDir = resolve(outputDir, 'after');
      const beforePngs = new Set(readdirSync(beforeDir).filter((f) => f.endsWith('.png')));
      const afterPngs = new Set(readdirSync(afterDir).filter((f) => f.endsWith('.png')));
      const states = [...beforePngs].filter((f) => afterPngs.has(f)).sort();

      mkdirSync(resolve(homedir(), '.invoker'), { recursive: true });
      const tmpDir = mkdtempSync(resolve(homedir(), '.invoker', 'vp-'));
      try {
        for (const mode of ['before', 'after']) {
          for (const f of readdirSync(resolve(outputDir, mode))) {
            copyFileSync(resolve(outputDir, mode, f), resolve(tmpDir, `${mode}--${f}`));
          }
        }

        const uploadResult = await new Promise<string>((resolveP, reject) => {
          const files = readdirSync(tmpDir).map(f => resolve(tmpDir, f));
          const child = spawn('node', [resolve(this.cwd, 'scripts/upload-pr-images.mjs'), ...files], {
            cwd: this.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
          child.on('error', (err) => reject(err));
          child.on('close', (code) => {
            if (code !== 0) reject(new Error(`Upload failed (exit ${code}): ${stderr}`));
            else resolveP(stdout.trim());
          });
        });

        const urlMap = JSON.parse(uploadResult);
        const lines: string[] = ['## Visual Proof', ''];
        if (states.length === 0) {
          lines.push('> Warning: visual proof capture completed, but no matching before/after PNG pairs were found.', '');
        }
        for (const filename of states) {
          const stateName = filename
            .replace(/\.png$/i, '')
            .replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
          const beforeUrl = urlMap[`before--${filename}`] ?? '';
          const afterUrl = urlMap[`after--${filename}`] ?? '';
          lines.push(`<details open>`, `<summary>${stateName}</summary>`, '',
            '| Before | After |', '|--------|-------|',
            `| ![before](${beforeUrl}) | ![after](${afterUrl}) |`, '', '</details>', '');
        }
        const beforeVideo = urlMap['before--walkthrough.webm'] ?? '';
        const afterVideo = urlMap['after--walkthrough.webm'] ?? '';
        if (beforeVideo || afterVideo) {
          lines.push('<details>', '<summary>Video Walkthroughs</summary>', '',
            `- [Before walkthrough](${beforeVideo})`, `- [After walkthrough](${afterVideo})`,
            '', '</details>');
        }

        return lines.join('\n');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('[visual-proof] Capture failed (non-blocking)', {
        error: message,
        err,
      });
      return [
        '## Visual Proof',
        '',
        `> Warning: visual proof capture failed and screenshots could not be attached. ${message}`,
      ].join('\n');
    }
  }

  /** @internal */ async consolidateAndMerge(
    onFinish: string,
    baseBranch: string,
    featureBranch: string,
    workflowId?: string,
    workflowName?: string,
    leafTaskIds?: readonly string[],
    body?: string,
    visualProof?: boolean,
    baseCheckoutRef?: string,
    mergeNodeTaskId?: string,
  ): Promise<string | undefined> {
    return consolidateAndMergeImpl(
      this,
      onFinish,
      baseBranch,
      featureBranch,
      workflowId,
      workflowName,
      leafTaskIds,
      body,
      visualProof,
      baseCheckoutRef,
      mergeNodeTaskId,
    );
  }

  /**
   * @internal Read-only git queries only. Config mutations must use git-config-mutation helpers.
   */
  execGitReadonly(args: string[], cwd?: string): Promise<string> {
    assertNotGitConfigMutation(args, 'TaskRunner.execGitReadonly');
    return execGitWithTimeout(args, cwd ?? this.cwd);
  }

  /** @internal */ execGitIn(args: string[], dir: string): Promise<string> {
    assertNotGitConfigMutation(args, 'TaskRunner.execGitIn');
    return execGitWithTimeout(args, dir);
  }

  /** @internal */ async createMergeWorktree(ref: string, label: string, repoUrl?: string): Promise<string> {
    const invokerHomeRoot = process.env.INVOKER_DB_DIR
      ? resolve(process.env.INVOKER_DB_DIR)
      : resolve(homedir(), '.invoker');
    const mergeCloneRoot = resolve(invokerHomeRoot, 'merge-clones');
    const clonePath = resolve(mergeCloneRoot, `${label}-${Date.now()}`);
    mkdirSync(mergeCloneRoot, { recursive: true });

    // Determine clone source: prefer pool mirror (has latest remote refs), fall back to host repo
    let cloneSource: string = this.cwd;
    let originUrl: string | undefined;
    if (repoUrl) {
      const mirrorPath = await this.ensureRepoMirrorPath(repoUrl);
      if (mirrorPath) {
        cloneSource = mirrorPath;
        originUrl = repoUrl;
      } else {
        this.logger.warn(`[createMergeWorktree] Pool mirror unavailable for ${repoUrl}, falling back to host repo`);
      }
    }

    await this.cloneMergeWorktree(cloneSource, clonePath);
    // Detach HEAD so the fetch can overwrite all branch refs (including the default branch)
    const headSha = (await this.execGitIn(['rev-parse', 'HEAD'], clonePath)).trim();
    await this.execGitIn(['update-ref', '--no-deref', 'HEAD', headSha], clonePath);
    // Mirror all branches as local refs so bare branch names resolve.
    await this.execGitIn(['fetch', 'origin', '+refs/heads/*:refs/heads/*'], clonePath);

    // Reconfigure origin to the real remote URL (GitHub) so subsequent push/fetch
    // operations go directly to GitHub, bypassing any intermediate clone.
    if (!originUrl) {
      // Fallback: read origin from the host repo (old behavior)
      originUrl = (await this.execGitReadonly(['remote', 'get-url', 'origin'])).trim();
    }
    await ensureRemoteUrl({
      cwd: clonePath,
      remote: 'origin',
      url: originUrl,
      context: { caller: 'TaskRunner.createMergeWorktree', detail: `${label}:${ref}` },
    });

    // Refresh the requested base branch from the real remote. The pool mirror's
    // local refs/heads/* can go stale after force-pushes or history rewrites,
    // causing merge conflicts when experiment branches are based on the new
    // history but the clone got the old branch tip from the pool.
    const normalizedRef = ref.trim();
    const strippedRemoteRef = normalizeBranchForGithubCli(normalizedRef);
    const remoteName = 'origin';
    const baseRef = normalizedRef.startsWith('origin/')
      ? normalizedRef.slice('origin/'.length)
      : strippedRemoteRef;
    try {
      await this.execGitIn(
        ['fetch', remoteName, `+refs/heads/${baseRef}:refs/remotes/${remoteName}/${baseRef}`],
        clonePath,
      );
    } catch {
      // Non-critical: pool's ref may still be valid
    }

    // Resolve ref in the clone (not in host repo — the clone has mirrored branches).
    // Accept both "feature/x" and "origin/feature/x" forms, and tolerate missing
    // origin tracking refs for local-only stacked branches.
    const tryResolve = async (expr: string): Promise<string | undefined> => {
      try {
        return (await this.execGitIn(['rev-parse', '--verify', `${expr}^{commit}`], clonePath)).trim();
      } catch {
        return undefined;
      }
    };

    const candidates = Array.from(new Set([
      `refs/remotes/${remoteName}/${baseRef}`,
      `${remoteName}/${baseRef}`,
      normalizedRef,
      strippedRemoteRef,
      `refs/heads/${strippedRemoteRef}`,
    ]));

    let refSha: string | undefined;
    for (const candidate of candidates) {
      refSha = await tryResolve(candidate);
      if (refSha) break;
    }

    if (!refSha) {
      // Last chance: fetch only the requested branch from origin, then retry.
      // This can happen if clone source had stale refs at submit time.
      try {
        await this.execGitIn(
          ['fetch', remoteName, `+refs/heads/${strippedRemoteRef}:refs/remotes/${remoteName}/${strippedRemoteRef}`],
          clonePath,
        );
      } catch {
        // Best-effort; keep error message from final resolve below.
      }
      for (const candidate of candidates) {
        refSha = await tryResolve(candidate);
        if (refSha) break;
      }
    }

    // Fallback: if the requested ref is one of the common default branch names
    // and it doesn't exist, try the alternate (main↔master). Plan YAML files
    // sometimes specify "main" for repos whose default branch is "master" or
    // vice versa.
    if (!refSha) {
      const alternates: Record<string, string> = { main: 'master', master: 'main' };
      const alt = alternates[strippedRemoteRef];
      if (alt) {
        try {
          await this.execGitIn(
            ['fetch', remoteName, `+refs/heads/${alt}:refs/remotes/${remoteName}/${alt}`],
            clonePath,
          );
        } catch {
          // Best-effort
        }
        const altCandidates = [
          `refs/remotes/${remoteName}/${alt}`,
          `${remoteName}/${alt}`,
          alt,
          `refs/heads/${alt}`,
        ];
        for (const candidate of altCandidates) {
          refSha = await tryResolve(candidate);
          if (refSha) break;
        }
      }
    }

    if (!refSha) {
      throw new Error(
        `Unable to resolve merge worktree ref "${ref}" in clone ${clonePath}. ` +
        `Tried: ${candidates.join(', ')}`,
      );
    }
    await this.execGitIn(['checkout', '--detach', refSha], clonePath);
    return clonePath;
  }

  /** @internal */ async cloneMergeWorktree(cloneSource: string, clonePath: string): Promise<void> {
    try {
      // Hard-linked objects make local pool clones near-instant while keeping refs isolated.
      await this.execGitReadonly(['clone', '--local', '--no-checkout', cloneSource, clonePath]);
    } catch (err) {
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      if (!message.includes('Invalid cross-device link') && !message.includes('EXDEV')) {
        throw err;
      }

      // CI may place the repo/mirror and temp merge clone on different mounts,
      // where Git's hardlink-based local clone fails with EXDEV.
      this.logger.warn(
        `[createMergeWorktree] Local clone crossed filesystems; retrying without hardlinks: ${message.split('\n')[0]}`,
      );
      rmSync(clonePath, { recursive: true, force: true });
      await this.execGitReadonly(['clone', '--no-local', '--no-checkout', cloneSource, clonePath]);
    }
  }

  /** @internal */ async removeMergeWorktree(dir: string): Promise<void> {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn('[TaskRunner] removeMergeWorktree failed (best-effort)', {
        dir,
        error: err instanceof Error ? err.message : String(err),
        err,
      });
    }
  }

  async detectDefaultBranch(): Promise<string> {
    try {
      const ref = await this.execGitReadonly(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      return ref.replace('refs/remotes/origin/', '');
    } catch {
      try {
        await this.execGitReadonly(['rev-parse', '--verify', 'main']);
        return 'main';
      } catch {
        return 'master';
      }
    }
  }

  /** @internal */ execGh(args: string[], cwd?: string): Promise<string> {
    const effectiveCwd = cwd ?? this.cwd;
    return new Promise((resolvePromise, reject) => {
      const child = spawn('gh', args, {
        cwd: effectiveCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else reject(new Error(`gh ${args[0]} ${args[1]} failed (code ${code}): ${stderr.trim()}`));
      });
    });
  }

  /** @internal */ async execPr(baseBranch: string, featureBranch: string, title: string, body?: string, cwd?: string): Promise<string> {
    const ghBase = normalizeBranchForGithubCli(baseBranch);
    const ghHead = normalizeBranchForGithubCli(featureBranch);

    const listOutput = await this.execGh([
      'pr', 'list', '--head', ghHead, '--base', ghBase,
      '--state', 'open', '--json', 'url,number', '--limit', '1',
    ], cwd);

    const existing: Array<{ url: string; number: number }> = JSON.parse(listOutput || '[]');
    if (existing.length > 0) {
      const pr = existing[0];
      const editArgs = ['pr', 'edit', String(pr.number), '--title', title];
      if (body) editArgs.push('--body', body);
      await this.execGh(editArgs, cwd);
      return pr.url;
    }

    return this.execGh([
      'pr', 'create', '--base', ghBase,
      '--head', ghHead, '--title', title, '--body', body ?? '',
    ], cwd);
  }

  // ── Experiment Branch Merging ────────────────────────────

  /**
   * Merge multiple selected experiment branches into a single reconciliation branch.
   * Returns the combined branch name and HEAD commit hash.
   */
  async mergeExperimentBranches(
    reconTaskId: string,
    experimentIds: string[],
  ): Promise<{ branch: string; commit: string }> {
    if (experimentIds.length === 1) {
      const task = this.orchestrator.getTask(experimentIds[0]);
      if (!task?.execution.branch) {
        throw new Error(`Experiment ${experimentIds[0]} has no branch`);
      }
      return { branch: task.execution.branch, commit: task.execution.commit ?? '' };
    }

    const branchName = `reconciliation/${reconTaskId}`;
    const reconTask = this.orchestrator.getTask(reconTaskId);
    const parentId = reconTask?.config.parentTask;
    const parentTask = parentId ? this.orchestrator.getTask(parentId) : undefined;
    const baseBranch = parentTask?.execution.branch
      ?? this.defaultBranch
      ?? await this.detectDefaultBranch();

    const reconWorkflowId = reconTask?.config.workflowId;
    const reconWorkflow =
      reconWorkflowId !== undefined && reconWorkflowId !== ''
        ? this.persistence.loadWorkflow(reconWorkflowId)
        : undefined;
    const reconRepoUrl = reconWorkflow?.repoUrl;
    const reconBranchRepoUrl = reconWorkflow?.intermediateRepoUrl?.trim() || undefined;

    const worktreeDir = await this.createMergeWorktree(baseBranch, 'recon-' + reconTaskId, reconRepoUrl);

    try {
      try {
        await this.execGitIn(['checkout', '-b', branchName, baseBranch], worktreeDir);
      } catch {
        await this.execGitIn(['branch', '-D', branchName], worktreeDir);
        await this.execGitIn(['checkout', '-b', branchName, baseBranch], worktreeDir);
      }

      for (const expId of experimentIds) {
        const expTask = this.orchestrator.getTask(expId);
        if (!expTask?.execution.branch) {
          throw new Error(`Experiment ${expId} has no branch`);
        }
        const b = expTask.execution.branch;
        await ensureLocalBranchForMerge(this, worktreeDir, b, reconRepoUrl, reconBranchRepoUrl);
        const expMergeMsg = `Merge ${b} — ${expTask.description}`;
        await this.execGitIn(['merge', '--no-ff', '-m', expMergeMsg, b], worktreeDir);
      }

      await this.pushBranchFromMergeWorktree(worktreeDir, branchName, reconBranchRepoUrl);

      const commit = await this.execGitIn(['rev-parse', 'HEAD'], worktreeDir);
      return { branch: branchName, commit };
    } catch (err) {
      try { await this.execGitIn(['merge', '--abort'], worktreeDir); } catch { /* no merge in progress */ }
      throw err;
    } finally {
      await this.removeMergeWorktree(worktreeDir);
    }
  }

  /**
   * Resolve a merge conflict by re-creating the merge state and spawning an agent to fix it.
   * After resolution, the task is restarted so it can proceed normally.
   */
  async resolveConflict(taskId: string, savedError?: string, agentName?: string): Promise<void> {
    return this.withAttemptHeartbeat(taskId, () => resolveConflictImpl(this, taskId, savedError, agentName));
  }

  /**
   * Fix a failed task by spawning an agent with the error output.
   * The agent's output is captured and appended to the task's output stream for auditing.
   */
  async fixWithAgent(
    taskId: string,
    taskOutput: string,
    agentName?: string,
    savedError?: string,
    fixContext?: string,
  ): Promise<void> {
    return this.withAttemptHeartbeat(
      taskId,
      () => fixWithAgentImpl(this, taskId, taskOutput, agentName, savedError, fixContext),
    );
  }

  private async withAttemptHeartbeat<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const attemptId = this.orchestrator.getTask(taskId)?.execution.selectedAttemptId;
    if (!attemptId) {
      return work();
    }

    const heartbeat = () => {
      const now = new Date();
      this.persistence.updateAttempt?.(attemptId, {
        lastHeartbeatAt: now,
        leaseExpiresAt: nextLeaseExpiry(now),
      } as any);
      this.callbacks.onHeartbeat?.(taskId, { at: now, source: 'executor' });
    };

    const heartbeatTimer = setInterval(heartbeat, PRE_START_HEARTBEAT_INTERVAL_MS);
    try {
      return await work();
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  async closeWorkflowReview(workflowId: string): Promise<void> {
    if (!this.mergeGateProvider?.closeReview) return;
    const getAllTasks = this.orchestrator.getAllTasks?.bind(this.orchestrator);
    if (!getAllTasks) return;
    const mergeTask = getAllTasks().find((task) =>
      task.config.workflowId === workflowId
      && task.config.isMergeNode
      && !!task.execution.reviewId
    );
    if (!mergeTask?.execution.reviewId) return;

    await this.mergeGateProvider.closeReview({
      identifier: mergeTask.execution.reviewId,
      cwd: mergeTask.execution.workspacePath ?? this.cwd,
    });
  }

  private async handleApprovedMergeGate(
    taskId: string,
    reviewId: string,
    source?: 'refresh' | 'manual check',
  ): Promise<void> {
    const sourceSuffix = source ? ` (${source})` : '';
    this.logger.info(`[merge-gate] PR ${reviewId} approved${sourceSuffix}, completing merge gate`);
    const newlyStarted = await this.orchestrator.approve(taskId);
    if (newlyStarted.length > 0) {
      await this.executeTasks(newlyStarted);
    }
  }

  private handleClosedMergeGate(
    taskId: string,
    reviewId: string,
    statusText: string,
    source?: 'refresh' | 'manual check',
  ): void {
    const sourceSuffix = source ? ` (${source})` : '';
    this.logger.info(`[merge-gate] PR ${reviewId} closed${sourceSuffix}: ${statusText}`);
    this.persistence.updateTask(taskId, {
      status: 'closed',
      execution: { reviewStatus: statusText },
    });
  }

  async checkMergeGateStatuses(): Promise<void> {
    if (!this.mergeGateProvider) return;
    for (const task of this.orchestrator.getAllTasks()) {
      if (
        task.config.isMergeNode &&
        (task.status === 'review_ready' || task.status === 'awaiting_approval') &&
        task.execution.reviewId
      ) {
        try {
          const gateCwd = task.execution.workspacePath ?? this.cwd;
          const status = await this.mergeGateProvider.checkApproval({
            identifier: task.execution.reviewId,
            cwd: gateCwd,
          });
          if (status.closed) {
            this.handleClosedMergeGate(task.id, task.execution.reviewId, status.statusText, 'refresh');
          } else if (status.approved) {
            this.persistence.updateTask(task.id, {
              execution: { reviewStatus: status.statusText },
            });
            await this.handleApprovedMergeGate(task.id, task.execution.reviewId, 'refresh');
          } else if (status.rejected) {
            this.persistence.updateTask(task.id, {
              execution: { reviewStatus: status.statusText },
            });
            this.logger.info(`[merge-gate] PR ${task.execution.reviewId} rejected (refresh): ${status.statusText}`);
          } else {
            this.persistence.updateTask(task.id, {
              execution: { reviewStatus: status.statusText },
            });
            await this.maybeTriggerReviewGateCiFix(task, status);
          }
        } catch (err) {
          this.logger.error(`[merge-gate] PR status check error for ${task.id}`, { err });
        }
      }
    }
  }

  async checkPrApprovalNow(taskId: string): Promise<void> {
    if (!this.mergeGateProvider) return;

    const task = this.orchestrator.getTask(taskId);
    const reviewId = task?.execution.reviewId;
    if (!task || !reviewId) return;

    try {
      const manualCwd = task.execution.workspacePath ?? this.cwd;
      const status = await this.mergeGateProvider.checkApproval({
        identifier: reviewId,
        cwd: manualCwd,
      });

      if (status.closed) {
        this.handleClosedMergeGate(taskId, reviewId, status.statusText, 'manual check');
      } else if (status.approved) {
        this.persistence.updateTask(taskId, {
          execution: { reviewStatus: status.statusText },
        });
        await this.handleApprovedMergeGate(taskId, reviewId, 'manual check');
      } else if (status.rejected) {
        this.persistence.updateTask(taskId, {
          execution: { reviewStatus: status.statusText },
        });
        this.logger.info(`[merge-gate] PR ${reviewId} rejected (manual check): ${status.statusText}`);
      } else {
        this.persistence.updateTask(taskId, {
          execution: { reviewStatus: status.statusText },
        });
        await this.maybeTriggerReviewGateCiFix(task, status);
      }
    } catch (err) {
      this.logger.error(`[merge-gate] Manual PR check error for ${taskId}`, { err });
    }
  }

  private async maybeTriggerReviewGateCiFix(
    task: TaskState,
    status: MergeGateApprovalStatus,
  ): Promise<void> {
    if (!this.onReviewGateCiFailure) return;
    if (!task.config.workflowId || !task.execution.reviewId) return;
    if (status.checks?.state !== 'failure' || status.checks.failed.length === 0) return;

    const key = [
      task.id,
      task.execution.selectedAttemptId ?? 'no-attempt',
      task.execution.generation ?? 0,
      status.headSha ?? 'no-head-sha',
    ].join(':');
    if (this.reviewGateCiFixInFlight.has(key)) return;

    this.reviewGateCiFixInFlight.add(key);
    try {
      await this.onReviewGateCiFailure({
        taskId: task.id,
        workflowId: task.config.workflowId,
        reviewId: task.execution.reviewId,
        reviewUrl: status.url,
        headSha: status.headSha,
        headRef: status.headRef,
        branch: task.execution.branch,
        selectedAttemptId: task.execution.selectedAttemptId,
        generation: task.execution.generation ?? 0,
        failedChecks: status.checks.failed,
        statusText: status.statusText,
      });
    } finally {
      this.reviewGateCiFixInFlight.delete(key);
    }
  }

  spawnAgentFix(
    prompt: string,
    cwd: string,
    agentName: string = DEFAULT_EXECUTION_AGENT,
  ): Promise<{ stdout: string; sessionId: string }> {
    if (!this.executionAgentRegistry) {
      throw new Error('executionAgentRegistry is required for spawnAgentFix');
    }
    const agent = this.executionAgentRegistry.getOrThrow(agentName);
    if (!agent.buildFixCommand) {
      throw new Error(`Agent "${agentName}" does not support fix commands`);
    }
    const driver = this.executionAgentRegistry.getSessionDriver(agentName);
    return spawnAgentFixViaRegistry(prompt, cwd, agent, driver);
  }

  async authorPrBodyWithSkill(args: {
    workflowId?: string;
    mergeNodeTaskId?: string;
    title: string;
    baseBranch: string;
    featureBranch: string;
    workflowSummary: string;
    structuredContext?: PrAuthoringContext;
    cwd: string;
  }): Promise<{ body: string; sessionId: string; agentName: string }> {
    if (!this.executionAgentRegistry) {
      this.logger.warn(
        '[pr-authoring] executionAgentRegistry missing, using canonical fallback PR body.',
      );
      const canonicalBody = buildCanonicalPrBody({
        title: args.title,
        workflowSummary: args.workflowSummary,
        structuredContext: args.structuredContext,
      });
      return { body: canonicalBody, sessionId: 'canonical-fallback', agentName: 'canonical' };
    }

    // Build the ordered agent fallback chain:
    // 1. Preferred agent from workflow tasks
    // 2. Remaining PR-capable agents in stable registry order
    const preferredName = this.resolvePrAuthoringAgentName(args.workflowId, args.mergeNodeTaskId);
    const prCapableAgents = this.executionAgentRegistry.listWithCapability('make-pr');
    const orderedAgents = this.buildAgentFallbackOrder(preferredName, prCapableAgents);

    const errors: string[] = [];
    for (const agent of orderedAgents) {
      const skillPath = resolveSkillPathViaAgent(agent, 'make-pr');
      if (!skillPath) {
        errors.push(`${agent.name}: skill "invoker-make-pr" not installed`);
        continue;
      }

      const driver = this.executionAgentRegistry.getSessionDriver(agent.name);
      const prompt = buildMakePrPrompt({
        skillPath,
        title: args.title,
        baseBranch: args.baseBranch,
        featureBranch: args.featureBranch,
        workflowSummary: args.workflowSummary,
        structuredContext: args.structuredContext,
      });

      try {
        const result = await spawnAgentPrAuthorViaRegistry(prompt, args.cwd, agent, driver);
        const validationErrors = validateCanonicalPrBody(result.body);
        if (validationErrors.length > 0) {
          errors.push(
            `${agent.name}: invalid PR body — ${validationErrors.join('; ')}`,
          );
          continue;
        }
        return { body: result.body, sessionId: result.sessionId, agentName: agent.name };
      } catch (err) {
        errors.push(
          `${agent.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // No AI agent succeeded — emit deterministic canonical PR body
    this.logger.warn(
      `[pr-authoring] All AI agents failed for PR authoring, using canonical fallback. Errors: ${errors.join(' | ')}`,
    );
    const canonicalBody = buildCanonicalPrBody({
      title: args.title,
      workflowSummary: args.workflowSummary,
      structuredContext: args.structuredContext,
    });
    return { body: canonicalBody, sessionId: 'canonical-fallback', agentName: 'canonical' };
  }

  /**
   * Build the ordered fallback list: preferred agent first, then remaining
   * PR-capable agents in stable registry order, deduplicated.
   */
  private buildAgentFallbackOrder(
    preferredName: string,
    prCapableAgents: import('./agent.js').ExecutionAgent[],
  ): import('./agent.js').ExecutionAgent[] {
    const seen = new Set<string>();
    const ordered: import('./agent.js').ExecutionAgent[] = [];

    // Preferred agent first (may or may not be in prCapableAgents)
    const preferred = this.executionAgentRegistry?.get(preferredName);
    if (preferred) {
      seen.add(preferred.name);
      ordered.push(preferred);
    }

    // Remaining PR-capable agents in registration order
    for (const agent of prCapableAgents) {
      if (!seen.has(agent.name)) {
        seen.add(agent.name);
        ordered.push(agent);
      }
    }

    return ordered;
  }

  private resolvePrAuthoringAgentName(workflowId?: string, mergeNodeTaskId?: string): string {
    const allTasks = this.orchestrator.getAllTasks();
    let candidateTasks = allTasks.filter((task) => !task.config.isMergeNode);
    if (workflowId) {
      candidateTasks = candidateTasks.filter((task) => task.config.workflowId === workflowId);
    }
    if (mergeNodeTaskId && workflowId) {
      const mergeTask = allTasks.find((task) => task.id === mergeNodeTaskId && task.config.isMergeNode);
      if (mergeTask) {
        const allowedTaskIds = collectTransitiveNonMergeTaskIds(
          mergeTask,
          (id) => this.orchestrator.getTask(id),
        );
        candidateTasks = candidateTasks.filter((task) => allowedTaskIds.has(task.id));
      }
    }

    const distinctAgents = [...new Set(
      candidateTasks
        .map((task) => task.config.executionAgent?.trim())
        .filter((agent): agent is string => Boolean(agent)),
    )];
    if (distinctAgents.length === 0) {
      return DEFAULT_EXECUTION_AGENT;
    }
    if (distinctAgents.length > 1) {
      console.warn(
        `[merge] Multiple execution agents found for PR authoring (${distinctAgents.join(', ')}); using ${distinctAgents[0]}`,
      );
    }
    return distinctAgents[0];
  }

  get agentRegistry(): AgentRegistry | undefined {
    return this.executionAgentRegistry;
  }

  getRemoteTargetConfig(targetId: string): {
    host: string;
    user: string;
    sshKeyPath: string;
    port?: number;
    managedWorkspaces?: boolean;
    remoteInvokerHome?: string;
    provisionCommand?: string;
    use_api_key?: boolean;
    secretsFile?: string;
    remoteHeartbeatIntervalSeconds?: number;
  } | undefined {
    const target = this.getRemoteTargets()[targetId];
    if (!target) return undefined;
    return {
      ...target,
      secretsFile: target.secretsFile ?? this.dockerConfig.secretsFile,
    };
  }

  /**
   * Destroy all cached SSH executors and clear the cache.
   * Useful for testing or when remote target configs change.
   */
  async clearSshExecutorCache(): Promise<void> {
    const destroyPromises = Array.from(this.sshExecutorCache.values()).map(
      executor => executor.destroyAll().catch(() => {})
    );
    await Promise.all(destroyPromises);
    this.sshExecutorCache.clear();
  }

  /**
   * Destroy and deregister a per-task Docker executor if one was created for this task.
   */
  private async cleanupPerTaskDockerExecutor(task: TaskState): Promise<void> {
    if (task.config.runnerKind !== 'docker') return;
    const dockerKey = `docker:${task.id}`;
    const dockerExec = this.executorRegistry.get(dockerKey);
    if (!dockerExec) return;
    try {
      await dockerExec.destroyAll();
    } catch (err) {
      this.logger.warn(`[TaskRunner] cleanupPerTaskDockerExecutor destroyAll failed for ${dockerKey}`, {
        error: err instanceof Error ? err.message : String(err),
        err,
      });
    }
    this.executorRegistry.deregister(dockerKey);
  }

  // ── Private Helpers ──────────────────────────────────────

  /**
   * Branch names from completed direct dependencies, for every executor that merges
   * upstream work (`setupTaskBranch`, WorktreeExecutor merge loop, SshExecutor remote merges).
   *
   * For **fan-in** (two or more upstream branches), prepends the workflow plan base
   * (`loadWorkflow(...).baseBranch` or `defaultBranch`) when it is not already listed,
   * so `setupTaskBranch` uses a single merge base: `base → merge dep₁ → merge dep₂ → …`.
   */
  collectUpstreamBranches(task: TaskState): string[] {
    const branches: string[] = [];
    const seen = new Set<string>();

    for (const depId of task.dependencies) {
      const dep = this.orchestrator.getTask(depId);
      if (dep && dep.status === 'completed' && dep.execution.branch) {
        const b = dep.execution.branch;
        if (!seen.has(b)) {
          seen.add(b);
          branches.push(b);
        }
      }
    }
    for (const depRef of task.config.externalDependencies ?? []) {
      const dep = this.resolveExternalDependencyTask(depRef.workflowId, depRef.taskId);
      if (dep && dep.status === 'completed' && dep.execution.branch) {
        const b = dep.execution.branch;
        if (!seen.has(b)) {
          seen.add(b);
          branches.push(b);
        }
      }
    }

    let planBase: string | undefined;
    if (task.config.workflowId && this.persistence.loadWorkflow) {
      try {
        const wf = this.persistence.loadWorkflow(task.config.workflowId) as { baseBranch?: string } | undefined;
        planBase = wf?.baseBranch;
      } catch {
        planBase = undefined;
      }
    }
    if (!planBase) planBase = this.defaultBranch;

    if (planBase && branches.length >= 2 && !seen.has(planBase)) {
      branches.unshift(planBase);
    }

    return branches;
  }

  private buildAlternatives(
    task: TaskState,
  ): Array<{taskId: string; description: string; branch?: string; commitHash?: string; status: 'completed' | 'failed'; exitCode?: number; summary?: string; selected?: boolean}> {
    const alternatives: Array<{taskId: string; description: string; branch?: string; commitHash?: string; status: 'completed' | 'failed'; exitCode?: number; summary?: string; selected?: boolean}> = [];

    for (const depId of task.dependencies) {
      const dep = this.orchestrator.getTask(depId);
      if (!dep?.config.isReconciliation) continue;

      const selectedSet = new Set(dep.execution.selectedExperiments ?? (dep.execution.selectedExperiment ? [dep.execution.selectedExperiment] : []));

      for (const result of dep.execution.experimentResults ?? []) {
        const expTask = this.orchestrator.getTask(result.id);
        alternatives.push({
          taskId: result.id,
          description: expTask?.description ?? result.id,
          branch: expTask?.execution.branch,
          commitHash: expTask?.execution.commit,
          status: result.status,
          exitCode: result.exitCode,
          summary: result.summary ?? expTask?.config.summary,
          selected: selectedSet.has(result.id),
        });
      }
    }

    return alternatives;
  }

  private async buildUpstreamContext(
    task: TaskState,
  ): Promise<Array<{taskId: string; description: string; summary?: string; commitHash?: string; commitMessage?: string}>> {
    const context: Array<{taskId: string; description: string; summary?: string; commitHash?: string; commitMessage?: string}> = [];
    const seenTaskIds = new Set<string>();

    // Resolve pool mirror for gitLogMessage so commits are found in the right repo
    let mirrorCwd: string | undefined;
    if (task.config.workflowId) {
      const wf = this.persistence.loadWorkflow?.(task.config.workflowId);
      if (wf?.repoUrl) {
        mirrorCwd = await this.ensureRepoMirrorPath(wf.repoUrl) ?? undefined;
      }
    }

    const pushDepContext = async (dep: TaskState): Promise<void> => {
      if (dep.status !== 'completed' || seenTaskIds.has(dep.id)) return;
      seenTaskIds.add(dep.id);
      let commitMessage: string | undefined;
      if (dep.execution.commit) {
        try {
          commitMessage = await this.gitLogMessage(dep.execution.commit, mirrorCwd);
        } catch {
          // Not in a git repo or commit not found
        }
      }
      context.push({
        taskId: dep.id,
        description: dep.description,
        summary: dep.config.summary,
        commitHash: dep.execution.commit,
        commitMessage,
      });
    };

    for (const depId of task.dependencies) {
      const dep = this.orchestrator.getTask(depId);
      if (dep) await pushDepContext(dep);
    }
    for (const depRef of task.config.externalDependencies ?? []) {
      const dep = this.resolveExternalDependencyTask(depRef.workflowId, depRef.taskId);
      if (dep) await pushDepContext(dep);
    }

    return context;
  }

  private resolveExternalDependencyTask(workflowId: string, taskId?: string): TaskState | undefined {
    const normalizedTaskId = taskId?.trim() || '__merge__';
    if (normalizedTaskId === '__merge__') {
      return this.orchestrator.getTask(`__merge__${workflowId}`);
    }

    if (normalizedTaskId.includes('/')) {
      const byDirectId = this.orchestrator.getTask(normalizedTaskId);
      if (byDirectId) return byDirectId;
    }

    const scopedId = scopePlanTaskId(workflowId, normalizedTaskId);
    const byScopedId = this.orchestrator.getTask(scopedId);
    if (byScopedId) return byScopedId;

    const byRawId = this.orchestrator.getTask(normalizedTaskId);
    if (byRawId) return byRawId;

    const wfTasks = (this.persistence.loadTasks?.(workflowId) ?? []) as TaskState[];
    return wfTasks.find((t) => t.id === scopedId || t.id === normalizedTaskId);
  }

  /**
   * Rebase all completed task branches in a workflow onto baseBranch.
   * Returns { success, rebasedBranches, errors }.
   */
  async rebaseTaskBranches(
    workflowId: string,
    baseBranch: string,
  ): Promise<{ success: boolean; rebasedBranches: string[]; errors: string[] }> {
    const taskBranches = this.collectManagedWorkflowBranches(workflowId);

    const rebaseWorkflow = this.persistence.loadWorkflow?.(workflowId);
    const rebaseRepoUrl = rebaseWorkflow?.repoUrl;
    const rebaseBranchRepoUrl = rebaseWorkflow?.intermediateRepoUrl?.trim() || undefined;
    const worktreeDir = await this.createMergeWorktree(baseBranch, 'rebase-' + workflowId, rebaseRepoUrl);

    const rebasedBranches: string[] = [];
    const errors: string[] = [];

    try {
      for (const branch of taskBranches) {
        try {
          await this.execGitIn(['checkout', branch], worktreeDir);
          await this.execGitIn(['rebase', baseBranch], worktreeDir);
          await this.pushBranchFromMergeWorktree(worktreeDir, branch, rebaseBranchRepoUrl);
          rebasedBranches.push(branch);
          this.logger.info(`[rebase] Successfully rebased ${branch} onto ${baseBranch}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${branch}: ${msg}`);
          this.logger.error(`[rebase] Failed to rebase ${branch}: ${msg}`, { branch, baseBranch, err });
          try { await this.execGitIn(['rebase', '--abort'], worktreeDir); } catch { /* no rebase in progress */ }
        }
      }

      return {
        success: errors.length === 0,
        rebasedBranches,
        errors,
      };
    } finally {
      await this.removeMergeWorktree(worktreeDir);
    }
  }

  private async pushBranchFromMergeWorktree(
    worktreeDir: string,
    branch: string,
    branchRepoUrl?: string,
  ): Promise<void> {
    const trimmedBranchRepoUrl = branchRepoUrl?.trim();
    if (trimmedBranchRepoUrl) {
      await ensureRemoteUrl({
        cwd: worktreeDir,
        remote: TaskRunner.BRANCH_REMOTE_NAME,
        url: trimmedBranchRepoUrl,
        context: { caller: 'TaskRunner.pushBranchFromMergeWorktree', detail: branch },
      });
      await this.execGitIn(
        ['push', '--force', TaskRunner.BRANCH_REMOTE_NAME, `${branch}:refs/heads/${branch}`],
        worktreeDir,
      );
      return;
    }

    await this.execGitIn(['push', '--force', 'origin', `${branch}:refs/heads/${branch}`], worktreeDir);
  }

  /** @internal */ gitLogMessage(commitHash: string, cwd?: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('git', ['log', '-1', '--format=%B', commitHash], {
        cwd: cwd ?? this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.on('error', (err) => {
        reject(new Error(`Failed to spawn git: ${err.message}`));
      });
      child.on('close', (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else reject(new Error(`git log failed (code ${code})`));
      });
    });
  }

  /** @internal */ gitDiffStat(branch: string, cwd?: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const baseBranch = this.defaultBranch ?? 'master';
      const child = spawn('git', ['diff', '--stat', '--stat-count=20', `${baseBranch}...${branch}`], {
        cwd: cwd ?? this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.on('error', (err) => {
        reject(new Error(`Failed to spawn git: ${err.message}`));
      });
      child.on('close', (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else reject(new Error(`git diff --stat failed (code ${code})`));
      });
    });
  }
}
