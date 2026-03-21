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

  execGit(args: string[]): Promise<string>;
  execGh(args: string[]): Promise<string>;
  execPr(baseBranch: string, featureBranch: string, title: string, body?: string): Promise<string>;
  detectDefaultBranch(): Promise<string>;
  gitLogMessage(commitHash: string): Promise<string>;
  gitDiffStat(branch: string): Promise<string>;
  startPrPolling(taskId: string, prIdentifier: string, workflowId: string): void;
  executeTasks(tasks: TaskState[]): Promise<void>;
  buildMergeSummary(workflowId: string): Promise<string>;
  consolidateAndMerge(
    onFinish: string,
    baseBranch: string,
    featureBranch: string,
    workflowId?: string,
    workflowName?: string,
    leafTaskIds?: readonly string[],
    body?: string,
  ): Promise<string | undefined>;
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

  if (featureBranch && (onFinish !== 'none' || mergeMode === 'github')) {
    const effectiveOnFinish = mergeMode === 'automatic' ? onFinish : 'none';
    try {
      prUrl = await host.consolidateAndMerge(effectiveOnFinish, baseBranch, featureBranch, workflowId, workflow?.name, task.dependencies, summary);
      if (mergeMode === 'manual') {
        const manualResponse: WorkResponse = {
          requestId: `merge-${task.id}`,
          actionId: task.id,
          status: 'completed',
          outputs: { exitCode: 0 },
        };
        host.callbacks.onComplete?.(task.id, manualResponse);
        host.orchestrator.setTaskAwaitingApproval(task.id, {
          config: { familiarType: 'local', summary },
          execution: { branch: featureBranch ?? undefined, workspacePath: host.cwd },
        });
        return;
      }
      if (mergeMode === 'github') {
        if (!host.mergeGateProvider) {
          throw new Error('mergeMode is "github" but no mergeGateProvider configured');
        }

        // Create PR via provider (consolidation already done above)
        const result = await host.mergeGateProvider.createReview({
          baseBranch,
          featureBranch,
          title: workflow?.name ?? 'Workflow',
          cwd: host.cwd,
          body: summary,
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
          config: { familiarType: 'local', summary },
          execution: {
            branch: featureBranch,
            workspacePath: host.cwd,
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
        config: { familiarType: 'local', summary },
        execution: { branch: featureBranch ?? undefined, workspacePath: host.cwd },
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
    config: { familiarType: 'local', summary },
    execution: {
      branch: featureBranch ?? undefined,
      workspacePath: host.cwd,
      ...(prUrl ? { prUrl } : {}),
    },
  });
  host.callbacks.onComplete?.(task.id, response);
  if (mergeMode === 'manual' && response.status === 'completed') {
    host.orchestrator.setTaskAwaitingApproval(task.id, {
      config: { familiarType: 'local', summary },
      execution: {
        branch: featureBranch ?? undefined,
        workspacePath: host.cwd,
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

  const originalBranch = await host.execGit(['branch', '--show-current']);
  mergeTrace('APPROVE_MERGE_ORIGINAL_BRANCH', { workflowId, originalBranch });
  try {
    const mergeMessage = workflow.name ?? 'Workflow';
    if (onFinish === 'merge') {
      mergeTrace('GIT_CHECKOUT_BASE', { baseBranch });
      await host.execGit(['checkout', baseBranch]);
      mergeTrace('GIT_MERGE_SQUASH', { featureBranch });
      await host.execGit(['merge', '--squash', featureBranch]);
      mergeTrace('GIT_COMMIT', { mergeMessage });
      const commitBody = summary ? `${mergeMessage}\n\n${summary}` : mergeMessage;
      await host.execGit(['commit', '-m', commitBody]);
      mergeTrace('SQUASH_MERGE_COMPLETE', { featureBranch, baseBranch });
      console.log(`[merge] Approved: squash-merged ${featureBranch} into ${baseBranch}`);
    } else if (onFinish === 'pull_request') {
      mergeTrace('GIT_PUSH', { featureBranch });
      await host.execGit(['push', '--force', '-u', 'origin', featureBranch]);
      const prUrl = await host.execPr(baseBranch, featureBranch, mergeMessage, summary);
      mergeTrace('PR_CREATED', { featureBranch, baseBranch, prUrl });
      console.log(`[merge] Approved: created pull request ${prUrl}`);
      const mergeTaskId = `__merge__${workflowId}`;
      host.persistence.updateTask(mergeTaskId, {
        config: { summary },
        execution: { prUrl },
      });
    }
  } catch (err) {
    mergeTrace('APPROVE_MERGE_ERROR', { workflowId, error: String(err) });
    try { await host.execGit(['merge', '--abort']); } catch { /* no merge in progress */ }
    try { await host.execGit(['checkout', originalBranch]); } catch { /* best effort */ }
    throw err;
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
    (t) => t.config.isReconciliation || t.execution.claudeSessionId,
  );

  const workflow = host.persistence.loadWorkflow(workflowId);
  const workflowName = workflow?.name ?? 'Workflow';

  const lines: string[] = [];

  lines.push('## Summary');
  lines.push(
    `${workflowName} — ${completed.length} tasks completed, ${failed.length} failed, ${skipped.length} skipped`,
  );
  lines.push('');

  if (completed.length > 0) {
    lines.push('## Changes');
    for (const t of completed) {
      const statusHint = t.config.command ? ' (passed)' : '';
      lines.push(`### ${t.id} — ${t.description}${statusHint}`);
      if (t.execution.branch) {
        try {
          const stat = await host.gitDiffStat(t.execution.branch);
          if (stat) {
            lines.push(stat);
          }
        } catch {
        }
      }
      lines.push('');
    }
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
): Promise<string | undefined> {
  const originalBranch = await host.execGit(['branch', '--show-current']);
  console.log(`[merge] consolidateAndMerge: featureBranch=${featureBranch}, baseBranch=${baseBranch}, originalBranch=${originalBranch}`);

  try {
    // Consolidate all completed task branches into featureBranch
    try {
      await host.execGit(['checkout', '-b', featureBranch, baseBranch]);
      console.log(`[merge] Created ${featureBranch} from ${baseBranch}`);
    } catch {
      // Branch exists from a previous attempt — delete and recreate for a clean slate
      console.log(`[merge] WARNING: Deleting existing ${featureBranch} to recreate from ${baseBranch}`);
      await host.execGit(['checkout', baseBranch]);
      await host.execGit(['branch', '-D', featureBranch]);
      await host.execGit(['checkout', '-b', featureBranch, baseBranch]);
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
      const task = allTasks.find(t => t.execution.branch === branch);
      const desc = task?.description ?? '';
      const mergeMsg = desc ? `Merge ${branch} — ${desc}` : `Merge ${branch}`;
      await host.execGit(['merge', '--no-ff', '-m', mergeMsg, branch]);
    }
    console.log(`[merge] Consolidated ${taskBranches.length} task branches into ${featureBranch}`);

    const mergeMessage = workflowName ?? 'Workflow';

    if (onFinish === 'merge') {
      await host.execGit(['checkout', baseBranch]);
      await host.execGit(['merge', '--squash', featureBranch]);
      const hasChanges = await host.execGit(['diff', '--cached', '--quiet'])
        .then(() => false)
        .catch(() => true);
      if (hasChanges) {
        const commitBody = body ? `${mergeMessage}\n\n${body}` : mergeMessage;
        await host.execGit(['commit', '-m', commitBody]);
        console.log(`[merge] Squash-merged ${featureBranch} into ${baseBranch}`);
      } else {
        console.log(`[merge] No changes to commit — ${baseBranch} already up-to-date with ${featureBranch}`);
      }
    } else if (onFinish === 'pull_request') {
      await host.execGit(['push', '--force', '-u', 'origin', featureBranch]);
      const prUrl = await host.execPr(baseBranch, featureBranch, workflowName ?? 'Workflow', body);
      console.log(`[merge] Created pull request: ${prUrl}`);
      return prUrl;
    }
  } catch (err) {
    try { await host.execGit(['merge', '--abort']); } catch { /* no merge in progress */ }
    try { await host.execGit(['checkout', originalBranch]); } catch { /* best effort */ }
    throw err;
  }
}
