/**
 * Merge node execution logic, extracted from TaskExecutor.
 *
 * Each function takes a MergeExecutorHost (a subset of TaskExecutor's
 * capabilities) as its first parameter, avoiding circular imports.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { homedir } from 'node:os';

import type { Orchestrator, TaskState } from '@invoker/core';
import type { SQLiteAdapter } from '@invoker/persistence';
import type { WorkResponse } from '@invoker/protocol';
import type { TaskExecutorCallbacks } from './task-executor.js';
import type { MergeGateProvider } from './merge-gate-provider.js';

// ── Trace logging ────────────────────────────────────────

export const MERGE_TRACE_LOG = resolve(homedir(), '.invoker', 'merge-trace.log');

export function mergeTrace(tag: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(resolve(homedir(), '.invoker'), { recursive: true });
    appendFileSync(MERGE_TRACE_LOG, `${new Date().toISOString()} [merge-trace:executor] ${tag} ${JSON.stringify(data)}\n`);
  } catch { /* best effort */ }
}

// ── Host-cwd safety guard ─────────────────────────────────

/**
 * Wrapper around host.execGitIn that throws if the target directory is the
 * user's main working directory (host.cwd). All merge-executor git operations
 * must target a managed merge clone, never the host repo.
 */
async function execGitInMergeSafe(
  host: MergeExecutorHost,
  args: string[],
  dir: string,
): Promise<string> {
  if (normalize(resolve(dir)) === normalize(resolve(host.cwd))) {
    throw new Error(
      `SAFETY: merge-executor must not run git in host repo (${host.cwd}). ` +
      `All merge git operations must use a managed merge clone. ` +
      `git args: [${args.join(', ')}]\n${new Error().stack}`,
    );
  }
  return host.execGitIn(args, dir);
}

// ── Host interface ───────────────────────────────────────

/**
 * Subset of TaskExecutor that merge functions need.
 * Defined here (not by importing TaskExecutor) to avoid circular deps.
 */
export interface MergeExecutorHost {
  readonly persistence: SQLiteAdapter;
  readonly orchestrator: Orchestrator;
  readonly defaultBranch: string | undefined;
  readonly callbacks: TaskExecutorCallbacks;
  readonly cwd: string;
  readonly mergeGateProvider?: MergeGateProvider;

  execGitReadonly(args: string[]): Promise<string>;
  execGitIn(args: string[], dir: string): Promise<string>;
  createMergeWorktree(ref: string, label: string): Promise<string>;
  removeMergeWorktree(dir: string): Promise<void>;
  execGh(args: string[], cwd?: string): Promise<string>;
  execPr(baseBranch: string, featureBranch: string, title: string, body?: string, cwd?: string): Promise<string>;
  detectDefaultBranch(): Promise<string>;
  gitLogMessage(commitHash: string): Promise<string>;
  gitDiffStat(branch: string): Promise<string>;
  startPrPolling(taskId: string, prIdentifier: string, workflowId: string): void;
  executeTasks(tasks: TaskState[]): Promise<void>;
  buildMergeSummary(workflowId: string): Promise<string>;
  runVisualProofCapture?(baseBranch: string, featureBranch: string, slug: string): Promise<string | undefined>;
  consolidateAndMerge(
    onFinish: string,
    baseBranch: string,
    featureBranch: string,
    workflowId?: string,
    workflowName?: string,
    leafTaskIds?: readonly string[],
    body?: string,
    visualProof?: boolean,
    mergeNodeTaskId?: string,
  ): Promise<string | undefined>;
}

/**
 * Ensure `branch` resolves in `worktreeDir` for `git merge`. Local worktree tasks
 * already have the ref; SSH (or other) tasks often push to origin from another host,
 * so fetch into refs/heads/{branch} when missing.
 */
export async function ensureLocalBranchForMerge(
  host: MergeExecutorHost,
  worktreeDir: string,
  branch: string,
): Promise<void> {
  let hadLocal = false;
  try {
    await execGitInMergeSafe(host, ['rev-parse', '--verify', branch], worktreeDir);
    hadLocal = true;
  } catch {
    /* ref missing — try origin */
  }

  if (hadLocal) return;

  try {
    await execGitInMergeSafe(
      host,
      ['fetch', 'origin', `+refs/heads/${branch}:refs/heads/${branch}`],
      worktreeDir,
    );
  } catch {
    try {
      await execGitInMergeSafe(
        host,
        ['fetch', 'origin', `+refs/remotes/origin/${branch}:refs/heads/${branch}`],
        worktreeDir,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot merge ${branch}: not found locally and fetch from origin failed (${msg}). ` +
          'For SSH remote worktrees, ensure the task pushed this branch to origin before merging.',
      );
    }
  }

}

/**
 * All non-merge tasks reachable by walking backwards from the merge gate's
 * direct dependencies. Used so consolidation merges every task branch that
 * fed the gate, not only leaf tips (a leaf may not contain an intermediate
 * sibling's commits if branch setup preserved stale state).
 */
export function collectTransitiveNonMergeTaskIds(
  mergeTask: TaskState,
  getTask: (id: string) => TaskState | undefined,
): Set<string> {
  const out = new Set<string>();
  const stack = [...mergeTask.dependencies];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    const t = getTask(id);
    if (!t || t.config.isMergeNode) continue;
    out.add(id);
    for (const d of t.dependencies) {
      if (!out.has(d)) stack.push(d);
    }
  }
  return out;
}

/** Leaf tasks in a workflow (same semantics as reconcileMergeLeaves / findLeafTaskIds). */
function findLeafTaskIdsInWorkflow(allTasks: TaskState[], workflowId: string): string[] {
  const wf = allTasks.filter(
    (t) => t.config.workflowId === workflowId && !t.config.isMergeNode && t.status !== 'stale',
  );
  const dependedOn = new Set<string>();
  for (const t of wf) {
    for (const d of t.dependencies) dependedOn.add(d);
  }
  return wf.filter((t) => !dependedOn.has(t.id)).map((t) => t.id);
}

// ── Extracted functions ──────────────────────────────────

export async function executeMergeNodeImpl(
  host: MergeExecutorHost,
  task: TaskState,
): Promise<void> {
  const workflowId = task.config.workflowId;
  const workflow = workflowId
    ? host.persistence.loadWorkflow(workflowId)
    : undefined;
  const onFinish = workflow?.onFinish ?? 'none';
  const mergeMode = workflow?.mergeMode ?? 'manual';
  const baseBranch = workflow?.baseBranch ?? host.defaultBranch ?? await host.detectDefaultBranch();
  const featureBranch = workflow?.featureBranch;
  const visualProof = workflow?.visualProof ?? false;

  let response: WorkResponse;
  let prUrl: string | undefined;

  const summary = workflowId ? await host.buildMergeSummary(workflowId) : undefined;

  host.persistence.updateTask(task.id, {
    execution: {
      prUrl: undefined,
      prIdentifier: undefined,
      prStatus: undefined,
    },
  });

  // Create a persistent gate worktree so workspacePath is never the main repo.
  // Use baseBranch as the ref because featureBranch may not exist yet
  // (it gets created inside consolidateAndMerge). Terminal restore does
  // `git checkout <branch>` to switch to featureBranch anyway.
  let gateWorkspacePath: string | undefined;
  if (featureBranch) {
    gateWorkspacePath = await host.createMergeWorktree(baseBranch, 'gate-' + task.id.replace(/[^a-zA-Z0-9_-]/g, '-'));
  }

  if (featureBranch && (onFinish !== 'none' || mergeMode === 'github')) {
    const effectiveOnFinish = mergeMode === 'automatic' ? onFinish : 'none';
    try {
      prUrl = await host.consolidateAndMerge(
        effectiveOnFinish,
        baseBranch,
        featureBranch,
        workflowId,
        workflow?.name,
        undefined,
        summary,
        visualProof,
        task.id,
      );
      if (mergeMode === 'manual') {
        const manualResponse: WorkResponse = {
          requestId: `merge-${task.id}`,
          actionId: task.id,
          status: 'completed',
          outputs: { exitCode: 0 },
        };
        host.callbacks.onComplete?.(task.id, manualResponse);
        host.orchestrator.setTaskAwaitingApproval(task.id, {
          config: { familiarType: 'worktree', summary },
          execution: { branch: featureBranch ?? undefined, workspacePath: gateWorkspacePath },
        });
        return;
      }
      if (mergeMode === 'github') {
        if (!host.mergeGateProvider) {
          throw new Error('mergeMode is "github" but no mergeGateProvider configured');
        }

        let fullSummary = summary;
        if (visualProof && host.runVisualProofCapture) {
          const slug = (featureBranch ?? 'workflow').replace(/\//g, '-');
          const vpMarkdown = await host.runVisualProofCapture(baseBranch, featureBranch!, slug);
          if (vpMarkdown) {
            fullSummary = (summary ?? '') + '\n\n' + vpMarkdown;
          }
        }

        // Create PR via provider (consolidation already done above).
        // Use the gate clone dir so gh CLI resolves the correct GitHub remote.
        const result = await host.mergeGateProvider.createReview({
          baseBranch,
          featureBranch,
          title: workflow?.name ?? 'Workflow',
          cwd: gateWorkspacePath!,
          body: fullSummary,
        });
        console.log(`[merge] Created GitHub PR: ${result.url}`);

        const prResponse: WorkResponse = {
          requestId: `merge-${task.id}`,
          actionId: task.id,
          status: 'completed',
          outputs: { exitCode: 0 },
        };
        host.callbacks.onComplete?.(task.id, prResponse);
        host.orchestrator.setTaskAwaitingApproval(task.id, {
          config: { familiarType: 'worktree', summary },
          execution: {
            branch: featureBranch,
            workspacePath: gateWorkspacePath,
            prUrl: result.url,
            prIdentifier: result.identifier,
            prStatus: 'Awaiting review',
          },
        });
        host.startPrPolling(task.id, result.identifier, workflowId!);
        return;
      }
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
    if (mergeMode === 'manual' || mergeMode === 'github') {
      const gateResponse: WorkResponse = {
        requestId: `merge-${task.id}`,
        actionId: task.id,
        status: 'completed',
        outputs: { exitCode: 0 },
      };
      host.callbacks.onComplete?.(task.id, gateResponse);
      host.orchestrator.setTaskAwaitingApproval(task.id, {
        config: { familiarType: 'worktree', summary },
        execution: { branch: featureBranch ?? undefined, workspacePath: gateWorkspacePath },
      });
      return;
    }
    response = {
      requestId: `merge-${task.id}`,
      actionId: task.id,
      status: 'completed',
      outputs: { exitCode: 0 },
    };
  }

  host.persistence.updateTask(task.id, {
    config: { familiarType: 'worktree', summary },
    execution: {
      branch: featureBranch ?? undefined,
      workspacePath: gateWorkspacePath,
      ...(prUrl ? { prUrl } : {}),
    },
  });
  host.callbacks.onComplete?.(task.id, response);
  if (mergeMode === 'manual' && response.status === 'completed') {
    host.orchestrator.setTaskAwaitingApproval(task.id, {
      config: { familiarType: 'worktree', summary },
      execution: {
        branch: featureBranch ?? undefined,
        workspacePath: gateWorkspacePath,
        ...(prUrl ? { prUrl } : {}),
      },
    });
  } else {
    const newlyStarted = host.orchestrator.handleWorkerResponse(response) ?? [];
    if (newlyStarted.length > 0) {
      host.executeTasks(newlyStarted);
    }
  }
}

export async function approveMergeImpl(
  host: MergeExecutorHost,
  workflowId: string,
): Promise<void> {
  mergeTrace('APPROVE_MERGE_ENTER', { workflowId });
  const workflow = host.persistence.loadWorkflow(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

  const onFinish = workflow.onFinish ?? 'none';
  const baseBranch = workflow.baseBranch ?? host.defaultBranch ?? await host.detectDefaultBranch();
  const featureBranch = workflow.featureBranch;
  mergeTrace('APPROVE_MERGE_CONFIG', { workflowId, onFinish, baseBranch, featureBranch, workflowName: workflow.name });

  if (onFinish === 'none' || !featureBranch) {
    mergeTrace('APPROVE_MERGE_SKIP', { workflowId, reason: 'no merge configured', onFinish, featureBranch });
    throw new Error(`Workflow ${workflowId} has no merge configured (onFinish=${onFinish}, featureBranch=${featureBranch})`);
  }

  const summary = await host.buildMergeSummary(workflowId);
  let fullSummary = summary;
  const visualProof = workflow.visualProof ?? false;
  if (visualProof && host.runVisualProofCapture) {
    const slug = (featureBranch ?? 'workflow').replace(/\//g, '-');
    const vpMarkdown = await host.runVisualProofCapture(baseBranch, featureBranch!, slug);
    if (vpMarkdown) {
      fullSummary = summary + '\n\n' + vpMarkdown;
    }
  }
  const mergeMessage = workflow.name ?? 'Workflow';

  // Clean up the persistent gate worktree created by executeMergeNodeImpl
  const mergeTaskId = `__merge__${workflowId}`;
  const gateWorktreePath = host.persistence.getWorkspacePath(mergeTaskId);

  if (onFinish === 'merge') {
    const worktreeDir = await host.createMergeWorktree(baseBranch, 'approve-' + workflowId);
    try {
      mergeTrace('GIT_MERGE_SQUASH', { featureBranch, worktreeDir });
      await ensureLocalBranchForMerge(host, worktreeDir, featureBranch);
      await execGitInMergeSafe(host, ['merge', '--squash', featureBranch], worktreeDir);
      mergeTrace('GIT_COMMIT', { mergeMessage });
      const commitBody = fullSummary ? `${mergeMessage}\n\n${fullSummary}` : mergeMessage;
      await execGitInMergeSafe(host, ['commit', '-m', commitBody], worktreeDir);
      // Push squash commit directly to origin (GitHub) from the clone
      await execGitInMergeSafe(host, ['push', '--force', 'origin', `HEAD:refs/heads/${baseBranch}`], worktreeDir);
      // Advance the baseBranch ref in the clone so subsequent operations see the updated base
      const newHead = (await execGitInMergeSafe(host, ['rev-parse', 'HEAD'], worktreeDir)).trim();
      await execGitInMergeSafe(host, ['update-ref', `refs/heads/${baseBranch}`, newHead], worktreeDir);
      mergeTrace('SQUASH_MERGE_COMPLETE', { featureBranch, baseBranch });
      console.log(`[merge] Approved: squash-merged ${featureBranch} into ${baseBranch}`);
    } catch (err) {
      mergeTrace('APPROVE_MERGE_ERROR', { workflowId, error: String(err) });
      try { await execGitInMergeSafe(host, ['merge', '--abort'], worktreeDir); } catch { /* no merge in progress */ }
      throw err;
    } finally {
      await host.removeMergeWorktree(worktreeDir);
      if (gateWorktreePath) {
        await host.removeMergeWorktree(gateWorktreePath);
      }
    }
  } else if (onFinish === 'pull_request') {
    const worktreeDir = await host.createMergeWorktree(featureBranch, 'approve-pr-' + workflowId);
    try {
      mergeTrace('GIT_PUSH', { featureBranch, worktreeDir });
      // Push feature branch directly to origin (GitHub) from the clone
      await execGitInMergeSafe(host, ['push', '--force', '-u', 'origin', featureBranch], worktreeDir);
      const prUrl = await host.execPr(baseBranch, featureBranch, mergeMessage, fullSummary, worktreeDir);
      mergeTrace('PR_CREATED', { featureBranch, baseBranch, prUrl });
      console.log(`[merge] Approved: created pull request ${prUrl}`);
      host.persistence.updateTask(mergeTaskId, {
        config: { summary },
        execution: { prUrl },
      });
    } finally {
      await host.removeMergeWorktree(worktreeDir);
      if (gateWorktreePath) {
        await host.removeMergeWorktree(gateWorktreePath);
      }
    }
  }
}

/**
 * Re-run consolidation + push + PR creation after a Claude fix was approved.
 * Called when orchestrator.approve() transitions a merge gate from
 * awaiting_approval (with pendingFixError) to running.
 *
 * Key insight: Claude fixed the code in the gate clone (on its HEAD, typically
 * the baseBranch). We must consolidate task branches starting from the gate
 * clone's HEAD (which has the fixes), NOT from the original baseBranch.
 * Using the normal consolidateAndMerge would destroy the fixes by recreating
 * the feature branch from the un-fixed baseBranch.
 *
 * On success: sets awaiting_approval (ready for second-step merge approval).
 * On failure: sets failed with the error.
 */
export async function publishAfterFixImpl(
  host: MergeExecutorHost,
  task: TaskState,
): Promise<void> {
  const workflowId = task.config.workflowId;
  const workflow = workflowId
    ? host.persistence.loadWorkflow(workflowId)
    : undefined;
  const onFinish = workflow?.onFinish ?? 'none';
  const mergeMode = workflow?.mergeMode ?? 'manual';
  const baseBranch = workflow?.baseBranch ?? host.defaultBranch ?? await host.detectDefaultBranch();
  const featureBranch = workflow?.featureBranch;
  const visualProof = workflow?.visualProof ?? false;

  mergeTrace('PUBLISH_AFTER_FIX_ENTER', {
    taskId: task.id, workflowId, onFinish, mergeMode, baseBranch, featureBranch,
  });

  const summary = workflowId ? await host.buildMergeSummary(workflowId) : undefined;
  const gateWorkspacePath = host.persistence.getWorkspacePath(task.id) ?? undefined;

  // #region agent log
  fetch('http://127.0.0.1:7658/ingest/762b7479-8057-4c6f-a805-85ee7d433bf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'16cf33'},body:JSON.stringify({sessionId:'16cf33',location:'merge-executor.ts:publishAfterFixImpl',message:'publishAfterFix config',data:{taskId:task.id,workflowId,onFinish,mergeMode,baseBranch,featureBranch,gateWorkspacePath},timestamp:Date.now(),runId:'post-fix-v3'})}).catch(()=>{});
  // #endregion

  try {
    if (!featureBranch) {
      host.orchestrator.setTaskAwaitingApproval(task.id, {
        config: { familiarType: 'worktree', summary },
        execution: { workspacePath: gateWorkspacePath },
      });
      return;
    }

    // Consolidate task branches in the gate clone, starting from the gate
    // clone's current HEAD (which has Claude's fixes).
    if (!gateWorkspacePath) {
      throw new Error('publishAfterFix requires a gate workspace (managed clone), not host.cwd');
    }
    const consolidateDir = gateWorkspacePath;

    // Refresh branch refs from origin (GitHub) into the gate clone.
    // Must detach HEAD first — git refuses to fetch into a checked-out branch.
    const headSha = (await execGitInMergeSafe(host, ['rev-parse', 'HEAD'], gateWorkspacePath)).trim();
    await execGitInMergeSafe(host, ['checkout', '--detach', headSha], gateWorkspacePath);
    await execGitInMergeSafe(host, ['fetch', 'origin', '+refs/heads/*:refs/heads/*'], gateWorkspacePath);

    // Create feature branch from HEAD (Claude's fixed base)
    try {
      await execGitInMergeSafe(host, ['checkout', '-b', featureBranch], consolidateDir);
    } catch {
      await execGitInMergeSafe(host, ['branch', '-D', featureBranch], consolidateDir);
      await execGitInMergeSafe(host, ['checkout', '-b', featureBranch], consolidateDir);
    }

    // Gather task branches (same logic as consolidateAndMergeImpl)
    const allTasks = host.orchestrator.getAllTasks();
    let allowedTaskIds: Set<string> | undefined;
    if (task.id && workflowId) {
      const mergeT = allTasks.find((x) => x.id === task.id && x.config.isMergeNode);
      if (mergeT) {
        allowedTaskIds = collectTransitiveNonMergeTaskIds(mergeT, (id) => host.orchestrator.getTask(id));
        for (const lid of findLeafTaskIdsInWorkflow(allTasks, workflowId)) {
          allowedTaskIds.add(lid);
        }
      }
    }
    const taskBranches = allTasks
      .filter((t) => {
        if (!t.execution.branch || t.config.isMergeNode) return false;
        if (t.status !== 'completed') return false;
        if (allowedTaskIds) return allowedTaskIds.has(t.id);
        return t.config.workflowId === workflowId;
      })
      .map((t) => ({ branch: t.execution.branch!, description: t.description }))
      .sort((a, b) => a.branch.localeCompare(b.branch));

    // #region agent log
    fetch('http://127.0.0.1:7658/ingest/762b7479-8057-4c6f-a805-85ee7d433bf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'16cf33'},body:JSON.stringify({sessionId:'16cf33',location:'merge-executor.ts:publishAfterFixImpl:consolidate',message:'consolidating in gate clone',data:{taskId:task.id,consolidateDir,branchCount:taskBranches.length,branches:taskBranches.map(t=>t.branch)},timestamp:Date.now(),runId:'post-fix-v3'})}).catch(()=>{});
    // #endregion

    for (const { branch, description } of taskBranches) {
      console.log(`[merge] Post-fix: merging task branch ${branch} → ${featureBranch}`);
      await ensureLocalBranchForMerge(host, consolidateDir, branch);
      const mergeMsg = description ? `Merge ${branch} — ${description}` : `Merge ${branch}`;
      await execGitInMergeSafe(host, ['merge', '--no-ff', '-m', mergeMsg, branch], consolidateDir);
    }
    console.log(`[merge] Post-fix: consolidated ${taskBranches.length} task branches into ${featureBranch}`);

    // Push feature branch directly to origin (GitHub) from the gate clone
    await execGitInMergeSafe(host, ['push', '--force', '-u', 'origin', featureBranch], consolidateDir);

    let fullSummary = summary;
    if (visualProof && host.runVisualProofCapture) {
      const slug = featureBranch.replace(/\//g, '-');
      const vpMarkdown = await host.runVisualProofCapture(baseBranch, featureBranch, slug);
      if (vpMarkdown) {
        fullSummary = (summary ?? '') + '\n\n' + vpMarkdown;
      }
    }

    if (mergeMode === 'github') {
      if (!host.mergeGateProvider) {
        throw new Error('mergeMode is "github" but no mergeGateProvider configured');
      }

      const result = await host.mergeGateProvider.createReview({
        baseBranch,
        featureBranch,
        title: workflow?.name ?? 'Workflow',
        cwd: consolidateDir,
        body: fullSummary,
      });
      console.log(`[merge] Post-fix: created/updated GitHub PR: ${result.url}`);

      // #region agent log
      fetch('http://127.0.0.1:7658/ingest/762b7479-8057-4c6f-a805-85ee7d433bf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'16cf33'},body:JSON.stringify({sessionId:'16cf33',location:'merge-executor.ts:publishAfterFixImpl:success',message:'PR created successfully',data:{taskId:task.id,prUrl:result.url},timestamp:Date.now(),runId:'post-fix-v3'})}).catch(()=>{});
      // #endregion

      host.orchestrator.setTaskAwaitingApproval(task.id, {
        config: { familiarType: 'worktree', summary },
        execution: {
          branch: featureBranch,
          workspacePath: gateWorkspacePath,
          prUrl: result.url,
          prIdentifier: result.identifier,
          prStatus: 'Awaiting review',
        },
      });
      host.startPrPolling(task.id, result.identifier, workflowId!);
      return;
    }

    // manual mode with pull_request onFinish
    if (onFinish === 'pull_request') {
      const prUrl = await host.execPr(baseBranch, featureBranch, workflow?.name ?? 'Workflow', fullSummary, consolidateDir);
      console.log(`[merge] Post-fix: created pull request ${prUrl}`);
      host.persistence.updateTask(task.id, {
        config: { summary },
        execution: { prUrl },
      });
    }

    host.orchestrator.setTaskAwaitingApproval(task.id, {
      config: { familiarType: 'worktree', summary },
      execution: {
        branch: featureBranch,
        workspacePath: gateWorkspacePath,
      },
    });
    mergeTrace('PUBLISH_AFTER_FIX_DONE', { taskId: task.id });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // #region agent log
    fetch('http://127.0.0.1:7658/ingest/762b7479-8057-4c6f-a805-85ee7d433bf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'16cf33'},body:JSON.stringify({sessionId:'16cf33',location:'merge-executor.ts:publishAfterFixImpl:catch',message:'publishAfterFix error',data:{taskId:task.id,error:errorMsg},timestamp:Date.now(),runId:'post-fix-v3'})}).catch(()=>{});
    // #endregion
    mergeTrace('PUBLISH_AFTER_FIX_FAILED', { taskId: task.id, error: errorMsg });
    console.error(`[merge] Post-fix PR prep failed for ${task.id}: ${errorMsg}`);
    const failedResponse: WorkResponse = {
      requestId: `postfix-${task.id}`,
      actionId: task.id,
      status: 'failed',
      outputs: { exitCode: 1, error: `Post-fix PR prep failed: ${errorMsg}` },
    };
    host.orchestrator.handleWorkerResponse(failedResponse);
  }
}

export async function buildMergeSummaryImpl(
  host: MergeExecutorHost,
  workflowId: string,
): Promise<string> {
  const allTasks = host.orchestrator.getAllTasks();
  const workflowTasks = allTasks.filter(
    (t) => t.config.workflowId === workflowId && !t.config.isMergeNode,
  );

  const completed = workflowTasks.filter((t) => t.status === 'completed');
  const failed = workflowTasks.filter((t) => t.status === 'failed');
  const skipped = workflowTasks.filter(
    (t) => t.status !== 'completed' && t.status !== 'failed',
  );
  const claudeResolved = completed.filter(
    (t) => t.config.isReconciliation,
  );

  const workflow = host.persistence.loadWorkflow(workflowId);
  const workflowName = workflow?.name ?? 'Workflow';
  const description = workflow?.description;

  const lines: string[] = [];

  lines.push('## Summary');

  // Add description if present
  if (description && description.trim()) {
    lines.push(description);
    lines.push('');
    lines.push('---');
  }

  lines.push(
    `${workflowName} — ${completed.length} tasks completed, ${failed.length} failed, ${skipped.length} skipped`,
  );
  lines.push('');

  // Task breakdown table
  lines.push('<details>');
  lines.push('<summary>Task breakdown</summary>');
  lines.push('');
  lines.push('| Task | Description | Status |');
  lines.push('|------|-------------|--------|');
  for (const t of workflowTasks) {
    let statusDisplay: string = t.status;
    if (t.status === 'completed' && t.config.command) {
      statusDisplay = 'completed (passed)';
    } else if (t.status === 'failed' && t.config.command) {
      statusDisplay = 'failed (failed)';
    }
    lines.push(`| ${t.id} | ${t.description} | ${statusDisplay} |`);
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');

  // File changes per task
  if (completed.length > 0) {
    lines.push('<details>');
    lines.push('<summary>File changes per task</summary>');
    lines.push('');
    for (const t of completed) {
      if (t.execution.branch) {
        lines.push(`### ${t.id} — ${t.description}`);
        try {
          const stat = await host.gitDiffStat(t.execution.branch);
          if (stat) {
            lines.push(stat);
          }
        } catch {
          // Silently skip if git diff fails
        }
        lines.push('');
      }
    }
    lines.push('</details>');
    lines.push('');
  }

  if (claudeResolved.length > 0) {
    lines.push('## Conflict Resolutions');
    for (const t of claudeResolved) {
      lines.push(`- **${t.id}**: Resolved with Claude — ${t.description}`);
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push('## Failed Tasks');
    for (const t of failed) {
      lines.push(
        `- **${t.id}**: ${t.description} — ${t.execution.error ?? 'unknown error'}`,
      );
    }
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push('## Skipped Tasks');
    for (const t of skipped) {
      lines.push(`- **${t.id}**: ${t.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function consolidateAndMergeImpl(
  host: MergeExecutorHost,
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
  const worktreeDir = await host.createMergeWorktree(baseBranch, 'consolidate-' + (workflowId ?? 'default'));
  console.log(`[merge] consolidateAndMerge: featureBranch=${featureBranch}, baseBranch=${baseBranch}, worktree=${worktreeDir}`);

  try {
    // Create feature branch in worktree
    try {
      await execGitInMergeSafe(host, ['checkout', '-b', featureBranch, baseBranch], worktreeDir);
      console.log(`[merge] Created ${featureBranch} from ${baseBranch}`);
    } catch {
      console.log(`[merge] WARNING: Deleting existing ${featureBranch} to recreate from ${baseBranch}`);
      await execGitInMergeSafe(host, ['branch', '-D', featureBranch], worktreeDir);
      await execGitInMergeSafe(host, ['checkout', '-b', featureBranch, baseBranch], worktreeDir);
      console.log(`[merge] Recreated ${featureBranch} from ${baseBranch}`);
    }

    const allTasks = host.orchestrator.getAllTasks();
    let allowedTaskIds: Set<string> | undefined;
    if (mergeNodeTaskId && workflowId) {
      const mergeT = allTasks.find((x) => x.id === mergeNodeTaskId && x.config.isMergeNode);
      if (mergeT) {
        allowedTaskIds = collectTransitiveNonMergeTaskIds(mergeT, (id) => host.orchestrator.getTask(id));
        for (const lid of findLeafTaskIdsInWorkflow(allTasks, workflowId)) {
          allowedTaskIds.add(lid);
        }
        console.log(
          `[merge] consolidation task set (${allowedTaskIds.size} ids): ${[...allowedTaskIds].sort().join(', ')}`,
        );
        mergeTrace('CONSOLIDATION_TASK_SET', {
          workflowId,
          mergeNodeTaskId,
          ids: [...allowedTaskIds].sort(),
          leafIds: findLeafTaskIdsInWorkflow(allTasks, workflowId),
        });
      }
    }
    const taskBranches = allTasks
      .filter((t) => {
        if (!t.execution.branch || t.config.isMergeNode) return false;
        if (t.status !== 'completed') return false;
        if (allowedTaskIds) return allowedTaskIds.has(t.id);
        if (leafTaskIds && leafTaskIds.length > 0) return leafTaskIds.includes(t.id);
        return t.config.workflowId === workflowId;
      })
      .map((t) => t.execution.branch!)
      .sort();
    for (const branch of taskBranches) {
      console.log(`[merge] Merging task branch: ${branch} → ${featureBranch}`);
      await ensureLocalBranchForMerge(host, worktreeDir, branch);
      const task = allTasks.find(t => t.execution.branch === branch);
      const desc = task?.description ?? '';
      const mergeMsg = desc ? `Merge ${branch} — ${desc}` : `Merge ${branch}`;
      await execGitInMergeSafe(host, ['merge', '--no-ff', '-m', mergeMsg, branch], worktreeDir);
    }
    console.log(`[merge] Consolidated ${taskBranches.length} task branches into ${featureBranch}`);

    if (visualProof && onFinish === 'pull_request' && host.runVisualProofCapture) {
      const slug = (featureBranch ?? 'workflow').replace(/\//g, '-');
      const vpMarkdown = await host.runVisualProofCapture(baseBranch, featureBranch, slug);
      if (vpMarkdown) {
        body = (body ? body + '\n\n' : '') + vpMarkdown;
      }
    }

    const mergeMessage = workflowName ?? 'Workflow';

    if (onFinish === 'merge') {
      // Squash merge in the clone and push result directly to origin (GitHub)
      await execGitInMergeSafe(host, ['checkout', '--detach', baseBranch], worktreeDir);
      await execGitInMergeSafe(host, ['merge', '--squash', featureBranch], worktreeDir);
      const hasChanges = await execGitInMergeSafe(host, ['diff', '--cached', '--quiet'], worktreeDir)
        .then(() => false)
        .catch(() => true);
      if (hasChanges) {
        const commitBody = body ? `${mergeMessage}\n\n${body}` : mergeMessage;
        await execGitInMergeSafe(host, ['commit', '-m', commitBody], worktreeDir);
        await execGitInMergeSafe(host, ['push', '--force', 'origin', `HEAD:refs/heads/${baseBranch}`], worktreeDir);
        // Advance the baseBranch ref in the clone so subsequent operations see the updated base
        const newHead = (await execGitInMergeSafe(host, ['rev-parse', 'HEAD'], worktreeDir)).trim();
        await execGitInMergeSafe(host, ['update-ref', `refs/heads/${baseBranch}`, newHead], worktreeDir);
        console.log(`[merge] Squash-merged ${featureBranch} into ${baseBranch} (pushed to origin)`);
      } else {
        console.log(`[merge] No changes to commit — ${baseBranch} already up-to-date with ${featureBranch}`);
      }
    } else if (onFinish === 'pull_request') {
      // Push feature branch directly to origin (GitHub) from the clone
      await execGitInMergeSafe(host, ['push', '--force', '-u', 'origin', featureBranch], worktreeDir);
      const prUrl = await host.execPr(baseBranch, featureBranch, workflowName ?? 'Workflow', body, worktreeDir);
      console.log(`[merge] Created pull request: ${prUrl}`);
      return prUrl;
    }
  } catch (err) {
    try { await execGitInMergeSafe(host, ['merge', '--abort'], worktreeDir); } catch { /* no merge in progress */ }
    throw err;
  } finally {
    await host.removeMergeWorktree(worktreeDir);
  }
}
