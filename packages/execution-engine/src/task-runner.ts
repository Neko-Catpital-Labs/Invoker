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
import type { Orchestrator, TaskState, ExperimentVariant } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { WorkRequest, WorkResponse, ActionType, Logger } from '@invoker/contracts';
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
import { WorktreeExecutor } from './worktree-executor.js';
import { isInvokerManagedPoolBranch } from './plan-base-remote.js';
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
  isInvokerRepoUrl,
  buildMakePrStackPublishPrompt,
  buildMakePrPrompt,
  parseMakePrStackPublishResult,
  resolveSkillPathViaAgent,
  spawnAgentPrAuthorViaRegistry,
  validateCanonicalPrBody,
  validateReviewStackPrBody,
  type PrAuthoringContext,
} from './pr-authoring.js';
import { ensureRemoteUrl } from './git-config-mutation.js';
import * as gitPlumbing from './task-runner-git.js';
import { PRE_START_HEARTBEAT_INTERVAL_MS, nextLeaseExpiry } from './task-runner-launch-support.js';
import { buildWorkRequest } from './task-runner-prepare.js';
import { dispatchExecutor } from './task-runner-dispatch.js';
import { wireCompletion } from './task-runner-finalize.js';
import * as reviewGate from './task-runner-review-gate.js';
import type {
  ReviewGateCiFailureLifecyclePublisher,
  ReviewGateMergeConflictLifecyclePublisher,
} from './task-runner-review-gate.js';
import {
  poolMemberKey,
  selectPoolMember,
  acquirePoolSelectionLease,
  renewPoolSelectionLease,
  releasePoolSelectionLease,
  logExecutorSelected,
  selectedRemoteTargetId,
  takeResolvedExecutionSelection,
  selectExecutor,
  clearSshExecutorCache,
  recordPoolMemberTransportFailure,
  recordPoolMemberStartSuccess,
  getPoolMemberHealthSnapshot,
} from './task-runner-pool.js';
import type {
  ExecutionPoolMember,
  ExecutionPoolConfig,
  PoolSelection,
  RemoteTargetDisplay,
  ResolvedExecutionSelection,
  SelectedExecutor,
  PoolMemberHealth,
} from './task-runner-pool.js';

export type { TaskHeartbeatEvent, TaskRunnerCallbacks } from './task-runner-callbacks.js';
type ReviewGateState = NonNullable<TaskState['execution']['reviewGate']>;
type ReviewGateArtifact = ReviewGateState['artifacts'][number];
type ReviewGateArtifactStatus = ReviewGateArtifact['status'];

export type ActiveExecutionHandle = ExecutorHandle & { attemptId?: string };
export type ActiveExecutionEntry = {
  handle: ActiveExecutionHandle;
  executor: Executor;
  taskId: string;
  poolId?: string;
  poolMemberKey?: string;
  leaseResourceKey?: string;
  leaseHolderId?: string;
};


export type FreshBaseCommit = {
  branch: string;
  commit: string;
};


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
  reviewGateCiFailurePublisher?: ReviewGateCiFailureLifecyclePublisher;
  reviewGateMergeConflictPublisher?: ReviewGateMergeConflictLifecyclePublisher;
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
    use_api_key?: boolean;
    secretsFile?: string;
    remoteHeartbeatIntervalSeconds?: number;
    maxConcurrentTasks?: number;
  }>;
  executionPoolsProvider?: () => Record<string, {
    members: Array<
      | { type: 'ssh'; id: string; maxConcurrentTasks?: number }
      | { type: 'worktree'; id: string; maxConcurrentTasks?: number }
    >;
    selectionStrategy?: 'roundRobin' | 'leastLoaded';
    maxConcurrentTasksPerMember?: number;
  }>;
  executionDefaultsProvider?: () => {
    executionAgent?: string;
    executionModel?: string;
  };
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
  /** @internal */ executorRegistry: ExecutorRegistry;
  /** @internal */ cwd: string;
  /** @internal */ maxWorktreesPerRepo: number;
  /** @internal */ defaultBranch: string | undefined;
  /** @internal */ callbacks: TaskRunnerCallbacks;
  /** @internal */ mergeGateProvider?: MergeGateProvider;
  /** @internal */ reviewProviderRegistry?: ReviewProviderRegistry;
  /** @internal */ reviewGateCiFailurePublisher?: ReviewGateCiFailureLifecyclePublisher;
  /** @internal */ reviewGateCiFailureInFlight = new Set<string>();
  /** @internal */ reviewGateMergeConflictPublisher?: ReviewGateMergeConflictLifecyclePublisher;
  /** @internal */ reviewGateMergeConflictInFlight = new Set<string>();

  /** @internal */ getRemoteTargets: () => Record<string, RemoteTargetDisplay>;
  /** @internal */ getExecutionPools: () => Record<string, ExecutionPoolConfig>;
  private getExecutionDefaults: () => { executionAgent?: string; executionModel?: string };
  /** @internal */ dockerConfig: { imageName?: string; secretsFile?: string };
  /** @internal */ executionAgentRegistry?: AgentRegistry;
  /** @internal */ logger: Logger;
  /** @internal */ readonly runnerInstanceId = randomUUID();
  /** Cache for SSH executors, keyed by poolMemberId. One instance per target for correct git locking. */
  /** @internal */ sshExecutorCache = new Map<string, SshExecutor>();
  /** @internal */ poolRoundRobinCursor = new Map<string, number>();
  poolMemberHealth = new Map<string, PoolMemberHealth>();
  /** @internal */ readonly pendingPoolSelections = new Map<string, PoolSelection>();
  /** @internal */ readonly freshBaseCommits = new Map<string, FreshBaseCommit>();

  /** In-flight executions keyed by attemptId (with taskId retained for external kill resolution). @internal */
  readonly activeExecutions = new Map<string, ActiveExecutionEntry>();
  private launchingAttemptIds = new Set<string>();

  /** Serializes async onComplete handlers so orchestrator mutations never overlap. */
  private completionChain: Promise<void> = Promise.resolve();

  /** Config default branch (e.g. master) for workflows without baseBranch. */
  getDefaultBranchHint(): string | undefined {
    return this.defaultBranch;
  }

  /** @internal */ getDefaultExecutionAgent(): string {
    const configured = this.getExecutionDefaults().executionAgent?.trim();
    return configured && configured.length > 0 ? configured : DEFAULT_EXECUTION_AGENT;
  }

  /** @internal */ getDefaultExecutionModel(): string | undefined {
    const configured = this.getExecutionDefaults().executionModel?.trim();
    return configured && configured.length > 0 ? configured : undefined;
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
    this.reviewGateCiFailurePublisher = config.reviewGateCiFailurePublisher;
    this.reviewGateMergeConflictPublisher = config.reviewGateMergeConflictPublisher;
    this.getRemoteTargets = config.remoteTargetsProvider ?? (() => ({}));
    this.getExecutionPools = config.executionPoolsProvider ?? (() => ({}));
    this.getExecutionDefaults = config.executionDefaultsProvider ?? (() => ({}));
    this.dockerConfig = config.dockerConfig ?? {};
    this.executionAgentRegistry = config.executionAgentRegistry;
    this.logger = config.logger ?? NOOP_LOGGER;
  }

  resolveExecutionAgent(task: Pick<TaskState, 'config'>): string {
    return task.config.executionAgent?.trim() || this.getDefaultExecutionAgent();
  }

  resolveExecutionModel(task: Pick<TaskState, 'config'>): string | undefined {
    const explicitModel = task.config.executionModel?.trim();
    if (explicitModel) return explicitModel;
    const defaults = this.getExecutionDefaults();
    const defaultAgent = this.getDefaultExecutionAgent();
    const defaultModel = defaults.executionModel?.trim();
    if (!defaultModel) return undefined;
    return this.resolveExecutionAgent(task) === defaultAgent ? defaultModel : undefined;
  }

  /**
   * Stop the executor child for a task that is currently in-flight (after orchestrator.cancelTask).
   */
  async killActiveExecution(taskId: string): Promise<boolean> {
    const resolved = this.resolveActiveExecution(taskId);
    if (!resolved) return false;
    this.activeExecutions.delete(resolved.attemptId);
    if (resolved.entry.leaseResourceKey && resolved.entry.leaseHolderId) {
      this.persistence.releaseExecutionResourceLease?.(resolved.entry.leaseResourceKey, resolved.entry.leaseHolderId);
    }
    try {
      await resolved.entry.executor.kill(resolved.entry.handle);
    } catch (killErr) {
      this.logger.warn(`[TaskRunner] killActiveExecution failed for task=${taskId}`, { err: killErr });
    }
    return true;
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

  /** @internal */ executeNewlyStartedTasks(
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
  /** @internal */ isLaunchStale(
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
        this.logger.info(
          `[TaskRunner] launch deferred task=${task.id} attempt=${attemptId}; task remains pending and will retry when capacity is available: ${cause.message}`,
          {
            taskId: task.id,
            attemptId,
            reason: 'resource-limit',
            message: cause.message,
            phase: task.execution.phase ?? 'none',
          },
        );
        this.orchestrator.deferTask(task.id, {
          reason: 'resource-limit',
          message: cause.message,
          attemptId,
          phase: task.execution.phase ?? 'none',
        });
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

    const request = await buildWorkRequest(this, { task, attemptId, bench });

    const dispatched = await dispatchExecutor(this, {
      task,
      attemptId,
      request,
      bench,
      dispatchOpts,
    });
    // Launch was rejected as stale/non-executable after executor start;
    // dispatch already cleaned up and acked the dispatch row.
    if (!dispatched) return;
    return wireCompletion(this, {
      task,
      attemptId,
      executor: dispatched.executor,
      handle: dispatched.handle,
      dispatchOpts,
    });
  }

  /**
   * Serialize completion `work` through {@link completionChain} so concurrent
   * onComplete firings never overlap inside orchestrator mutations. Used by the
   * finalize phase.
   * @internal
   */
  async runSerializedCompletion(work: () => Promise<void>): Promise<void> {
    const prev = this.completionChain;
    this.completionChain = prev.then(work, work);
    await this.completionChain;
  }

  /**
   * Recreate flows clear both branch and workspacePath before rerun.
   * Restarts preserve them, so this is the executor-facing signal to bypass
   * same-action worktree reuse only for semantically fresh recreates.
   */
  /** @internal */ shouldUseFreshWorkspace(task: TaskState): boolean {
    return (task.execution.generation ?? 0) > 0
      && task.execution.branch === undefined
      && task.execution.workspacePath === undefined;
  }

  /** @internal */ poolMemberKey(member: ExecutionPoolMember): string {
    return poolMemberKey(member);
  }

  recordPoolMemberTransportFailure(memberKey: string, error: unknown): PoolMemberHealth {
    return recordPoolMemberTransportFailure(this, memberKey, error);
  }

  recordPoolMemberStartSuccess(memberKey: string): boolean {
    return recordPoolMemberStartSuccess(this, memberKey);
  }

  getPoolMemberHealthSnapshot(now: number = Date.now()): ReturnType<typeof getPoolMemberHealthSnapshot> {
    return getPoolMemberHealthSnapshot(this, now);
  }

  private selectPoolMember(
    poolId: string,
    pool: ExecutionPoolConfig,
    excludedMemberKeys: Set<string> = new Set(),
  ): ExecutionPoolMember | undefined {
    return selectPoolMember(this, poolId, pool, excludedMemberKeys);
  }

  /** @internal */ acquirePoolSelectionLease(task: TaskState, attemptId: string, selection: PoolSelection | undefined): boolean {
    return acquirePoolSelectionLease(this, task, attemptId, selection);
  }

  /** @internal */ renewPoolSelectionLease(selection: PoolSelection | undefined): void {
    renewPoolSelectionLease(this, selection);
  }

  /** @internal */ releasePoolSelectionLease(selection: PoolSelection | undefined): void {
    releasePoolSelectionLease(this, selection);
  }

  /** @internal */ logExecutorSelected(
    task: TaskState,
    executor: Executor,
    handle: ExecutorHandle,
    attemptId: string,
    poolSelection: PoolSelection | undefined,
  ): void {
    logExecutorSelected(this, task, executor, handle, attemptId, poolSelection);
  }

  /** @internal */ selectedRemoteTargetId(task: TaskState, poolSelection: PoolSelection | undefined): string | undefined {
    return selectedRemoteTargetId(this, task, poolSelection);
  }

  takeResolvedExecutionSelection(taskId: string): ResolvedExecutionSelection | undefined {
    return takeResolvedExecutionSelection(this, taskId);
  }

  selectExecutor(task: TaskState, excludedPoolMemberKeys: Set<string> = new Set()): SelectedExecutor {
    return selectExecutor(this, task, excludedPoolMemberKeys);
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
    // Pump the attempt heartbeat/lease while the make-pr publisher runs, exactly
    // as executeMergeNode does. A slow publish (large stack, loaded machine) must
    // not be misread as a liveness stall by the executing-stall watchdog.
    return this.withAttemptHeartbeat(task.id, () => publishAfterFixImpl(this, task));
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

    const selectedExecutor = this.selectExecutor(task);
    const executor = selectedExecutor.executor;
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
    return gitPlumbing.execGitReadonly(args, cwd ?? this.cwd);
  }

  /** @internal */ execGitIn(args: string[], dir: string): Promise<string> {
    return gitPlumbing.execGitIn(args, dir);
  }

  /** @internal */ createMergeWorktree(ref: string, label: string, repoUrl?: string): Promise<string> {
    return gitPlumbing.createMergeWorktree(ref, label, repoUrl, {
      cwd: this.cwd,
      logger: this.logger,
      ensureRepoMirrorPath: (url) => this.ensureRepoMirrorPath(url),
    });
  }

  /** @internal */ cloneMergeWorktree(cloneSource: string, clonePath: string): Promise<void> {
    return gitPlumbing.cloneMergeWorktree(cloneSource, clonePath, (args) => this.execGitReadonly(args), this.logger);
  }

  /** @internal */ removeMergeWorktree(dir: string): Promise<void> {
    return gitPlumbing.removeMergeWorktree(dir, this.logger);
  }

  detectDefaultBranch(): Promise<string> {
    return gitPlumbing.detectDefaultBranch((args) => this.execGitReadonly(args));
  }

  /** @internal */ execGh(args: string[], cwd?: string): Promise<string> {
    return gitPlumbing.execGh(args, cwd ?? this.cwd);
  }

  /** @internal */ execPr(baseBranch: string, featureBranch: string, title: string, body?: string, cwd?: string): Promise<string> {
    return gitPlumbing.execPr(
      baseBranch,
      featureBranch,
      title,
      body,
      cwd ?? this.cwd,
      (args, ghCwd) => this.execGh(args, ghCwd),
      (args, dir) => this.execGitIn(args, dir),
    );
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
  async resolveConflict(
    taskId: string,
    savedError?: string,
    agentName?: string,
    executionModel?: string,
  ): Promise<void> {
    const task = this.orchestrator.getTask(taskId);
    const explicitModel = executionModel?.trim();
    const resolvedModel = explicitModel && explicitModel.length > 0
      ? explicitModel
      : (task ? this.resolveExecutionModel(task) : undefined);
    return this.withAttemptHeartbeat(taskId, () => resolveConflictImpl(this, taskId, savedError, agentName, resolvedModel));
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
    return reviewGate.closeWorkflowReview(this, workflowId);
  }

  private isCurrentReviewGateArtifact(gate: ReviewGateState, artifact: ReviewGateArtifact): boolean {
    return reviewGate.isCurrentReviewGateArtifact(gate, artifact);
  }

  private getCurrentReviewArtifacts(task: TaskState): ReviewGateArtifact[] {
    return reviewGate.getCurrentReviewArtifacts(task);
  }

  private getCurrentRequiredReviewArtifacts(task: TaskState): ReviewGateArtifact[] {
    return reviewGate.getCurrentRequiredReviewArtifacts(task);
  }

  private getCurrentClosableReviewIdentifiers(task: TaskState): string[] {
    return reviewGate.getCurrentClosableReviewIdentifiers(task);
  }

  private mapReviewGateArtifactStatus(status: MergeGateApprovalStatus): ReviewGateArtifactStatus {
    return reviewGate.mapReviewGateArtifactStatus(status);
  }

  private reviewPollStillMatches(
    before: TaskState,
    current: TaskState | undefined,
    providerId: string,
  ): boolean {
    return reviewGate.reviewPollStillMatches(before, current, providerId);
  }

  private updateReviewGateArtifact(
    gate: ReviewGateState,
    providerId: string,
    status: MergeGateApprovalStatus,
  ): ReviewGateState {
    return reviewGate.updateReviewGateArtifact(gate, providerId, status);
  }

  private reviewGateIsApproved(gate: ReviewGateState): boolean {
    return reviewGate.reviewGateIsApproved(gate);
  }

  private async handleApprovedMergeGate(
    taskId: string,
    reviewId: string,
    source?: 'refresh' | 'manual check',
  ): Promise<void> {
    return reviewGate.handleApprovedMergeGate(this, taskId, reviewId, source);
  }

  private async pollMergeGateTask(
    task: TaskState,
    source: 'refresh' | 'manual check',
  ): Promise<void> {
    return reviewGate.pollMergeGateTask(this, task, source);
  }

  async checkMergeGateStatuses(): Promise<void> {
    return reviewGate.checkMergeGateStatuses(this);
  }

  async checkPrApprovalNow(taskId: string): Promise<void> {
    return reviewGate.checkPrApprovalNow(this, taskId);
  }

  private async maybePublishReviewGateCiFailure(
    task: TaskState,
    status: MergeGateApprovalStatus,
    reviewId: string = task.execution.reviewId ?? '',
  ): Promise<void> {
    return reviewGate.maybePublishReviewGateCiFailure(this, task, status, reviewId);
  }

  spawnAgentFix(
    prompt: string,
    cwd: string,
    agentName: string = DEFAULT_EXECUTION_AGENT,
    executionModel?: string,
  ): Promise<{ stdout: string; sessionId: string }> {
    if (!this.executionAgentRegistry) {
      throw new Error('executionAgentRegistry is required for spawnAgentFix');
    }
    const agent = this.executionAgentRegistry.getOrThrow(agentName);
    if (!agent.buildFixCommand) {
      throw new Error(`Agent "${agentName}" does not support fix commands`);
    }
    const driver = this.executionAgentRegistry.getSessionDriver(agentName);
    return spawnAgentFixViaRegistry(prompt, cwd, agent, driver, executionModel);
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
    repoUrl?: string;
  }): Promise<{ body: string; sessionId: string; agentName: string }> {
    const strictReviewStack = isInvokerRepoUrl(args.repoUrl);
    if (!this.executionAgentRegistry) {
      if (strictReviewStack) {
        throw new Error(
          '[pr-authoring] executionAgentRegistry missing and target is the Invoker repo; '
            + 'refusing canonical fallback PR body (it cannot pass scripts/validate-pr-body.mjs).',
        );
      }
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
        strictReviewStack,
      });

      try {
        this.logger.info(
          `[pr-authoring] body authoring starting agent=${agent.name} `
            + `workflow=${args.workflowId ?? 'unknown'} skill=invoker-make-pr`
            + (strictReviewStack ? ' schema=review-stack' : ''),
        );
        const result = await spawnAgentPrAuthorViaRegistry(prompt, args.cwd, agent, driver);
        const validationErrors = strictReviewStack
          ? validateReviewStackPrBody(result.body)
          : validateCanonicalPrBody(result.body);
        if (validationErrors.length > 0) {
          this.logger.warn(
            `[pr-authoring] body validation failed agent=${agent.name} `
              + `errors=${validationErrors.join('; ')}`,
          );
          errors.push(
            `${agent.name}: invalid PR body — ${validationErrors.join('; ')}`,
          );
          continue;
        }
        this.logger.info(`[pr-authoring] body authored agent=${agent.name} validated`);
        return { body: result.body, sessionId: result.sessionId, agentName: agent.name };
      } catch (err) {
        errors.push(
          `${agent.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (strictReviewStack) {
      throw new Error(
        '[pr-authoring] All AI agents failed to author a review-stack PR body for the Invoker repo; '
          + `refusing canonical fallback (it cannot pass scripts/validate-pr-body.mjs). Errors: ${errors.join(' | ')}`,
      );
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

  async publishReviewStackWithMakePrSkill(args: {
    workflowId?: string;
    mergeNodeTaskId?: string;
    title: string;
    baseBranch: string;
    featureBranch: string;
    workflowSummary: string;
    cwd: string;
    expectedGeneration: number;
    reviewGate?: ReviewGateState;
  }): Promise<{ artifacts: ReviewGateArtifact[]; sessionId: string; agentName: string }> {
    if (!this.executionAgentRegistry) {
      throw new Error('make-pr skill is required to publish Invoker review stacks');
    }

    const preferredName = this.resolvePrAuthoringAgentName(args.workflowId, args.mergeNodeTaskId);
    const prCapableAgents = this.executionAgentRegistry.listWithCapability('make-pr');
    const orderedAgents = this.buildAgentFallbackOrder(preferredName, prCapableAgents);
    const logProgress = (
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      detail: Record<string, unknown> = {},
    ) => {
      if (!args.mergeNodeTaskId) return;
      try {
        const persistence = this.persistence as { logEvent?: (taskId: string, eventType: string, payload?: unknown) => void };
        persistence.logEvent?.(args.mergeNodeTaskId, 'task.log', {
          level,
          message,
          ...detail,
        });
      } catch (error) {
        this.logger.warn('[pr-authoring] failed to persist task progress event', {
          taskId: args.mergeNodeTaskId,
          error,
        });
      }
    };

    logProgress('info', 'Preparing make-pr review stack publisher', {
      featureBranch: args.featureBranch,
      baseBranch: args.baseBranch,
      agentCount: orderedAgents.length,
    });

    const errors: string[] = [];

    for (const agent of orderedAgents) {
      const skillPath = resolveSkillPathViaAgent(agent, 'make-pr');
      if (!skillPath) {
        errors.push(`${agent.name}: skill "invoker-make-pr" not installed`);
        continue;
      }

      const driver = this.executionAgentRegistry.getSessionDriver(agent.name);
      const prompt = buildMakePrStackPublishPrompt({
        skillPath,
        title: args.title,
        baseBranch: args.baseBranch,
        featureBranch: args.featureBranch,
        workflowSummary: args.workflowSummary,
        cwd: args.cwd,
        reviewGate: args.reviewGate,
      });

      try {
        logProgress('info', `Starting ${agent.name} make-pr agent`, {
          agentName: agent.name,
          cwd: args.cwd,
        });
        this.logger.info(
          `[pr-authoring] review-stack publish starting agent=${agent.name} `
            + `workflow=${args.workflowId ?? 'unknown'} skill=invoker-make-pr cwd=${args.cwd}`,
        );
        const result = await spawnAgentPrAuthorViaRegistry(prompt, args.cwd, agent, driver);
        logProgress('info', `${agent.name} make-pr agent finished; validating output`, {
          agentName: agent.name,
          sessionId: result.sessionId,
        });
        const parsedArtifacts = parseMakePrStackPublishResult(result.body);

        // Enforce the make-pr review-stack schema on every published body. Prefer
        // the body actually published on the provider: a lazy agent could report a
        // compliant body in JSON while letting Mergify default the real PR to the
        // commit message — the exact PR #2170 failure. Fall back to the
        // agent-reported body only when the live body cannot be read.
        const bodyErrors: string[] = [];
        for (let index = 0; index < parsedArtifacts.length; index += 1) {
          const artifact = parsedArtifacts[index];
          let bodyToCheck = artifact.body ?? '';
          let bodySource = 'agent-reported';
          if (this.mergeGateProvider?.getReviewBody && artifact.providerId) {
            try {
              bodyToCheck = await this.mergeGateProvider.getReviewBody({
                identifier: artifact.providerId,
                cwd: args.cwd,
              });
              bodySource = 'published';
            } catch (fetchErr) {
              this.logger.warn(
                `[pr-authoring] could not read published body for PR ${artifact.providerId}; `
                  + `validating agent-reported body instead: `
                  + `${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
              );
            }
          }
          for (const error of validateReviewStackPrBody(bodyToCheck)) {
            bodyErrors.push(`artifact[${index}] (${artifact.url}) [${bodySource}]: ${error}`);
          }
        }
        if (bodyErrors.length > 0) {
          this.logger.warn(
            `[pr-authoring] review-stack body validation failed agent=${agent.name} `
              + `errors=${bodyErrors.join('; ')}`,
          );
          logProgress('warn', `${agent.name} published review stack failed validation`, {
            agentName: agent.name,
            errors: bodyErrors,
          });
          errors.push(`${agent.name}: invalid PR body — ${bodyErrors.join('; ')}`);
          continue;
        }

        const nowIso = new Date().toISOString();
        const generation = args.expectedGeneration;
        const artifacts: ReviewGateArtifact[] = parsedArtifacts.map(({ body: _body, ...artifact }) => ({
          ...artifact,
          provider: 'github',
          baseBranch: artifact.baseBranch ?? args.baseBranch,
          required: true,
          status: 'open',
          generation,
          createdAt: nowIso,
        }));
        logProgress('info', 'Review stack body validated', {
          agentName: agent.name,
          artifactCount: artifacts.length,
        });
        this.logger.info(
          `[pr-authoring] review-stack published agent=${agent.name} artifacts=${artifacts.length} `
            + 'bodies validated against make-pr schema',
        );
        return { artifacts, sessionId: result.sessionId, agentName: agent.name };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logProgress('warn', `${agent.name} make-pr agent failed`, {
          agentName: agent.name,
          error: message,
        });
        errors.push(`${agent.name}: ${message}`);
      }
    }

    throw new Error(
      `make-pr skill is required to publish Invoker review stacks${errors.length > 0 ? `: ${errors.join(' | ')}` : ''}`,
    );
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
      return this.getDefaultExecutionAgent();
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
    return clearSshExecutorCache(this);
  }

  /**
   * Destroy and deregister a per-task Docker executor if one was created for this task.
   */
  /** @internal */ async cleanupPerTaskDockerExecutor(task: TaskState): Promise<void> {
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

  /** @internal */ buildAlternatives(
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

  /** @internal */ async buildUpstreamContext(
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

  /** @internal */ resolveExternalDependencyTask(workflowId: string, taskId?: string): TaskState | undefined {
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
    return gitPlumbing.gitLogMessage(commitHash, cwd ?? this.cwd);
  }

  /** @internal */ gitDiffStat(branch: string, cwd?: string): Promise<string> {
    return gitPlumbing.gitDiffStat(branch, this.defaultBranch, cwd ?? this.cwd);
  }
}
