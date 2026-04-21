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
import type { Orchestrator, TaskState, ExperimentVariant, ExecutorType } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { WorkRequest, WorkResponse, ActionType } from '@invoker/contracts';
import type { Executor, ExecutorHandle } from './executor.js';
import { BaseExecutor } from './base-executor.js';
import { RESTART_TO_BRANCH_TRACE, traceExecution } from './exec-trace.js';
import { ResourceLimitError } from './repo-pool.js';
import type { ExecutorRegistry } from './registry.js';
import type { AgentRegistry } from './agent-registry.js';
import type { MergeGateProvider } from './merge-gate-provider.js';
import type { ReviewProviderRegistry } from './review-provider-registry.js';
import { DockerExecutor } from './docker-executor.js';
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
} from './merge-runner.js';
import { normalizeBranchForGithubCli } from './github-branch-ref.js';
import {
  resolveConflictImpl,
  fixWithAgentImpl,
  spawnAgentFixViaRegistry,
} from './conflict-resolver.js';
import { DEFAULT_EXECUTION_AGENT } from './agent.js';

/** Keeps `lastHeartbeatAt` fresh while `executor.start()` is awaited (SSH remote setup/provision can take minutes). Matches BaseExecutor default heartbeat cadence. */
const PRE_START_HEARTBEAT_INTERVAL_MS = 30_000;
const ATTEMPT_LEASE_MS = 20 * 60 * 1000;
const DEFAULT_EXECUTOR_START_TIMEOUT_MS = 10 * 60 * 1000;

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
};

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

// ── Callbacks ─────────────────────────────────────────────

export interface TaskRunnerCallbacks {
  onOutput?: (taskId: string, data: string) => void;
  onSpawned?: (taskId: string, handle: ExecutorHandle, executor: Executor) => void;
  onComplete?: (taskId: string, response: WorkResponse) => void;
  onHeartbeat?: (taskId: string) => void;
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
  }>;
  /** Docker execution environment configuration from .invoker.json. */
  dockerConfig?: {
    imageName?: string;
    secretsFile?: string;
  };
  /** Shared execution agents (Claude, Codex). Passed into lazily constructed executors. */
  executionAgentRegistry?: AgentRegistry;
}

// ── TaskRunner ──────────────────────────────────────────

export class TaskRunner {
  /** @internal */ orchestrator: Orchestrator;
  /** @internal */ persistence: SQLiteAdapter;
  private executorRegistry: ExecutorRegistry;
  /** @internal */ cwd: string;
  private maxWorktreesPerRepo: number;
  /** @internal */ defaultBranch: string | undefined;
  /** @internal */ callbacks: TaskRunnerCallbacks;
  /** @internal */ mergeGateProvider?: MergeGateProvider;
  /** @internal */ reviewProviderRegistry?: ReviewProviderRegistry;
  private activePrPollers = new Map<string, ReturnType<typeof setInterval>>();
  private getRemoteTargets: () => Record<string, { host: string; user: string; sshKeyPath: string; port?: number; managedWorkspaces?: boolean; remoteInvokerHome?: string; provisionCommand?: string }>;
  private dockerConfig: { imageName?: string; secretsFile?: string };
  private executionAgentRegistry?: AgentRegistry;
  /** Cache for SSH executors, keyed by remoteTargetId. One instance per target for correct git locking. */
  private sshExecutorCache = new Map<string, SshExecutor>();

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
  ): Promise<void> {
    if (!repoUrl) return;
    const executor = this.executorRegistry.get('worktree');
    if (!(executor instanceof WorktreeExecutor)) return;
    const pool = executor.getRepoPool();
    const baseBranch = baseBranchHint?.trim() || this.defaultBranch || 'master';
    await pool.refreshMirrorForRebase(repoUrl, baseBranch);
    const branches = this.collectManagedWorkflowBranches(workflowId);
    await pool.removeManagedBranchesInMirror(repoUrl, branches);
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
      return await executor.getRepoPool().ensureClone(trimmed);
    } catch (err) {
      console.warn(`[merge] ensureRepoMirrorPath failed for ${trimmed}: ${err}`);
      return undefined;
    }
  }

  private collectManagedWorkflowBranches(workflowId: string): string[] {
    return this.orchestrator
      .getAllTasks()
      .filter((t) => t.config.workflowId === workflowId && !t.config.isMergeNode)
      .map((t) => t.execution.branch ?? `invoker/${t.id}`)
      .filter((b) => isInvokerManagedPoolBranch(b));
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
    this.getRemoteTargets = config.remoteTargetsProvider ?? (() => ({}));
    this.dockerConfig = config.dockerConfig ?? {};
    this.executionAgentRegistry = config.executionAgentRegistry;
  }

  /**
   * Stop the executor child for a task that is currently in-flight (after orchestrator.cancelTask).
   */
  async killActiveExecution(taskId: string): Promise<void> {
    const resolved = this.resolveActiveExecution(taskId);
    if (!resolved) return;
    this.activeExecutions.delete(resolved.attemptId);
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
    for (const [attemptId, entry] of this.activeExecutions) {
      if (entry.taskId === taskId || entry.handle.taskId === taskId) {
        return { attemptId, entry };
      }
    }

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

    return undefined;
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
  async executeTask(task: TaskState): Promise<void> {
    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} TaskRunner.executeTask BEGIN taskId=${task.id} isMergeNode=${Boolean(task.config.isMergeNode)} status=${task.status}`,
    );
    const attemptId = this.resolveAttemptIdForStart(task);
    if (this.launchingAttemptIds.has(attemptId) || this.activeExecutions.has(attemptId)) {
      traceExecution(
        `[TaskRunner] executeTask skipping duplicate launch for task=${task.id} attempt=${attemptId}`,
      );
      return;
    }
    this.launchingAttemptIds.add(attemptId);
    try {
      await this.executeTaskInner(task, attemptId);
    } catch (err) {
      // Resource limit: defer the task instead of failing it
      const cause = err instanceof Error ? err.cause : undefined;
      if (cause instanceof ResourceLimitError) {
        traceExecution(`[TaskRunner] executeTask deferred for task=${task.id}: ${cause.message}`);
        this.orchestrator.deferTask(task.id);
        return;
      }

      console.error(`[TaskRunner] executeTask failed for task=${task.id}:`, err);
      const launchFailedAt = new Date();
      try {
        const latest = this.orchestrator.getTask(task.id);
        if (latest && (latest.status === 'running' || latest.status === 'fixing_with_ai')) {
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
      this.callbacks.onComplete?.(task.id, response);
      this.orchestrator.handleWorkerResponse(response);
    } finally {
      this.launchingAttemptIds.delete(attemptId);
    }
  }

  private async executeTaskInner(task: TaskState, attemptId: string): Promise<void> {
    // Pivot tasks with experimentVariants: synthesize a spawn_experiments
    // response instead of running through the executor.
    if (task.config.pivot && task.config.experimentVariants && task.config.experimentVariants.length > 0) {
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
      if (newlyStarted.length > 0) {
        this.executeTasks(newlyStarted);
      }
      return;
    }

    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} (past pivot check) → gather upstreams + build WorkRequest`,
    );

    // Gather upstream context from completed dependencies
    const upstreamContext = await this.buildUpstreamContext(task);
    const upstreamBranches = this.collectUpstreamBranches(task);
    const alternatives = this.buildAlternatives(task);

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

    // Read workflow + task generations for content-addressable branch salt.
    const workflow = task.config.workflowId ? this.persistence.loadWorkflow?.(task.config.workflowId) : undefined;
    const workflowGeneration = (workflow as any)?.generation ?? 0;
    const taskExecutionGeneration = task.execution.generation ?? 0;
    const generationSalt = workflowGeneration > 0 || taskExecutionGeneration > 0
      ? `wf:${workflowGeneration}|task:${taskExecutionGeneration}`
      : undefined;
    const baseBranch = workflow?.baseBranch ?? this.defaultBranch;
    const repoUrl = workflow?.repoUrl;

    const request: WorkRequest = {
      requestId: randomUUID(),
      actionId: task.id,
      attemptId,
      executionGeneration: task.execution.generation ?? 0,
      actionType: this.determineActionType(task),
      inputs: {
        description: task.description,
        command: task.config.command,
        prompt: task.config.prompt,
        executionAgent: task.config.executionAgent?.trim() || DEFAULT_EXECUTION_AGENT,
        repoUrl,
        featureBranch: task.config.featureBranch,
        upstreamContext: upstreamContext.length > 0 ? upstreamContext : undefined,
        alternatives: alternatives.length > 0 ? alternatives : undefined,
        upstreamBranches: upstreamBranches.length > 0 ? upstreamBranches : undefined,
        salt: generationSalt,
        baseBranch,
        freshWorkspace: this.shouldUseFreshWorkspace(task),
      },
      callbackUrl: '',
      timestamps: {
        createdAt: new Date().toISOString(),
      },
    };

    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} WorkRequest built actionType=${request.actionType} repoUrl=${request.inputs.repoUrl ?? '(none)'} upstreamBranches=${JSON.stringify(request.inputs.upstreamBranches ?? [])}`,
    );
    const executor = this.selectExecutor(task);
    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} selectExecutor → type=${executor.type} calling executor.start()`,
    );
    traceExecution(`[trace] TaskRunner: task=${task.id} calling executor.start() type=${executor.type}`);
    const startT0 = Date.now();
    const startTimeoutMs = getExecutorStartTimeoutMs();
    const preStartHeartbeatTimer = setInterval(() => {
      const now = new Date();
      this.persistence.updateAttempt?.(attemptId, {
        lastHeartbeatAt: now,
        leaseExpiresAt: nextLeaseExpiry(now),
      } as any);
      this.callbacks.onHeartbeat?.(task.id);
    }, PRE_START_HEARTBEAT_INTERVAL_MS);
    let preStartTimeout: ReturnType<typeof setTimeout> | undefined;
    let handle: ExecutorHandle;
    try {
      handle = await Promise.race<ExecutorHandle>([
        executor.start(request),
        new Promise<ExecutorHandle>((_resolve, reject) => {
          preStartTimeout = setTimeout(() => {
            reject(new Error(`Executor startup timed out after ${startTimeoutMs}ms (${executor.type})`));
          }, startTimeoutMs);
        }),
      ]);
    } catch (err) {
      const meta = err as StartupFailureMetadata;
      const startupErrorMessage = `Executor startup failed (${executor.type}): ${err instanceof Error ? err.message : String(err)}\n`;
      this.callbacks.onOutput?.(task.id, startupErrorMessage);
      try {
        this.persistence.appendTaskOutput(task.id, startupErrorMessage);
      } catch {
        // Preserve the original startup failure if output persistence also fails.
      }
      if (meta.workspacePath || meta.branch || meta.agentSessionId || meta.containerId) {
        const execution: Record<string, string> = {};
        if (meta.workspacePath) execution.workspacePath = meta.workspacePath;
        if (meta.branch) execution.branch = meta.branch;
        if (meta.agentSessionId) {
          execution.agentSessionId = meta.agentSessionId;
          execution.lastAgentSessionId = meta.agentSessionId;
        }
        if (meta.containerId) execution.containerId = meta.containerId;
        this.persistence.updateTask(task.id, {
          config: { executorType: executor.type as ExecutorType },
          execution: execution as any,
        });
      }
      throw new Error(
        startupErrorMessage.trimEnd(),
        { cause: err },
      );
    } finally {
      clearInterval(preStartHeartbeatTimer);
      if (preStartTimeout) clearTimeout(preStartTimeout);
    }
    traceExecution(`[trace] TaskRunner: task=${task.id} executor.start() returned after ${Date.now() - startT0}ms executor=${executor.type} sessionId=${handle.agentSessionId ?? 'none'} workspace=${handle.workspacePath ?? 'default'}`);
    const launchAccepted =
      this.orchestrator.markTaskRunningAfterLaunch?.(task.id, attemptId) ?? true;
    if (!launchAccepted) {
      console.warn(
        `[TaskRunner] launch rejected as stale/non-executable for task=${task.id} attemptId=${attemptId}; killing spawned process`,
      );
      try {
        await executor.kill(handle);
      } catch (killErr) {
        console.warn(`[TaskRunner] failed to kill rejected launch for task=${task.id}: ${killErr}`);
      }
      await this.cleanupPerTaskDockerExecutor(task);
      return;
    }

    // Persist execution metadata immediately at task start — all fields explicit
    {
      // Fail-fast: workspacePath must be provided by all executors
      if (!handle.workspacePath) {
        throw new Error(
          `Executor "${executor.type}" did not provide workspacePath for task "${task.id}". ` +
          `All executors must set workspacePath; refusing to fall back to host repo.`,
        );
      }

      const changes = {
        config: { executorType: executor.type as ExecutorType },
        execution: {
          workspacePath: handle.workspacePath,
          branch: handle.branch ?? undefined,  // Explicit undefined when branch is not applicable (e.g., BYO mode)
          agentSessionId: handle.agentSessionId ?? undefined,
          lastAgentSessionId: handle.agentSessionId ?? undefined,
          lastAgentName: task.execution.agentName ?? undefined,
          containerId: handle.containerId ?? undefined,
        },
      };
      this.persistence.updateTask(task.id, changes);
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
    }

    // Notify consumer about the spawned handle
    const activeHandle = handle as ActiveExecutionHandle;
    activeHandle.attemptId = attemptId;
    this.activeExecutions.set(attemptId, { handle: activeHandle, executor, taskId: task.id });
    this.callbacks.onSpawned?.(task.id, handle, executor);

    // Wire output
    executor.onOutput(handle, (data) => {
      this.callbacks.onOutput?.(task.id, data);
    });

    // Wire heartbeat
    executor.onHeartbeat(handle, () => {
      const now = new Date();
      this.persistence.updateAttempt?.(attemptId, {
        lastHeartbeatAt: now,
        leaseExpiresAt: nextLeaseExpiry(now),
      } as any);
      this.callbacks.onHeartbeat?.(task.id);
    });

    // Wait for completion and feed response to orchestrator.
    // The callback is serialized through completionChain so that concurrent
    // onComplete firings never overlap inside orchestrator mutations.
    return new Promise<void>((resolvePromise) => {
      executor.onComplete(handle, async (response: WorkResponse) => {
        const work = async () => {
          const normalizedResponse = response.attemptId ? response : { ...response, attemptId };
          this.activeExecutions.delete(normalizedResponse.attemptId ?? attemptId);
          try {
            traceExecution(
              `[task-runner] onComplete taskId=${task.id} responseStatus=${response.status} ` +
                `responseAttemptId=${normalizedResponse.attemptId ?? attemptId} responseGeneration=${response.executionGeneration} executionId=${handle.executionId}`,
            );
            traceExecution(
              `${RESTART_TO_BRANCH_TRACE} resolvePromise | task.config.isMergeNode = ${task.config.isMergeNode}`,
            );
            // Merge nodes: run consolidation/finish logic after executor completes
            if (task.config.isMergeNode) {
              traceExecution(
                `${RESTART_TO_BRANCH_TRACE} executor.onComplete taskId=${task.id} isMergeNode → executeMergeNode (consolidate / gate)`,
              );
              await this.executeMergeNode(task);
              return;
            }

            this.callbacks.onComplete?.(task.id, normalizedResponse);

            const newlyStarted = this.orchestrator.handleWorkerResponse(normalizedResponse) ?? [];

            if (newlyStarted.length > 0) {
              this.executeTasks(newlyStarted);
            }
          } catch (err) {
            console.error(`[TaskRunner] onComplete handler failed for task=${task.id}:`, err);
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
            this.callbacks.onComplete?.(task.id, errResponse);
            this.orchestrator.handleWorkerResponse(errResponse);
          } finally {
            // Clean up per-task Docker executor to avoid resource leaks
            await this.cleanupPerTaskDockerExecutor(task);
          }
        };

        const prev = this.completionChain;
        this.completionChain = prev.then(work, work);
        await this.completionChain;
        resolvePromise();
      });
    });
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
   * Uses task.executorType to look up in the registry; falls back to default.
   * Merge gate tasks use the default (worktree) executor when selected explicitly.
   */
  selectExecutor(task: TaskState): Executor {
    const effectiveType = task.config.executorType;

    if (effectiveType) {
      const registered = this.executorRegistry.get(effectiveType);
      if (registered) {
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

      // Lazy registration for SSH — resolve remoteTargetId from config and cache by targetId.
      // The cache is config-aware: if the underlying remote target config changes (e.g. via
      // remoteTargetsProvider returning new values), we replace the cached executor so the
      // new config takes effect immediately.
      if (effectiveType === 'ssh') {
        const targetId = task.config.remoteTargetId;
        if (!targetId) {
          throw new Error(`Task ${task.id} has executorType=ssh but no remoteTargetId`);
        }

        // Always re-read targets so dynamic provider updates are picked up.
        const remoteTargets = this.getRemoteTargets();
        const target = remoteTargets[targetId];
        if (!target) {
          throw new Error(
            `Task ${task.id} references remoteTargetId="${targetId}" but no matching ` +
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
        });

        this.sshExecutorCache.set(cacheKey, ssh);
        traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=ssh remoteTarget=${targetId} → ssh (new, cached)`);
        return ssh;
      }
    }

    if (task.config.isMergeNode) {
      const mergeGateExecutor = this.executorRegistry.getDefault();
      traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} isMergeNode=true → ${mergeGateExecutor.type} (merge gate)`);
      return mergeGateExecutor;
    }

    const defaultExecutor = this.executorRegistry.getDefault();
    traceExecution(`[trace] TaskRunner.selectExecutor: task=${task.id} effectiveType=${effectiveType ?? 'none'} → ${defaultExecutor.type} (default)`);
    return defaultExecutor;
  }

  /**
   * Determine the correct ActionType for a task based on its fields.
   * Priority: isReconciliation > command > prompt > default 'command'.
   */
  determineActionType(task: TaskState): ActionType {
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
      },
      callbackUrl: '',
      timestamps: {
        createdAt: new Date().toISOString(),
      },
    };

    const executor = this.selectExecutor(task);
    let result: { commitHash?: string; error?: string };
    if (executor instanceof SshExecutor) {
      result = await executor.publishApprovedFix(workspacePath, request, branch);
    } else if (executor instanceof BaseExecutor) {
      result = await executor.publishApprovedFix(workspacePath, request, branch);
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
            console.log(`[visual-proof] ${d.toString().trimEnd()}`);
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

      // Upload and build markdown
      const states = ['empty-state', 'dag-loaded', 'task-running', 'task-complete', 'task-panel'];
      mkdirSync(resolve(homedir(), '.invoker'), { recursive: true });
      const tmpDir = mkdtempSync(resolve(homedir(), '.invoker', 'vp-'));
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
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`Upload failed (exit ${code})`));
          else resolveP(stdout.trim());
        });
      });

      rmSync(tmpDir, { recursive: true, force: true });

      const urlMap = JSON.parse(uploadResult);
      const lines: string[] = ['## Visual Proof', ''];
      for (const state of states) {
        const stateName = state.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const beforeUrl = urlMap[`before--${state}.png`] ?? '';
        const afterUrl = urlMap[`after--${state}.png`] ?? '';
        lines.push(`<details open>`, `<summary>${stateName}</summary>`, '',
          '| Before | After |', '|--------|-------|',
          `| ![before](${beforeUrl}) | ![after](${afterUrl}) |`, '', '</details>', '');
      }
      const beforeVideo = urlMap['before--walkthrough.webm'] ?? '';
      const afterVideo = urlMap['after--walkthrough.webm'] ?? '';
      lines.push('<details>', '<summary>Video Walkthroughs</summary>', '',
        `- [Before walkthrough](${beforeVideo})`, `- [After walkthrough](${afterVideo})`,
        '', '</details>');

      return lines.join('\n');
    } catch (err) {
      console.warn(`[visual-proof] Capture failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
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
   * @internal Read-only git queries only. For mutations, use execGitIn.
   */
  execGitReadonly(args: string[], cwd?: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('git', args, {
        cwd: cwd ?? this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (err) => {
        reject(new Error(`Failed to spawn git: ${err.message}`));
      });
      child.on('close', (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else reject(new Error(
          `git ${args.join(' ')} failed (code ${code}): ${stderr.trim()}${stdout.trim() ? '\n' + stdout.trim() : ''}`
        ));
      });
    });
  }

  /** @internal */ execGitIn(args: string[], dir: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('git', args, {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (err) => {
        reject(new Error(`Failed to spawn git: ${err.message}`));
      });
      child.on('close', (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else reject(new Error(
          `git ${args.join(' ')} failed (code ${code}): ${stderr.trim()}${stdout.trim() ? '\n' + stdout.trim() : ''}`
        ));
      });
    });
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
        console.warn(`[createMergeWorktree] Pool mirror unavailable for ${repoUrl}, falling back to host repo`);
      }
    }

    // Clone with hard-linked objects — near-instant, fully isolated refs
    await this.execGitReadonly(['clone', '--local', '--no-checkout', cloneSource, clonePath]);
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
    await this.execGitIn(['remote', 'set-url', 'origin', originUrl], clonePath);

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

    const candidates = [
      normalizedRef,
      strippedRemoteRef,
      `refs/heads/${strippedRemoteRef}`,
      `refs/remotes/origin/${strippedRemoteRef}`,
      `origin/${strippedRemoteRef}`,
    ];

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

    if (!refSha) {
      throw new Error(
        `Unable to resolve merge worktree ref "${ref}" in clone ${clonePath}. ` +
        `Tried: ${candidates.join(', ')}`,
      );
    }
    await this.execGitIn(['checkout', '--detach', refSha], clonePath);
    return clonePath;
  }

  /** @internal */ async removeMergeWorktree(dir: string): Promise<void> {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[TaskRunner] removeMergeWorktree failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
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
    const reconRepoUrl =
      reconWorkflowId !== undefined && reconWorkflowId !== ''
        ? this.persistence.loadWorkflow(reconWorkflowId)?.repoUrl
        : undefined;

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
        await ensureLocalBranchForMerge(this, worktreeDir, b, reconRepoUrl);
        const expMergeMsg = `Merge ${b} — ${expTask.description}`;
        await this.execGitIn(['merge', '--no-ff', '-m', expMergeMsg, b], worktreeDir);
      }

      // Push reconciliation branch from clone to origin (GitHub)
      await this.execGitIn(['push', '--force', 'origin', `${branchName}:refs/heads/${branchName}`], worktreeDir);

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
  async fixWithAgent(taskId: string, taskOutput: string, agentName?: string, savedError?: string): Promise<void> {
    return this.withAttemptHeartbeat(taskId, () => fixWithAgentImpl(this, taskId, taskOutput, agentName, savedError));
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
      this.callbacks.onHeartbeat?.(taskId);
    };

    const heartbeatTimer = setInterval(heartbeat, PRE_START_HEARTBEAT_INTERVAL_MS);
    try {
      return await work();
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  resumeMergeGatePolling(): void {
    if (!this.mergeGateProvider) return;
    for (const task of this.orchestrator.getAllTasks()) {
      if (
        task.config.isMergeNode &&
        (task.status === 'review_ready' || task.status === 'awaiting_approval') &&
        task.execution.reviewId &&
        !this.activePrPollers.has(task.id)
      ) {
        console.log(`[merge-gate] Resuming PR polling for ${task.id} (PR ${task.execution.reviewId})`);
        this.startPrPolling(task.id, task.execution.reviewId, task.config.workflowId!);
      }
    }
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
          const status = await this.mergeGateProvider.checkApproval({
            identifier: task.execution.reviewId,
            cwd: this.cwd,
          });
          this.persistence.updateTask(task.id, {
            execution: { reviewStatus: status.statusText },
          });
          if (status.approved) {
            console.log(`[merge-gate] PR ${task.execution.reviewId} approved (refresh), completing merge gate`);
            this.stopPrPolling(task.id);
            await this.orchestrator.approve(task.id);
          } else if (status.rejected) {
            console.log(`[merge-gate] PR ${task.execution.reviewId} rejected (refresh): ${status.statusText}`);
            this.stopPrPolling(task.id);
          }
        } catch (err) {
          console.error(`[merge-gate] PR status check error for ${task.id}:`, err);
        }
      }
    }
  }

  /** @internal */ startPrPolling(taskId: string, reviewId: string, workflowId: string): void {
    const pollIntervalMs = 30_000;
    const interval = setInterval(async () => {
      try {
        if (!this.mergeGateProvider) return;
        const status = await this.mergeGateProvider.checkApproval({
          identifier: reviewId,
          cwd: this.cwd,
        });

        // Update PR status on task
        this.persistence.updateTask(taskId, {
          execution: { reviewStatus: status.statusText },
        });

        if (status.approved) {
          console.log(`[merge-gate] PR ${reviewId} approved, completing merge gate`);
          this.stopPrPolling(taskId);
          await this.orchestrator.approve(taskId);
        } else if (status.rejected) {
          console.log(`[merge-gate] PR ${reviewId} rejected: ${status.statusText}`);
          this.stopPrPolling(taskId);
          // Leave in review_ready/awaiting_approval — user can retry
        }
      } catch (err) {
        console.error(`[merge-gate] PR poll error for ${taskId}:`, err);
        // Continue polling on transient errors
      }
    }, pollIntervalMs);
    this.activePrPollers.set(taskId, interval);
  }

  private stopPrPolling(taskId: string): void {
    const interval = this.activePrPollers.get(taskId);
    if (interval) {
      clearInterval(interval);
      this.activePrPollers.delete(taskId);
    }
  }

  async checkPrApprovalNow(taskId: string): Promise<void> {
    if (!this.mergeGateProvider) return;
    if (!this.activePrPollers.has(taskId)) return;

    // Read reviewId from persistence
    const task = this.orchestrator.getTask(taskId);
    const reviewId = task?.execution.reviewId;
    if (!reviewId) return;

    try {
      const status = await this.mergeGateProvider.checkApproval({
        identifier: reviewId,
        cwd: this.cwd,
      });

      this.persistence.updateTask(taskId, {
        execution: { reviewStatus: status.statusText },
      });

      if (status.approved) {
        console.log(`[merge-gate] PR ${reviewId} approved (manual check), completing merge gate`);
        this.stopPrPolling(taskId);
        await this.orchestrator.approve(taskId);
      } else if (status.rejected) {
        console.log(`[merge-gate] PR ${reviewId} rejected (manual check): ${status.statusText}`);
        this.stopPrPolling(taskId);
      }
    } catch (err) {
      console.error(`[merge-gate] Manual PR check error for ${taskId}:`, err);
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

  get agentRegistry(): AgentRegistry | undefined {
    return this.executionAgentRegistry;
  }

  getRemoteTargetConfig(targetId: string): { host: string; user: string; sshKeyPath: string; port?: number } | undefined {
    return this.getRemoteTargets()[targetId];
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
    if (task.config.executorType !== 'docker') return;
    const dockerKey = `docker:${task.id}`;
    const dockerExec = this.executorRegistry.get(dockerKey);
    if (!dockerExec) return;
    try {
      await dockerExec.destroyAll();
    } catch (err) {
      console.warn(`[TaskRunner] cleanupPerTaskDockerExecutor destroyAll failed for ${dockerKey}: ${err instanceof Error ? err.message : String(err)}`);
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
    const allTasks = this.orchestrator.getAllTasks();
    const taskBranches = allTasks
      .filter((t) => t.config.workflowId === workflowId && t.status === 'completed' && t.execution.branch && !t.config.isMergeNode)
      .map((t) => t.execution.branch!);

    const rebaseRepoUrl = this.persistence.loadWorkflow?.(workflowId)?.repoUrl;
    const worktreeDir = await this.createMergeWorktree(baseBranch, 'rebase-' + workflowId, rebaseRepoUrl);

    const rebasedBranches: string[] = [];
    const errors: string[] = [];

    try {
      for (const branch of taskBranches) {
        try {
          await this.execGitIn(['checkout', branch], worktreeDir);
          await this.execGitIn(['rebase', baseBranch], worktreeDir);
          // Push rebased branch from clone to origin (GitHub)
          await this.execGitIn(['push', '--force', 'origin', `${branch}:refs/heads/${branch}`], worktreeDir);
          rebasedBranches.push(branch);
          console.log(`[rebase] Successfully rebased ${branch} onto ${baseBranch}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${branch}: ${msg}`);
          console.error(`[rebase] Failed to rebase ${branch}: ${msg}`);
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
