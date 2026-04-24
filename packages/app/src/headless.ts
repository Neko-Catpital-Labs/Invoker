/**
 * Headless CLI logic extracted from main.ts.
 *
 * All functions that implement `--headless <command>` live here.
 * They receive shared services via a `HeadlessDeps` object instead of
 * accessing module-level variables directly.
 *
 * Business logic (orchestrator mutations) lives in workflow-actions.ts.
 * This file handles CLI parsing, TaskRunner lifecycle, and output formatting.
 */

import type { Logger } from '@invoker/contracts';
import { makeEnvelope } from '@invoker/contracts';
import type { Orchestrator, CommandService, TaskDelta, TaskReplacementDef, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import { createDeleteAllSnapshot } from './delete-all-snapshot.js';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import {
  ExecutorRegistry,
  TaskRunner,
  GitHubMergeGateProvider,
  ReviewProviderRegistry,
  remoteFetchForPool,
  registerBuiltinAgents,
  assertPlanExecutionAgentsRegistered,
  type AgentRegistry,
} from '@invoker/execution-engine';
import { loadConfig, resolveSecretsFilePath, type InvokerConfig } from './config.js';
import { backupPlan } from './plan-backup.js';
import { startApiServer, type ApiServerDeps } from './api-server.js';
import {
  approveTask,
  rebaseAndRetry,
  resolveConflictAction,
  recreateWorkflow as sharedRecreateWorkflow,
  recreateTask as sharedRecreateTask,
  forkWorkflow as sharedForkWorkflow,
  setWorkflowMergeMode,
  finalizeAppliedFix,
} from './workflow-actions.js';
import { normalizeMergeModeForPersistence } from './merge-mode.js';
import { openExternalTerminalForTask } from './open-terminal-for-task.js';
import { dispatchStartedTasksWithGlobalTopup, executeGlobalTopup, finalizeMutationWithGlobalTopup } from './global-topup.js';
import {
  delegationTimeoutMs,
  tryDelegateExec,
  tryDelegateQuery,
  tryDelegateResume,
  tryDelegateRun,
} from './headless-delegation.js';
import { trackWorkflow } from './headless-watch.js';
import { preemptWorkflowBeforeMutation, type WorkflowCancelResult } from './workflow-preemption.js';
import { relaunchOrphansAndStartReady } from './orphan-relaunch.js';

export { bumpGenerationAndRecreate } from './workflow-actions.js';
export {
  delegationTimeoutMs,
  tryDelegateExec,
  tryDelegateQuery,
  tryDelegateResume,
  tryDelegateRun,
} from './headless-delegation.js';

// ── HeadlessDeps interface ───────────────────────────────────

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
  setTaskDispatcherExecutor?: (executor: Pick<TaskRunner, 'executeTasks'> | null) => void;
  wireSlackBot: (deps: {
    executor: TaskRunner;
    logFn: (source: string, level: string, message: string) => void;
    approveTaskAction?: (taskId: string) => Promise<void>;
    onPlanLoaded?: () => void;
  }) => Promise<any>;
  getUiPerfStats?: () => Record<string, unknown>;
  resetUiPerfStats?: () => void;
  deferRunnableTasks?: (tasks: TaskState[], workflowId?: string) => void;
  preemptTaskSubgraph?: (taskId: string) => Promise<void>;
  preemptWorkflowExecution?: (workflowId: string) => Promise<WorkflowCancelResult>;
  cancelTask?: (taskId: string) => Promise<{ cancelled: string[]; runningCancelled: string[] }>;
  cancelWorkflow?: (workflowId: string) => Promise<{ cancelled: string[]; runningCancelled: string[] }>;
  waitForApproval?: boolean;
  noTrack?: boolean;
  isStandaloneOwnerIdle?: () => boolean;
}

// ── ANSI Helpers ─────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const YELLOW = '\x1b[33m';

// ── Shared Helpers ───────────────────────────────────────────

function headlessHeartbeat(taskId: string, deps: Pick<HeadlessDeps, 'persistence'>): void {
  const now = new Date();
  try { deps.persistence.updateTask(taskId, { execution: { lastHeartbeatAt: now } }); } catch { /* db locked */ }
}

function buildHeadlessApiCancelHooks(
  deps: HeadlessDeps,
  taskExecutor: TaskRunner,
): Pick<ApiServerDeps, 'cancelTask' | 'cancelWorkflow' | 'killRunningTask'> {
  return {
    killRunningTask: (taskId: string) => taskExecutor.killActiveExecution(taskId),
    cancelTask: async (taskId: string) => {
      const envelope = makeEnvelope('cancel-task', 'headless', 'task', { taskId });
      const cmdResult = await deps.commandService.cancelTask(envelope);
      if (!cmdResult.ok) throw new Error(cmdResult.error.message);
      for (const id of cmdResult.data.runningCancelled) {
        await taskExecutor.killActiveExecution(id);
      }
      return cmdResult.data;
    },
    cancelWorkflow: async (workflowId: string) => {
      const envelope = makeEnvelope('cancel-workflow', 'headless', 'workflow', { workflowId });
      const cmdResult = await deps.commandService.cancelWorkflow(envelope);
      if (!cmdResult.ok) throw new Error(cmdResult.error.message);
      for (const id of cmdResult.data.runningCancelled) {
        await taskExecutor.killActiveExecution(id);
      }
      return cmdResult.data;
    },
  };
}

function buildHeadlessApproveAction(
  deps: Pick<HeadlessDeps, 'orchestrator' | 'commandService'>,
  taskExecutor: TaskRunner,
): (taskId: string) => Promise<{ started: TaskState[] }> {
  return async (taskId: string) => {
    const result = await approveTask(taskId, {
      orchestrator: deps.orchestrator,
      taskExecutor,
      approve: async (approvedTaskId) => {
        const envelope = makeEnvelope('approve', 'headless', 'task', { taskId: approvedTaskId });
        const result = await deps.commandService.approve(envelope);
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
      resumeAfterFixApproval: async (approvedTaskId) => {
        const envelope = makeEnvelope('approve', 'headless', 'task', { taskId: approvedTaskId });
        const result = await deps.commandService.resumeTaskAfterFixApproval(envelope);
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
    });
    return { started: result.started };
  };
}

export function createHeadlessExecutor(
  deps: HeadlessDeps,
  callbackOverrides?: Partial<ConstructorParameters<typeof TaskRunner>[0]['callbacks']>,
): TaskRunner {
  const executor = new TaskRunner({
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
      onHeartbeat: (taskId) => headlessHeartbeat(taskId, deps),
      ...callbackOverrides,
    },
  });
  deps.setTaskDispatcherExecutor?.(executor);
  return executor;
}

export function wireHeadlessAutoFix(
  deps: Pick<HeadlessDeps, 'messageBus' | 'orchestrator' | 'persistence'>,
  taskExecutor: Pick<TaskRunner, 'executeTasks' | 'fixWithAgent' | 'resolveConflict'>,
  invokeAutoFix: (taskId: string) => Promise<void> = async (taskId) => {
    const { autoFixOnFailure } = await import('./workflow-actions.js');
    await autoFixOnFailure(taskId, {
      orchestrator: deps.orchestrator,
      persistence: deps.persistence,
      taskExecutor: taskExecutor as TaskRunner,
      getAutoFixAgent: () => loadConfig().autoFixAgent,
      getAutoApproveAIFixes: () => loadConfig().autoApproveAIFixes,
    });
  },
  onError: (taskId: string, err: unknown) => void = (taskId, err) => {
    process.stderr.write(`[auto-fix] "${taskId}": ${err}\n`);
  },
): HeadlessAutoFixController {
  const autoFixInProgress = new Set<string>();
  const logHeadlessAutoFixDebug = (
    taskId: string,
    phase: string,
    details: Record<string, unknown> = {},
  ): void => {
    const getTask = (deps.orchestrator as { getTask?: (id: string) => unknown }).getTask;
    const task = getTask?.(taskId) as
      | { status?: string; execution?: { autoFixAttempts?: number | null } }
      | undefined;
    const payload = {
      phase,
      status: task?.status ?? 'missing',
      autoFixAttempts: task?.execution?.autoFixAttempts ?? null,
      inProgressCount: autoFixInProgress.size,
      inProgressForTask: autoFixInProgress.has(taskId),
      ...details,
    };
    deps.persistence.logEvent?.(taskId, 'debug.auto-fix', payload);
    process.stderr.write(`[auto-fix-debug][headless] task="${taskId}" phase=${phase} payload=${JSON.stringify(payload)}\n`);
  };

  const unsubscribe = deps.messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
    if (delta.type !== 'updated' || delta.changes.status !== 'failed') return;
    const inProgress = autoFixInProgress.has(delta.taskId);
    const shouldAutoFix = deps.orchestrator.shouldAutoFix(delta.taskId);
    logHeadlessAutoFixDebug(delta.taskId, 'delta-failed', { shouldAutoFix, inProgress });
    if (inProgress || !shouldAutoFix) {
      logHeadlessAutoFixDebug(delta.taskId, 'schedule-skip', {
        reason: !shouldAutoFix ? 'shouldAutoFix-false' : 'already-in-progress',
      });
      return;
    }
    autoFixInProgress.add(delta.taskId);
    logHeadlessAutoFixDebug(delta.taskId, 'dispatch');
    void invokeAutoFix(delta.taskId)
      .catch((err) => {
        logHeadlessAutoFixDebug(delta.taskId, 'dispatch-error', {
          error: err instanceof Error ? err.stack ?? err.message : String(err),
        });
        onError(delta.taskId, err);
      })
      .finally(() => {
        autoFixInProgress.delete(delta.taskId);
        logHeadlessAutoFixDebug(delta.taskId, 'dispatch-finished');
      });
  });
  return {
    unsubscribe,
    isBusy: () => autoFixInProgress.size > 0,
  };
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

// ── Deprecation Warning ─────────────────────────────────────

function warnDeprecated(oldCmd: string, newCmd: string): void {
  process.stderr.write(
    `${YELLOW}[deprecated]${RESET} "${oldCmd}" is deprecated. Use "${newCmd}" instead.\n`,
  );
}

function assertDeleteAllEnabled(): void {
  if (process.env.INVOKER_ALLOW_DELETE_ALL === '1') return;
  throw new Error(
    'delete-all is disabled by default. Set INVOKER_ALLOW_DELETE_ALL=1 to enable it explicitly.',
  );
}

// ── Query Flag Parsing ──────────────────────────────────────

export interface QueryFlags {
  output: 'text' | 'label' | 'json' | 'jsonl';
  status?: string;
  workflow?: string;
  noMerge?: boolean;
  reset?: boolean;
  positional: string[];
}

export interface HeadlessAutoFixController {
  unsubscribe: () => void;
  isBusy: () => boolean;
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
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown query flag: "${arg}"`);
    } else {
      flags.positional.push(arg);
      i += 1;
    }
  }
  return flags;
}

// ── Query Router ────────────────────────────────────────────

async function headlessQuery(args: string[], deps: HeadlessDeps): Promise<void> {
  const subCommand = args[0];
  if (!subCommand) {
    throw new Error('Missing query sub-command. Usage: --headless query <workflows|tasks|task|queue|audit|session|ui-perf>');
  }
  const flags = parseQueryFlags(args.slice(1));

  const {
    formatWorkflowList, formatTaskStatus, formatWorkflowStatus,
    formatEventLog, formatQueueStatus,
    serializeWorkflow, serializeTask, serializeEvent,
    formatAsLabel, formatAsJson, formatAsJsonl,
  } = await import('./formatter.js');

  switch (subCommand) {
    case 'workflows': {
      let workflows = deps.persistence.listWorkflows();
      if (flags.status) {
        workflows = workflows.filter(wf => wf.status === flags.status);
      }
      switch (flags.output) {
        case 'label': process.stdout.write(formatAsLabel(workflows) + '\n'); break;
        case 'json':  process.stdout.write(formatAsJson(workflows.map(serializeWorkflow)) + '\n'); break;
        case 'jsonl': process.stdout.write(formatAsJsonl(workflows.map(serializeWorkflow)) + '\n'); break;
        default:      process.stdout.write(formatWorkflowList(workflows) + '\n'); break;
      }
      break;
    }
    case 'tasks': {
      const { orchestrator, persistence } = deps;
      const workflows = persistence.listWorkflows();
      if (workflows.length === 0) {
        process.stdout.write('No workflows found. Run a plan first.\n');
        return;
      }

      // Support both:
      //   query tasks --workflow <id>
      //   query tasks <workflowId>
      const workflowFilter = flags.workflow ?? flags.positional[0];

      // Load tasks from specific workflow or latest
      const targetWorkflows = workflowFilter
        ? workflows.filter(wf => wf.id === workflowFilter)
        : [workflows[0]];

      if (targetWorkflows.length === 0) {
        throw new Error(`Workflow "${workflowFilter}" not found.`);
      }

      let allTasks: import('@invoker/workflow-core').TaskState[] = [];
      for (const wf of targetWorkflows) {
        // Query must stay read-only: sync graph from DB without starting/restarting tasks.
        orchestrator.syncFromDb(wf.id);
        // Filter by workflow ID — the orchestrator may have loaded other workflows during init.
        allTasks.push(...orchestrator.getAllTasks().filter(t => t.config.workflowId === wf.id));
      }

      // Apply filters
      if (flags.status) {
        allTasks = allTasks.filter(t => t.status === flags.status);
      }
      if (flags.noMerge) {
        allTasks = allTasks.filter(t => !t.config.isMergeNode);
      }

      switch (flags.output) {
        case 'label': process.stdout.write(formatAsLabel(allTasks) + '\n'); break;
        case 'json':  process.stdout.write(formatAsJson(allTasks.map(serializeTask)) + '\n'); break;
        case 'jsonl': process.stdout.write(formatAsJsonl(allTasks.map(serializeTask)) + '\n'); break;
        default: {
          for (const task of allTasks) process.stdout.write(formatTaskStatus(task) + '\n');
          const status = orchestrator.getWorkflowStatus();
          process.stdout.write(`\n${formatWorkflowStatus(status)}\n`);
          break;
        }
      }
      break;
    }
    case 'task': {
      const taskId = flags.positional[0];
      if (!taskId) throw new Error('Usage: --headless query task <taskId>');
      const resolved = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
      const task = deps.orchestrator.getTask(resolved);
      if (!task) throw new Error(`Task "${taskId}" not found`);

      switch (flags.output) {
        case 'label': process.stdout.write(task.id + '\n'); break;
        case 'json':  process.stdout.write(formatAsJson(serializeTask(task)) + '\n'); break;
        case 'jsonl': process.stdout.write(formatAsJsonl([serializeTask(task)]) + '\n'); break;
        default:      process.stdout.write(task.status + '\n'); break;
      }
      break;
    }
    case 'queue': {
      const workflows = deps.persistence.listWorkflows();
      for (const workflow of workflows) {
        deps.orchestrator.syncFromDb(workflow.id);
      }
      const status = deps.orchestrator.getQueueStatus();

      switch (flags.output) {
        case 'label': {
          const ids = [...status.running.map(t => t.taskId), ...status.queued.map(t => t.taskId)];
          process.stdout.write(ids.join('\n') + '\n');
          break;
        }
        case 'json':  process.stdout.write(formatAsJson(status) + '\n'); break;
        case 'jsonl': {
          for (const t of status.running) process.stdout.write(JSON.stringify({ ...t, state: 'running' }) + '\n');
          for (const t of status.queued) process.stdout.write(JSON.stringify({ ...t, state: 'queued' }) + '\n');
          break;
        }
        default: process.stdout.write(formatQueueStatus(status) + '\n'); break;
      }
      break;
    }
    case 'audit': {
      const taskId = flags.positional[0];
      if (!taskId) throw new Error('Usage: --headless query audit <taskId>');
      const events = deps.persistence.getEvents(taskId);

      switch (flags.output) {
        case 'label': process.stdout.write(events.map(e => `${e.taskId}:${e.eventType}`).join('\n') + '\n'); break;
        case 'json':  process.stdout.write(formatAsJson(events.map(serializeEvent)) + '\n'); break;
        case 'jsonl': process.stdout.write(formatAsJsonl(events.map(serializeEvent)) + '\n'); break;
        default:      process.stdout.write(formatEventLog(events) + '\n'); break;
      }
      break;
    }
    case 'session': {
      const taskId = flags.positional[0];
      if (!taskId) throw new Error('Usage: --headless query session <taskId>');
      // For non-text output, we'd need structured session data.
      // For now, session only supports text output; other formats fall through to text.
      await headlessSession(taskId, deps);
      break;
    }
    case 'ui-perf': {
      if (flags.reset) {
        deps.resetUiPerfStats?.();
      }
      const stats = deps.getUiPerfStats?.() ?? {
        ownerMode: 'local',
        ts: new Date().toISOString(),
        mainDeltaToUi: 0,
        dbPollCreated: 0,
        dbPollUpdatedAsCreated: 0,
        dbPollUpdatedAsUpdated: 0,
        rendererReports: 0,
        maxRendererEventLoopLagMs: 0,
        maxRendererLongTaskMs: 0,
      };
      switch (flags.output) {
        case 'label':
          process.stdout.write(String((stats as Record<string, unknown>).maxRendererEventLoopLagMs ?? 0) + '\n');
          break;
        case 'json':
          process.stdout.write(formatAsJson(stats) + '\n');
          break;
        case 'jsonl':
          process.stdout.write(formatAsJsonl([stats]) + '\n');
          break;
        default:
          process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
          break;
      }
      break;
    }
    default:
      throw new Error(`Unknown query sub-command: "${subCommand}". Use: workflows, tasks, task, queue, audit, session, ui-perf`);
  }
}

// ── Set Router ──────────────────────────────────────────────

async function headlessSet(args: string[], deps: HeadlessDeps): Promise<void> {
  const subCommand = args[0];
  if (!subCommand) {
    throw new Error('Missing set sub-command. Usage: --headless set <command|executor|agent|merge-mode|gate-policy>');
  }

  switch (subCommand) {
    case 'command':
      await headlessEdit(args[1], args.slice(2).join(' '), deps);
      break;
    case 'prompt':
      await headlessEditPrompt(args[1], args.slice(2).join(' '), deps);
      break;
    case 'executor':
      await headlessEditExecutor(args[1], args[2], deps);
      break;
    case 'agent':
      await headlessEditAgent(args[1], args[2], deps);
      break;
    case 'merge-mode':
      await headlessSetMergeMode(args[1], args[2], deps);
      break;
    case 'fix-prompt':
      await headlessSetFixContext(args[1], { fixPrompt: args.slice(2).join(' ') }, deps);
      break;
    case 'fix-context':
      await headlessSetFixContext(args[1], { fixContext: args.slice(2).join(' ') }, deps);
      break;
    case 'gate-policy':
      await headlessSetGatePolicy(args.slice(1), deps);
      break;
    default:
      throw new Error(`Unknown set sub-command: "${subCommand}". Use: command, prompt, executor, agent, merge-mode, fix-prompt, fix-context, gate-policy`);
  }
}

async function headlessMigrateCompatibility(deps: HeadlessDeps): Promise<void> {
  const report = deps.persistence.runCompatibilityMigration();
  process.stdout.write(`${BOLD}Compatibility migration complete.${RESET}\n`);
  process.stdout.write(`  migratedFixingWithAiStatuses: ${report.migratedFixingWithAiStatuses}\n`);
  process.stdout.write(`  normalizedMergeModes: ${report.normalizedMergeModes}\n`);
  process.stdout.write(`  staleAutoFixExperimentTasks: ${report.staleAutoFixExperimentTasks}\n`);
}

// ── Headless Command Router ──────────────────────────────────

export async function runHeadless(args: string[], deps: HeadlessDeps): Promise<void> {
  const command = args[0];

  switch (command) {
    case 'owner-serve':
      await headlessOwnerServe(deps);
      break;
    // ── New grouped commands ──
    case 'query':
      await headlessQuery(args.slice(1), deps);
      break;
    case 'set':
      await headlessSet(args.slice(1), deps);
      break;
    case 'migrate-compat':
      await headlessMigrateCompatibility(deps);
      break;
    case 'watch':
      await headlessWatch(args[1], deps);
      break;

    // ── Execute (unchanged) ──
    case 'run':
      await headlessRun(args[1], deps, deps.waitForApproval, deps.noTrack);
      break;
    case 'resume':
      await headlessResume(args[1], deps, deps.waitForApproval, deps.noTrack);
      break;
    case 'retry':
      await headlessRetryWorkflow(args[1], deps);
      break;
    case 'retry-task':
      await headlessRetryTask(args[1], deps);
      break;
    case 'recreate':
      await headlessRecreateWorkflow(args[1], deps);
      break;
    case 'recreate-task':
      await headlessRecreateTask(args[1], deps);
      break;
    case 'replace-task':
      await headlessReplaceTask(args[1], args[2], deps);
      break;
    case 'fork-workflow':
      await headlessForkWorkflow(args[1], deps);
      break;
    case 'rebase':
      await headlessRebaseAndRetry(args[1], deps);
      break;

    // Deprecated aliases
    case 'rebase-and-retry':
      warnDeprecated('rebase-and-retry', 'rebase');
      await headlessRebaseAndRetry(args[1], deps);
      break;
    case 'fix':
      await headlessFix(args[1], deps, args[2]);
      break;
    case 'resolve-conflict':
      await headlessResolveConflict(args[1], deps, args[2]);
      break;

    // ── Respond (unchanged) ──
    case 'approve':
      await headlessApprove(args[1], deps);
      break;
    case 'reject':
      await headlessReject(args[1], deps, args.slice(2).join(' ') || undefined);
      break;
    case 'input':
      await headlessInput(args[1], args.slice(2).join(' '), deps);
      break;
    case 'select':
      await headlessSelect(args[1], args[2], deps);
      break;

    // ── Lifecycle (unchanged) ──
    case 'cancel':
      await headlessCancel(args[1], deps);
      break;
    case 'cancel-workflow':
      await headlessCancelWorkflow(args[1], deps);
      break;
    case 'delete':
    case 'delete-workflow':
      await headlessDeleteWorkflow(args[1], deps);
      break;
    case 'delete-all':
      assertDeleteAllEnabled();
      {
        const snapshot = createDeleteAllSnapshot();
        if (snapshot) {
          process.stderr.write(`[headless] delete-all snapshot: ${snapshot}\n`);
        } else {
          process.stderr.write('[headless] delete-all snapshot skipped: DB file does not exist yet\n');
        }
      }
      deps.orchestrator.deleteAllWorkflows();
      process.stdout.write('All workflows deleted.\n');
      break;
    case 'open-terminal':
      await headlessOpenTerminal(args[1], deps);
      break;
    case 'slack':
      await headlessSlack(deps);
      break;
    case 'query-select':
      await headlessQuerySelect(args[1], deps);
      break;

    // ── Deprecated aliases → query ──
    case 'list':
      warnDeprecated('list', 'query workflows');
      await headlessQuery(['workflows', ...args.slice(1)], deps);
      break;
    case 'status':
      warnDeprecated('status', 'query tasks');
      await headlessQuery(['tasks', ...args.slice(1)], deps);
      break;
    case 'task-status':
      warnDeprecated('task-status', 'query task');
      await headlessQuery(['task', ...args.slice(1)], deps);
      break;
    case 'queue':
      warnDeprecated('queue', 'query queue');
      await headlessQuery(['queue', ...args.slice(1)], deps);
      break;
    case 'audit':
      warnDeprecated('audit', 'query audit');
      await headlessQuery(['audit', ...args.slice(1)], deps);
      break;
    case 'session':
      warnDeprecated('session', 'query session');
      await headlessQuery(['session', ...args.slice(1)], deps);
      break;

    // ── Deprecated aliases → set ──
    case 'edit':
      warnDeprecated('edit', 'set command');
      await headlessSet(['command', ...args.slice(1)], deps);
      break;
    case 'edit-executor':
    case 'edit-type':
      warnDeprecated(command, 'set executor');
      await headlessSet(['executor', ...args.slice(1)], deps);
      break;
    case 'edit-agent':
      warnDeprecated('edit-agent', 'set agent');
      await headlessSet(['agent', ...args.slice(1)], deps);
      break;
    case 'set-merge-mode':
      warnDeprecated('set-merge-mode', 'set merge-mode');
      await headlessSet(['merge-mode', ...args.slice(1)], deps);
      break;

    case '--help':
    case '-h':
    case undefined:
      printHeadlessUsage();
      break;
    default:
      throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

async function headlessOwnerServe(deps: Pick<HeadlessDeps, 'isStandaloneOwnerIdle'>): Promise<void> {
  process.stdout.write('[headless] standalone owner ready; waiting for delegated mutations.\n');
  const idlePollMs = 250;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearInterval(idleTimer);
      resolve();
    };
    const idleTimer = setInterval(() => {
      if (deps.isStandaloneOwnerIdle?.()) {
        finish();
      }
    }, idlePollMs);
    idleTimer.unref?.();
    process.once('SIGTERM', finish);
    process.once('SIGINT', finish);
  });
}

function printHeadlessUsage(): void {
  process.stdout.write(`${BOLD}invoker${RESET} — Headless workflow runner (Electron)

${BOLD}Usage:${RESET}  electron dist/main.js --headless <command> [args...]

${BOLD}Query${RESET} (read-only, all support --output text|label|json|jsonl):
  query workflows [--status S] [--output F]          List all saved workflows
  query tasks [--workflow <id>|<workflowId>] [--status S]
                                                      Show task states (latest workflow by default)
    [--no-merge] [--output F]
  query task <taskId> [--output F]                    Print single task status
  query queue [--output F]                            Show queue status
  query audit <taskId> [--output F]                   Print event history
  query session <taskId>                              Print agent session messages
  query ui-perf [--output F] [--reset]               Print live UI perf stats

${BOLD}Execute:${RESET}
  watch [<workflowId>]                                Watch workflow status until settled or Ctrl-C
  run <plan.yaml>                                     Load and execute plan
  resume <id>                                         Resume incomplete workflow
  retry <workflowId>                                  Retry workflow: rerun failed, keep completed
  retry-task <taskId>                                 Retry a single failed/stuck task
  recreate <workflowId>                                Recreate workflow: wipe all state, new generation
  recreate-task <taskId>                               Recreate task + downstream (task-scoped reset)
  replace-task <taskId> <replacementTasksJson>        Replace a task with new task definitions
  fork-workflow <workflowId>                          Fork a live workflow into a new branched workflow (Step 14)
  rebase <taskId>                                     Refresh pool base + nuclear restart
  fix <taskId> [claude|codex]                         Fix a failed task (default: claude)
  resolve-conflict <taskId> [claude|codex]            Resolve merge conflict + restart

${BOLD}Respond:${RESET}
  approve <taskId>                                    Approve a task
  reject <taskId> [reason]                            Reject a task
  input <taskId> <text>                               Provide input to task
  select <taskId> <experimentId>                      Select winning experiment

${BOLD}Configure:${RESET}
  set command <taskId> <cmd>                          Edit task command and re-run
  set prompt <taskId> <text>                          Edit task prompt and re-run
  set executor <taskId> <type>                        Change executor type (worktree|docker|ssh)
  set agent <taskId> <agent>                          Change execution agent (claude|codex)
  set merge-mode <workflowId> <mode>                  manual | automatic | external_review
  set fix-prompt <taskId> <text>                      Update fix-session prompt and retry
  set fix-context <taskId> <text>                     Update fix-session context and retry
  set gate-policy <taskId> <wfId> [depTaskId] <policy>
                                                      policy: completed | review_ready
  migrate-compat                                     Normalize persisted compatibility workflow/task state

${BOLD}Lifecycle:${RESET}
  cancel <taskId>                                     Cancel task + all downstream
  cancel-workflow <workflowId>                        Cancel all active tasks in a workflow
  delete <workflowId>                                 Delete a single workflow
  delete-all                                          Delete all workflows (requires INVOKER_ALLOW_DELETE_ALL=1)
  open-terminal <taskId>                              Open OS terminal for a task
  slack                                               Start Slack bot (long-running)

${BOLD}Deprecated${RESET} (use new names above):
  list → query workflows       status → query tasks       task-status → query task
  queue → query queue           audit → query audit         session → query session
  edit → set command            edit-executor → set executor
  edit-agent → set agent        set-merge-mode → set merge-mode
  delete-workflow → delete
  rebase-and-retry → rebase

${BOLD}Options:${RESET}
  --wait-for-approval    Keep running until PR approval (use with 'run' or 'resume')
  --no-track             Submit and return immediately after printing Workflow ID
  --do-not-track         Alias for --no-track
`);
}

async function trackHeadlessWorkflow(
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

async function headlessWatch(workflowId: string | undefined, deps: HeadlessDeps): Promise<void> {
  const workflows = deps.persistence.listWorkflows();
  if (workflows.length === 0) {
    process.stdout.write('No workflows found. Run a plan first.\n');
    return;
  }
  const targetWorkflowId = workflowId ?? workflows[0]?.id;
  const workflow = workflows.find((item) => item.id === targetWorkflowId);
  if (!workflow || !targetWorkflowId) {
    throw new Error(`Workflow "${workflowId}" not found.`);
  }

  process.stdout.write(`${BOLD}Watching workflow: ${workflow.id}${RESET}\n\n`);
  const result = await trackHeadlessWorkflow(workflow.id, deps, {
    printSnapshot: true,
    printSummary: true,
    printTaskOutput: false,
    allowSignals: true,
    syncFromDb: true,
    setExitCodeOnFailure: true,
  });
  process.stdout.write(`\n[watch] done — ${result.status.completed} completed, ${result.status.failed} failed\n`);
}

// ── Headless Commands ────────────────────────────────────────

async function headlessRun(
  planPath: string,
  deps: HeadlessDeps,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<void> {
  const { orchestrator, repoRoot, invokerConfig } = deps;
  if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');

  const { readFile } = await import('node:fs/promises');
  const { parsePlanFile } = await import('./plan-parser.js');

  const yamlSource = await readFile(planPath, 'utf-8');
  const plan = await parsePlanFile(planPath);
  const execRegistry = deps.executionAgentRegistry ?? registerBuiltinAgents();
  assertPlanExecutionAgentsRegistered(plan, execRegistry);
  backupPlan(plan, yamlSource, deps.logger);
  process.stdout.write(`${BOLD}Loading plan: ${plan.name}${RESET}\n`);
  process.stdout.write(`Tasks: ${plan.tasks.length}\n\n`);

  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);
  const approveTaskAction = buildHeadlessApproveAction(deps, taskExecutor);

  const api = startApiServer({
    logger: deps.logger,
    orchestrator,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    taskExecutor,
    autoApproveAIFixes: deps.invokerConfig.autoApproveAIFixes,
    approveTaskAction,
    ...buildHeadlessApiCancelHooks(deps, taskExecutor),
  });

  const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
  orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
  const currentWorkflowId = orchestrator.getWorkflowIds().find((id) => !wfIdsBefore.has(id));
  if (currentWorkflowId) process.stdout.write(`Workflow ID: ${currentWorkflowId}\n`);

  const started = orchestrator.startExecution();
  void started;

  if (noTrack) {
    process.stdout.write('[headless] --no-track enabled: submission accepted; exiting without tracking.\n');
    await api.close().catch(() => {});
    return;
  }

  if (currentWorkflowId) {
    await trackHeadlessWorkflow(currentWorkflowId, deps, {
      waitForApproval,
      hasBackgroundWork: autoFix.isBusy,
      printSnapshot: true,
      printSummary: true,
      printTaskOutput: true,
      setExitCodeOnFailure: true,
    });
  }

  await api.close().catch(() => {});
  autoFix.unsubscribe();
}

async function headlessResume(
  workflowId: string,
  deps: HeadlessDeps,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<void> {
  const { orchestrator } = deps;
  if (!workflowId) throw new Error('Missing workflowId. Usage: --headless resume <id>');

  process.stdout.write(`${BOLD}Resuming workflow: ${workflowId}${RESET}\n\n`);

  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);
  const approveTaskAction = buildHeadlessApproveAction(deps, taskExecutor);

  const api = startApiServer({
    logger: deps.logger,
    orchestrator,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    taskExecutor,
    autoApproveAIFixes: deps.invokerConfig.autoApproveAIFixes,
    approveTaskAction,
    ...buildHeadlessApiCancelHooks(deps, taskExecutor),
  });

  orchestrator.syncFromDb(workflowId);
  const allStarted = relaunchOrphansAndStartReady(orchestrator, deps.logger, 'headless', workflowId);

  if (noTrack) {
    if (allStarted.length > 0) {
      void Promise.resolve()
        .then(() => taskExecutor.executeTasks(allStarted))
        .catch((err) => {
          deps.logger.error(
            `background no-track resume failed for ${workflowId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
            { module: 'headless' },
          );
        });
    }
    process.stdout.write('[headless] --no-track enabled: resume accepted; exiting without tracking.\n');
    await api.close().catch(() => {});
    autoFix.unsubscribe();
    return;
  }

  if (allStarted.length === 0) {
    await api.close().catch(() => {});
    autoFix.unsubscribe();
    return;
  }

  await taskExecutor.executeTasks(allStarted);

  await trackHeadlessWorkflow(workflowId, deps, {
    waitForApproval,
    hasBackgroundWork: autoFix.isBusy,
    printSnapshot: true,
    printSummary: true,
    printTaskOutput: true,
    setExitCodeOnFailure: true,
  });

  await api.close().catch(() => {});
  autoFix.unsubscribe();
}

async function headlessApprove(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing taskId.');
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;
  const te = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, te);
  const autoFix = wireHeadlessAutoFix(deps, te);
  const approveTaskAction = buildHeadlessApproveAction(deps, te);
  const beforeStatus = deps.orchestrator.getWorkflowStatus(restored.workflowId);
  const { started } = await approveTaskAction(taskId);
  await finalizeMutationWithGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor: te,
    logger: deps.logger,
    context: 'headless.approve',
    started,
  });
  process.stdout.write(`Approved task: ${taskId}\n`);
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: approve accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  const afterStatus = deps.orchestrator.getWorkflowStatus(restored.workflowId);
  const readyTasks = deps
    .orchestrator
    .getReadyTasks()
    .filter((task) => task.config.workflowId === restored.workflowId && task.status === 'pending');
  const resumedWork =
    afterStatus.running > beforeStatus.running
    || afterStatus.pending < beforeStatus.pending
    || readyTasks.length > 0
    || started.some((task) => task.config.workflowId === restored.workflowId && task.status === 'running');
  if (!resumedWork) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}

async function headlessReject(taskId: string, deps: Pick<HeadlessDeps, 'commandService' | 'orchestrator' | 'persistence'>, reason?: string): Promise<void> {
  if (!taskId) throw new Error('Missing taskId.');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  const envelope = makeEnvelope('reject', 'headless', 'task', { taskId, reason });
  const result = await deps.commandService.reject(envelope);
  if (!result.ok) throw new Error(result.error.message);
  process.stdout.write(`Rejected task: ${taskId}${reason ? ` (reason: ${reason})` : ''}\n`);
}

async function headlessInput(taskId: string, text: string, deps: Pick<HeadlessDeps, 'commandService' | 'orchestrator' | 'persistence'>): Promise<void> {
  if (!taskId || !text) throw new Error('Missing arguments. Usage: --headless input <taskId> <text>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  const envelope = makeEnvelope('provide-input', 'headless', 'task', { taskId, input: text });
  const result = await deps.commandService.provideInput(envelope);
  if (!result.ok) throw new Error(result.error.message);
  process.stdout.write(`Input provided to task: ${taskId}\n`);
}

async function headlessSelect(taskId: string, experimentId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !experimentId) throw new Error('Missing arguments. Usage: --headless select <taskId> <expId>');
  const { workflowId, resolvedTaskId } = restoreWorkflowForTask(taskId, deps);
  const envelope = makeEnvelope('select-experiment', 'headless', 'task', { taskId: resolvedTaskId, experimentId });
  const result = await deps.commandService.selectExperiment(envelope);
  if (!result.ok) throw new Error(result.error.message);
  process.stdout.write(`Selected experiment ${experimentId} for task: ${resolvedTaskId}\n`);

  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);
  const started = deps.orchestrator.resumeWorkflow(workflowId);
  void started;
  await trackHeadlessWorkflow(workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}

async function headlessRetryTask(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing arguments. Usage: --headless retry-task <taskId>');
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;
  await preemptTaskSubgraph(taskId, deps);

  const envelope = makeEnvelope('restart-task', 'headless', 'task', { taskId });
  const result = await deps.commandService.retryTask(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter(t => t.status === 'running');
  process.stdout.write(`Restarted task "${taskId}" — ${runnable.length} task(s) to execute\n`);

  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);
  const { topup } = await dispatchStartedTasksWithGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor,
    logger: deps.logger,
    context: 'headless.restart-task',
    started: result.data,
  });
  if (runnable.length + topup.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}

async function headlessFix(taskId: string, deps: HeadlessDeps, agentArg?: string): Promise<void> {
  if (!taskId) throw new Error('Missing taskId. Usage: --headless fix <taskId> [claude|codex]');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  const { savedError } = deps.orchestrator.beginConflictResolution(taskId);
  const agent = (agentArg ?? 'claude').toLowerCase();
  const isMergeConflictError = (() => {
    const candidates = [
      savedError,
      savedError.trim(),
      savedError.split('\n\n').at(-1)?.trim() ?? '',
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate) as { type?: unknown };
        if (parsed?.type === 'merge_conflict') return true;
      } catch {
        // ignore parse errors; this helper is best-effort
      }
    }
    return false;
  })();
  try {
    const output = deps.persistence.getTaskOutput(taskId);
    if (isMergeConflictError) {
      // For merge_conflict failures, run the deterministic conflict resolver first,
      // then gate rerun behind explicit approve/reject like normal fix flow.
      await te.resolveConflict(taskId, savedError, agent);
    } else {
      await te.fixWithAgent(taskId, output, agent, savedError);
    }
    const result = await finalizeAppliedFix(taskId, savedError, {
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      autoApproveAIFixes: deps.invokerConfig.autoApproveAIFixes,
    });
    await finalizeMutationWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.fix-with-agent',
      started: result.started,
    });
    process.stdout.write(
      result.autoApproved
        ? `Fix applied and auto-approved for task: ${taskId} (${agent}).\n`
        : `Fix applied for task: ${taskId} (${agent}). Use 'approve ${taskId}' or 'reject ${taskId}' to finalize.\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.persistence.appendTaskOutput(taskId, `\n[Fix with AI] Failed: ${msg}`);
    deps.orchestrator.revertConflictResolution(taskId, savedError, msg);
    await finalizeMutationWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.fix-with-agent.failure',
    });
    throw err;
  } finally {
    autoFix.unsubscribe();
  }
}

async function headlessResolveConflict(taskId: string, deps: HeadlessDeps, agentArg?: string): Promise<void> {
  if (!taskId) throw new Error('Missing taskId. Usage: --headless resolve-conflict <taskId> [claude|codex]');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  const agent = (agentArg ?? 'claude').toLowerCase();
  try {
    const result = await resolveConflictAction(taskId, {
      ...deps,
      taskExecutor: te,
      autoApproveAIFixes: deps.invokerConfig.autoApproveAIFixes,
    }, agent);
    await finalizeMutationWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.resolve-conflict',
      started: result.started,
    });
    process.stdout.write(
      deps.invokerConfig.autoApproveAIFixes
        ? `Conflict resolved and auto-approved for task: ${taskId} (${agent}).\n`
        : `Conflict resolved for task: ${taskId} (${agent}). Use 'approve ${taskId}' or 'reject ${taskId}' to finalize.\n`,
    );
  } catch (err) {
    await finalizeMutationWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.resolve-conflict.failure',
    });
    throw err;
  } finally {
    autoFix.unsubscribe();
  }
}

async function headlessRebaseAndRetry(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing arguments. Usage: --headless rebase-and-retry <taskId>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  const workflowId = deps.orchestrator.getTask(taskId)?.config.workflowId;
  if (!workflowId) throw new Error(`Task "${taskId}" has no workflow`);
  await preemptWorkflowBeforeMutation(workflowId, {
    preemptWorkflowExecution: (id) => preemptWorkflowExecution(id, deps),
    logger: deps.logger,
    context: 'headless.rebase-and-retry',
  });

  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  const started = await rebaseAndRetry(taskId, { ...deps, taskExecutor: te });
  const runnable = started.filter(t => t.status === 'running');
  const { topup } = await dispatchStartedTasksWithGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor: te,
    logger: deps.logger,
    context: 'headless.rebase-and-retry',
    started,
  });
  if (runnable.length + topup.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: rebase accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();

  const tasksStarted = runnable.length;
  process.stdout.write(`Rebase-and-retry: resetting workflow from current HEAD (${tasksStarted} task(s))\n`);
}

async function headlessRecreateWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowId) {
    throw new Error('Missing arguments. Usage: --headless recreate <workflowId>');
  }
  await preemptWorkflowBeforeMutation(workflowId, {
    preemptWorkflowExecution: (id) => preemptWorkflowExecution(id, deps),
    logger: deps.logger,
    context: 'headless.recreate-workflow',
  });
  const started = sharedRecreateWorkflow(workflowId, { persistence: deps.persistence, orchestrator: deps.orchestrator });
  const runnable = started.filter(t => t.status === 'running');
  if (runnable.length > 0) {
    const te = createHeadlessExecutor(deps);
    const autoFix = wireHeadlessAutoFix(deps, te);
    remoteFetchForPool.enabled = false;
    let topup: TaskState[] = [];
    try {
      await te.executeTasks(runnable);
      topup = await executeGlobalTopup({
        orchestrator: deps.orchestrator,
        taskExecutor: te,
        logger: deps.logger,
        context: 'headless.recreate-workflow',
        alreadyDispatched: runnable,
      });
    } finally {
      remoteFetchForPool.enabled = true;
    }
    if (runnable.length + topup.length === 0) {
      autoFix.unsubscribe();
      return;
    }
    if (deps.noTrack) {
      process.stdout.write('[headless] --no-track enabled: recreate accepted; exiting without tracking.\n');
      autoFix.unsubscribe();
      return;
    }
    await trackHeadlessWorkflow(workflowId, deps, {
      hasBackgroundWork: autoFix.isBusy,
      printSummary: false,
      printTaskOutput: true,
      setExitCodeOnFailure: false,
    });
    autoFix.unsubscribe();
  }
  const tasksStarted = runnable.length;
  process.stdout.write(`Recreate workflow "${workflowId}" — ${tasksStarted} task(s) to execute (pool fetch skipped)\n`);
}

async function headlessRecreateTask(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) {
    throw new Error('Missing arguments. Usage: --headless recreate-task <taskId>');
  }
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  await preemptTaskSubgraph(taskId, deps);

  const started = sharedRecreateTask(taskId, { persistence: deps.persistence, orchestrator: deps.orchestrator });
  const runnable = started.filter(t => t.status === 'running');
  const workflowId = deps.orchestrator.getTask(taskId)?.config.workflowId;
  process.stdout.write(`Recreate task "${taskId}" (+ downstream) — ${runnable.length} task(s) to execute (pool fetch skipped)\n`);
  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  remoteFetchForPool.enabled = false;
  let topup: TaskState[] = [];
  try {
    ({ topup } = await dispatchStartedTasksWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.recreate-task',
      started,
    }));
  } finally {
    remoteFetchForPool.enabled = true;
  }
  if (runnable.length + topup.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: recreate-task accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  if (workflowId) {
    await trackHeadlessWorkflow(workflowId, deps, {
      hasBackgroundWork: autoFix.isBusy,
      printSummary: false,
      printTaskOutput: true,
      setExitCodeOnFailure: false,
    });
  }
  autoFix.unsubscribe();
}

async function headlessReplaceTask(
  taskId: string,
  replacementTasksJson: string | undefined,
  deps: HeadlessDeps,
): Promise<void> {
  if (!taskId || !replacementTasksJson) {
    throw new Error('Missing arguments. Usage: --headless replace-task <taskId> <replacementTasksJson>');
  }
  let replacementTasks: TaskReplacementDef[];
  try {
    const parsed = JSON.parse(replacementTasksJson) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Replacement tasks must be a JSON array');
    replacementTasks = parsed as TaskReplacementDef[];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid replacementTasks JSON: ${reason}`);
  }

  // Step 14 (`docs/architecture/task-invalidation-roadmap.md`,
  // chart "Topology inconsistency"): for *live* workflows
  // `Orchestrator.replaceTask` now routes the topology mutation
  // through `forkWorkflow` and lands the replacement on a brand-new
  // workflow id. We snapshot the source workflow id BEFORE issuing
  // the command so we can detect the redirect and report the new id
  // to the caller. Terminal workflows still mutate in place, so the
  // pre-/post- ids match and we report the in-place result.
  const sourceWorkflowId = deps.orchestrator.getTask?.(taskId)?.config.workflowId;
  const envelope = makeEnvelope('replace-task', 'headless', 'task', { taskId, replacementTasks });
  const result = await deps.commandService.replaceTask(envelope);
  if (!result.ok) throw new Error(result.error.message);

  const taskExecutor = createHeadlessExecutor(deps);
  const { runnable } = await dispatchStartedTasksWithGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor,
    logger: deps.logger,
    context: 'headless.replace-task',
    started: result.data,
  });

  const landedWorkflowId = result.data[0]?.config.workflowId;
  if (sourceWorkflowId && landedWorkflowId && landedWorkflowId !== sourceWorkflowId) {
    process.stdout.write(
      `Live-workflow topology mutation: forked ${sourceWorkflowId} → ${landedWorkflowId}; ` +
        `replaced task ${taskId} with ${replacementTasks.length} task(s) in the fork; ` +
        `launched ${runnable.length} task(s)\n`,
    );
  } else {
    process.stdout.write(
      `Replaced task ${taskId} with ${replacementTasks.length} task(s); launched ${runnable.length} task(s)\n`,
    );
  }
}

async function headlessForkWorkflow(
  workflowId: string,
  deps: HeadlessDeps,
): Promise<void> {
  if (!workflowId) {
    throw new Error('Missing arguments. Usage: --headless fork-workflow <workflowId>');
  }
  const result = sharedForkWorkflow(workflowId, {
    orchestrator: deps.orchestrator,
    logger: deps.logger,
  });
  const taskExecutor = createHeadlessExecutor(deps);
  const { runnable } = await dispatchStartedTasksWithGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor,
    logger: deps.logger,
    context: 'headless.fork-workflow',
    started: result.started,
  });
  process.stdout.write(
    `Forked workflow ${result.sourceWorkflowId} → ${result.forkedWorkflowId}; ` +
      `launched ${runnable.length} task(s)\n`,
  );
}

async function headlessRetryWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowId) {
    throw new Error('Missing arguments. Usage: --headless retry <workflowId>');
  }
  deps.logger.info(`headlessRetryWorkflow begin workflow="${workflowId}" noTrack=${deps.noTrack ? 'true' : 'false'}`, {
    module: 'headless',
  });
  await preemptWorkflowBeforeMutation(workflowId, {
    preemptWorkflowExecution: (id) => preemptWorkflowExecution(id, deps),
    logger: deps.logger,
    context: 'headless.retry-workflow',
  });
  const envelope = makeEnvelope('retry-workflow', 'headless', 'workflow', { workflowId });
  const result = await deps.commandService.retryWorkflow(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const statusCounts = result.data.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});
  deps.logger.info(
    `headlessRetryWorkflow trace workflow="${workflowId}" retryResult total=${result.data.length} statusCounts=${JSON.stringify(statusCounts)}`,
    { module: 'headless' },
  );
  const retryRunningSummary = result.data
    .filter((task) => task.status === 'running')
    .map((task) => `${task.id}(${task.config.workflowId ?? 'unknown'})`);
  if (retryRunningSummary.length > 0) {
    deps.logger.info(
      `headlessRetryWorkflow trace workflow="${workflowId}" retryResult running=[${retryRunningSummary.join(', ')}]`,
      { module: 'headless' },
    );
  }
  const runnable = result.data.filter((t) => t.status === 'running');
  const crossWorkflow = runnable.filter((t) => t.config.workflowId !== workflowId);
  if (crossWorkflow.length > 0) {
    deps.logger.info(
      `headlessRetryWorkflow dispatching cross-workflow runnable tasks for "${workflowId}": ${crossWorkflow.map((task) => `${task.id}(${task.config.workflowId ?? 'unknown'})`).join(', ')}`,
      { module: 'headless' },
    );
  }
  deps.logger.info(`headlessRetryWorkflow retry complete workflow="${workflowId}" runnable=${runnable.length}`, {
    module: 'headless',
  });

  const runningKey = (task: TaskState): string => {
    const attemptId = task.execution.selectedAttemptId?.trim();
    return attemptId ? `attempt:${attemptId}` : `task:${task.id}`;
  };
  const scopedKeys = new Set(runnable.map((task) => runningKey(task)));
  const globalTopup = deps.orchestrator
    .startExecution()
    .filter((task) => task.status === 'running')
    .filter((task) => !scopedKeys.has(runningKey(task)));
  deps.logger.info(
    `headlessRetryWorkflow trace workflow="${workflowId}" postStartExecution globalTopup=${globalTopup.length}`,
    { module: 'headless' },
  );
  if (globalTopup.length > 0) {
    deps.logger.info(
      `headlessRetryWorkflow trace workflow="${workflowId}" globalTopup running=[${globalTopup.map((task) => `${task.id}(${task.config.workflowId ?? 'unknown'})`).join(', ')}]`,
      { module: 'headless' },
    );
  }
  const dispatchable = [...runnable, ...globalTopup];
  deps.logger.info(
    `headlessRetryWorkflow trace workflow="${workflowId}" dispatchable=${dispatchable.length} ids=[${dispatchable.map((task) => `${task.id}(${task.config.workflowId ?? 'unknown'})`).join(', ')}]`,
    { module: 'headless' },
  );

  process.stdout.write(`Retry workflow "${workflowId}" — ${dispatchable.length} task(s) to execute (completed tasks preserved)\n`);
  if (dispatchable.length === 0) return;

  if (deps.noTrack) {
    if (deps.deferRunnableTasks) {
      deps.deferRunnableTasks(dispatchable, workflowId);
    } else {
      const te = createHeadlessExecutor(deps);
      const launch = setTimeout(() => {
        void te.executeTasks(dispatchable).catch((err) => {
          deps.logger.error(
            `background no-track workflow retry failed for ${workflowId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
            { module: 'headless' },
          );
        });
      }, 25);
      launch.unref?.();
    }
    process.stdout.write('[headless] --no-track enabled: retry accepted; exiting without tracking.\n');
    return;
  }

  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  remoteFetchForPool.enabled = false;
  let topup: TaskState[] = [];
  try {
    ({ topup } = await dispatchStartedTasksWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.retry-workflow',
      started: dispatchable,
    }));
  } finally {
    remoteFetchForPool.enabled = true;
  }
  if (runnable.length + topup.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}

async function preemptTaskSubgraph(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (deps.preemptTaskSubgraph) {
    await deps.preemptTaskSubgraph(taskId);
    return;
  }
  if (typeof deps.commandService.cancelTask !== 'function') return;
  const envelope = makeEnvelope('cancel-task', 'headless', 'task', { taskId });
  const result = await deps.commandService.cancelTask(envelope);
  if (!result.ok) {
    const message = result.error.message;
    if (message.includes('already completed') || message.includes('already stale')) return;
    throw new Error(message);
  }
}

async function preemptWorkflowExecution(workflowId: string, deps: HeadlessDeps): Promise<WorkflowCancelResult> {
  if (deps.preemptWorkflowExecution) {
    return deps.preemptWorkflowExecution(workflowId);
  }
  if (typeof deps.commandService.cancelWorkflow !== 'function') {
    return { cancelled: [], runningCancelled: [] };
  }
  const envelope = makeEnvelope('cancel-workflow', 'headless', 'workflow', { workflowId });
  const result = await deps.commandService.cancelWorkflow(envelope);
  if (!result.ok) {
    const message = result.error.message;
    if (message.includes('No tasks found for workflow')) return { cancelled: [], runningCancelled: [] };
    throw new Error(message);
  }
  return result.data;
}

async function headlessEdit(taskId: string, newCommand: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !newCommand) throw new Error('Missing arguments. Usage: --headless edit <taskId> <newCommand>');
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const envelope = makeEnvelope('edit-task-command', 'headless', 'task', { taskId, newCommand });
  const result = await deps.commandService.editTaskCommand(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter((task) => task.status === 'running');
  if (runnable.length > 0) {
    await taskExecutor.executeTasks(runnable);
  }
  process.stdout.write(`Edited task "${taskId}" command → "${newCommand}"\n`);

  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set command accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  if (runnable.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}

async function headlessEditPrompt(taskId: string, newPrompt: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !newPrompt) throw new Error('Missing arguments. Usage: --headless set prompt <taskId> <newPrompt>');
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const envelope = makeEnvelope('edit-task-prompt', 'headless', 'task', { taskId, newPrompt });
  const result = await deps.commandService.editTaskPrompt(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter((task) => task.status === 'running');
  if (runnable.length > 0) {
    await taskExecutor.executeTasks(runnable);
  }
  process.stdout.write(`Edited task "${taskId}" prompt → "${newPrompt}"\n`);

  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set prompt accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  if (runnable.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}

async function headlessEditExecutor(taskId: string, executorType: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !executorType) throw new Error('Missing arguments. Usage: --headless edit-executor <taskId> <executorType>');
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const envelope = makeEnvelope('edit-task-type', 'headless', 'task', { taskId, executorType });
  const result = await deps.commandService.editTaskType(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter((task) => task.status === 'running');
  if (runnable.length > 0) {
    await taskExecutor.executeTasks(runnable);
  }
  process.stdout.write(`Edited task "${taskId}" executor → "${executorType}"\n`);

  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set executor accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  if (runnable.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}

async function headlessEditAgent(taskId: string, agentName: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !agentName) throw new Error('Missing arguments. Usage: --headless edit-agent <taskId> <claude|codex>');
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const envelope = makeEnvelope('edit-task-agent', 'headless', 'task', { taskId, agentName });
  const result = await deps.commandService.editTaskAgent(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter((task) => task.status === 'running');
  if (runnable.length > 0) {
    await taskExecutor.executeTasks(runnable);
  }
  process.stdout.write(`Edited task "${taskId}" agent → "${agentName}"\n`);

  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set agent accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  if (runnable.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}

async function headlessQuerySelect(taskId: string, deps: Pick<HeadlessDeps, 'persistence'>): Promise<void> {
  if (!taskId) throw new Error('Missing taskId.');
  const selected = deps.persistence.getSelectedExperiment(taskId);
  process.stdout.write((selected
    ? `Selected experiment for ${taskId}: ${selected}`
    : `No experiment selected for ${taskId}`) + '\n');
}

/**
 * Resolve an agent session by ID via registered SessionDriver.
 * Shared by IPC handler (main.ts) and headless CLI (below).
 *
 * Flow: driver.loadSession() → driver.fetchRemoteSession() → driver.parseSession().
 * Each agent owns its own session resolution logic.
 */
export async function resolveAgentSession(
  sessionId: string,
  agentName: string,
  registry?: AgentRegistry,
  allTasks?: import('@invoker/workflow-core').TaskState[],
): Promise<import('@invoker/execution-engine').AgentMessage[] | null> {
  const driver = registry?.getSessionDriver(agentName);
  if (!driver) return null;

  // 1. Try local
  const raw = driver.loadSession(sessionId);
  if (raw) return driver.parseSession(raw);

  // 2. Try remote (SSH tasks)
  if (driver.fetchRemoteSession && allTasks) {
    const sshTask = allTasks.find(
      t => t.execution.agentSessionId === sessionId
        && t.config.executorType === 'ssh',
    );
    if (sshTask) {
      const { loadConfig } = await import('./config.js');
      const targets = loadConfig().remoteTargets ?? {};
      const targetId = sshTask.config.remoteTargetId;
      const target = targetId
        ? targets[targetId]
        : Object.values(targets)[0];
      if (target) {
        const remoteRaw = await driver.fetchRemoteSession(sessionId, target);
        if (remoteRaw) return driver.parseSession(remoteRaw);
      }
    }
  }

  return null;
}

async function headlessSession(taskId: string | undefined, deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence' | 'executionAgentRegistry'>): Promise<void> {
  if (!taskId) throw new Error('Usage: --headless session <taskId>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  const task = deps.orchestrator.getTask(taskId);
  if (!task) throw new Error(`Task "${taskId}" not found`);

  let sessionId = task.execution.agentSessionId ?? task.execution.lastAgentSessionId;
  let agentName = task.execution.agentName ?? task.execution.lastAgentName ?? 'claude';

  // Fallback: if current execution dropped agentSessionId, recover the most
  // recent session from task event payloads.
  if (!sessionId) {
    const events = deps.persistence.getEvents(taskId) ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const payload = events[i].payload;
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload);
        const exec = parsed?.execution;
        if (exec?.agentSessionId) {
          sessionId = String(exec.agentSessionId);
          if (exec.agentName) {
            agentName = String(exec.agentName);
          }
          process.stdout.write(`Recovered agent session from event log: ${sessionId}\n`);
          break;
        }
      } catch {
        // Ignore malformed payload JSON
      }
    }
  }

  if (!sessionId) {
    process.stdout.write(`No agent session for task "${taskId}"\n`);
    return;
  }

  process.stdout.write(`agent=${agentName} sessionId=${sessionId}\n`);

  const allTasks = deps.orchestrator.getAllTasks();
  const messages = await resolveAgentSession(sessionId, agentName, deps.executionAgentRegistry, allTasks);
  if (!messages) {
    process.stdout.write('Session file not found\n');
    return;
  }
  for (const msg of messages) {
    process.stdout.write(`[${msg.role}] ${msg.content}\n`);
  }
}

async function headlessCancel(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing taskId. Usage: --headless cancel <taskId>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  if (deps.cancelTask) {
    const result = await deps.cancelTask(taskId);
    process.stdout.write(`Cancelled ${result.cancelled.length} task(s): [${result.cancelled.join(', ')}]\n`);
    if (result.runningCancelled.length > 0) {
      process.stdout.write(`Killed running: [${result.runningCancelled.join(', ')}]\n`);
    }
    return;
  }

  // Peer submit-plan / headless run holds the TaskRunner in another process; hit its local API so
  // cancel also kills the executor child (DB-only cancel would let the command keep running).
  const port = process.env.INVOKER_API_PORT;
  if (port) {
    const url = `http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(taskId)}/cancel`;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10_000);
      const res = await fetch(url, { method: 'POST', signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = (await res.json()) as { cancelled?: string[]; runningCancelled?: string[] };
        const cancelled = data.cancelled ?? [];
        const runningCancelled = data.runningCancelled ?? [];
        process.stdout.write(`Cancelled ${cancelled.length} task(s): [${cancelled.join(', ')}]\n`);
        if (runningCancelled.length > 0) {
          process.stdout.write(`Killed running: [${runningCancelled.join(', ')}]\n`);
        }
        return;
      }
    } catch {
      /* API unreachable — fall back to DB-only cancel */
    }
  }

  const envelope = makeEnvelope('cancel-task', 'headless', 'task', { taskId });
  const cmdResult = await deps.commandService.cancelTask(envelope);
  if (!cmdResult.ok) throw new Error(cmdResult.error.message);
  const te = createHeadlessExecutor(deps);
  await finalizeMutationWithGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor: te,
    logger: deps.logger,
    context: 'headless.cancel-task',
  });
  process.stdout.write(`Cancelled ${cmdResult.data.cancelled.length} task(s): [${cmdResult.data.cancelled.join(', ')}]\n`);
  if (cmdResult.data.runningCancelled.length > 0) {
    process.stdout.write(`Killed running: [${cmdResult.data.runningCancelled.join(', ')}]\n`);
  }
}

async function headlessCancelWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowId) throw new Error('Missing workflowId. Usage: --headless cancel-workflow <workflowId>');

  if (deps.cancelWorkflow) {
    const result = await deps.cancelWorkflow(workflowId);
    process.stdout.write(
      `Cancelled ${result.cancelled.length} task(s) in workflow "${workflowId}": [${result.cancelled.join(', ')}]\n`,
    );
    if (result.runningCancelled.length > 0) {
      process.stdout.write(`Killed running: [${result.runningCancelled.join(', ')}]\n`);
    }
    return;
  }

  const port = process.env.INVOKER_API_PORT;
  if (port) {
    const url = `http://127.0.0.1:${port}/api/workflows/${encodeURIComponent(workflowId)}/cancel`;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10_000);
      const res = await fetch(url, { method: 'POST', signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = (await res.json()) as { cancelled?: string[]; runningCancelled?: string[] };
        const cancelled = data.cancelled ?? [];
        const runningCancelled = data.runningCancelled ?? [];
        process.stdout.write(
          `Cancelled ${cancelled.length} task(s) in workflow "${workflowId}": [${cancelled.join(', ')}]\n`,
        );
        if (runningCancelled.length > 0) {
          process.stdout.write(`Killed running: [${runningCancelled.join(', ')}]\n`);
        }
        return;
      }
    } catch {
      /* fall back */
    }
  }

  const result = await preemptWorkflowExecution(workflowId, deps);
  const te = createHeadlessExecutor(deps);
  await finalizeMutationWithGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor: te,
    logger: deps.logger,
    context: 'headless.cancel-workflow',
  });
  process.stdout.write(`Cancelled ${result.cancelled.length} task(s) in workflow "${workflowId}": [${result.cancelled.join(', ')}]\n`);
  if (result.runningCancelled.length > 0) {
    process.stdout.write(`Killed running: [${result.runningCancelled.join(', ')}]\n`);
  }
}

async function headlessOpenTerminal(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing taskId. Usage: --headless open-terminal <taskId>');
  const result = await openExternalTerminalForTask({
    taskId,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    executionAgentRegistry: deps.executionAgentRegistry,
    repoRoot: deps.repoRoot,
    logger: deps.logger,
    runningTaskReason: 'Task is still running. View output in logs.',
  });
  if (result.opened) {
    process.stdout.write(`Opened terminal for task: ${taskId}\n`);
  } else {
    process.stderr.write(`Could not open terminal: ${result.reason}\n`);
    process.exitCode = 1;
  }
}

async function headlessDeleteWorkflow(workflowId: string, deps: Pick<HeadlessDeps, 'commandService'>): Promise<void> {
  if (!workflowId) throw new Error('Missing workflowId. Usage: --headless delete-workflow <workflowId>');
  const envelope = makeEnvelope('delete-workflow', 'headless', 'workflow', { workflowId });
  const result = await deps.commandService.deleteWorkflow(envelope);
  if (!result.ok) throw new Error(result.error.message);
  process.stdout.write(`Deleted workflow: ${workflowId}\n`);
}

/**
 * Headless `set merge-mode` — **retry-class** invalidation route per
 * Step 9 of `docs/architecture/task-invalidation-roadmap.md` (chart
 * Decision Table row "Change merge mode";
 * `MUTATION_POLICIES.mergeMode` → `retryTask` / task scope, scoped
 * to the merge node). Mirrors the Step 5 `set type` headless pattern
 * (retry-class, preserves branch / workspacePath lineage) rather
 * than the Step 2/3/4 recreate-class headless paths
 * (`set command` / `set prompt` / `set agent`).
 *
 * Step 9 routes the headless surface through
 * `commandService.editTaskMergeMode` so the orchestrator's
 * cancel-first seam (`Orchestrator.editTaskMergeMode`) runs under
 * the workflow mutex; same-mode no-op detection,
 * `persistence.updateWorkflow({ mergeMode })`, and the single
 * `withBumpedExecutionGeneration` bump live in `restartTask` (today's
 * `retryTask` compatibility wire — see `MUTATION_POLICIES.mergeMode`
 * and `buildInvalidationDeps`).
 *
 * The CLI argument is still a workflow id (matches the legacy
 * `set-merge-mode <workflowId> <mode>` surface and the
 * `invoker:set-merge-mode` IPC). `mergeMode` is normalized at the
 * app boundary because that concerns UI/CLI input parsing, not the
 * chart's invalidation routing. The merge-task-id translation
 * (`workflowId → __merge__<workflowId>`) happens here because the
 * orchestrator seam speaks merge-node task ids. When the workflow
 * has no merge node (degenerate workflows that opted out of a merge
 * gate) we persist the new mode directly via the shared
 * `setWorkflowMergeMode` action — there is nothing to retry.
 */
async function headlessSetMergeMode(
  workflowId: string,
  mergeMode: string,
  deps: HeadlessDeps,
): Promise<void> {
  if (!workflowId || !mergeMode) {
    throw new Error(
      'Missing arguments. Usage: --headless set-merge-mode <workflowId> <manual|automatic|external_review>',
    );
  }
  const normalized = normalizeMergeModeForPersistence(mergeMode);

  const tasks = deps.persistence.loadTasks(workflowId);
  const mergeTask = tasks.find((t) => t.config.isMergeNode);
  if (!mergeTask) {
    const taskExecutor = createHeadlessExecutor(deps);
    await setWorkflowMergeMode(workflowId, normalized, {
      orchestrator: deps.orchestrator,
      persistence: deps.persistence,
      taskExecutor,
    });
    const wf = deps.persistence.loadWorkflow(workflowId);
    process.stdout.write(`Merge mode updated for ${workflowId}: ${wf?.mergeMode ?? '?'}\n`);
    return;
  }

  deps.orchestrator.syncFromDb(workflowId);
  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);

  const envelope = makeEnvelope('edit-task-merge-mode', 'headless', 'task', {
    taskId: mergeTask.id,
    mergeMode: normalized,
  });
  const result = await deps.commandService.editTaskMergeMode(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter((t) => t.status === 'running');
  if (runnable.length > 0) {
    await taskExecutor.executeTasks(runnable);
  }
  const wf = deps.persistence.loadWorkflow(workflowId);
  process.stdout.write(`Merge mode updated for ${workflowId}: ${wf?.mergeMode ?? '?'}\n`);
}

/**
 * Headless `set fix-prompt` / `set fix-context` — **retry-class**
 * invalidation route per Step 10 of
 * `docs/architecture/task-invalidation-roadmap.md` (chart Decision
 * Table row "Change fix prompt or fix context while
 * `fixing_with_ai`"; `MUTATION_POLICIES.fixContext` → `retryTask` /
 * task scope, scoped to the failed/fixing task).
 *
 * Step 10 routes the headless surface through
 * `commandService.editTaskFixContext` so the orchestrator's
 * cancel-first seam (`Orchestrator.editTaskFixContext`) runs under
 * the workflow mutex; same-content no-op detection,
 * `config.fixPrompt` / `config.fixContext` persistence, and the
 * single `withBumpedExecutionGeneration` bump live in `restartTask`
 * (today's `retryTask` compatibility wire — see
 * `MUTATION_POLICIES.fixContext` and `buildInvalidationDeps`).
 *
 * The CLI argument is a task id (matches the Step 2/3 `set command` /
 * `set prompt` headless surface). The `patch` discriminates between
 * `fixPrompt` and `fixContext` at the dispatcher: `set fix-prompt`
 * forwards `{ fixPrompt }`, `set fix-context` forwards
 * `{ fixContext }`. Omitted keys leave the existing config field
 * untouched per `Orchestrator.editTaskFixContext`'s same-content
 * detection contract.
 */
async function headlessSetFixContext(
  taskId: string,
  patch: { fixPrompt?: string; fixContext?: string },
  deps: HeadlessDeps,
): Promise<void> {
  const which = 'fixPrompt' in patch ? 'fix-prompt' : 'fix-context';
  if (!taskId) {
    throw new Error(`Missing arguments. Usage: --headless set ${which} <taskId> <text>`);
  }
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const envelope = makeEnvelope('edit-task-fix-context', 'headless', 'task', {
    taskId,
    ...patch,
  });
  const result = await deps.commandService.editTaskFixContext(envelope);
  if (!result.ok) {
    autoFix.unsubscribe();
    throw new Error(result.error.message);
  }
  const runnable = result.data.filter((t) => t.status === 'running');
  if (runnable.length > 0) {
    await taskExecutor.executeTasks(runnable);
  }
  const value = 'fixPrompt' in patch ? patch.fixPrompt : patch.fixContext;
  process.stdout.write(`Updated ${which} for "${taskId}" → "${value ?? ''}"\n`);

  if (deps.noTrack) {
    process.stdout.write(`[headless] --no-track enabled: set ${which} accepted; exiting without tracking.\n`);
    autoFix.unsubscribe();
    return;
  }
  if (runnable.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}

async function headlessSetGatePolicy(args: string[], deps: HeadlessDeps): Promise<void> {
  const [taskIdRaw, workflowId, arg3, arg4] = args;
  if (!taskIdRaw || !workflowId || !arg3) {
    throw new Error(
      'Missing arguments. Usage: --headless set gate-policy <taskId> <workflowId> [depTaskId] <completed|review_ready>',
    );
  }
  const taskId = restoreWorkflowForTask(taskIdRaw, deps).resolvedTaskId;
  const hasDepTaskId = arg4 !== undefined;
  const depTaskId = hasDepTaskId ? arg3 : '__merge__';
  const gatePolicy = (hasDepTaskId ? arg4 : arg3) as 'completed' | 'review_ready';
  if (gatePolicy !== 'completed' && gatePolicy !== 'review_ready') {
    throw new Error(`Invalid gate policy "${String(gatePolicy)}". Expected completed|review_ready`);
  }

  const envelope = makeEnvelope('set-gate-policies', 'headless', 'task', {
    taskId,
    updates: [{ workflowId, taskId: depTaskId, gatePolicy }],
  });
  const result = await deps.commandService.setTaskExternalGatePolicies(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter((t) => t.status === 'running');
  if (runnable.length > 0) {
    const taskExecutor = createHeadlessExecutor(deps);
    await taskExecutor.executeTasks(runnable);
  }
  process.stdout.write(
    `Updated gate policy for ${taskId}: ${workflowId}/${depTaskId} -> ${gatePolicy} (${runnable.length} task(s) started)\n`,
  );
}

async function headlessSlack(deps: HeadlessDeps): Promise<void> {
  const { orchestrator, persistence, initServices, wireSlackBot } = deps;

  const logFn = (source: string, level: string, message: string) => {
    const logMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    deps.logger[logMethod](message, { module: source });
    persistence.writeActivityLog(source, level, message);
  };

  await initServices();

  const taskExecutor = createHeadlessExecutor(deps, {
    onComplete: (taskId) => {
      logFn('exec', 'info', `Task "${taskId}" completed`);
    },
  });
  wireHeadlessApproveHook(deps, taskExecutor);
  const approveTaskAction = buildHeadlessApproveAction(deps, taskExecutor);

  const api = startApiServer({
    logger: deps.logger,
    orchestrator,
    persistence,
    executorRegistry: deps.executorRegistry,
    taskExecutor,
    approveTaskAction,
    ...buildHeadlessApiCancelHooks(deps, taskExecutor),
  });

  const slack = await wireSlackBot({
    executor: taskExecutor,
    logFn,
    onPlanLoaded: () => {},
  });

  logFn('slack', 'info', 'Slack bot is running (headless, using TaskRunner). Press Ctrl+C to stop.');

  // Stay alive until SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await api.close().catch(() => {});
      logFn('slack', 'info', 'Shutting down...');
      await slack.stop();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

// ── Headless Helpers ─────────────────────────────────────────

function restoreWorkflowForTask(
  taskId: string,
  deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>,
): { workflowId: string; resolvedTaskId: string } {
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
  throw new Error(`Task "${taskId}" not found in any workflow`);
}

async function waitForCompletion(
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
      ? ['completed', 'failed', 'needs_input', 'blocked', 'stale']
      : ['completed', 'failed', 'needs_input', 'awaiting_approval', 'review_ready', 'blocked', 'stale'];
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
// ── Headless Delegation ──────────────────────────────────────
