/**
 * Merge node execution logic, extracted from TaskExecutor.
 *
 * Each function takes a MergeExecutorHost (a subset of TaskExecutor's
 * capabilities) as its first parameter, avoiding circular imports.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
  execGh(args: string[]): Promise<string>;
  execPr(baseBranch: string, featureBranch: string, title: string, body?: string): Promise<string>;
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
    await host.execGitIn(['rev-parse', '--verify', branch], worktreeDir);
    hadLocal = true;
  } catch {
    /* ref missing — try origin */
  }

  if (hadLocal) return;

  try {
    await host.execGitIn(
      ['fetch', 'origin', `+refs/heads/${branch}:refs/heads/${branch}`],
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
      prUrl = await host.consolidateAndMerge(effectiveOnFinish, baseBranch, featureBranch, workflowId, workflow?.name, task.dependencies, summary, visualProof);
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

        // Create PR via provider (consolidation already done above)
        const result = await host.mergeGateProvider.createReview({
          baseBranch,
          featureBranch,
          title: workflow?.name ?? 'Workflow',
          cwd: host.cwd,
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
      await host.execGitIn(['merge', '--squash', featureBranch], worktreeDir);
      mergeTrace('GIT_COMMIT', { mergeMessage });
      const commitBody = fullSummary ? `${mergeMessage}\n\n${fullSummary}` : mergeMessage;
      await host.execGitIn(['commit', '-m', commitBody], worktreeDir);
      await host.execGitIn(['update-ref', 'refs/heads/' + baseBranch, 'HEAD'], worktreeDir);
      await host.execGitIn(['reset', '--hard', baseBranch], host.cwd);
      mergeTrace('SQUASH_MERGE_COMPLETE', { featureBranch, baseBranch });
      console.log(`[merge] Approved: squash-merged ${featureBranch} into ${baseBranch}`);
    } catch (err) {
      mergeTrace('APPROVE_MERGE_ERROR', { workflowId, error: String(err) });
      try { await host.execGitIn(['merge', '--abort'], worktreeDir); } catch { /* no merge in progress */ }
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
      await host.execGitIn(['push', '--force', '-u', 'origin', featureBranch], worktreeDir);
      const prUrl = await host.execPr(baseBranch, featureBranch, mergeMessage, fullSummary);
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
): Promise<string | undefined> {
  const worktreeDir = await host.createMergeWorktree(baseBranch, 'consolidate-' + (workflowId ?? 'default'));
  console.log(`[merge] consolidateAndMerge: featureBranch=${featureBranch}, baseBranch=${baseBranch}, worktree=${worktreeDir}`);

  try {
    // Create feature branch in worktree
    try {
      await host.execGitIn(['checkout', '-b', featureBranch, baseBranch], worktreeDir);
      console.log(`[merge] Created ${featureBranch} from ${baseBranch}`);
    } catch {
      // Branch exists from a previous attempt — delete and recreate for a clean slate
      console.log(`[merge] WARNING: Deleting existing ${featureBranch} to recreate from ${baseBranch}`);
      await host.execGitIn(['branch', '-D', featureBranch], worktreeDir);
      await host.execGitIn(['checkout', '-b', featureBranch, baseBranch], worktreeDir);
      console.log(`[merge] Recreated ${featureBranch} from ${baseBranch}`);
    }

    const allTasks = host.orchestrator.getAllTasks();
    const taskBranches = allTasks
      .filter((t) => {
        if (!t.execution.branch || t.config.isMergeNode) return false;
        if (t.status !== 'completed') return false;
        if (leafTaskIds) return leafTaskIds.includes(t.id);
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
      await host.execGitIn(['merge', '--no-ff', '-m', mergeMsg, branch], worktreeDir);
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
      // Detach at baseBranch and squash merge
      await host.execGitIn(['checkout', '--detach', baseBranch], worktreeDir);
      await host.execGitIn(['merge', '--squash', featureBranch], worktreeDir);
      const hasChanges = await host.execGitIn(['diff', '--cached', '--quiet'], worktreeDir)
        .then(() => false)
        .catch(() => true);
      if (hasChanges) {
        const commitBody = body ? `${mergeMessage}\n\n${body}` : mergeMessage;
        await host.execGitIn(['commit', '-m', commitBody], worktreeDir);
        await host.execGitIn(['update-ref', 'refs/heads/' + baseBranch, 'HEAD'], worktreeDir);
        await host.execGitIn(['reset', '--hard', baseBranch], host.cwd);
        console.log(`[merge] Squash-merged ${featureBranch} into ${baseBranch}`);
      } else {
        console.log(`[merge] No changes to commit — ${baseBranch} already up-to-date with ${featureBranch}`);
      }
    } else if (onFinish === 'pull_request') {
      await host.execGitIn(['push', '--force', '-u', 'origin', featureBranch], worktreeDir);
      const prUrl = await host.execPr(baseBranch, featureBranch, workflowName ?? 'Workflow', body);
      console.log(`[merge] Created pull request: ${prUrl}`);
      return prUrl;
    }
  } catch (err) {
    try { await host.execGitIn(['merge', '--abort'], worktreeDir); } catch { /* no merge in progress */ }
    throw err;
  } finally {
    await host.removeMergeWorktree(worktreeDir);
  }
}
