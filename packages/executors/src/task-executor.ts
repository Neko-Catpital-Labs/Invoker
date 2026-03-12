/**
 * TaskExecutor — Shared task execution logic for CLI and Electron.
 *
 * Extracted from CLI Runner to eliminate duplication between
 * the CLI runner and Electron app execution paths.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { Orchestrator, TaskState, ExperimentVariant } from '@invoker/core';
import type { SQLiteAdapter } from '@invoker/persistence';
import type { WorkRequest, WorkResponse, ActionType } from '@invoker/protocol';
import type { Familiar, FamiliarHandle } from './familiar.js';
import type { FamiliarRegistry } from './registry.js';
import { DockerFamiliar } from './docker-familiar.js';
import { WorktreeFamiliar } from './worktree-familiar.js';

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
}

// ── TaskExecutor ──────────────────────────────────────────

export class TaskExecutor {
  private orchestrator: Orchestrator;
  private persistence: SQLiteAdapter;
  private familiarRegistry: FamiliarRegistry;
  private cwd: string;
  private maxWorktreesPerRepo: number;
  private defaultBranch: string | undefined;
  private callbacks: TaskExecutorCallbacks;
  private abiChecked = false;

  constructor(config: TaskExecutorConfig) {
    this.orchestrator = config.orchestrator;
    this.persistence = config.persistence;
    this.familiarRegistry = config.familiarRegistry;
    this.cwd = config.cwd;
    this.maxWorktreesPerRepo = config.maxWorktreesPerRepo ?? 5;
    this.defaultBranch = config.defaultBranch;
    this.callbacks = config.callbacks ?? {};
  }

  /**
   * Execute multiple tasks concurrently.
   */
  async executeTasks(tasks: TaskState[]): Promise<void> {
    if (!this.abiChecked) {
      this.abiChecked = true;
      this.checkNativeModuleAbi();
    }
    await Promise.all(tasks.map((task) => this.executeTask(task)));
  }

  /**
   * One-time check: warn if better-sqlite3 was compiled for a different ABI
   * than the system Node that task subprocesses will use.
   */
  private checkNativeModuleAbi(): void {
    try {
      const req = createRequire(resolve(this.cwd, 'packages', 'persistence', 'dummy.js'));
      const pkgPath = req.resolve('better-sqlite3/package.json');
      const binaryPath = resolve(dirname(pkgPath), 'build', 'Release', 'better_sqlite3.node');
      if (!existsSync(binaryPath)) return;

      const nm = execSync(`nm -D "${binaryPath}" 2>/dev/null || true`, { encoding: 'utf8' });
      const match = nm.match(/node_register_module_v(\d+)/);
      if (!match) return;

      const binaryAbi = parseInt(match[1], 10);
      const runtimeAbi = parseInt(process.versions.modules, 10);
      if (binaryAbi === runtimeAbi) return;

      console.warn(
        `[TaskExecutor] better-sqlite3 ABI mismatch: binary=${binaryAbi}, ` +
        `runtime=${runtimeAbi}. Task commands that use 'npx vitest run' will crash. ` +
        `Use 'pnpm test' (electron-vitest) in plan tasks instead.`,
      );
    } catch {
      // Non-fatal — skip check if anything goes wrong
    }
  }

  /**
   * Execute a single task through the familiar pipeline.
   *
   * 1. Pivot tasks with variants → synthesize spawn_experiments response
   * 2. Build upstream context from completed dependencies
   * 3. Build WorkRequest with workspacePath
   * 4. Start familiar → persist claudeSessionId + workspacePath immediately
   * 5. Wire output/completion callbacks
   * 6. On completion → feed response to orchestrator → auto-execute newly ready tasks
   */
  async executeTask(task: TaskState): Promise<void> {
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
          error: `executeTask error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
      this.callbacks.onComplete?.(task.id, response);
      this.orchestrator.handleWorkerResponse(response);
    }
  }

  private async executeTaskInner(task: TaskState): Promise<void> {
    // Merge nodes: execute git consolidation/merge or auto-complete
    if (task.isMergeNode) {
      await this.executeMergeNode(task);
      return;
    }

    // Pivot tasks with experimentVariants: synthesize a spawn_experiments
    // response instead of running through the familiar.
    if (task.pivot && task.experimentVariants && task.experimentVariants.length > 0) {
      const response: WorkResponse = {
        requestId: `req-${task.id}`,
        actionId: task.id,
        status: 'spawn_experiments',
        outputs: {},
        dagMutation: {
          spawnExperiments: {
            description: task.description,
            variants: task.experimentVariants.map((v: ExperimentVariant) => ({
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

    // Gather upstream context from completed dependencies
    const upstreamContext = await this.buildUpstreamContext(task);
    const upstreamBranches = this.collectUpstreamBranches(task);

    // Read workflow generation for content-addressable branch salt
    const workflow = task.workflowId ? this.persistence.loadWorkflow?.(task.workflowId) : undefined;
    const generation = (workflow as any)?.generation ?? 0;

    const request: WorkRequest = {
      requestId: randomUUID(),
      actionId: task.id,
      actionType: this.determineActionType(task),
      inputs: {
        description: task.description,
        command: task.command,
        prompt: task.prompt,
        workspacePath: this.cwd,
        repoUrl: task.repoUrl,
        featureBranch: task.featureBranch,
        upstreamContext: upstreamContext.length > 0 ? upstreamContext : undefined,
        upstreamBranches: upstreamBranches.length > 0 ? upstreamBranches : undefined,
        salt: generation > 0 ? generation.toString() : undefined,
      },
      callbackUrl: '',
      timestamps: {
        createdAt: new Date().toISOString(),
      },
    };

    const familiar = this.selectFamiliar(task);
    const handle = await familiar.start(request);
    console.log(`[trace] TaskExecutor: task=${task.id} familiar=${familiar.type} sessionId=${handle.claudeSessionId ?? 'none'} workspace=${handle.workspacePath ?? 'default'}`);

    // Persist execution metadata immediately at task start — all fields explicit
    {
      const changes: Record<string, unknown> = {
        familiarType: familiar.type,
        workspacePath: handle.workspacePath ?? this.cwd,
        claudeSessionId: handle.claudeSessionId ?? null,
        containerId: handle.containerId ?? null,
        branch: handle.branch ?? null,
      };
      this.persistence.updateTask(task.id, changes);
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
      familiar.onComplete(handle, (response: WorkResponse) => {
        this.callbacks.onComplete?.(task.id, response);

        const newlyStarted = this.orchestrator.handleWorkerResponse(response) ?? [];

        // Execute any newly started tasks returned by the orchestrator
        if (newlyStarted.length > 0) {
          this.executeTasks(newlyStarted);
        }

        resolvePromise();
      });
    });
  }

  /**
   * Select the familiar to use for a given task.
   * Uses task.familiarType to look up in the registry; falls back to default.
   * Merge gate tasks use local familiar for direct repo access.
   */
  selectFamiliar(task: TaskState): Familiar {
    // Infer 'worktree' when task has repoUrl but no explicit familiarType
    const effectiveType = task.familiarType
      ?? (task.repoUrl ? 'worktree' : undefined);

    if (effectiveType) {
      const registered = this.familiarRegistry.get(effectiveType);
      if (registered) {
        console.log(`[trace] TaskExecutor.selectFamiliar: task=${task.id} effectiveType=${effectiveType} → ${registered.type}`);
        return registered;
      }

      // Lazy registration for Docker
      if (effectiveType === 'docker') {
        const docker = new DockerFamiliar({ workspaceDir: this.cwd });
        this.familiarRegistry.register('docker', docker);
        console.log(`[trace] TaskExecutor.selectFamiliar: task=${task.id} effectiveType=docker → docker (lazy registered)`);
        return docker;
      }

      // Lazy registration for Worktree
      if (effectiveType === 'worktree') {
        const invokerHome = resolve(homedir(), '.invoker');
        const worktree = new WorktreeFamiliar({
          repoDir: this.cwd,
          worktreeBaseDir: resolve(invokerHome, 'worktrees'),
          cacheDir: resolve(invokerHome, 'repos'),
          maxWorktrees: this.maxWorktreesPerRepo,
        });
        this.familiarRegistry.register('worktree', worktree);
        console.log(`[trace] TaskExecutor.selectFamiliar: task=${task.id} effectiveType=worktree → worktree (lazy registered)`);
        return worktree;
      }
    }

    // Merge gate tasks need local familiar for direct repo access
    if (task.isMergeNode) {
      const mergeGateFamiliar = this.familiarRegistry.getMergeGateFamiliar();
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
    if (task.isReconciliation) return 'reconciliation';
    if (task.command) return 'command';
    if (task.prompt) return 'claude';
    return 'command';
  }

  // ── Merge Node Execution ─────────────────────────────────

  private async executeMergeNode(task: TaskState): Promise<void> {
    const workflowId = task.workflowId;
    const workflow = workflowId
      ? this.persistence.loadWorkflow(workflowId)
      : undefined;
    const onFinish = workflow?.onFinish ?? 'none';
    const mergeMode = workflow?.mergeMode ?? 'manual';
    const baseBranch = workflow?.baseBranch ?? this.defaultBranch ?? await this.detectDefaultBranch();
    const featureBranch = workflow?.featureBranch;

    let response: WorkResponse;

    if (onFinish !== 'none' && featureBranch) {
      const effectiveOnFinish = mergeMode === 'manual' ? 'none' : onFinish;
      try {
        await this.consolidateAndMerge(effectiveOnFinish, baseBranch, featureBranch, workflowId, workflow?.name);
        response = {
          requestId: `merge-${task.id}`,
          actionId: task.id,
          status: 'completed',
          outputs: { exitCode: 0 },
        };
      } catch (err) {
        response = {
          requestId: `merge-${task.id}`,
          actionId: task.id,
          status: 'failed',
          outputs: {
            exitCode: 1,
            error: `Merge failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    } else {
      response = {
        requestId: `merge-${task.id}`,
        actionId: task.id,
        status: 'completed',
        outputs: { exitCode: 0 },
      };
    }

    this.callbacks.onComplete?.(task.id, response);
    const newlyStarted = this.orchestrator.handleWorkerResponse(response) ?? [];
    if (newlyStarted.length > 0) {
      this.executeTasks(newlyStarted);
    }
  }

  async approveMerge(workflowId: string): Promise<void> {
    const workflow = this.persistence.loadWorkflow(workflowId);
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

    const onFinish = workflow.onFinish ?? 'none';
    const baseBranch = workflow.baseBranch ?? this.defaultBranch ?? await this.detectDefaultBranch();
    const featureBranch = workflow.featureBranch;

    if (onFinish === 'none' || !featureBranch) {
      throw new Error(`Workflow ${workflowId} has no merge configured (onFinish=${onFinish}, featureBranch=${featureBranch})`);
    }

    const originalBranch = await this.execGit(['branch', '--show-current']);
    try {
      const mergeMessage = workflow.name ?? 'Workflow';
      if (onFinish === 'merge') {
        await this.execGit(['checkout', baseBranch]);
        await this.execGit(['merge', '--no-ff', '-m', mergeMessage, featureBranch]);
        console.log(`[merge] Approved: merged ${featureBranch} into ${baseBranch} (no-ff)`);
      } else if (onFinish === 'pull_request') {
        await this.execGit(['push', '-u', 'origin', featureBranch]);
        await this.execPr(baseBranch, featureBranch, mergeMessage);
        console.log(`[merge] Approved: created pull request ${featureBranch} → ${baseBranch}`);
      }
    } catch (err) {
      try { await this.execGit(['merge', '--abort']); } catch { /* no merge in progress */ }
      try { await this.execGit(['checkout', originalBranch]); } catch { /* best effort */ }
      throw err;
    }
  }

  private async consolidateAndMerge(
    onFinish: string,
    baseBranch: string,
    featureBranch: string,
    workflowId?: string,
    workflowName?: string,
  ): Promise<void> {
    const originalBranch = await this.execGit(['branch', '--show-current']);

    try {
      // Consolidate all completed task branches into featureBranch
      try {
        await this.execGit(['checkout', '-b', featureBranch, baseBranch]);
        console.log(`[merge] Created ${featureBranch} from ${baseBranch}`);
      } catch {
        // Branch exists from a previous attempt — delete and recreate for a clean slate
        await this.execGit(['checkout', baseBranch]);
        await this.execGit(['branch', '-D', featureBranch]);
        await this.execGit(['checkout', '-b', featureBranch, baseBranch]);
        console.log(`[merge] Recreated ${featureBranch} from ${baseBranch}`);
      }

      const allTasks = this.orchestrator.getAllTasks();
      const taskBranches = allTasks
        .filter((t) => t.workflowId === workflowId && t.status === 'completed' && t.branch && !t.isMergeNode)
        .map((t) => t.branch!);

      for (const branch of taskBranches) {
        console.log(`[merge] Merging task branch: ${branch} → ${featureBranch}`);
        await this.execGit(['merge', '--no-ff', '-m', `Merge ${branch}`, branch]);
      }
      console.log(`[merge] Consolidated ${taskBranches.length} task branches into ${featureBranch}`);

      const mergeMessage = workflowName ?? 'Workflow';

      if (onFinish === 'merge') {
        await this.execGit(['checkout', baseBranch]);
        await this.execGit(['merge', '--no-ff', '-m', mergeMessage, featureBranch]);
        console.log(`[merge] Merged ${featureBranch} into ${baseBranch} (no-ff)`);
      } else if (onFinish === 'pull_request') {
        await this.execGit(['push', '-u', 'origin', featureBranch]);
        await this.execPr(baseBranch, featureBranch, workflowName ?? 'Workflow');
        console.log(`[merge] Created pull request: ${featureBranch} → ${baseBranch}`);
      }
    } catch (err) {
      try { await this.execGit(['merge', '--abort']); } catch { /* no merge in progress */ }
      try { await this.execGit(['checkout', originalBranch]); } catch { /* best effort */ }
      throw err;
    }
  }

  private execGit(args: string[]): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('git', args, {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else reject(new Error(
          `git ${args.join(' ')} failed (code ${code}): ${stderr.trim()}${stdout.trim() ? '\n' + stdout.trim() : ''}`
        ));
      });
    });
  }

  async detectDefaultBranch(): Promise<string> {
    try {
      const ref = await this.execGit(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      return ref.replace('refs/remotes/origin/', '');
    } catch {
      try {
        await this.execGit(['rev-parse', '--verify', 'main']);
        return 'main';
      } catch {
        return 'master';
      }
    }
  }

  private execPr(baseBranch: string, featureBranch: string, title: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('gh', [
        'pr', 'create', '--base', baseBranch,
        '--head', featureBranch, '--title', title, '--body', '',
      ], {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else reject(new Error(`gh pr create failed (code ${code}): ${stderr.trim()}`));
      });
    });
  }

  // ── Private Helpers ──────────────────────────────────────

  collectUpstreamBranches(task: TaskState): string[] {
    const branches: string[] = [];
    for (const depId of task.dependencies) {
      const dep = this.orchestrator.getTask(depId);
      if (dep && dep.status === 'completed' && dep.branch) {
        branches.push(dep.branch);
      }
    }
    return branches;
  }

  private async buildUpstreamContext(
    task: TaskState,
  ): Promise<Array<{taskId: string; description: string; summary?: string; commitHash?: string; commitMessage?: string}>> {
    const context: Array<{taskId: string; description: string; summary?: string; commitHash?: string; commitMessage?: string}> = [];

    for (const depId of task.dependencies) {
      const dep = this.orchestrator.getTask(depId);
      if (dep && dep.status === 'completed') {
        let commitMessage: string | undefined;
        if (dep.commit) {
          try {
            commitMessage = await this.gitLogMessage(dep.commit);
          } catch {
            // Not in a git repo or commit not found
          }
        }
        context.push({
          taskId: dep.id,
          description: dep.description,
          summary: dep.summary,
          commitHash: dep.commit,
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
    const originalBranch = await this.execGit(['branch', '--show-current']);
    const allTasks = this.orchestrator.getAllTasks();
    const taskBranches = allTasks
      .filter((t) => t.workflowId === workflowId && t.status === 'completed' && t.branch && !t.isMergeNode)
      .map((t) => t.branch!);

    const rebasedBranches: string[] = [];
    const errors: string[] = [];

    for (const branch of taskBranches) {
      try {
        await this.execGit(['checkout', branch]);
        await this.execGit(['rebase', baseBranch]);
        rebasedBranches.push(branch);
        console.log(`[rebase] Successfully rebased ${branch} onto ${baseBranch}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${branch}: ${msg}`);
        console.error(`[rebase] Failed to rebase ${branch}: ${msg}`);
        try { await this.execGit(['rebase', '--abort']); } catch { /* no rebase in progress */ }
      }
    }

    try { await this.execGit(['checkout', originalBranch]); } catch { /* best effort */ }

    return {
      success: errors.length === 0,
      rebasedBranches,
      errors,
    };
  }

  private gitLogMessage(commitHash: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('git', ['log', '-1', '--format=%B', commitHash], {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else reject(new Error(`git log failed (code ${code})`));
      });
    });
  }
}
