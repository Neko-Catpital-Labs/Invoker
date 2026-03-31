/**
 * TaskExecutor — Shared task execution logic for CLI and Electron.
 *
 * Extracted from CLI Runner to eliminate duplication between
 * the CLI runner and Electron app execution paths.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import type { Orchestrator, TaskState, ExperimentVariant } from '@invoker/core';
import type { SQLiteAdapter } from '@invoker/persistence';
import type { WorkRequest, WorkResponse, ActionType } from '@invoker/protocol';
import type { Familiar, FamiliarHandle } from './familiar.js';
import { RESTART_TO_BRANCH_TRACE } from './exec-trace.js';
import type { FamiliarRegistry } from './registry.js';
import type { MergeGateProvider } from './merge-gate-provider.js';
import type { ReviewProviderRegistry } from './review-provider-registry.js';
import { DockerFamiliar } from './docker-familiar.js';
import { WorktreeFamiliar } from './worktree-familiar.js';
import { isInvokerManagedPoolBranch } from './plan-base-remote.js';
import { SshFamiliar } from './ssh-familiar.js';
import {
  executeMergeNodeImpl,
  approveMergeImpl,
  publishAfterFixImpl,
  buildMergeSummaryImpl,
  consolidateAndMergeImpl,
  ensureLocalBranchForMerge,
} from './merge-executor.js';
import { normalizeBranchForGithubCli } from './github-branch-ref.js';
import {
  resolveConflictWithClaudeImpl,
  fixWithClaudeImpl,
  spawnClaudeFixImpl,
} from './conflict-resolver.js';

/** Keeps `lastHeartbeatAt` fresh while `familiar.start()` is awaited (SSH remote setup/provision can take minutes). Matches BaseFamiliar default heartbeat cadence. */
const PRE_START_HEARTBEAT_INTERVAL_MS = 30_000;

// ── Callbacks ─────────────────────────────────────────────

export interface TaskExecutorCallbacks {
  onOutput?: (taskId: string, data: string) => void;
  onSpawned?: (taskId: string, handle: FamiliarHandle, familiar: Familiar) => void;
  onComplete?: (taskId: string, response: WorkResponse) => void;
  onHeartbeat?: (taskId: string) => void;
}

// ── Config ────────────────────────────────────────────────

export interface TaskExecutorConfig {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  familiarRegistry: FamiliarRegistry;
  /** Repo root / working directory for git commands and task execution. */
  cwd: string;
  /** Max worktrees per repo for WorktreeFamiliar. Default: 3. */
  maxWorktreesPerRepo?: number;
  /** Default branch from config (e.g. "master"). Falls back to git heuristic if unset. */
  defaultBranch?: string;
  callbacks?: TaskExecutorCallbacks;
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
  }>;
  /** Docker execution environment configuration from .invoker.json. */
  dockerConfig?: {
    imageName?: string;
    repoInImage?: boolean;
  };
}

// ── TaskExecutor ──────────────────────────────────────────

export class TaskExecutor {
  /** @internal */ orchestrator: Orchestrator;
  /** @internal */ persistence: SQLiteAdapter;
  private familiarRegistry: FamiliarRegistry;
  /** @internal */ cwd: string;
  private maxWorktreesPerRepo: number;
  /** @internal */ defaultBranch: string | undefined;
  /** @internal */ callbacks: TaskExecutorCallbacks;
  /** @internal */ mergeGateProvider?: MergeGateProvider;
  /** @internal */ reviewProviderRegistry?: ReviewProviderRegistry;
  private activePrPollers = new Map<string, ReturnType<typeof setInterval>>();
  private getRemoteTargets: () => Record<string, { host: string; user: string; sshKeyPath: string; port?: number }>;
  private dockerConfig: { imageName?: string; repoInImage?: boolean };

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
    const familiar = this.familiarRegistry.get('worktree');
    if (!(familiar instanceof WorktreeFamiliar)) return;
    const pool = familiar.getRepoPool();
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
    const familiar = this.familiarRegistry.get('worktree');
    if (!(familiar instanceof WorktreeFamiliar)) return undefined;
    try {
      return await familiar.getRepoPool().ensureClone(trimmed);
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

  constructor(config: TaskExecutorConfig) {
    this.orchestrator = config.orchestrator;
    this.persistence = config.persistence;
    this.familiarRegistry = config.familiarRegistry;
    this.cwd = config.cwd;
    this.maxWorktreesPerRepo = config.maxWorktreesPerRepo ?? 5;
    this.defaultBranch = config.defaultBranch;
    this.callbacks = config.callbacks ?? {};
    this.mergeGateProvider = config.mergeGateProvider;
    this.reviewProviderRegistry = config.reviewProviderRegistry;
    this.getRemoteTargets = config.remoteTargetsProvider ?? (() => ({}));
    this.dockerConfig = config.dockerConfig ?? {};
  }

  /**
   * Execute multiple tasks concurrently.
   */
  async executeTasks(tasks: TaskState[]): Promise<void> {
    if (tasks.length > 0) {
      console.log(
        `${RESTART_TO_BRANCH_TRACE} TaskExecutor.executeTasks count=${tasks.length} ids=${tasks.map((t) => t.id).join(', ')}`,
      );
    }
    await Promise.all(tasks.map((task) => this.executeTask(task)));
  }

  /**
   * Execute a single task through the familiar pipeline.
   *
   * 1. Pivot tasks with variants → synthesize spawn_experiments response
   * 2. Build upstream context from completed dependencies
   * 3. Build WorkRequest with workspacePath
   * 4. Start familiar → persist agentSessionId + workspacePath immediately
   * 5. Wire output/completion callbacks
   * 6. On completion → feed response to orchestrator → auto-execute newly ready tasks
   */
  async executeTask(task: TaskState): Promise<void> {
    console.log(
      `${RESTART_TO_BRANCH_TRACE} TaskExecutor.executeTask BEGIN taskId=${task.id} isMergeNode=${Boolean(task.config.isMergeNode)} status=${task.status}`,
    );
    try {
      await this.executeTaskInner(task);
    } catch (err) {
      console.error(`[TaskExecutor] executeTask failed for task=${task.id}:`, err);
      const response: WorkResponse = {
        requestId: `err-${task.id}`,
        actionId: task.id,
        status: 'failed',
        outputs: {
          exitCode: 1,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        },
      };
      this.callbacks.onComplete?.(task.id, response);
      this.orchestrator.handleWorkerResponse(response);
    }
  }

  private async executeTaskInner(task: TaskState): Promise<void> {
    // Pivot tasks with experimentVariants: synthesize a spawn_experiments
    // response instead of running through the familiar.
    if (task.config.pivot && task.config.experimentVariants && task.config.experimentVariants.length > 0) {
      const response: WorkResponse = {
        requestId: `req-${task.id}`,
        actionId: task.id,
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

    console.log(
      `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} (past pivot check) → gather upstreams + build WorkRequest`,
    );

    // Gather upstream context from completed dependencies
    const upstreamContext = await this.buildUpstreamContext(task);
    const upstreamBranches = this.collectUpstreamBranches(task);
    const alternatives = this.buildAlternatives(task);

    // Guard: every completed dependency must have branch metadata.
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
    }

    // Read workflow generation for content-addressable branch salt
    const workflow = task.config.workflowId ? this.persistence.loadWorkflow?.(task.config.workflowId) : undefined;
    const generation = (workflow as any)?.generation ?? 0;
    const baseBranch = workflow?.baseBranch ?? this.defaultBranch;

    const repoUrl = workflow?.repoUrl;

    const request: WorkRequest = {
      requestId: randomUUID(),
      actionId: task.id,
      actionType: this.determineActionType(task),
      inputs: {
        description: task.description,
        command: task.config.command,
        prompt: task.config.prompt,
        workspacePath: this.cwd,
        repoUrl,
        featureBranch: task.config.featureBranch,
        upstreamContext: upstreamContext.length > 0 ? upstreamContext : undefined,
        alternatives: alternatives.length > 0 ? alternatives : undefined,
        upstreamBranches: upstreamBranches.length > 0 ? upstreamBranches : undefined,
        salt: generation > 0 ? generation.toString() : undefined,
        baseBranch,
      },
      callbackUrl: '',
      timestamps: {
        createdAt: new Date().toISOString(),
      },
    };

    console.log(
      `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} WorkRequest built actionType=${request.actionType} repoUrl=${request.inputs.repoUrl ?? '(none)'} upstreamBranches=${JSON.stringify(request.inputs.upstreamBranches ?? [])}`,
    );

    const familiar = this.selectFamiliar(task);
    console.log(
      `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} selectFamiliar → type=${familiar.type} calling familiar.start()`,
    );
    console.log(`[trace] TaskExecutor: task=${task.id} calling familiar.start() type=${familiar.type}`);
    const startT0 = Date.now();
    const preStartHeartbeatTimer = setInterval(() => {
      this.callbacks.onHeartbeat?.(task.id);
    }, PRE_START_HEARTBEAT_INTERVAL_MS);
    let handle: FamiliarHandle;
    try {
      handle = await familiar.start(request);
    } catch (err) {
      throw new Error(
        `Familiar startup failed (${familiar.type}): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      clearInterval(preStartHeartbeatTimer);
    }
    console.log(`[trace] TaskExecutor: task=${task.id} familiar.start() returned after ${Date.now() - startT0}ms familiar=${familiar.type} sessionId=${handle.agentSessionId ?? 'none'} workspace=${handle.workspacePath ?? 'default'}`);

    // Persist execution metadata immediately at task start — all fields explicit
    {
      const changes = {
        config: { familiarType: familiar.type },
        execution: {
          workspacePath: handle.workspacePath ?? this.cwd,
          agentSessionId: handle.agentSessionId ?? undefined,
          containerId: handle.containerId ?? undefined,
          branch: handle.branch ?? undefined,
        },
      };
      this.persistence.updateTask(task.id, changes);
      console.log(
        `[agent-session-trace] TaskExecutor.persistStartMetadata task=${task.id} agentSessionId=${handle.agentSessionId ?? 'null'}`,
      );
      if (task.config.isMergeNode) {
        console.log(
          `[merge-gate-workspace] persistStartMetadata mergeNode=${task.id} ` +
            `familiar workspacePath=${changes.execution.workspacePath ?? 'NULL'} ` +
            '(gate clone path is written later in executeMergeNode)',
        );
      }
      console.log(`[trace] TaskExecutor: persisted metadata for task=${task.id}`);
    }

    // Notify consumer about the spawned handle
    this.callbacks.onSpawned?.(task.id, handle, familiar);

    // Wire output
    familiar.onOutput(handle, (data) => {
      this.callbacks.onOutput?.(task.id, data);
    });

    // Wire heartbeat
    familiar.onHeartbeat(handle, () => {
      this.callbacks.onHeartbeat?.(task.id);
    });

    // Wait for completion and feed response to orchestrator
    return new Promise<void>((resolvePromise) => {
      familiar.onComplete(handle, async (response: WorkResponse) => {
        try {
          console.log(
            `${RESTART_TO_BRANCH_TRACE} resolvePromise | task.config.isMergeNode = ${task.config.isMergeNode}`,
          );
          // Merge nodes: run consolidation/finish logic after familiar completes
          if (task.config.isMergeNode) {
            console.log(
              `${RESTART_TO_BRANCH_TRACE} familiar.onComplete taskId=${task.id} isMergeNode → executeMergeNode (consolidate / gate)`,
            );
            await this.executeMergeNode(task);
            resolvePromise();
            return;
          }

          this.callbacks.onComplete?.(task.id, response);

          const newlyStarted = this.orchestrator.handleWorkerResponse(response) ?? [];

          if (newlyStarted.length > 0) {
            this.executeTasks(newlyStarted);
          }
        } catch (err) {
          console.error(`[TaskExecutor] onComplete handler failed for task=${task.id}:`, err);
          const errResponse: WorkResponse = {
            requestId: response.requestId,
            actionId: task.id,
            status: 'failed',
            outputs: {
              exitCode: 1,
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
            },
          };
          this.callbacks.onComplete?.(task.id, errResponse);
          this.orchestrator.handleWorkerResponse(errResponse);
        }

        resolvePromise();
      });
    });
  }

  /**
   * Select the familiar to use for a given task.
   * Uses task.familiarType to look up in the registry; falls back to default.
   * Merge gate tasks use the default (worktree) familiar when selected explicitly.
   */
  selectFamiliar(task: TaskState): Familiar {
    const effectiveType = task.config.familiarType;

    if (effectiveType) {
      const registered = this.familiarRegistry.get(effectiveType);
      if (registered) {
        console.log(`[trace] TaskExecutor.selectFamiliar: task=${task.id} effectiveType=${effectiveType} → ${registered.type}`);
        return registered;
      }

      // Per-task Docker instance (each task gets its own container + execGitSimple routing)
      if (effectiveType === 'docker') {
        const docker = new DockerFamiliar({
          workspaceDir: this.cwd,
          imageName: task.config.dockerImage ?? this.dockerConfig.imageName,
          repoInImage: this.dockerConfig.repoInImage,
        });
        this.familiarRegistry.register(`docker:${task.id}`, docker);
        console.log(`[trace] TaskExecutor.selectFamiliar: task=${task.id} effectiveType=docker → docker (per-task)`);
        return docker;
      }

      // Lazy registration for Worktree
      if (effectiveType === 'worktree') {
        const invokerHome = resolve(homedir(), '.invoker');
        const worktree = new WorktreeFamiliar({
          worktreeBaseDir: resolve(invokerHome, 'worktrees'),
          cacheDir: resolve(invokerHome, 'repos'),
          maxWorktrees: this.maxWorktreesPerRepo,
        });
        this.familiarRegistry.register('worktree', worktree);
        console.log(`[trace] TaskExecutor.selectFamiliar: task=${task.id} effectiveType=worktree → worktree (lazy registered)`);
        return worktree;
      }

      // Lazy registration for SSH — resolve remoteTargetId from config
      if (effectiveType === 'ssh') {
        const targetId = task.config.remoteTargetId;
        if (!targetId) {
          throw new Error(`Task ${task.id} has familiarType=ssh but no remoteTargetId`);
        }
        const remoteTargets = this.getRemoteTargets();
        const target = remoteTargets[targetId];
        if (!target) {
          throw new Error(
            `Task ${task.id} references remoteTargetId="${targetId}" but no matching ` +
            `entry exists in remoteTargets config. Available: [${Object.keys(remoteTargets).join(', ')}]`,
          );
        }
        const ssh = new SshFamiliar({
          host: target.host,
          user: target.user,
          sshKeyPath: target.sshKeyPath,
          port: target.port,
        });
        console.log(`[trace] TaskExecutor.selectFamiliar: task=${task.id} effectiveType=ssh remoteTarget=${targetId} → ssh (per-task)`);
        return ssh;
      }
    }

    if (task.config.isMergeNode) {
      const mergeGateFamiliar = this.familiarRegistry.getDefault();
      console.log(`[trace] TaskExecutor.selectFamiliar: task=${task.id} isMergeNode=true → ${mergeGateFamiliar.type} (merge gate)`);
      return mergeGateFamiliar;
    }

    const defaultFamiliar = this.familiarRegistry.getDefault();
    console.log(`[trace] TaskExecutor.selectFamiliar: task=${task.id} effectiveType=${effectiveType ?? 'none'} → ${defaultFamiliar.type} (default)`);
    return defaultFamiliar;
  }

  /**
   * Determine the correct ActionType for a task based on its fields.
   * Priority: isReconciliation > command > prompt > default 'command'.
   */
  determineActionType(task: TaskState): ActionType {
    if (task.config.isReconciliation) return 'reconciliation';
    if (task.config.command) return 'command';
    if (task.config.prompt) return 'claude';
    return 'command';
  }

  // ── Merge Node Execution ─────────────────────────────────

  private async executeMergeNode(task: TaskState): Promise<void> {
    console.log(`${RESTART_TO_BRANCH_TRACE} TaskExecutor.executeMergeNode taskId=${task.id} → merge-executor.executeMergeNodeImpl`);
    return executeMergeNodeImpl(this, task);
  }

  async approveMerge(workflowId: string): Promise<void> {
    return approveMergeImpl(this, workflowId);
  }

  async publishAfterFix(task: TaskState): Promise<void> {
    return publishAfterFixImpl(this, task);
  }

  async buildMergeSummary(workflowId: string): Promise<string> {
    return buildMergeSummaryImpl(this, workflowId);
  }

  async runVisualProofCapture(baseBranch: string, featureBranch: string, slug: string): Promise<string | undefined> {
    try {
      const scriptPath = resolve(this.cwd, 'scripts/ui-visual-proof.sh');
      const outputDir = resolve(this.cwd, 'packages/app/e2e/visual-proof');

      const wtDir = await this.createMergeWorktree(baseBranch, 'vp-' + slug);

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
        const featureSha = (await this.execGitReadonly(['rev-parse', featureBranch])).trim();
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

  /** @internal */ async createMergeWorktree(ref: string, label: string): Promise<string> {
    const clonePath = resolve(homedir(), '.invoker', 'merge-clones', `${label}-${Date.now()}`);
    mkdirSync(resolve(homedir(), '.invoker', 'merge-clones'), { recursive: true });
    // Resolve ref to SHA in the host repo — branch names may not resolve in the
    // --no-checkout clone (git interprets them as paths and rejects --detach).
    const refSha = (await this.execGitReadonly(['rev-parse', ref])).trim();
    // Clone with hard-linked objects from host repo — near-instant, fully isolated refs
    await this.execGitReadonly(['clone', '--local', '--no-checkout', this.cwd, clonePath]);
    // Detach HEAD so the fetch can overwrite all branch refs (including the default branch)
    const headSha = (await this.execGitIn(['rev-parse', 'HEAD'], clonePath)).trim();
    await this.execGitIn(['update-ref', '--no-deref', 'HEAD', headSha], clonePath);
    // Mirror all host branches as local refs so bare branch names resolve.
    // At this point origin still points to host.cwd, so this is a fast local fetch.
    await this.execGitIn(['fetch', 'origin', '+refs/heads/*:refs/heads/*'], clonePath);
    // Reconfigure origin to the real GitHub remote so subsequent push/fetch
    // operations go directly to GitHub, bypassing the user's working directory.
    const realOrigin = (await this.execGitReadonly(['remote', 'get-url', 'origin'])).trim();
    await this.execGitIn(['remote', 'set-url', 'origin', realOrigin], clonePath);
    await this.execGitIn(['checkout', '--detach', refSha], clonePath);
    return clonePath;
  }

  /** @internal */ async removeMergeWorktree(dir: string): Promise<void> {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[TaskExecutor] removeMergeWorktree failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
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

    const worktreeDir = await this.createMergeWorktree(baseBranch, 'recon-' + reconTaskId);
    const reconWorkflowId = reconTask?.config.workflowId;
    const reconRepoUrl =
      reconWorkflowId !== undefined && reconWorkflowId !== ''
        ? this.persistence.loadWorkflow(reconWorkflowId)?.repoUrl
        : undefined;

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
   * Resolve a merge conflict by re-creating the merge state and spawning Claude to fix it.
   * After resolution, the task is restarted so it can proceed normally.
   */
  async resolveConflictWithClaude(taskId: string): Promise<void> {
    return resolveConflictWithClaudeImpl(this, taskId);
  }

  /**
   * Fix a failed command task by spawning Claude with the error output.
   * Claude's output is captured and appended to the task's output stream for auditing.
   */
  async fixWithClaude(taskId: string, taskOutput: string): Promise<void> {
    return fixWithClaudeImpl(this, taskId, taskOutput);
  }

  resumeMergeGatePolling(): void {
    if (!this.mergeGateProvider) return;
    for (const task of this.orchestrator.getAllTasks()) {
      if (
        task.config.isMergeNode &&
        task.status === 'awaiting_approval' &&
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
        task.status === 'awaiting_approval' &&
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
          // Leave in awaiting_approval — user can retry
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

  spawnAgentFix(prompt: string, cwd: string): Promise<{ stdout: string; sessionId: string }> {
    return spawnClaudeFixImpl(prompt, cwd);
  }

  getRemoteTargetConfig(targetId: string): { host: string; user: string; sshKeyPath: string; port?: number } | undefined {
    return this.getRemoteTargets()[targetId];
  }

  // ── Private Helpers ──────────────────────────────────────

  /**
   * Branch names from completed direct dependencies, for every executor that merges
   * upstream work (`setupTaskBranch`, WorktreeFamiliar merge loop, SshFamiliar remote merges).
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

    for (const depId of task.dependencies) {
      const dep = this.orchestrator.getTask(depId);
      if (dep && dep.status === 'completed') {
        let commitMessage: string | undefined;
        if (dep.execution.commit) {
          try {
            commitMessage = await this.gitLogMessage(dep.execution.commit);
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
      }
    }

    return context;
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

    const worktreeDir = await this.createMergeWorktree(baseBranch, 'rebase-' + workflowId);

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

  /** @internal */ gitLogMessage(commitHash: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('git', ['log', '-1', '--format=%B', commitHash], {
        cwd: this.cwd,
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

  /** @internal */ gitDiffStat(branch: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const baseBranch = this.defaultBranch ?? 'master';
      const child = spawn('git', ['diff', '--stat', `${baseBranch}...${branch}`], {
        cwd: this.cwd,
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
