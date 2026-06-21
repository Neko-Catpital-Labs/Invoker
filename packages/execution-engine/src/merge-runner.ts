/**
 * Merge node execution logic, extracted from TaskRunner.
 *
 * Each function takes a MergeRunnerHost (a subset of TaskRunner's
 * capabilities) as its first parameter, avoiding circular imports.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import type { Orchestrator, TaskState, TaskStateChanges } from '@invoker/workflow-core';
import { OrchestratorError, OrchestratorErrorCode } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { WorkResponse } from '@invoker/contracts';
import type { TaskRunnerCallbacks } from './task-runner-callbacks.js';
import type { MergeGateProvider } from './merge-gate-provider.js';
import type { ReviewProviderRegistry } from './review-provider-registry.js';
import { normalizeBranchForGithubCli } from './github-branch-ref.js';
import type { PrAuthoringContext, PrAuthoringTaskEntry } from './pr-authoring.js';
import { isGitRefLockRace } from './git-utils.js';

// ── Trace logging ────────────────────────────────────────

export const MERGE_TRACE_LOG = resolve(homedir(), '.invoker', 'merge-trace.log');

export function mergeTrace(tag: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(resolve(homedir(), '.invoker'), { recursive: true });
    appendFileSync(MERGE_TRACE_LOG, `${new Date().toISOString()} [merge-trace:runner] ${tag} ${JSON.stringify(data)}\n`);
  } catch { /* best effort */ }
}

/** Unit tests may use partial persistence mocks without {@link SQLiteAdapter.getWorkspacePath}. */
function safeGetWorkspacePath(persistence: SQLiteAdapter, taskId: string): string | null | undefined {
  const p = persistence as { getWorkspacePath?: (this: SQLiteAdapter, id: string) => string | null };
  return typeof p.getWorkspacePath === 'function'
    ? p.getWorkspacePath.call(persistence, taskId)
    : undefined;
}

function canonicalMergeMode(mode: string | undefined): 'manual' | 'automatic' | 'external_review' {
  const m = mode ?? 'manual';
  if (m === 'external_review') return 'external_review';
  if (m === 'automatic') return 'automatic';
  return 'manual';
}

async function resolveBaseCheckoutRef(
  host: MergeRunnerHost,
  baseBranch: string,
  _preferOriginTracking: boolean,
): Promise<string> {
  return normalizeBranchForGithubCli(baseBranch);
}

/**
 * Merge gates can move to awaiting_approval before final completion.
 * Start any newly-ready downstream tasks (e.g., cross-workflow review_ready deps).
 */
async function startReviewReadyDependents(host: MergeRunnerHost): Promise<void> {
  const newlyStarted = host.orchestrator.autoStartExternallyUnblockedReadyTasks();
  if (newlyStarted.length === 0) {
    return;
  }
  await host.executeTasks(newlyStarted);
}

function setMergeGateReviewReady(
  host: MergeRunnerHost,
  taskId: string,
  changes: TaskStateChanges,
): void {
  host.orchestrator.setTaskReviewReady(taskId, changes);
}

function buildMergeConflictJson(errorText: string, failedBranch: string): string | undefined {
  const hasConflictMarkers =
    errorText.includes('CONFLICT (') ||
    errorText.includes('Automatic merge failed');
  const hasMergeCommandFailure =
    errorText.includes('git merge --no-ff') &&
    errorText.includes(` ${failedBranch}`);
  if (!hasConflictMarkers && !hasMergeCommandFailure) return undefined;
  const files = new Set<string>();
  const regex = /Merge conflict in ([^\n]+)/g;
  for (const match of errorText.matchAll(regex)) {
    const file = match[1]?.trim();
    if (file) files.add(file);
  }
  return JSON.stringify({
    type: 'merge_conflict',
    failedBranch,
    conflictFiles: [...files],
  });
}

// ── Host-cwd safety guard ─────────────────────────────────

/**
 * Wrapper around host.execGitIn that throws if the target directory is the
 * user's main working directory (host.cwd). All merge-runner git operations
 * must target a managed merge clone, never the host repo.
 */
async function execGitInMergeSafe(
  host: MergeRunnerHost,
  args: string[],
  dir: string,
): Promise<string> {
  if (normalize(resolve(dir)) === normalize(resolve(host.cwd))) {
    throw new Error(
      `SAFETY: merge-runner must not run git in host repo (${host.cwd}). ` +
      `All merge git operations must use a managed merge clone. ` +
      `git args: [${args.join(', ')}]\n${new Error().stack}`,
    );
  }
  return host.execGitIn(args, dir);
}

async function pushFeatureBranchWithRefLockRetry(
  host: MergeRunnerHost,
  dir: string,
  featureBranch: string,
): Promise<void> {
  const pushArgs = ['push', '--force', 'origin', `${featureBranch}:refs/heads/${featureBranch}`];
  try {
    await execGitInMergeSafe(host, pushArgs, dir);
  } catch (err) {
    if (!isGitRefLockRace(err)) throw err;
    mergeTrace('GIT_PUSH_REF_LOCK_RACE_RETRY', {
      featureBranch,
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
    await execGitInMergeSafe(host, [
      'fetch',
      'origin',
      `+refs/heads/${featureBranch}:refs/remotes/origin/${featureBranch}`,
    ], dir);
    await execGitInMergeSafe(host, pushArgs, dir);
  }
}

async function syncGateWorkspaceToFeatureBranch(
  host: MergeRunnerHost,
  gateWorkspacePath: string | undefined,
  featureBranch: string,
): Promise<void> {
  if (!gateWorkspacePath) return;
  await execGitInMergeSafe(
    host,
    ['fetch', 'origin', `+refs/heads/${featureBranch}:refs/heads/${featureBranch}`],
    gateWorkspacePath,
  );
  await execGitInMergeSafe(host, ['checkout', featureBranch], gateWorkspacePath);
}

// ── Host interface ───────────────────────────────────────

/**
 * Subset of TaskRunner that merge functions need.
 * Defined here (not by importing TaskRunner) to avoid circular deps.
 */
export interface MergeRunnerHost {
  readonly persistence: SQLiteAdapter;
  readonly orchestrator: Orchestrator;
  readonly defaultBranch: string | undefined;
  readonly callbacks: TaskRunnerCallbacks;
  readonly cwd: string;
  readonly mergeGateProvider?: MergeGateProvider;
  readonly reviewProviderRegistry?: ReviewProviderRegistry;

  execGitReadonly(args: string[], cwd?: string): Promise<string>;
  execGitIn(args: string[], dir: string): Promise<string>;
  createMergeWorktree(ref: string, label: string, repoUrl?: string): Promise<string>;
  removeMergeWorktree(dir: string): Promise<void>;
  execGh(args: string[], cwd?: string): Promise<string>;
  execPr(baseBranch: string, featureBranch: string, title: string, body?: string, cwd?: string): Promise<string>;
  authorPrBodyWithSkill?(args: {
    workflowId?: string;
    mergeNodeTaskId?: string;
    title: string;
    baseBranch: string;
    featureBranch: string;
    workflowSummary: string;
    structuredContext?: PrAuthoringContext;
    cwd: string;
  }): Promise<{ body: string; sessionId: string; agentName: string }>;
  detectDefaultBranch(): Promise<string>;
  gitLogMessage(commitHash: string, cwd?: string): Promise<string>;
  gitDiffStat(branch: string, cwd?: string): Promise<string>;
  executeTasks(tasks: TaskState[]): Promise<void>;
  buildMergeSummary(workflowId: string): Promise<string>;
  runVisualProofCapture?(baseBranch: string, featureBranch: string, slug: string, repoUrl?: string): Promise<string | undefined>;
  /** Pool mirror path for `repoUrl`, when worktree executor + repo pool are available. */
  ensureRepoMirrorPath?(repoUrl: string): Promise<string | undefined>;
  consolidateAndMerge(
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
  ): Promise<string | undefined>;
}

async function authorPrBodyForMerge(
  host: MergeRunnerHost,
  args: {
    workflowId?: string;
    mergeNodeTaskId?: string;
    title: string;
    baseBranch: string;
    featureBranch: string;
    workflowSummary: string;
    structuredContext?: PrAuthoringContext;
    cwd: string;
  },
): Promise<string> {
  if (!host.authorPrBodyWithSkill) {
    throw new Error('authorPrBodyWithSkill is required for merge PR authoring');
  }
  const authored = await host.authorPrBodyWithSkill(args);
  console.log(
    `[merge] Authored PR body via ${authored.agentName} skill session=${authored.sessionId}`,
  );
  return authored.body;
}

/**
 * Build structured PR-authoring context from workflow tasks.
 * This carries per-task evidence (verification commands, file-change summaries)
 * alongside the free-form summary string for richer PR bodies.
 */
export async function buildPrAuthoringContext(
  host: MergeRunnerHost,
  workflowId: string,
  visualProofMarkdown?: string,
): Promise<PrAuthoringContext> {
  const allTasks = host.orchestrator.getAllTasks();
  const workflowTasks = allTasks.filter(
    (t) => t.config.workflowId === workflowId && !t.config.isMergeNode,
  );

  const workflow = host.persistence.loadWorkflow(workflowId);

  // Resolve pool mirror path so gitDiffStat runs against the correct repo
  const mirrorCwd = workflow?.repoUrl && host.ensureRepoMirrorPath
    ? await host.ensureRepoMirrorPath(workflow.repoUrl)
    : undefined;

  const tasks: PrAuthoringTaskEntry[] = [];
  for (const t of workflowTasks) {
    const status: PrAuthoringTaskEntry['status'] =
      t.status === 'completed' ? 'completed'
        : t.status === 'failed' ? 'failed'
          : 'skipped';

    let fileChangeSummary: string | undefined;
    if (t.status === 'completed' && t.execution.branch) {
      try {
        const stat = await host.gitDiffStat(t.execution.branch, mirrorCwd ?? undefined);
        if (stat) fileChangeSummary = stat;
      } catch {
        // Silently skip if git diff fails
      }
    }

    tasks.push({
      taskId: t.id,
      description: t.description,
      status,
      command: t.config.command ?? undefined,
      fileChangeSummary,
    });
  }

  return {
    workflowName: workflow?.name,
    workflowDescription: workflow?.description,
    tasks,
    visualProofMarkdown,
  };
}

/**
 * Ensure `branch` resolves in `worktreeDir` for `git merge`. Local worktree tasks
 * already have the ref; SSH (or other) tasks often push to origin from another host,
 * so fetch into refs/heads/{branch} when missing.
 *
 * Returns true if the branch was found/fetched, false if it's missing everywhere.
 * Callers that are preparing node output branches must treat false as fatal:
 * dependency branches are required graph inputs.
 */
export async function ensureLocalBranchForMerge(
  host: MergeRunnerHost,
  worktreeDir: string,
  branch: string,
  repoUrl?: string,
  branchRepoUrl?: string,
): Promise<boolean> {
  let hadLocal = false;
  try {
    await execGitInMergeSafe(host, ['rev-parse', '--verify', branch], worktreeDir);
    hadLocal = true;
  } catch {
    /* ref missing — try origin */
  }

  if (hadLocal) return true;

  let originErr: unknown;
  try {
    await execGitInMergeSafe(
      host,
      ['fetch', 'origin', `+refs/heads/${branch}:refs/heads/${branch}`],
      worktreeDir,
    );
    return true;
  } catch (err) {
    originErr = err;
  }

  const trimmedBranchRepoUrl = branchRepoUrl?.trim();
  if (trimmedBranchRepoUrl) {
    try {
      await execGitInMergeSafe(
        host,
        ['fetch', trimmedBranchRepoUrl, `+refs/heads/${branch}:refs/heads/${branch}`],
        worktreeDir,
      );
      return true;
    } catch {
      // Fall through to mirror fetch and final diagnostics.
    }
  }

  const trimmedUrl = repoUrl?.trim();
  let mirrorErr: string | undefined;
  if (trimmedUrl && host.ensureRepoMirrorPath) {
    const mirror = await host.ensureRepoMirrorPath(trimmedUrl);
    if (mirror) {
      try {
        const mirrorUrl = pathToFileURL(mirror).href;
        await execGitInMergeSafe(
          host,
          ['fetch', mirrorUrl, `+refs/heads/${branch}:refs/heads/${branch}`],
          worktreeDir,
        );
        console.log(
          `[merge-gate-workspace] ensureLocalBranchForMerge fetched ${branch} from pool mirror ${mirror}`,
        );
        return true;
      } catch (e) {
        mirrorErr = e instanceof Error ? e.message : String(e);
      }
    }
  }

  // Branch not found anywhere.
  const originMsg = originErr instanceof Error ? originErr.message : String(originErr);
  console.log(
    `[merge-gate-workspace] ensureLocalBranchForMerge: branch ${branch} not found locally, on origin, or in mirror. ` +
    `Origin error: ${originMsg}` + (mirrorErr ? `. Mirror error: ${mirrorErr}` : ''),
  );
  return false;
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

/** Direct non-merge dependencies of a merge node (no transitive expansion). */
export function collectDirectNonMergeTaskIds(
  mergeTask: TaskState,
  getTask: (id: string) => TaskState | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const id of mergeTask.dependencies) {
    const t = getTask(id);
    if (!t || t.config.isMergeNode) continue;
    out.add(id);
  }
  return out;
}

// ── Extracted functions ──────────────────────────────────

export interface MergeGateActionResult {
  response: WorkResponse;
  taskChanges: TaskStateChanges;
}

export async function runMergeGateActionImpl(
  host: MergeRunnerHost,
  task: TaskState,
  opts: { gateWorkspacePath?: string } = {},
): Promise<MergeGateActionResult> {
  const workflowId = task.config.workflowId;
  const workflow = workflowId
    ? host.persistence.loadWorkflow(workflowId)
    : undefined;
  const onFinish = workflow?.onFinish ?? 'none';
  const mergeMode = canonicalMergeMode(workflow?.mergeMode);
  const baseBranch = workflow?.baseBranch ?? host.defaultBranch ?? await host.detectDefaultBranch();
  const featureBranch = workflow?.featureBranch;
  const visualProof = workflow?.visualProof ?? false;

  let response: WorkResponse;
  let reviewUrl: string | undefined;
  let reviewId: string | undefined;
  let reviewStatus: string | undefined;

  const summary = workflowId ? await host.buildMergeSummary(workflowId) : undefined;

  mergeTrace('GATE_WS_EXECUTE_MERGE_ENTER', {
    taskId: task.id,
    workflowId,
    onFinish,
    mergeMode,
    baseBranch,
    featureBranch: featureBranch ?? null,
    persistedWorkspaceBefore: safeGetWorkspacePath(host.persistence, task.id),
  });
  console.log(
    `[merge-gate-workspace] executeMergeNode enter task=${task.id} featureBranch=${featureBranch ?? 'none'} ` +
      `mergeMode=${mergeMode} onFinish=${onFinish} dbWorkspacePath=${safeGetWorkspacePath(host.persistence, task.id) ?? 'NULL'}`,
  );

  host.persistence.updateTask(task.id, {
    execution: {
      reviewUrl: undefined,
      reviewId: undefined,
      reviewStatus: undefined,
    },
  });

  // Create a persistent gate worktree so workspacePath is never the main repo.
  // Use baseBranch as the ref because featureBranch may not exist yet
  // (it gets created inside consolidateAndMerge). Terminal restore does
  // `git checkout <branch>` to switch to featureBranch anyway.
  let gateWorkspacePath: string | undefined = opts.gateWorkspacePath;
  if (!gateWorkspacePath && featureBranch) {
    const baseCheckoutRef = await resolveBaseCheckoutRef(
      host,
      baseBranch,
      mergeMode === 'external_review' || onFinish === 'pull_request',
    );
    gateWorkspacePath = await host.createMergeWorktree(
      baseCheckoutRef,
      'gate-' + task.id.replace(/[^a-zA-Z0-9_-]/g, '-'),
      workflow?.repoUrl,
    );
    mergeTrace('GATE_WS_GATE_CLONE_CREATED', { taskId: task.id, gateWorkspacePath });
    console.log(`[merge-gate-workspace] gate clone created task=${task.id} path=${gateWorkspacePath}`);
  } else {
    mergeTrace('GATE_WS_GATE_CLONE_SKIPPED', { taskId: task.id, reason: 'no_feature_branch' });
    console.log(`[merge-gate-workspace] gate clone skipped task=${task.id} (no featureBranch on workflow)`);
  }

  if (featureBranch && (onFinish !== 'none' || mergeMode === 'external_review')) {
    const effectiveOnFinish = mergeMode === 'automatic' ? onFinish : 'none';
    try {
      const baseCheckoutRef = await resolveBaseCheckoutRef(
        host,
        baseBranch,
        mergeMode === 'external_review' || onFinish === 'pull_request',
      );
      reviewUrl = await host.consolidateAndMerge(
        effectiveOnFinish,
        baseBranch,
        featureBranch,
        workflowId,
        workflow?.name,
        undefined,
        summary,
        visualProof,
        baseCheckoutRef,
        task.id,
      );
      if (mergeMode === 'manual') {
        mergeTrace('GATE_WS_PATH_MANUAL_AWAIT', { taskId: task.id, gateWorkspacePath: gateWorkspacePath ?? null });
        console.log(
          `[merge-gate-workspace] setTaskReviewReady path=manual branch consolidate ` +
            `task=${task.id} gateWorkspacePath=${gateWorkspacePath ?? 'NULL'}`,
        );
        response = {
          requestId: `merge-${task.id}`,
          actionId: task.id,
          executionGeneration: task.execution.generation ?? 0,
          status: 'review_ready',
          outputs: { exitCode: 0, summary, branch: featureBranch ?? undefined },
        };
        return {
          response,
          taskChanges: {
            config: { summary },
            execution: { branch: featureBranch ?? undefined, workspacePath: gateWorkspacePath },
          },
        };
      }
      if (mergeMode === 'external_review') {
        if (!host.mergeGateProvider) {
          throw new Error('mergeMode is "external_review" but no review provider configured');
        }

        // The PR branch is pushed from the separate consolidation clone above.
        // Fetch it into the persistent gate workspace and check it out before
        // persisting the workspace handoff used by review terminals.
        await syncGateWorkspaceToFeatureBranch(host, gateWorkspacePath, featureBranch);

        let fullSummary = summary;
        let vpMarkdownCapture: string | undefined;
        if (visualProof && host.runVisualProofCapture) {
          const slug = (featureBranch ?? 'workflow').replace(/\//g, '-');
          const vpMarkdown = await host.runVisualProofCapture(baseBranch, featureBranch!, slug, workflow?.repoUrl);
          if (vpMarkdown) {
            vpMarkdownCapture = vpMarkdown;
            fullSummary = (summary ?? '') + '\n\n' + vpMarkdown;
          }
        }

        // Route through shared PR-authoring helper for consistent PR bodies.
        const structuredCtx = workflowId
          ? await buildPrAuthoringContext(host, workflowId, vpMarkdownCapture)
          : undefined;
        const prBody = await authorPrBodyForMerge(host, {
          workflowId,
          mergeNodeTaskId: task.id,
          title: workflow?.name ?? 'Workflow',
          baseBranch,
          featureBranch: featureBranch!,
          workflowSummary: fullSummary ?? '',
          structuredContext: structuredCtx,
          cwd: gateWorkspacePath!,
        });

        // Create PR via provider (consolidation already done above).
        // Use the gate clone dir so gh CLI resolves the correct GitHub remote.
        const result = await host.mergeGateProvider.createReview({
          baseBranch,
          featureBranch,
          title: workflow?.name ?? 'Workflow',
          cwd: gateWorkspacePath!,
          body: prBody,
        });
        console.log(`[merge] Created GitHub PR: ${result.url}`);

        reviewUrl = result.url;
        reviewId = result.identifier;
        reviewStatus = 'Awaiting review';
        mergeTrace('GATE_WS_PATH_EXTERNAL_REVIEW_AWAIT', {
          taskId: task.id,
          gateWorkspacePath: gateWorkspacePath ?? null,
          reviewUrl: result.url,
        });
        console.log(
          `[merge-gate-workspace] setTaskReviewReady path=external_review ` +
            `task=${task.id} gateWorkspacePath=${gateWorkspacePath ?? 'NULL'}`,
        );
        response = {
          requestId: `merge-${task.id}`,
          actionId: task.id,
          executionGeneration: task.execution.generation ?? 0,
          status: 'review_ready',
          outputs: {
            exitCode: 0,
            summary,
            branch: featureBranch,
            reviewUrl,
            reviewId,
            reviewStatus,
          },
        };
        return {
          response,
          taskChanges: {
            config: { summary },
            execution: {
              branch: featureBranch,
              workspacePath: gateWorkspacePath,
              reviewUrl,
              reviewId,
              reviewStatus,
            },
          },
        };
      }
      response = {
        requestId: `merge-${task.id}`,
        actionId: task.id,
        executionGeneration: task.execution.generation ?? 0,
        status: 'completed',
        outputs: { exitCode: 0, summary, branch: featureBranch ?? undefined },
      };
    } catch (err) {
      response = {
        requestId: `merge-${task.id}`,
        actionId: task.id,
        executionGeneration: task.execution.generation ?? 0,
        status: 'failed',
        outputs: {
          exitCode: 1,
          error: `Merge failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  } else {
    if (mergeMode === 'manual' || mergeMode === 'external_review') {
      mergeTrace('GATE_WS_PATH_NO_CONSOLIDATE_AWAIT', {
        taskId: task.id,
        gateWorkspacePath: gateWorkspacePath ?? null,
        mergeMode,
      });
      console.log(
        `[merge-gate-workspace] setTaskReviewReady path=no_consolidate_branch ` +
          `task=${task.id} gateWorkspacePath=${gateWorkspacePath ?? 'NULL'} mergeMode=${mergeMode}`,
      );
      response = {
        requestId: `merge-${task.id}`,
        actionId: task.id,
        executionGeneration: task.execution.generation ?? 0,
        status: 'review_ready',
        outputs: { exitCode: 0, summary, branch: featureBranch ?? undefined },
      };
        return {
          response,
          taskChanges: {
            config: { summary },
            execution: { branch: featureBranch ?? undefined, workspacePath: gateWorkspacePath },
          },
        };
    }
    response = {
      requestId: `merge-${task.id}`,
      actionId: task.id,
      executionGeneration: task.execution.generation ?? 0,
      status: 'completed',
      outputs: { exitCode: 0, summary, branch: featureBranch ?? undefined },
    };
  }

  mergeTrace('GATE_WS_UPDATE_TASK_BEFORE_CALLBACK', {
    taskId: task.id,
    gateWorkspacePath: gateWorkspacePath ?? null,
    responseStatus: response.status,
  });
  console.log(
    `[merge-gate-workspace] updateTask(merge metadata) task=${task.id} ` +
      `gateWorkspacePath=${gateWorkspacePath ?? 'NULL'} response=${response.status}`,
  );
  return {
    response,
    taskChanges: {
      config: { summary },
      execution: {
      branch: featureBranch ?? undefined,
      workspacePath: gateWorkspacePath,
      ...(reviewUrl ? { reviewUrl } : {}),
      ...(reviewId ? { reviewId } : {}),
      ...(reviewStatus ? { reviewStatus } : {}),
      ...(response.status === 'failed' && response.outputs.error
        ? { error: response.outputs.error }
        : {}),
      },
    },
  };
}

export async function executeMergeNodeImpl(
  host: MergeRunnerHost,
  task: TaskState,
): Promise<void> {
  const result = await runMergeGateActionImpl(host, task);
  const { response } = result;
  const legacyConfig = {
    ...(result.taskChanges.config ?? {}),
    runnerKind: 'worktree',
  } as TaskStateChanges['config'];
  const legacyChanges: TaskStateChanges = {
    status: result.taskChanges.status,
    dependencies: result.taskChanges.dependencies,
    execution: result.taskChanges.execution,
    config: legacyConfig,
  };

  host.persistence.updateTask(task.id, legacyChanges);

  if (response.status === 'review_ready') {
    setMergeGateReviewReady(host, task.id, legacyChanges);
    await startReviewReadyDependents(host);
  } else {
    const newlyStarted = host.orchestrator.handleWorkerResponse(response) ?? [];
    if (newlyStarted.length > 0) {
      host.executeTasks(newlyStarted);
    }
  }

  try {
    host.callbacks.onComplete?.(task.id, response);
  } catch (err) {
    console.warn(
      `[merge] completion callback observer failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function approveMergeImpl(
  host: MergeRunnerHost,
  workflowId: string,
): Promise<void> {
  mergeTrace('APPROVE_MERGE_ENTER', { workflowId });
  const workflow = host.persistence.loadWorkflow(workflowId);
  if (!workflow) throw new OrchestratorError(OrchestratorErrorCode.WORKFLOW_NOT_FOUND, `Workflow ${workflowId} not found`);

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
  let vpMarkdownCapture: string | undefined;
  if (visualProof && host.runVisualProofCapture) {
    const slug = (featureBranch ?? 'workflow').replace(/\//g, '-');
    const vpMarkdown = await host.runVisualProofCapture(baseBranch, featureBranch!, slug, workflow.repoUrl);
    if (vpMarkdown) {
      vpMarkdownCapture = vpMarkdown;
      fullSummary = summary + '\n\n' + vpMarkdown;
    }
  }
  const structuredContext = await buildPrAuthoringContext(host, workflowId, vpMarkdownCapture);
  const mergeMessage = workflow.name ?? 'Workflow';

  // Clean up the persistent gate worktree created by executeMergeNodeImpl
  const mergeTaskId = `__merge__${workflowId}`;
  const gateWorktreePath = safeGetWorkspacePath(host.persistence, mergeTaskId);
  const branchRepoUrl = workflow.intermediateRepoUrl?.trim() || undefined;

  if (onFinish === 'merge') {
    const worktreeDir = await host.createMergeWorktree(baseBranch, 'approve-' + workflowId, workflow.repoUrl);
    try {
      mergeTrace('GIT_MERGE_SQUASH', { featureBranch, worktreeDir });
      await ensureLocalBranchForMerge(
        host,
        worktreeDir,
        featureBranch,
        workflow.repoUrl,
        branchRepoUrl,
      );
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
    const worktreeDir = await host.createMergeWorktree(featureBranch, 'approve-pr-' + workflowId, workflow.repoUrl);
    try {
      mergeTrace('GIT_PUSH', { featureBranch, worktreeDir });
      // Push feature branch directly to origin (GitHub) from the clone
      await pushFeatureBranchWithRefLockRetry(host, worktreeDir, featureBranch);
      const prBody = await authorPrBodyForMerge(host, {
        workflowId,
        mergeNodeTaskId: mergeTaskId,
        title: mergeMessage,
        baseBranch,
        featureBranch,
        workflowSummary: fullSummary ?? '',
        structuredContext,
        cwd: worktreeDir,
      });
      const reviewUrl = await host.execPr(baseBranch, featureBranch, mergeMessage, prBody, worktreeDir);
      mergeTrace('PR_CREATED', { featureBranch, baseBranch, reviewUrl });
      console.log(`[merge] Approved: created pull request ${reviewUrl}`);
      host.persistence.updateTask(mergeTaskId, {
        config: { summary },
        execution: { reviewUrl },
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
 * Called when fixed-task approval resumes a merge gate from
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
  host: MergeRunnerHost,
  task: TaskState,
): Promise<void> {
  const workflowId = task.config.workflowId;
  const workflow = workflowId
    ? host.persistence.loadWorkflow(workflowId)
    : undefined;
  const onFinish = workflow?.onFinish ?? 'none';
  const mergeMode = canonicalMergeMode(workflow?.mergeMode);
  const baseBranch = workflow?.baseBranch ?? host.defaultBranch ?? await host.detectDefaultBranch();
  const featureBranch = workflow?.featureBranch;
  const visualProof = workflow?.visualProof ?? false;

  const summary = workflowId ? await host.buildMergeSummary(workflowId) : undefined;
  const gateWorkspacePath = safeGetWorkspacePath(host.persistence, task.id) ?? undefined;
  const fixedIntegrationSha = task.execution.fixedIntegrationSha?.trim() || undefined;

  mergeTrace('PUBLISH_AFTER_FIX_ENTER', {
    taskId: task.id,
    workflowId,
    onFinish,
    mergeMode,
    baseBranch,
    featureBranch,
    gateWorkspacePathFromDb: gateWorkspacePath ?? null,
    taskExecutionWorkspacePath: task.execution.workspacePath ?? null,
  });
  console.log(
    `[merge-gate-workspace] publishAfterFix enter task=${task.id} featureBranch=${featureBranch ?? 'none'} ` +
      `db.getWorkspacePath=${gateWorkspacePath ?? 'NULL'} task.execution.workspacePath=${task.execution.workspacePath ?? 'none'}`,
  );

  try {
    if (!featureBranch) {
      mergeTrace('PUBLISH_AFTER_FIX_NO_FEATURE_BRANCH', {
        taskId: task.id,
        gateWorkspacePathFromDb: gateWorkspacePath ?? null,
      });
      console.log(
        `[merge-gate-workspace] publishAfterFix early return (no featureBranch) task=${task.id} ` +
          `will persist workspacePath=${gateWorkspacePath ?? 'NULL'}`,
      );
      setMergeGateReviewReady(host, task.id, {
        config: { runnerKind: 'worktree', summary },
        execution: {
          workspacePath: gateWorkspacePath,
          fixedIntegrationSha: undefined,
          fixedIntegrationRecordedAt: undefined,
          fixedIntegrationSource: undefined,
        },
      });
      await startReviewReadyDependents(host);
      return;
    }

    // Consolidate task branches in the gate clone, starting from the gate
    // clone's current HEAD (which has Claude's fixes).
    if (!gateWorkspacePath) {
      mergeTrace('PUBLISH_AFTER_FIX_MISSING_GATE_PATH', {
        taskId: task.id,
        taskExecutionWorkspacePath: task.execution.workspacePath ?? null,
      });
      console.error(
        `[merge-gate-workspace] publishAfterFix ABORT task=${task.id}: no gate path in DB ` +
          `(task.execution.workspacePath=${task.execution.workspacePath ?? 'none'})`,
      );
      throw new Error('publishAfterFix requires a gate workspace (managed clone), not host.cwd');
    }
    const consolidateDir = gateWorkspacePath;

    // Refresh branch refs from origin (GitHub) into the gate clone.
    // Must detach HEAD first — git refuses to fetch into a checked-out branch.
    const headSha = (await execGitInMergeSafe(host, ['rev-parse', 'HEAD'], gateWorkspacePath)).trim();
    await execGitInMergeSafe(host, ['checkout', '--detach', headSha], gateWorkspacePath);
    await execGitInMergeSafe(host, ['fetch', 'origin', '+refs/heads/*:refs/heads/*'], gateWorkspacePath);
    if (fixedIntegrationSha) {
      try {
        await execGitInMergeSafe(host, ['rev-parse', '--verify', `${fixedIntegrationSha}^{commit}`], gateWorkspacePath);
        await execGitInMergeSafe(host, ['checkout', '--detach', fixedIntegrationSha], gateWorkspacePath);
        mergeTrace('PUBLISH_AFTER_FIX_USE_FIXED_ANCHOR', {
          taskId: task.id,
          fixedIntegrationSha,
          gateWorkspacePath,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        mergeTrace('PUBLISH_AFTER_FIX_ANCHOR_FALLBACK', {
          taskId: task.id,
          fixedIntegrationSha,
          gateWorkspacePath,
          error,
        });
        console.warn(
          `[merge] Post-fix: failed to use fixedIntegrationSha=${fixedIntegrationSha} ` +
          `for ${task.id}; falling back to current gate HEAD. Error: ${error}`,
        );
      }
    }

    // If consolidateAndMerge already pushed featureBranch, remember its tip before we
    // delete/recreate the local branch name. Merging that one commit graph avoids
    // re-merging every experiment/* branch on top of Claude's gate HEAD (which can
    // produce spurious conflicts when resolutions overlap the same files).
    let priorConsolidatedSha: string | undefined;
    try {
      priorConsolidatedSha = (
        await execGitInMergeSafe(host, ['rev-parse', '--verify', featureBranch], consolidateDir)
      ).trim();
    } catch {
      /* no local ref — e.g. consolidate failed before first push */
    }

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
        allowedTaskIds = collectDirectNonMergeTaskIds(mergeT, (id) => host.orchestrator.getTask(id));
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

    let mergedViaPriorConsolidation = false;
    if (priorConsolidatedSha) {
      try {
        const mergeMsg = `Merge ${featureBranch} (workflow consolidation)`;
        await execGitInMergeSafe(
          host,
          ['merge', '--no-ff', '-m', mergeMsg, priorConsolidatedSha],
          consolidateDir,
        );
        mergedViaPriorConsolidation = true;
        console.log(
          `[merge] Post-fix: merged pre-pushed consolidation ${priorConsolidatedSha.slice(0, 7)} → ${featureBranch}`,
        );
      } catch {
        try {
          await execGitInMergeSafe(host, ['merge', '--abort'], consolidateDir);
        } catch {
          /* no merge in progress */
        }
      }
    }

    if (!mergedViaPriorConsolidation) {
      let mergedCount = 0;
      let skippedCount = 0;
      for (const { branch, description } of taskBranches) {
        // Skip branches already merged into HEAD (e.g., resolved by AI fix)
        try {
          await execGitInMergeSafe(host, ['merge-base', '--is-ancestor', branch, 'HEAD'], consolidateDir);
          console.log(`[merge] Post-fix: ${branch} already merged, skipping`);
          skippedCount++;
          continue;
        } catch { /* not an ancestor — needs merging */ }

        console.log(`[merge] Post-fix: merging task branch ${branch} → ${featureBranch}`);
        const branchRepoUrl = workflow?.intermediateRepoUrl?.trim() || undefined;
        const branchAvailable = await ensureLocalBranchForMerge(
          host,
          consolidateDir,
          branch,
          workflow?.repoUrl,
          branchRepoUrl,
        );
        if (!branchAvailable) {
          throw new Error(
            `Cannot merge ${branch}: not found locally, on origin, or in mirror. ` +
            `Dependency branches are required graph inputs and must be available.`,
          );
        }
        const mergeMsg = description ? `Merge ${branch} — ${description}` : `Merge ${branch}`;
        try {
          await execGitInMergeSafe(host, ['merge', '--no-ff', '-m', mergeMsg, branch], consolidateDir);
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          const mergeConflictJson = buildMergeConflictJson(errorText, branch);
          if (mergeConflictJson) {
            throw new Error(mergeConflictJson);
          }
          throw err;
        }
        mergedCount++;
      }
      console.log(`[merge] Post-fix: consolidated ${mergedCount} task branches into ${featureBranch}` +
        (skippedCount > 0 ? ` (skipped ${skippedCount} missing branches)` : ''));
    }

    // Push feature branch directly to origin (GitHub) from the gate clone
    await pushFeatureBranchWithRefLockRetry(host, consolidateDir, featureBranch);

    let fullSummary = summary;
    let vpMarkdownCapture2: string | undefined;
    if (visualProof && host.runVisualProofCapture) {
      const slug = featureBranch.replace(/\//g, '-');
      const vpMarkdown = await host.runVisualProofCapture(baseBranch, featureBranch, slug, workflow?.repoUrl);
      if (vpMarkdown) {
        vpMarkdownCapture2 = vpMarkdown;
        fullSummary = (summary ?? '') + '\n\n' + vpMarkdown;
      }
    }

    if (mergeMode === 'external_review') {
      if (!host.mergeGateProvider) {
        throw new Error('mergeMode is "external_review" but no review provider configured');
      }

      // Route through shared PR-authoring helper for consistent PR bodies.
      const structuredCtxReview = workflowId
        ? await buildPrAuthoringContext(host, workflowId, vpMarkdownCapture2)
        : undefined;
      const prBodyReview = await authorPrBodyForMerge(host, {
        workflowId,
        mergeNodeTaskId: task.id,
        title: workflow?.name ?? 'Workflow',
        baseBranch,
        featureBranch,
        workflowSummary: fullSummary ?? '',
        structuredContext: structuredCtxReview,
        cwd: consolidateDir,
      });

      const result = await host.mergeGateProvider.createReview({
        baseBranch,
        featureBranch,
        title: workflow?.name ?? 'Workflow',
        cwd: consolidateDir,
        body: prBodyReview,
      });
      console.log(`[merge] Post-fix: created/updated GitHub PR: ${result.url}`);



      setMergeGateReviewReady(host, task.id, {
        config: { runnerKind: 'worktree', summary },
        execution: {
          branch: featureBranch,
          workspacePath: gateWorkspacePath,
          reviewUrl: result.url,
          reviewId: result.identifier,
          reviewStatus: 'Awaiting review',
          fixedIntegrationSha: undefined,
          fixedIntegrationRecordedAt: undefined,
          fixedIntegrationSource: undefined,
        },
      });
      await startReviewReadyDependents(host);
      return;
    }

    // manual mode with pull_request onFinish
    if (onFinish === 'pull_request') {
      const structuredCtx = workflowId
        ? await buildPrAuthoringContext(host, workflowId, vpMarkdownCapture2)
        : undefined;
      const prBody = await authorPrBodyForMerge(host, {
        workflowId,
        mergeNodeTaskId: task.id,
        title: workflow?.name ?? 'Workflow',
        baseBranch,
        featureBranch,
        workflowSummary: fullSummary ?? '',
        structuredContext: structuredCtx,
        cwd: consolidateDir,
      });
      const reviewUrl = await host.execPr(baseBranch, featureBranch, workflow?.name ?? 'Workflow', prBody, consolidateDir);
      console.log(`[merge] Post-fix: created pull request ${reviewUrl}`);
      host.persistence.updateTask(task.id, {
        config: { summary },
        execution: { reviewUrl },
      });
    }

    setMergeGateReviewReady(host, task.id, {
      config: { runnerKind: 'worktree', summary },
      execution: {
        branch: featureBranch,
        workspacePath: gateWorkspacePath,
        fixedIntegrationSha: undefined,
        fixedIntegrationRecordedAt: undefined,
        fixedIntegrationSource: undefined,
      },
    });
    await startReviewReadyDependents(host);
    mergeTrace('PUBLISH_AFTER_FIX_DONE', { taskId: task.id });
  } catch (err) {
    // Clean up any in-progress merge in the gate clone
    try { await execGitInMergeSafe(host, ['merge', '--abort'], gateWorkspacePath!); } catch { /* no merge in progress */ }

    const errorMsg = err instanceof Error ? err.message : String(err);
    let outputError = `Post-fix PR prep failed: ${errorMsg}`;
    try {
      const parsed = JSON.parse(errorMsg) as { type?: string };
      if (parsed?.type === 'merge_conflict') {
        outputError = errorMsg;
      }
    } catch {
      // keep prefixed error for non-JSON errors
    }
    mergeTrace('PUBLISH_AFTER_FIX_FAILED', { taskId: task.id, error: errorMsg });
    console.error(`[merge] Post-fix PR prep failed for ${task.id}: ${errorMsg}`);
    const failedResponse: WorkResponse = {
      requestId: `postfix-${task.id}`,
      actionId: task.id,
      executionGeneration: task.execution.generation ?? 0,
      status: 'failed',
      outputs: { exitCode: 1, error: outputError },
    };
    host.orchestrator.handleWorkerResponse(failedResponse);
  }
}

export async function buildMergeSummaryImpl(
  host: MergeRunnerHost,
  workflowId: string,
): Promise<string> {
  const allTasks = host.orchestrator.getAllTasks();
  const workflowTasks = allTasks.filter(
    (t) => t.config.workflowId === workflowId && !t.config.isMergeNode,
  );

  const completed = workflowTasks.filter((t) => t.status === 'completed');
  const failed = workflowTasks.filter((t) => t.status === 'failed');
  const closed = workflowTasks.filter((t) => t.status === 'closed');
  const skipped = workflowTasks.filter(
    (t) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'closed',
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
    `${workflowName} — ${completed.length} tasks completed, ${failed.length} failed, ${closed.length} closed, ${skipped.length} skipped`,
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
    // Resolve pool mirror path so gitDiffStat runs against the correct repo
    const mirrorCwd = workflow?.repoUrl && host.ensureRepoMirrorPath
      ? await host.ensureRepoMirrorPath(workflow.repoUrl)
      : undefined;

    lines.push('<details>');
    lines.push('<summary>File changes per task</summary>');
    lines.push('');
    for (const t of completed) {
      if (t.execution.branch) {
        lines.push(`### ${t.id} — ${t.description}`);
        try {
          const stat = await host.gitDiffStat(t.execution.branch, mirrorCwd ?? undefined);
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

  if (closed.length > 0) {
    lines.push('## Closed Tasks');
    for (const t of closed) {
      lines.push(`- **${t.id}**: ${t.description}`);
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

  const MAX_BODY_LENGTH = 60_000;
  let result = lines.join('\n');
  if (result.length > MAX_BODY_LENGTH) {
    result = result.slice(0, MAX_BODY_LENGTH) + '\n\n---\n*(Summary truncated — exceeded GitHub PR body limit)*';
  }
  return result;
}

export async function consolidateAndMergeImpl(
  host: MergeRunnerHost,
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
  const workflowForMerge =
    workflowId !== undefined && workflowId !== ''
      ? host.persistence.loadWorkflow(workflowId)
      : undefined;
  const repoUrlForMerge = workflowForMerge?.repoUrl;

  const worktreeDir = await host.createMergeWorktree(
    baseCheckoutRef ?? baseBranch,
    'consolidate-' + (workflowId ?? 'default'),
    repoUrlForMerge,
  );
  console.log(`[merge] consolidateAndMerge: featureBranch=${featureBranch}, baseBranch=${baseBranch}, worktree=${worktreeDir}`);

  try {

    // Create feature branch in worktree
    try {
      // createMergeWorktree() already checks out detached HEAD at baseBranch/ref,
      // so branch creation should be relative to current HEAD (not by name lookup).
      await execGitInMergeSafe(host, ['checkout', '-b', featureBranch], worktreeDir);
      console.log(`[merge] Created ${featureBranch} from current base HEAD (${baseBranch})`);
    } catch {
      console.log(`[merge] WARNING: Deleting existing ${featureBranch} to recreate from ${baseBranch}`);
      try {
        await execGitInMergeSafe(host, ['branch', '-D', featureBranch], worktreeDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const missingBranch =
          msg.includes(`branch '${featureBranch}' not found`)
          || msg.includes(`branch \"${featureBranch}\" not found`)
          || msg.includes('not found');
        if (!missingBranch) {
          throw err;
        }
      }
      await execGitInMergeSafe(host, ['checkout', '-b', featureBranch], worktreeDir);
      console.log(`[merge] Recreated ${featureBranch} from current base HEAD (${baseBranch})`);
    }

    const allTasks = host.orchestrator.getAllTasks();
    let allowedTaskIds: Set<string> | undefined;
    if (mergeNodeTaskId && workflowId) {
      const mergeT = allTasks.find((x) => x.id === mergeNodeTaskId && x.config.isMergeNode);
      if (mergeT) {
        allowedTaskIds = collectDirectNonMergeTaskIds(mergeT, (id) => host.orchestrator.getTask(id));
        console.log(
          `[merge] consolidation task set (${allowedTaskIds.size} ids): ${[...allowedTaskIds].sort().join(', ')}`,
        );
        mergeTrace('CONSOLIDATION_TASK_SET', {
          workflowId,
          mergeNodeTaskId,
          ids: [...allowedTaskIds].sort(),
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
    let mergedCount = 0;
    let skippedCount = 0;
    for (const branch of taskBranches) {
      console.log(`[merge] Merging task branch: ${branch} → ${featureBranch}`);
      const branchRepoUrl = workflowForMerge?.intermediateRepoUrl?.trim() || undefined;
      const branchAvailable = await ensureLocalBranchForMerge(
        host,
        worktreeDir,
        branch,
        repoUrlForMerge,
        branchRepoUrl,
      );
      if (!branchAvailable) {
        throw new Error(
          `Cannot merge ${branch}: not found locally, on origin, or in mirror. ` +
          `Dependency branches are required graph inputs and must be available.`,
        );
      }
      const task = allTasks.find(t => t.execution.branch === branch);
      const desc = task?.description ?? '';
      const mergeMsg = desc ? `Merge ${branch} — ${desc}` : `Merge ${branch}`;
      await execGitInMergeSafe(host, ['merge', '--no-ff', '-m', mergeMsg, branch], worktreeDir);
      mergedCount++;
    }
    console.log(`[merge] Consolidated ${mergedCount} task branches into ${featureBranch}` +
      (skippedCount > 0 ? ` (skipped ${skippedCount} missing branches)` : ''));

    // Push feature branch to origin so other clones (e.g., the gate clone used
    // by external review providers can access it. The consolidation clone is removed
    // in the finally block, so without this push the branch would be lost.
    await pushFeatureBranchWithRefLockRetry(host, worktreeDir, featureBranch);

    if (visualProof && onFinish === 'pull_request' && host.runVisualProofCapture) {
      const slug = (featureBranch ?? 'workflow').replace(/\//g, '-');
      const vpMarkdown = await host.runVisualProofCapture(baseBranch, featureBranch, slug, repoUrlForMerge);
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
      await pushFeatureBranchWithRefLockRetry(host, worktreeDir, featureBranch);
      const structuredCtx3 = workflowId
        ? await buildPrAuthoringContext(host, workflowId)
        : undefined;
      const prBody = await authorPrBodyForMerge(host, {
        workflowId,
        mergeNodeTaskId,
        title: workflowName ?? 'Workflow',
        baseBranch,
        featureBranch,
        workflowSummary: body ?? '',
        structuredContext: structuredCtx3,
        cwd: worktreeDir,
      });
      const reviewUrl = await host.execPr(baseBranch, featureBranch, workflowName ?? 'Workflow', prBody, worktreeDir);
      console.log(`[merge] Created pull request: ${reviewUrl}`);
      return reviewUrl;
    }
  } catch (err) {
    console.error(`[merge] consolidateAndMerge FAILED: ${err instanceof Error ? err.message : String(err)}`);
    try { await execGitInMergeSafe(host, ['merge', '--abort'], worktreeDir); } catch { /* no merge in progress */ }
    throw err;
  } finally {
    await host.removeMergeWorktree(worktreeDir);
  }
}
