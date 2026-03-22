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
import type { MergeGateProvider } from './merge-gate-provider.js';
import { DockerFamiliar } from './docker-familiar.js';
import { WorktreeFamiliar } from './worktree-familiar.js';
import {
  executeMergeNodeImpl,
  approveMergeImpl,
  buildMergeSummaryImpl,
  consolidateAndMergeImpl,
} from './merge-executor.js';
import {
  resolveConflictWithClaudeImpl,
  fixWithClaudeImpl,
  spawnClaudeFixImpl,
} from './conflict-resolver.js';

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
  private abiChecked = false;
  /** @internal */ mergeGateProvider?: MergeGateProvider;
  private activePrPollers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(config: TaskExecutorConfig) {
    this.orchestrator = config.orchestrator;
    this.persistence = config.persistence;
    this.familiarRegistry = config.familiarRegistry;
    this.cwd = config.cwd;
    this.maxWorktreesPerRepo = config.maxWorktreesPerRepo ?? 5;
    this.defaultBranch = config.defaultBranch;
    this.callbacks = config.callbacks ?? {};
    this.mergeGateProvider = config.mergeGateProvider;
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
    if (task.config.isMergeNode) {
      await this.executeMergeNode(task);
      return;
    }

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

    // Gather upstream context from completed dependencies
    const upstreamContext = await this.buildUpstreamContext(task);
    const upstreamBranches = this.collectUpstreamBranches(task);
    const alternatives = this.buildAlternatives(task);

    // Read workflow generation for content-addressable branch salt
    const workflow = task.config.workflowId ? this.persistence.loadWorkflow?.(task.config.workflowId) : undefined;
    const generation = (workflow as any)?.generation ?? 0;
    const baseBranch = workflow?.baseBranch ?? this.defaultBranch;

    const request: WorkRequest = {
      requestId: randomUUID(),
      actionId: task.id,
      actionType: this.determineActionType(task),
      inputs: {
        description: task.description,
        command: task.config.command,
        prompt: task.config.prompt,
        workspacePath: this.cwd,
        repoUrl: task.config.repoUrl,
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

    const familiar = this.selectFamiliar(task);
    console.log(`[trace] TaskExecutor: task=${task.id} calling familiar.start() type=${familiar.type}`);
    const startT0 = Date.now();
    const handle = await familiar.start(request);
    console.log(`[trace] TaskExecutor: task=${task.id} familiar.start() returned after ${Date.now() - startT0}ms familiar=${familiar.type} sessionId=${handle.claudeSessionId ?? 'none'} workspace=${handle.workspacePath ?? 'default'}`);

    // Persist execution metadata immediately at task start — all fields explicit
    {
      const changes = {
        config: { familiarType: familiar.type },
        execution: {
          workspacePath: handle.workspacePath ?? this.cwd,
          claudeSessionId: handle.claudeSessionId ?? undefined,
          containerId: handle.containerId ?? undefined,
          branch: handle.branch ?? undefined,
        },
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
    const effectiveType = task.config.familiarType
      ?? (task.config.repoUrl ? 'worktree' : undefined);

    if (effectiveType) {
      const registered = this.familiarRegistry.get(effectiveType);
      if (registered) {
        console.log(`[trace] TaskExecutor.selectFamiliar: task=${task.id} effectiveType=${effectiveType} → ${registered.type}`);
        return registered;
      }

      // Lazy registration for Docker
      if (effectiveType === 'docker') {
        // Per-task dockerImage: create a one-off DockerFamiliar (not cached in registry)
        if (task.config.dockerImage) {
          const docker = new DockerFamiliar({ workspaceDir: this.cwd, imageName: task.config.dockerImage });
          console.log(`[trace] TaskExecutor.selectFamiliar: task=${task.id} effectiveType=docker dockerImage=${task.config.dockerImage} → docker (per-task image)`);
          return docker;
        }
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
    if (task.config.isMergeNode) {
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
    if (task.config.isReconciliation) return 'reconciliation';
    if (task.config.command) return 'command';
    if (task.config.prompt) return 'claude';
    return 'command';
  }

  // ── Merge Node Execution ─────────────────────────────────

  private async executeMergeNode(task: TaskState): Promise<void> {
    return executeMergeNodeImpl(this, task);
  }

  async approveMerge(workflowId: string): Promise<void> {
    return approveMergeImpl(this, workflowId);
  }

  async buildMergeSummary(workflowId: string): Promise<string> {
    return buildMergeSummaryImpl(this, workflowId);
  }

  /** @internal */ async consolidateAndMerge(
    onFinish: string,
    baseBranch: string,
    featureBranch: string,
    workflowId?: string,
    workflowName?: string,
    leafTaskIds?: readonly string[],
    body?: string,
  ): Promise<string | undefined> {
    return consolidateAndMergeImpl(this, onFinish, baseBranch, featureBranch, workflowId, workflowName, leafTaskIds, body);
  }

  /** @internal */ execGit(args: string[]): Promise<string> {
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

  /** @internal */ execGh(args: string[]): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('gh', args, {
        cwd: this.cwd,
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

  /** @internal */ async execPr(baseBranch: string, featureBranch: string, title: string, body?: string): Promise<string> {
    // Check for an existing open PR first
    const listOutput = await this.execGh([
      'pr', 'list', '--head', featureBranch, '--base', baseBranch,
      '--state', 'open', '--json', 'url,number', '--limit', '1',
    ]);

    const existing: Array<{ url: string; number: number }> = JSON.parse(listOutput || '[]');
    if (existing.length > 0) {
      const pr = existing[0];
      const editArgs = ['pr', 'edit', String(pr.number), '--title', title];
      if (body) editArgs.push('--body', body);
      await this.execGh(editArgs);
      return pr.url;
    }

    // No existing PR — create a new one
    return this.execGh([
      'pr', 'create', '--base', baseBranch,
      '--head', featureBranch, '--title', title, '--body', body ?? '',
    ]);
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

    const originalBranch = await this.execGit(['branch', '--show-current']);

    try {
      try {
        await this.execGit(['checkout', '-b', branchName, baseBranch]);
      } catch {
        await this.execGit(['checkout', baseBranch]);
        await this.execGit(['branch', '-D', branchName]);
        await this.execGit(['checkout', '-b', branchName, baseBranch]);
      }

      for (const expId of experimentIds) {
        const expTask = this.orchestrator.getTask(expId);
        if (!expTask?.execution.branch) {
          throw new Error(`Experiment ${expId} has no branch`);
        }
        const expMergeMsg = `Merge ${expTask.execution.branch} — ${expTask.description}`;
        await this.execGit(['merge', '--no-ff', '-m', expMergeMsg, expTask.execution.branch]);
      }

      const commit = await this.execGit(['rev-parse', 'HEAD']);
      return { branch: branchName, commit };
    } catch (err) {
      try { await this.execGit(['merge', '--abort']); } catch { /* no merge in progress */ }
      try { await this.execGit(['checkout', originalBranch]); } catch { /* best effort */ }
      throw err;
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
        task.execution.prIdentifier &&
        !this.activePrPollers.has(task.id)
      ) {
        console.log(`[merge-gate] Resuming PR polling for ${task.id} (PR ${task.execution.prIdentifier})`);
        this.startPrPolling(task.id, task.execution.prIdentifier, task.config.workflowId!);
      }
    }
  }

  async checkMergeGateStatuses(): Promise<void> {
    if (!this.mergeGateProvider) return;
    for (const task of this.orchestrator.getAllTasks()) {
      if (
        task.config.isMergeNode &&
        task.status === 'awaiting_approval' &&
        task.execution.prIdentifier
      ) {
        try {
          const status = await this.mergeGateProvider.checkApproval({
            identifier: task.execution.prIdentifier,
            cwd: this.cwd,
          });
          this.persistence.updateTask(task.id, {
            execution: { prStatus: status.statusText },
          });
          if (status.approved) {
            console.log(`[merge-gate] PR ${task.execution.prIdentifier} approved (refresh), completing merge gate`);
            this.stopPrPolling(task.id);
            await this.orchestrator.approve(task.id);
          } else if (status.rejected) {
            console.log(`[merge-gate] PR ${task.execution.prIdentifier} rejected (refresh): ${status.statusText}`);
            this.stopPrPolling(task.id);
          }
        } catch (err) {
          console.error(`[merge-gate] PR status check error for ${task.id}:`, err);
        }
      }
    }
  }

  /** @internal */ startPrPolling(taskId: string, prIdentifier: string, workflowId: string): void {
    const pollIntervalMs = 30_000;
    const interval = setInterval(async () => {
      try {
        if (!this.mergeGateProvider) return;
        const status = await this.mergeGateProvider.checkApproval({
          identifier: prIdentifier,
          cwd: this.cwd,
        });

        // Update PR status on task
        this.persistence.updateTask(taskId, {
          execution: { prStatus: status.statusText },
        });

        if (status.approved) {
          console.log(`[merge-gate] PR ${prIdentifier} approved, completing merge gate`);
          this.stopPrPolling(taskId);
          await this.orchestrator.approve(taskId);
        } else if (status.rejected) {
          console.log(`[merge-gate] PR ${prIdentifier} rejected: ${status.statusText}`);
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

  spawnClaudeFix(prompt: string, cwd: string): Promise<{ stdout: string; sessionId: string }> {
    return spawnClaudeFixImpl(prompt, cwd);
  }

  // ── Private Helpers ──────────────────────────────────────

  collectUpstreamBranches(task: TaskState): string[] {
    const branches: string[] = [];
    for (const depId of task.dependencies) {
      const dep = this.orchestrator.getTask(depId);
      if (dep && dep.status === 'completed' && dep.execution.branch) {
        branches.push(dep.execution.branch);
      }
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
    const originalBranch = await this.execGit(['branch', '--show-current']);
    const allTasks = this.orchestrator.getAllTasks();
    const taskBranches = allTasks
      .filter((t) => t.config.workflowId === workflowId && t.status === 'completed' && t.execution.branch && !t.config.isMergeNode)
      .map((t) => t.execution.branch!);

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

  /** @internal */ gitLogMessage(commitHash: string): Promise<string> {
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

  /** @internal */ gitDiffStat(branch: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const baseBranch = this.defaultBranch ?? 'master';
      const child = spawn('git', ['diff', '--stat', `${baseBranch}...${branch}`], {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else reject(new Error(`git diff --stat failed (code ${code})`));
      });
    });
  }
}
