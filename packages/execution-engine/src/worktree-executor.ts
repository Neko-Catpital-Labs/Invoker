import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { ExecutorHandle, PersistedTaskMeta, TerminalSpec } from './executor.js';
import { BaseExecutor, MergeConflictError, type BaseEntry } from './base-executor.js';
import { RepoPool } from './repo-pool.js';
import { killProcessGroup, cleanElectronEnv, resolveExecutableOnCurrentPath, SIGKILL_TIMEOUT_MS } from './process-utils.js';
import { DEFAULT_WORKTREE_PROVISION_COMMAND } from './default-worktree-provision-command.js';
import {
  computeContentHash,
  buildExperimentBranchName,
} from './branch-utils.js';
import { RESTART_TO_BRANCH_TRACE, traceExecution } from './exec-trace.js';
import { createExecutionBench } from './execution-bench.js';
import {
  syncPlanBaseRemote,
  syncPlanBaseRemoteForRef,
  resolvePlanBaseRevision,
  resolvePreferredTrackingRemote,
  shouldResolveViaOriginTracking,
} from './plan-base-remote.js';
import { remoteFetchForPool } from './remote-fetch-policy.js';
import { DEFAULT_EXECUTION_AGENT } from './agent.js';
import { sanitizeBranchForPath } from './git-utils.js';

// Re-export for backward compatibility
export { computeContentHash, buildExperimentBranchName } from './branch-utils.js';

export interface WorktreeExecutorConfig {
  /** Directory where worktrees are created. */
  worktreeBaseDir?: string;
  /** Directory for RepoPool clone cache. Required. */
  cacheDir: string;
  /** Maximum worktrees per cached repo. Default: 5. */
  maxWorktrees?: number;
  /** Command to invoke the Claude CLI. Defaults to 'claude'. */
  claudeCommand?: string;
  /** Agent registry for pluggable AI agents. When set, overrides claudeCommand. */
  agentRegistry?: import('./agent-registry.js').AgentRegistry;
  /** Heartbeat interval in milliseconds. Default: 30000. */
  heartbeatIntervalMs?: number;
  /** Maximum task duration in milliseconds. Default: 4 hours. */
  maxDurationMs?: number;
}


interface WorktreeEntry extends BaseEntry {
  process: ChildProcess | null;
  worktreeDir: string;
  branch: string;
  phase: 'preparing' | 'provisioning' | 'running' | 'completed';
  /** Full pool release: git worktree remove (used on provision failure, not on destroyAll). */
  poolRelease?: () => Promise<void>;
  /** Soft-release: frees the pool slot without removing the worktree from disk. */
  poolSoftRelease?: () => void;
  /** Agent session ID for resuming sessions. */
  agentSessionId?: string;
  /** Name of the ExecutionAgent that produced this session. */
  agentName?: string;
  rawStdout?: string;
  poolSlotReleased?: boolean;
}

/**
 * Executor implementation that runs tasks inside git worktrees.
 *
 * Each experiment gets its own worktree directory and branch, providing
 * filesystem-level isolation without the overhead of Docker containers.
 */
export class WorktreeExecutor extends BaseExecutor<WorktreeEntry> {
  readonly type = 'worktree';

  private readonly worktreeBaseDir: string;
  private readonly claudeCommand: string;
  private readonly agentRegistry?: import('./agent-registry.js').AgentRegistry;
  private pool: RepoPool;

  constructor(config: WorktreeExecutorConfig) {
    super(config.heartbeatIntervalMs, config.maxDurationMs);
    this.claudeCommand = config.claudeCommand ?? 'claude';
    this.agentRegistry = config.agentRegistry;
    this.worktreeBaseDir =
      config.worktreeBaseDir ?? resolve(homedir(), '.invoker', 'worktrees');
    this.pool = new RepoPool({
      cacheDir: config.cacheDir,
      maxWorktrees: config.maxWorktrees,
      worktreeBaseDir: this.worktreeBaseDir,
    });
  }

  /** Pool mirror used for this executor (rebase-and-retry / tests). */
  getRepoPool(): RepoPool {
    return this.pool;
  }

  private getLiveWorktreePaths(repoUrl: string): Set<string> {
    const livePaths = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.request.inputs.repoUrl !== repoUrl) continue;
      if (entry.completed) continue;
      livePaths.add(entry.worktreeDir);
    }
    return livePaths;
  }

  private reconcilePoolSlots(repoUrl: string): void {
    this.pool.reconcileActiveWorktrees(repoUrl, this.getLiveWorktreePaths(repoUrl));
  }

  private softReleasePoolSlot(entry: WorktreeEntry | undefined): void {
    if (!entry || entry.poolSlotReleased) return;
    entry.poolSlotReleased = true;
    entry.poolSoftRelease?.();
  }

  async start(request: WorkRequest): Promise<ExecutorHandle> {
    const repoUrl = request.inputs.repoUrl;
    if (!repoUrl) {
      throw new Error(
        `WorktreeExecutor.start(): missing repoUrl for task "${request.actionId}". ` +
        `Plans must declare a repoUrl.`,
      );
    }
    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} WorktreeExecutor.start() actionId=${request.actionId} repoUrl=${repoUrl}`,
    );
    const bench = createExecutionBench({
      module: 'worktree-executor-start-bench',
      baseMetadata: {
        requestId: request.requestId,
        actionId: request.actionId,
        actionType: request.actionType,
        repoUrl,
      },
    });
    bench('WorktreeExecutor.start.begin');
    await this.ensureGitAvailable();
    bench('WorktreeExecutor.ensureGitAvailable.done');
    const handle = this.createHandle(request);
    const executionId = handle.executionId;
    const t0 = Date.now();
    const log = (step: string) => traceExecution(`[WorktreeExecutor] start task=${request.actionId} step=${step} elapsed=${Date.now() - t0}ms`);

    bench('RepoPool.ensureCloneThroughRepoQueue.before');
    const clonePath = await this.pool.ensureCloneThroughRepoQueue(repoUrl);
    bench('RepoPool.ensureCloneThroughRepoQueue.after', { clonePath });
    const baseRef = request.inputs.baseBranch ?? 'HEAD';
    const runGit = (args: string[]) => this.execGitSimple(args, clonePath);
    let baseHead = request.inputs.baseCommit?.trim();
    if (baseHead) {
      bench('WorktreeExecutor.resolveBase.skipped', {
        baseRef,
        baseHead,
        reason: 'base-commit-provided',
      });
      log(`resolve base ${baseRef} skipped → ${baseHead}`);
    } else {
      log(`resolve base ${baseRef} begin`);
      bench('WorktreeExecutor.resolveBase.before', { baseRef });
      if (remoteFetchForPool.enabled && shouldResolveViaOriginTracking(baseRef)) {
        const preferredRemote = await resolvePreferredTrackingRemote(runGit, baseRef.trim());
        bench('WorktreeExecutor.resolvePreferredTrackingRemote.done', { baseRef, preferredRemote });
        await syncPlanBaseRemote(runGit, baseRef.trim(), preferredRemote);
        bench('WorktreeExecutor.syncPlanBaseRemote.done', { baseRef, preferredRemote });
      } else if (remoteFetchForPool.enabled) {
        await syncPlanBaseRemoteForRef(runGit, baseRef.trim());
        bench('WorktreeExecutor.syncPlanBaseRemoteForRef.done', { baseRef });
      }
      baseHead = await resolvePlanBaseRevision(runGit, baseRef);
      bench('WorktreeExecutor.resolveBase.after', { baseRef, baseHead });
      log(`resolve base ${baseRef} done → ${baseHead}`);
    }
    const upstreamCommits = (request.inputs.upstreamContext ?? [])
      .map(c => c.commitHash)
      .filter((h): h is string => !!h);
    const contentHash = computeContentHash(
      request.actionId,
      request.inputs.command,
      request.inputs.prompt,
      upstreamCommits,
      baseHead,
    );
    const branch = buildExperimentBranchName(
      request.actionId,
      request.inputs.lifecycleTag ?? '',
      contentHash,
    );
    traceExecution(`[WorktreeExecutor] branch=${branch} contentHash=${contentHash}`);
    bench('WorktreeExecutor.branchComputed', { branch, contentHash });
    // Notify the orchestrator before any `git worktree add` so a leaked
    // worktree (process killed mid-acquire) can still be reconciled.
    try {
      request.onBranchResolved?.(branch);
      bench('WorktreeExecutor.onBranchResolved.done', { branch });
    } catch (err) {
      traceExecution(
        `[WorktreeExecutor] onBranchResolved threw — continuing: ${err instanceof Error ? err.message : String(err)}`,
      );
      bench('WorktreeExecutor.onBranchResolved.failed', {
        branch,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // -- Reconciliation: real pool worktree at plan base (no upstream merges), then needs_input --
    if (request.actionType === 'reconciliation') {
      traceExecution(
        `${RESTART_TO_BRANCH_TRACE} WorktreeExecutor.start() actionId=${request.actionId} reconciliation → acquireWorktree (skip upstream merge)`,
      );
      bench('RepoPool.acquireWorktree.reconciliation.before', { branch, baseHead });
      const acquired = await this.pool.acquireWorktree(
        repoUrl,
        branch,
        baseHead,
        request.actionId,
        {
          forceFresh: request.inputs.freshWorkspace === true,
          ...(request.inputs.reusableWorktree
            ? { reusableWorktree: request.inputs.reusableWorktree }
            : {}),
        },
      );
      bench('RepoPool.acquireWorktree.reconciliation.after', {
        branch: acquired.branch,
        worktreePath: acquired.worktreePath,
      });
      this.cleanStaleLocks(acquired.worktreePath);

      const entry: WorktreeEntry = {
        process: null,
        request,
        worktreeDir: acquired.worktreePath,
        branch: acquired.branch,
        phase: 'preparing',
        outputListeners: new Set(),
        outputBuffer: [],
        outputBufferBytes: 0,
        evictedChunkCount: 0,
        completeListeners: new Set(),
        heartbeatListeners: new Set(),
        completed: false,
        poolRelease: acquired.release,
        poolSoftRelease: acquired.softRelease,
      };
      this.registerEntry(handle, entry);
      handle.workspacePath = acquired.worktreePath;
      handle.branch = acquired.branch;
      bench('WorktreeExecutor.registerEntry.reconciliation.done', {
        workspacePath: handle.workspacePath,
        branch: handle.branch,
      });

      setTimeout(() => {
        const e = this.entries.get(executionId);
        if (!e) return;
        const response: WorkResponse = {
          requestId: request.requestId,
          actionId: request.actionId,
          executionGeneration: request.executionGeneration,
          status: 'needs_input',
          outputs: { summary: 'Select winning experiment' },
        };
        this.emitComplete(executionId, response);
        this.softReleasePoolSlot(e);
      }, 0);

      bench('WorktreeExecutor.start.reconciliation.returning');
      return handle;
    }

    // -- Always use RepoPool --
    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} WorktreeExecutor.start() actionId=${request.actionId} → RepoPool path`,
    );
    bench('WorktreeExecutor.reconcilePoolSlots.before');
    this.reconcilePoolSlots(repoUrl);
    bench('WorktreeExecutor.reconcilePoolSlots.after');
    bench('RepoPool.acquireWorktree.before', { branch, baseHead });
    const acquired = await this.pool.acquireWorktree(
      repoUrl,
      branch,
      baseHead,
      request.actionId,
      {
        forceFresh: request.inputs.freshWorkspace === true,
        ...(request.inputs.reusableWorktree
          ? { reusableWorktree: request.inputs.reusableWorktree }
          : {}),
      },
    );
    bench('RepoPool.acquireWorktree.after', {
      branch: acquired.branch,
      worktreePath: acquired.worktreePath,
    });

    this.cleanStaleLocks(acquired.worktreePath);

    // Merge upstream dependency branches (pool already did preserve-or-reset)
    const poolUpstreams = request.inputs.upstreamBranches ?? [];
    if (poolUpstreams.length > 0) {
      try {
        bench('WorktreeExecutor.mergeRequestUpstreamBranches.before', { upstreamCount: poolUpstreams.length });
        await this.mergeRequestUpstreamBranches(request, acquired.worktreePath, baseHead);
        bench('WorktreeExecutor.mergeRequestUpstreamBranches.after', { upstreamCount: poolUpstreams.length });
      } catch (err: any) {
        if (err instanceof MergeConflictError) {
          const entry: WorktreeEntry = {
            process: null, request, worktreeDir: acquired.worktreePath, branch,
            phase: 'completed',
            outputListeners: new Set(), outputBuffer: [],
            outputBufferBytes: 0, evictedChunkCount: 0,
            completeListeners: new Set(), heartbeatListeners: new Set(),
            completed: true,
            poolRelease: acquired.release,
            poolSoftRelease: acquired.softRelease,
          };
          this.registerEntry(handle, entry);
          handle.workspacePath = acquired.worktreePath;
          handle.branch = acquired.branch;
          const response: WorkResponse = {
            requestId: request.requestId,
            actionId: request.actionId,
            executionGeneration: request.executionGeneration,
            status: 'failed',
            outputs: {
              exitCode: 1,
              error: JSON.stringify({
                type: 'merge_conflict',
                failedBranch: err.failedBranch,
                conflictFiles: err.conflictFiles,
              }),
            },
          };
          this.emitComplete(handle.executionId, response);
          this.softReleasePoolSlot(entry);
          bench('WorktreeExecutor.mergeConflict.returning', { failedBranch: err.failedBranch });
          return handle;
        }
        bench('WorktreeExecutor.mergeRequestUpstreamBranches.failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    // No-command tasks: complete immediately after branch setup
    if (!request.inputs.command && !request.inputs.prompt) {
      const entry: WorktreeEntry = {
        process: null, request, worktreeDir: acquired.worktreePath, branch,
        phase: 'preparing',
        outputListeners: new Set(), outputBuffer: [],
        outputBufferBytes: 0, evictedChunkCount: 0,
        completeListeners: new Set(), heartbeatListeners: new Set(),
        completed: false,
        poolRelease: acquired.release,
        poolSoftRelease: acquired.softRelease,
      };
      this.registerEntry(handle, entry);
      handle.workspacePath = acquired.worktreePath;
      handle.branch = acquired.branch;
      bench('WorktreeExecutor.registerEntry.noCommand.done', {
        workspacePath: handle.workspacePath,
        branch: handle.branch,
      });
      await this.handleProcessExit(executionId, request, acquired.worktreePath, 0, { branch });
      entry.phase = 'completed';
      this.softReleasePoolSlot(entry);
      bench('WorktreeExecutor.start.noCommand.returning');
      return handle;
    }

    const entry: WorktreeEntry = {
      process: null,
      request,
      worktreeDir: acquired.worktreePath,
      branch: acquired.branch,
      phase: 'provisioning',
      outputListeners: new Set(),
      outputBuffer: [],
      outputBufferBytes: 0,
      evictedChunkCount: 0,
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
      poolRelease: acquired.release,
      poolSoftRelease: acquired.softRelease,
    };
    this.registerEntry(handle, entry);
    handle.workspacePath = acquired.worktreePath;
    handle.branch = acquired.branch;
    bench('WorktreeExecutor.registerEntry.provisioning.done', {
      workspacePath: handle.workspacePath,
      branch: handle.branch,
    });

    const provisioning = this.provisionWorktree(acquired.worktreePath, executionId);
    entry.process = provisioning.child;
    try {
      await provisioning.completion;
      entry.process = null;
      entry.phase = 'running';
    } catch (err) {
      // Keep the failed workspace on disk for post-failure debugging/fix flows.
      // Only free the in-memory pool slot so retries are not blocked.
      entry.process = null;
      entry.phase = 'completed';
      entry.completed = true;
      this.softReleasePoolSlot(entry);
      this.entries.delete(executionId);
      const startupErr = err instanceof Error ? err : new Error(String(err));
      (startupErr as Error & { workspacePath?: string; branch?: string }).workspacePath = acquired.worktreePath;
      (startupErr as Error & { workspacePath?: string; branch?: string }).branch = acquired.branch;
      bench('WorktreeExecutor.provisionWorktree.failed', {
        error: startupErr.message,
        workspacePath: acquired.worktreePath,
        branch: acquired.branch,
      });
      throw startupErr;
    }

    bench('WorktreeExecutor.buildCommandAndArgs.before');
    const { cmd, args, agentSessionId } = this.buildCommandAndArgs(request, {
      claudeCommand: this.claudeCommand,
      agentRegistry: this.agentRegistry,
    });
    bench('WorktreeExecutor.buildCommandAndArgs.after', {
      cmd,
      argCount: args.length,
      hasAgentSessionId: !!agentSessionId,
    });

    const usesAgent = request.actionType === 'ai_task';
    const executionAgent = request.inputs.executionAgent ?? DEFAULT_EXECUTION_AGENT;
    const stdinMode = usesAgent && this.agentRegistry
      ? this.agentRegistry.getOrThrow(executionAgent).stdinMode
      : (usesAgent ? 'ignore' : 'pipe');
    const spawnCmd = request.actionType === 'ai_task' ? (resolveExecutableOnCurrentPath(cmd) ?? cmd) : cmd;
    bench('WorktreeExecutor.spawn.before', { cmd: spawnCmd, argCount: args.length, cwd: acquired.worktreePath });
    const child = spawn(spawnCmd, args, {
      stdio: [stdinMode, 'pipe', 'pipe'],
      cwd: acquired.worktreePath,
      detached: true,
      env: cleanElectronEnv(),
    });
    bench('WorktreeExecutor.spawn.after');

    // Register error handler IMMEDIATELY to catch synchronous spawn failures
    child.on('error', (err) => {
      traceExecution(`[WorktreeExecutor] child process spawn error: ${err.message}`);
      const response: WorkResponse = {
        requestId: request.requestId,
        actionId: request.actionId,
        executionGeneration: request.executionGeneration,
        status: 'failed',
        outputs: {
          exitCode: 1,
          error: `Failed to spawn command: ${err.message}`,
          agentName: request.actionType === 'ai_task' ? executionAgent : undefined,
        },
      };
      this.emitComplete(executionId, response);
      this.softReleasePoolSlot(entry);
    });

    entry.process = child;
    entry.phase = 'running';
    if (agentSessionId) {
      entry.agentSessionId = agentSessionId;
      handle.agentSessionId = agentSessionId;
    }

    const driver = usesAgent ? this.agentRegistry?.getSessionDriver(executionAgent) : undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (driver) {
        entry.rawStdout = (entry.rawStdout ?? '') + text;
      } else {
        this.emitOutput(executionId, text);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.on('close', async (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      entry.finalizingAfterClose = true;
      try {
        if (driver && entry.rawStdout) {
          // Extract real backend session/thread ID BEFORE writing the file,
          // so processOutput stores under the real ID (not the local UUID).
          const realId = driver.extractSessionId?.(entry.rawStdout);
          if (realId) {
            entry.agentSessionId = realId;
          }
          const readable = driver.processOutput(entry.agentSessionId ?? '', entry.rawStdout);
          if (readable) this.emitOutput(executionId, readable);
        }
        await this.handleProcessExit(executionId, request, acquired.worktreePath, exitCode, {
          signal,
          branch,
          agentSessionId: entry.agentSessionId,
          agentName: request.actionType === 'ai_task' ? executionAgent : undefined,
        });
      } catch (err) {
        const ent = this.entries.get(executionId);
        if (ent && !ent.completionResponse) {
          const reason = err instanceof Error ? err.stack ?? err.message : String(err);
          this.emitOutput(
            executionId,
            `[worktree] Finalization failed after agent exited: ${reason}\n`,
          );
          this.emitComplete(executionId, {
            requestId: request.requestId,
            actionId: request.actionId,
            executionGeneration: request.executionGeneration,
            status: 'failed',
            outputs: {
              exitCode: exitCode === 0 ? 1 : exitCode,
              error: `Invoker finalization failed after agent exited: ${reason}`,
              agentSessionId: entry.agentSessionId,
              agentName: request.actionType === 'ai_task' ? executionAgent : undefined,
              branch,
            },
          });
        }
      } finally {
        const ent = this.entries.get(executionId);
        if (ent) {
          ent.finalizingAfterClose = false;
          ent.process = null;
          ent.phase = 'completed';
          this.softReleasePoolSlot(ent);
        }
      }
    });

    this.startHeartbeat(executionId, child);
    log('startHeartbeat done — start() returning');
    bench('WorktreeExecutor.start.returning', {
      workspacePath: handle.workspacePath,
      branch: handle.branch,
    });
    return handle;
  }

  async kill(handle: ExecutorHandle): Promise<void> {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed || !entry.process) return;

    await super.kill(handle);

    this.softReleasePoolSlot(entry);
  }

  sendInput(handle: ExecutorHandle, input: string): void {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed) return;
    entry.process?.stdin?.write(input);
  }

  getTerminalSpec(handle: ExecutorHandle): TerminalSpec | null {
    const entry = this.entries.get(handle.executionId);
    if (!entry) return null;
    if (entry.agentSessionId) {
      const agentName = entry.request.inputs.executionAgent ?? DEFAULT_EXECUTION_AGENT;
      const resume = this.agentRegistry
        ? this.agentRegistry.getOrThrow(agentName).buildResumeArgs(entry.agentSessionId)
        : { cmd: 'claude', args: ['--resume', entry.agentSessionId, '--dangerously-skip-permissions'] };
      return withDisplayBridge({ command: resume.cmd, args: resume.args, cwd: entry.worktreeDir }, handle);
    }
    return withDisplayBridge({ cwd: entry.worktreeDir }, handle);
  }

  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec {
    traceExecution(`[WorktreeExecutor] getRestoredTerminalSpec task="${meta.taskId}" workspacePath="${meta.workspacePath ?? 'none'}" sessionId="${meta.agentSessionId ?? 'none'}"`);
    if (meta.workspacePath && !existsSync(meta.workspacePath)) {
      traceExecution(`[WorktreeExecutor] getRestoredTerminalSpec task="${meta.taskId}" — worktree path does NOT exist: ${meta.workspacePath}`);
      // Fall back to finding the worktree by branch via git worktree list
      const recovered = meta.branch ? this.findWorktreeByBranch(meta.branch) : undefined;
      if (recovered) {
        traceExecution(`[WorktreeExecutor] getRestoredTerminalSpec task="${meta.taskId}" — recovered worktree by branch: ${recovered}`);
        meta = { ...meta, workspacePath: recovered };
      } else {
        throw new Error(
          `Worktree ${meta.workspacePath} no longer exists for task ${meta.taskId}. It may have been cleaned up.`,
        );
      }
    }
    if (meta.workspacePath) {
      traceExecution(`[WorktreeExecutor] getRestoredTerminalSpec task="${meta.taskId}" — worktree path exists: ${meta.workspacePath}`);
    }
    if (meta.agentSessionId) {
      const resume = this.agentRegistry
        ? this.agentRegistry.getOrThrow(meta.executionAgent ?? DEFAULT_EXECUTION_AGENT).buildResumeArgs(meta.agentSessionId)
        : { cmd: 'claude', args: ['--resume', meta.agentSessionId, '--dangerously-skip-permissions'] };
      const spec = withDisplayBridge({
        command: resume.cmd,
        args: resume.args,
        cwd: meta.workspacePath,
      }, meta);
      traceExecution(
        `[agent-session-trace] WorktreeExecutor.getRestoredTerminalSpec: task="${meta.taskId}" resume with agentSessionId=${meta.agentSessionId}`,
      );
      traceExecution(`[WorktreeExecutor] getRestoredTerminalSpec task="${meta.taskId}" → agent --resume spec, cwd="${spec.cwd}"`);
      return spec;
    }
    if (meta.branch) {
      // workspacePath is already a worktree — just checkout the branch there.
      const sh = process.platform === 'darwin' ? 'zsh' : 'bash';
      const spec = withDisplayBridge({
        command: sh,
        args: ['-c', `git checkout '${meta.branch}' 2>/dev/null; exec ${sh}`],
        cwd: meta.workspacePath,
      }, meta);
      traceExecution(`[WorktreeExecutor] getRestoredTerminalSpec task="${meta.taskId}" → checkout branch spec, branch="${meta.branch}" cwd="${spec.cwd}"`);
      return spec;
    }
    traceExecution(`[WorktreeExecutor] getRestoredTerminalSpec task="${meta.taskId}" → cwd-only spec, cwd="${meta.workspacePath}"`);
    return withDisplayBridge({ cwd: meta.workspacePath }, meta);
  }

  /**
   * Look up a worktree path by branch name.
   * Searches the worktreeBaseDir for a directory matching the sanitized branch name.
   * Returns the worktree directory if found, undefined otherwise.
   */
  private findWorktreeByBranch(branch: string): string | undefined {
    try {
      // The pool creates worktrees at {worktreeBaseDir}/{urlHash}/{sanitizedBranch}
      const sanitized = sanitizeBranchForPath(branch);
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      for (const sub of readdirSync(this.worktreeBaseDir, { withFileTypes: true })) {
        if (sub.isDirectory()) {
          const candidate = join(this.worktreeBaseDir, sub.name, sanitized);
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch (err) {
      console.warn(`[WorktreeExecutor] findWorktreeByBranch failed: ${err}`);
    }
    return undefined;
  }

  async destroyAll(): Promise<void> {
    const allEntries = Array.from(this.entries.entries());
    const closePromises: Promise<void>[] = [];

    for (const [_executionId, entry] of allEntries) {
      if (!entry.completed && entry.process) {
        closePromises.push(
          new Promise<void>((resolve) => {
            entry.process!.on('close', () => resolve());

            killProcessGroup(entry.process!, 'SIGTERM');

            setTimeout(() => {
              if (!entry.completed && entry.process) {
                killProcessGroup(entry.process, 'SIGKILL');
              }
            }, SIGKILL_TIMEOUT_MS);
          }),
        );
      }
    }

    await Promise.all(closePromises);

    // Soft-release only: free pool slots without git worktree remove (same as task end / kill).
    // Hard removal stays in RepoPool.release and explicit cleanup flows.
    for (const [_executionId, entry] of allEntries) {
      this.softReleasePoolSlot(entry);
    }

    this.entries.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private cleanStaleLocks(dir: string): void {
    const gitDir = join(dir, '.git');
    const lockFiles = ['index.lock', 'shallow.lock', 'HEAD.lock'];
    for (const lockFile of lockFiles) {
      const lockPath = join(gitDir, lockFile);
      if (existsSync(lockPath)) {
        console.warn(`[WorktreeExecutor] Removing stale git lock: ${lockPath}`);
        try { unlinkSync(lockPath); } catch { /* race: already removed */ }
      }
    }
  }

  private provisionWorktree(dir: string, _executionId?: string): { child: ChildProcess | null; completion: Promise<void> } {
    traceExecution(`[WorktreeExecutor] provisionWorktree skipped dir=${dir}`);
    return { child: null, completion: Promise.resolve() };
  }
}

function withDisplayBridge<T extends TerminalSpec>(
  spec: T,
  source: { displayBridge?: string },
): T {
  return source.displayBridge === undefined
    ? spec
    : { ...spec, displayBridge: source.displayBridge };
}
