/**
 * Shared headless infrastructure used across the command-family modules.
 *
 * This module owns the cross-cutting pieces that every headless command
 * family needs: the `HeadlessDeps` contract, TaskRunner construction and
 * wiring, workflow tracking, task/workflow restore + preemption helpers,
 * and query-flag parsing. Keeping it dependency-free of the family modules
 * (run-resume, query-list, approve-delete) keeps the import graph acyclic:
 * the families and the `headless.ts` router import from here, never the
 * other way around.
 */

import type { BundledSkillsInstallMode, BundledSkillsStatus, Logger, WorkerStatusSnapshot } from '@invoker/contracts';
import { makeEnvelope } from '@invoker/contracts';
import { OrchestratorErrorCode } from '@invoker/workflow-core';
import type { Orchestrator, CommandService, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import {
  ExecutorRegistry,
  TaskRunner,
  GitHubMergeGateProvider,
  ReviewProviderRegistry,
  type AgentRegistry,
  type TaskHeartbeatEvent,
} from '@invoker/execution-engine';
import { loadConfig, resolveSecretsFilePath, type InvokerConfig } from './config.js';
import { WorkflowMutationFacade } from './workflow-mutation-facade.js';
import { trackWorkflow } from './headless-watch.js';
import {
  publishReviewGateCiFailedLifecycleEvent,
  publishReviewGateMergeConflictLifecycleEvent,
} from './lifecycle-event-bridge.js';
import type { WorkflowCancelResult } from './workflow-preemption.js';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';
import type { RuntimeServices } from '@invoker/runtime-service';
import type { ReviewGateCiRepairCommandResult } from './review-gate-ci-repair-command.js';


export interface HeadlessDeps {
  logger: Logger;
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  executorRegistry: ExecutorRegistry;
  messageBus: MessageBus;
  commandService: CommandService;
  repoRoot: string;
  invokerConfig: InvokerConfig;
  initServices: () => Promise<void>;
  executionAgentRegistry?: AgentRegistry;
  getUiPerfStats?: () => Record<string, unknown>;
  resetUiPerfStats?: () => void;
  getWorkerStatus?: () => WorkerStatusSnapshot;
  deferRunnableTasks?: (tasks: TaskState[], workflowId?: string) => void;
  preemptTaskSubgraph?: (taskId: string) => Promise<void>;
  preemptWorkflowExecution?: (workflowId: string) => Promise<WorkflowCancelResult>;
  cancelTask?: (taskId: string) => Promise<{ cancelled: string[]; runningCancelled: string[] }>;
  cancelWorkflow?: (workflowId: string) => Promise<{ cancelled: string[]; runningCancelled: string[] }>;
  waitForApproval?: boolean;
  noTrack?: boolean;
  isStandaloneOwnerIdle?: () => boolean;
  getBundledSkillsStatus?: () => BundledSkillsStatus;
  installBundledSkills?: (mode?: BundledSkillsInstallMode) => BundledSkillsStatus;
  repairReviewGateCi?: (prArg: string) => Promise<ReviewGateCiRepairCommandResult>;
  /** Abort signal from the workflow mutation coordinator, if running inside a coordinated mutation. */
  signal?: AbortSignal;
  mutationTiming?: WorkflowMutationTiming;
  runtimeServices?: RuntimeServices;
  /**
   * CB.7: provider for the owner's long-lived TaskRunner. When the
   * launch-outbox is `'active'`, `createHeadlessExecutor` reuses this
   * instance instead of constructing a fresh `TaskRunner` per command.
   * Returning `null` (or omitting the provider entirely) falls back to
   * the legacy behaviour (a new TaskRunner each call). This eliminates
   * Issue 6 (multi-TaskRunner blindness — each runner has its own
   * `launchingAttemptIds` Set) once the outbox dispatcher is the only
   * launch path. The fallback also keeps the function safe to call in
   * environments without an owner-mode TaskRunner (peer mode, tests).
   */
  ownerTaskRunnerProvider?: () => TaskRunner | null;
  /** Main process dist directory (`__dirname` of main.js); used to locate the built web UI. */
  appRootDir?: string;
}

export const RESET = '\x1b[0m';

export const BOLD = '\x1b[1m';

export const YELLOW = '\x1b[33m';

function headlessHeartbeat(
  taskId: string,
  event: TaskHeartbeatEvent,
  deps: Pick<HeadlessDeps, 'orchestrator'>,
): void {
  deps.orchestrator.recordTaskHeartbeat(taskId, { at: event.at, source: event.source });
}

export function buildHeadlessApiServerDeps(
  deps: HeadlessDeps,
  taskExecutor: TaskRunner,
): { mutations: WorkflowMutationFacade; deleteWorkflow: (id: string) => Promise<void>; detachWorkflow: (id: string, upstreamId: string) => Promise<void> } {
  return {
    mutations: new WorkflowMutationFacade({
      logger: deps.logger,
      orchestrator: deps.orchestrator,
      persistence: deps.persistence,
      taskExecutor,
      dispatchMode: deps.mutationTiming ? 'fire-and-forget' : 'await',
      autoApproveAIFixes: deps.invokerConfig?.autoApproveAIFixes,
      killRunningTask: async (taskId: string) => {
        await taskExecutor.killActiveExecution(taskId);
      },
      commandService: deps.commandService,
    }),
    deleteWorkflow: async (workflowId: string) => {
      const allTasks = deps.orchestrator.getAllTasks();
      const workflowTasks = allTasks.filter(
        (t) =>
          t.config.workflowId === workflowId &&
          (t.status === 'running' || t.status === 'fixing_with_ai'),
      );
      for (const task of workflowTasks) {
        await taskExecutor.killActiveExecution(task.id);
      }
      await taskExecutor.closeWorkflowReview(workflowId);
      const envelope = makeEnvelope('delete-workflow', 'headless', 'workflow', { workflowId });
      const cmdResult = await deps.commandService.deleteWorkflow(envelope);
      if (!cmdResult.ok) throw new Error(cmdResult.error.message);
    },
    detachWorkflow: async (workflowId: string, upstreamWorkflowId: string) => {
      const envelope = makeEnvelope('detach-workflow', 'headless', 'workflow', { workflowId, upstreamWorkflowId });
      const cmdResult = await deps.commandService.detachWorkflow(envelope);
      if (!cmdResult.ok) throw new Error(cmdResult.error.message);
    },
  };
}
export function createHeadlessExecutor(
  deps: HeadlessDeps,
  callbackOverrides?: Partial<ConstructorParameters<typeof TaskRunner>[0]['callbacks']>,
): TaskRunner {
  const owner = deps.ownerTaskRunnerProvider?.() ?? null;
  if (owner) {
    if (callbackOverrides) {
      deps.logger?.debug?.(
        '[headless] createHeadlessExecutor: ignoring callbackOverrides — reusing owner TaskRunner',
        { module: 'headless' },
      );
    }
    return owner;
  }
  let executor: TaskRunner;
  executor = new TaskRunner({
    orchestrator: deps.orchestrator,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    cwd: deps.repoRoot,
    defaultBranch: deps.invokerConfig.defaultBranch,
    dockerConfig: {
      imageName: deps.invokerConfig.docker?.imageName,
      secretsFile: resolveSecretsFilePath(deps.invokerConfig),
    },
    remoteTargetsProvider: () => loadConfig().remoteTargets ?? {},
    executionPoolsProvider: () => deps.invokerConfig.executionPools ?? {},
    reviewGateCiFailurePublisher: {
      publish: (trigger) => {
        publishReviewGateCiFailedLifecycleEvent(trigger, {
          messageBus: deps.messageBus,
          getTask: (taskId) => deps.orchestrator.getTask(taskId),
        });
      },
    },
    reviewGateMergeConflictPublisher: {
      publish: (trigger) => {
        publishReviewGateMergeConflictLifecycleEvent(trigger, {
          messageBus: deps.messageBus,
          getTask: (taskId) => deps.orchestrator.getTask(taskId),
        });
      },
    },
    mergeGateProvider: new GitHubMergeGateProvider(),
    reviewProviderRegistry: (() => {
      const registry = new ReviewProviderRegistry();
      registry.register(new GitHubMergeGateProvider());
      return registry;
    })(),
    executionAgentRegistry: deps.executionAgentRegistry,
    callbacks: {
      onOutput: (taskId, data) => {
        process.stdout.write(`\x1b[2m[${taskId}]\x1b[0m ${data}`);
        try {
          deps.persistence.appendTaskOutput(taskId, data);
        } catch (err) {
          deps.logger.error(`Failed to persist output for ${taskId}: ${err}`, { module: 'output' });
        }
      },
      onHeartbeat: (taskId, event) => headlessHeartbeat(taskId, event, deps),
      ...callbackOverrides,
    },
  });
  return executor;
}

export function wireHeadlessApproveHook(deps: HeadlessDeps, te: TaskRunner): void {
  deps.orchestrator.setBeforeApproveHook(async (task) => {
    if (task.config.isMergeNode && task.config.workflowId && task.execution.pendingFixError === undefined) {
      const workflow = deps.persistence.loadWorkflow(task.config.workflowId);
      if (workflow?.mergeMode === "external_review") return;
      await te.approveMerge(task.config.workflowId);
    }
  });
}

export interface QueryFlags {
  output: 'text' | 'label' | 'json' | 'jsonl';
  status?: string;
  workflow?: string;
  noMerge?: boolean;
  reset?: boolean;
  groupBy?: string;
  decision?: string;
  reason?: string;
  positional: string[];
}

export function parseQueryFlags(args: string[]): QueryFlags {
  const flags: QueryFlags = { output: 'text', positional: [] };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--output' && i + 1 < args.length) {
      const val = args[i + 1] as QueryFlags['output'];
      if (!['text', 'label', 'json', 'jsonl'].includes(val)) {
        throw new Error(`Invalid --output format: "${val}". Must be text|label|json|jsonl.`);
      }
      flags.output = val;
      i += 2;
    } else if (arg === '--status' && i + 1 < args.length) {
      flags.status = args[i + 1];
      i += 2;
    } else if (arg === '--workflow' && i + 1 < args.length) {
      flags.workflow = args[i + 1];
      i += 2;
    } else if (arg === '--no-merge') {
      flags.noMerge = true;
      i += 1;
    } else if (arg === '--reset') {
      flags.reset = true;
      i += 1;
    } else if (arg === '--group-by' && i + 1 < args.length) {
      flags.groupBy = args[i + 1];
      i += 2;
    } else if (arg === '--decision' && i + 1 < args.length) {
      const val = args[i + 1];
      if (val !== 'act' && val !== 'skip') {
        throw new Error(`Invalid --decision: "${val}". Must be act|skip.`);
      }
      flags.decision = val;
      i += 2;
    } else if (arg === '--reason' && i + 1 < args.length) {
      flags.reason = args[i + 1];
      i += 2;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown query flag: "${arg}"`);
    } else {
      flags.positional.push(arg);
      i += 1;
    }
  }
  return flags;
}

export async function trackHeadlessWorkflow(
  workflowId: string,
  deps: Pick<HeadlessDeps, 'orchestrator' | 'messageBus'>,
  options: {
    waitForApproval?: boolean;
    hasBackgroundWork?: () => boolean;
    printSnapshot?: boolean;
    printSummary?: boolean;
    printTaskOutput?: boolean;
    allowSignals?: boolean;
    syncFromDb?: boolean;
    setExitCodeOnFailure?: boolean;
  } = {},
): Promise<Awaited<ReturnType<typeof trackWorkflow>>> {
  if (options.waitForApproval) {
    process.stdout.write('[headless] Waiting for PR approval (--wait-for-approval)...\n');
  }
  return await trackWorkflow({
    workflowId,
    messageBus: deps.messageBus,
    waitForApproval: options.waitForApproval,
    hasBackgroundWork: options.hasBackgroundWork,
    printSnapshot: options.printSnapshot,
    printSummary: options.printSummary,
    printTaskOutput: options.printTaskOutput,
    allowSignals: options.allowSignals,
    setExitCodeOnFailure: options.setExitCodeOnFailure,
    maxWaitMs: options.allowSignals ? undefined : (options.waitForApproval ? 86_400_000 : 1_800_000),
    loadTasks: () => {
      if (options.syncFromDb) {
        deps.orchestrator.syncFromDb(workflowId);
      }
      return deps.orchestrator.getAllTasks().filter((task) => task.config.workflowId === workflowId);
    },
  });
}

export function restoreWorkflowForTask(
  taskId: string,
  deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>,
): { workflowId: string; resolvedTaskId: string } {
  const restored = tryRestoreWorkflowForTask(taskId, deps);
  if (restored) {
    return restored;
  }
  throw new Error(`Task "${taskId}" not found in any workflow`);
}

export function tryRestoreWorkflowForTask(
  taskId: string,
  deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>,
): { workflowId: string; resolvedTaskId: string } | null {
  const { orchestrator, persistence } = deps;
  const workflows = persistence.listWorkflows();
  for (const wf of workflows) {
    const tasks = persistence.loadTasks(wf.id);
    const match = tasks.find(t => t.id === taskId || t.id.endsWith('/' + taskId));
    if (match) {
      // Keep lookup read-only: load graph state from DB without starting tasks.
      orchestrator.syncFromDb(wf.id);
      return { workflowId: wf.id, resolvedTaskId: match.id };
    }
  }
  return null;
}

export function restoreWorkflowForTaskUnlessDeleteAllWon(
  taskId: string,
  deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>,
  commandLabel: string,
): { workflowId: string; resolvedTaskId: string } | null {
  const restored = tryRestoreWorkflowForTask(taskId, deps);
  if (restored) {
    return restored;
  }
  if (deps.persistence.listWorkflows().length === 0) {
    process.stdout.write(`[headless] ${commandLabel} skipped: task "${taskId}" was removed by delete-all.\n`);
    return null;
  }
  throw new Error(`Task "${taskId}" not found in any workflow`);
}

export async function withRestoredTaskUnlessDeleteAllWon<T>(
  taskId: string,
  deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>,
  commandLabel: string,
  run: (restored: { workflowId: string; resolvedTaskId: string }) => Promise<T>,
): Promise<T | undefined> {
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, commandLabel);
  if (!restored) return undefined;
  return await run(restored);
}

export async function waitForCompletion(
  orchestrator: Orchestrator,
  workflowId?: string,
  waitForApproval?: boolean,
  hasBackgroundWork?: () => boolean,
): Promise<void> {
  const maxWaitMs = waitForApproval ? 86_400_000 : 1_800_000; // 24 hours if waiting for approval, else 30 minutes
  const pollIntervalMs = 100;
  const start = Date.now();

  if (waitForApproval) {
    process.stdout.write('[headless] Waiting for PR approval (--wait-for-approval)...\n');
  }

  while (Date.now() - start < maxWaitMs) {
    let tasks = orchestrator.getAllTasks();
    if (workflowId) {
      tasks = tasks.filter((t) => t.config.workflowId === workflowId);
    }
    let readyTasks = orchestrator.getReadyTasks();
    if (workflowId) {
      readyTasks = readyTasks.filter((t) => t.config.workflowId === workflowId);
    }
    const settledStatuses = waitForApproval
      ? ['completed', 'failed', 'closed', 'needs_input', 'blocked', 'stale']
      : ['completed', 'failed', 'closed', 'needs_input', 'awaiting_approval', 'review_ready', 'blocked', 'stale'];
    const allSettled = tasks.every((t) => settledStatuses.includes(t.status));
    if (allSettled && !hasBackgroundWork?.()) return;
    // Also settle if nothing is running and at least one task awaits human action.
    // Pending merge gates can't progress until their upstream is approved.
    const noneRunning = !tasks.some(
      (t) => t.status === 'running' || t.status === 'fixing_with_ai',
    );
    const hasReadyPending = readyTasks.some((t) => t.status === 'pending');
    const hasHumanBlocked = tasks.some((t) => settledStatuses.includes(t.status) && t.status !== 'completed');
    if (noneRunning && hasHumanBlocked && !hasBackgroundWork?.()) return;
    if (noneRunning && !hasReadyPending && !hasBackgroundWork?.()) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/** Orchestrator error codes that preemption treats as benign (cancel is best-effort). */
const preemptSkipCodes: ReadonlySet<string> = new Set([
  OrchestratorErrorCode.TASK_NOT_FOUND,
  OrchestratorErrorCode.TASK_ALREADY_TERMINAL,
  OrchestratorErrorCode.WORKFLOW_NOT_FOUND,
]);

export async function preemptTaskSubgraph(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (deps.preemptTaskSubgraph) {
    await deps.preemptTaskSubgraph(taskId);
    return;
  }
  if (typeof deps.commandService.cancelTask !== 'function') return;
  const envelope = makeEnvelope('cancel-task', 'headless', 'task', { taskId });
  const result = await deps.commandService.cancelTask(envelope);
  if (!result.ok) {
    if (preemptSkipCodes.has(result.error.code)) return;
    throw new Error(result.error.message);
  }
}

export async function preemptWorkflowExecution(workflowId: string, deps: HeadlessDeps): Promise<WorkflowCancelResult> {
  if (deps.preemptWorkflowExecution) {
    return deps.preemptWorkflowExecution(workflowId);
  }
  if (typeof deps.commandService.cancelWorkflow !== 'function') {
    return { cancelled: [], runningCancelled: [] };
  }
  const envelope = makeEnvelope('cancel-workflow', 'headless', 'workflow', { workflowId });
  const result = await deps.commandService.cancelWorkflow(envelope);
  if (!result.ok) {
    if (preemptSkipCodes.has(result.error.code)) return { cancelled: [], runningCancelled: [] };
    throw new Error(result.error.message);
  }
  return result.data;
}
