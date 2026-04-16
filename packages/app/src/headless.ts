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
import type { Orchestrator, CommandService, TaskDelta, TaskState, TaskConfig } from '@invoker/workflow-core';
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
  rebaseAndRetry,
  resolveConflictAction,
  recreateWorkflow as sharedRecreateWorkflow,
  recreateTask as sharedRecreateTask,
  setWorkflowMergeMode,
  finalizeAppliedFix,
} from './workflow-actions.js';
import { openExternalTerminalForTask } from './open-terminal-for-task.js';
import { executeGlobalTopup } from './global-topup.js';
import {
  delegationTimeoutMs,
  tryDelegateExec,
  tryDelegateResume,
  tryDelegateRun,
} from './headless-delegation.js';

export { bumpGenerationAndRecreate } from './workflow-actions.js';
export {
  delegationTimeoutMs,
  tryDelegateExec,
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
  wireSlackBot: (deps: {
    executor: TaskRunner;
    logFn: (source: string, level: string, message: string) => void;
    onPlanLoaded?: () => void;
  }) => Promise<any>;
  getUiPerfStats?: () => Record<string, unknown>;
  resetUiPerfStats?: () => void;
  deferRunnableTasks?: (tasks: TaskState[], workflowId?: string) => void;
  preemptTaskSubgraph?: (taskId: string) => Promise<void>;
  preemptWorkflowExecution?: (workflowId: string) => Promise<void>;
  waitForApproval?: boolean;
  noTrack?: boolean;
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

function workflowHasActiveExecution(workflowId: string, deps: Pick<HeadlessDeps, 'persistence' | 'orchestrator'>): boolean {
  const tasks = deps.persistence.loadTasks(workflowId);
  const persistedActiveTaskIds = deps.orchestrator.getPersistedActiveTaskIds?.() ?? new Set<string>();
  return tasks.some((task) =>
    task.status === 'running'
    || task.status === 'fixing_with_ai'
    || (task.status === 'pending' && persistedActiveTaskIds.has(task.id)),
  );
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

export function createHeadlessExecutor(
  deps: HeadlessDeps,
  callbackOverrides?: Partial<ConstructorParameters<typeof TaskRunner>[0]['callbacks']>,
): TaskRunner {
  return new TaskRunner({
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
    if (task.config.isMergeNode && task.config.workflowId) {
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
      if (workflows.length > 0) {
        deps.orchestrator.resumeWorkflow(workflows[0].id);
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
    case 'executor':
      await headlessEditExecutor(args[1], args[2], deps);
      break;
    case 'agent':
      await headlessEditAgent(args[1], args[2], deps);
      break;
    case 'merge-mode':
      await headlessSetMergeMode(args[1], args[2], deps);
      break;
    case 'gate-policy':
      await headlessSetGatePolicy(args.slice(1), deps);
      break;
    default:
      throw new Error(`Unknown set sub-command: "${subCommand}". Use: command, executor, agent, merge-mode, gate-policy`);
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
      await headlessOwnerServe();
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

    // ── Execute (unchanged) ──
    case 'run':
      await headlessRun(args[1], deps, deps.waitForApproval, deps.noTrack);
      break;
    case 'resume':
      await headlessResume(args[1], deps, deps.waitForApproval, deps.noTrack);
      break;
    case 'restart': {
      const id = args[1];
      if (id?.startsWith('wf-') && !id.includes('/')) {
        // Workflow ID → incremental retry
        await headlessRetryWorkflow(id, deps);
      } else {
        // Task ID → single task restart (existing behavior)
        await headlessRestart(id, deps);
      }
      break;
    }
    case 'recreate':
      await headlessRecreateWorkflow(args[1], deps);
      break;
    case 'recreate-task':
      await headlessRecreateTask(args[1], deps);
      break;
    case 'rebase':
      await headlessRebaseAndRetry(args[1], deps);
      break;

    // Deprecated aliases
    case 'restart-workflow':
      warnDeprecated('restart-workflow', 'recreate');
      await headlessRecreateWorkflow(args[1], deps);
      break;
    case 'clean-restart':
      warnDeprecated('clean-restart', 'recreate');
      await headlessRecreateWorkflow(args[1], deps);
      break;
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

async function headlessOwnerServe(): Promise<void> {
  process.stdout.write('[headless] standalone owner ready; waiting for delegated mutations.\n');
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
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
  run <plan.yaml>                                     Load and execute plan
  resume <id>                                         Resume incomplete workflow
  restart <taskId>                                    Restart a single failed/stuck task
  restart <workflowId>                                Retry workflow: rerun failed, keep completed
  recreate <workflowId>                                Recreate workflow: wipe all state, new generation
  recreate-task <taskId>                               Recreate task + downstream (task-scoped reset)
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
  set executor <taskId> <type>                        Change executor type (worktree|docker|ssh)
  set agent <taskId> <agent>                          Change execution agent (claude|codex)
  set merge-mode <workflowId> <mode>                  manual | automatic | external_review
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
  delete-workflow → delete      restart-workflow → recreate
  clean-restart → recreate
  rebase-and-retry → rebase

${BOLD}Options:${RESET}
  --wait-for-approval    Keep running until PR approval (use with 'run' or 'resume')
  --no-track             Submit and return immediately after printing Workflow ID
  --do-not-track         Alias for --no-track
`);
}

// ── Headless Commands ────────────────────────────────────────

async function headlessRun(
  planPath: string,
  deps: HeadlessDeps,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<void> {
  const { orchestrator, messageBus, repoRoot, invokerConfig } = deps;
  if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');

  const { readFile } = await import('node:fs/promises');
  const { parsePlanFile } = await import('./plan-parser.js');
  const { formatTaskStatus, formatWorkflowStatus } = await import('./formatter.js');

  const yamlSource = await readFile(planPath, 'utf-8');
  const plan = await parsePlanFile(planPath);
  const execRegistry = deps.executionAgentRegistry ?? registerBuiltinAgents();
  assertPlanExecutionAgentsRegistered(plan, execRegistry);
  backupPlan(plan, yamlSource, deps.logger);
  process.stdout.write(`${BOLD}Loading plan: ${plan.name}${RESET}\n`);
  process.stdout.write(`Tasks: ${plan.tasks.length}\n\n`);

  messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
    if (delta.type === 'updated') {
      const task = orchestrator.getTask(delta.taskId);
      if (task) process.stdout.write(formatTaskStatus(task) + '\n');
    } else if (delta.type === 'created') {
      process.stdout.write(formatTaskStatus(delta.task) + '\n');
    }
  });

  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const api = startApiServer({
    logger: deps.logger,
    orchestrator,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    taskExecutor,
    autoApproveAIFixes: deps.invokerConfig.autoApproveAIFixes,
    ...buildHeadlessApiCancelHooks(deps, taskExecutor),
  });

  const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
  orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
  const currentWorkflowId = orchestrator.getWorkflowIds().find((id) => !wfIdsBefore.has(id));
  if (currentWorkflowId) process.stdout.write(`Workflow ID: ${currentWorkflowId}\n`);

  const started = orchestrator.startExecution();
  await taskExecutor.executeTasks(started);

  if (noTrack) {
    process.stdout.write('[headless] --no-track enabled: submission accepted; exiting without tracking.\n');
    await api.close().catch(() => {});
    return;
  }

  await waitForCompletion(orchestrator, currentWorkflowId, waitForApproval, autoFix.isBusy);

  await api.close().catch(() => {});
  autoFix.unsubscribe();

  const status = orchestrator.getWorkflowStatus(currentWorkflowId);
  process.stdout.write(`\n${formatWorkflowStatus(status)}\n`);

  const mergeTask = orchestrator.getAllTasks().find(
    t => t.config.workflowId === currentWorkflowId && t.config.isMergeNode,
  );
  if (mergeTask?.execution?.reviewUrl) {
    process.stdout.write(`\nPull Request: ${mergeTask.execution.reviewUrl}\n`);
  }

  if (status.failed > 0) process.exitCode = 1;
}

async function headlessResume(
  workflowId: string,
  deps: HeadlessDeps,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<void> {
  const { orchestrator, messageBus } = deps;
  if (!workflowId) throw new Error('Missing workflowId. Usage: --headless resume <id>');

  const { formatTaskStatus, formatWorkflowStatus } = await import('./formatter.js');

  process.stdout.write(`${BOLD}Resuming workflow: ${workflowId}${RESET}\n\n`);

  messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
    if (delta.type === 'updated') {
      const task = orchestrator.getTask(delta.taskId);
      if (task) process.stdout.write(formatTaskStatus(task) + '\n');
    } else if (delta.type === 'created') {
      process.stdout.write(formatTaskStatus(delta.task) + '\n');
    }
  });

  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const api = startApiServer({
    logger: deps.logger,
    orchestrator,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    taskExecutor,
    autoApproveAIFixes: deps.invokerConfig.autoApproveAIFixes,
    ...buildHeadlessApiCancelHooks(deps, taskExecutor),
  });

  orchestrator.syncFromDb(workflowId);

  // Relaunch tasks stuck in 'running' from a previous session
  const orphanRestarted: TaskState[] = [];
  const activeTaskIds = orchestrator.getPersistedActiveTaskIds?.() ?? new Set<string>();
  for (const task of orchestrator.getAllTasks()) {
    if (
      (
        task.status === 'running'
        || task.status === 'fixing_with_ai'
        || (task.status === 'pending' && activeTaskIds.has(task.id))
      ) &&
      task.config.workflowId === workflowId
    ) {
      deps.logger.info(
        `relaunching orphaned in-flight task "${task.id}" (${task.status}${task.status === 'pending' ? '/claimed' : ''})`,
        { module: 'headless' },
      );
      const restarted = orchestrator.restartTask(task.id);
      orphanRestarted.push(...restarted.filter(t => t.status === 'running'));
    }
  }

  const started = orchestrator.startExecution();
  await taskExecutor.executeTasks([...orphanRestarted, ...started]);

  if (noTrack) {
    process.stdout.write('[headless] --no-track enabled: resume accepted; exiting without tracking.\n');
    await api.close().catch(() => {});
    return;
  }

  await waitForCompletion(orchestrator, workflowId, waitForApproval, autoFix.isBusy);

  await api.close().catch(() => {});
  autoFix.unsubscribe();

  const status = orchestrator.getWorkflowStatus();
  process.stdout.write(`\n${formatWorkflowStatus(status)}\n`);

  if (status.failed > 0) process.exitCode = 1;
}

async function headlessApprove(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing taskId.');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  const te = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, te);
  const envelope = makeEnvelope('approve', 'headless', 'task', { taskId });
  const result = await deps.commandService.approve(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const started = result.data;
  const postFixMerge = started.filter(t => t.status === 'running' && t.config.isMergeNode && t.id === taskId);
  for (const task of postFixMerge) {
    await te.publishAfterFix(task);
  }
  const runnable = started.filter(t => t.status === 'running' && !(t.config.isMergeNode && t.id === taskId));
  if (runnable.length > 0) await te.executeTasks(runnable);
  process.stdout.write(`Approved task: ${taskId}\n`);
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
  await taskExecutor.executeTasks(started);
  await waitForCompletion(deps.orchestrator, undefined, undefined, autoFix.isBusy);
  autoFix.unsubscribe();
}

async function headlessRestart(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing arguments. Usage: --headless restart <taskId>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  await preemptTaskSubgraph(taskId, deps);

  const envelope = makeEnvelope('restart-task', 'headless', 'task', { taskId });
  const result = await deps.commandService.restartTask(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter(t => t.status === 'running');
  process.stdout.write(`Restarted task "${taskId}" — ${runnable.length} task(s) to execute\n`);

  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);
  if (runnable.length > 0) {
    await taskExecutor.executeTasks(runnable);
  }
  const topup = await executeGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor,
    logger: deps.logger,
    context: 'headless.restart-task',
    alreadyDispatched: runnable,
  });
  if (runnable.length + topup.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await waitForCompletion(deps.orchestrator, undefined, undefined, autoFix.isBusy);
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
    process.stdout.write(
      result.autoApproved
        ? `Fix applied and auto-approved for task: ${taskId} (${agent}).\n`
        : `Fix applied for task: ${taskId} (${agent}). Use 'approve ${taskId}' or 'reject ${taskId}' to finalize.\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.persistence.appendTaskOutput(taskId, `\n[Fix with AI] Failed: ${msg}`);
    deps.orchestrator.revertConflictResolution(taskId, savedError, msg);
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
  await resolveConflictAction(taskId, {
    ...deps,
    taskExecutor: te,
    autoApproveAIFixes: deps.invokerConfig.autoApproveAIFixes,
  }, agent);
  process.stdout.write(
    deps.invokerConfig.autoApproveAIFixes
      ? `Conflict resolved and auto-approved for task: ${taskId} (${agent}).\n`
      : `Conflict resolved for task: ${taskId} (${agent}). Use 'approve ${taskId}' or 'reject ${taskId}' to finalize.\n`,
  );
  autoFix.unsubscribe();
}

async function headlessRebaseAndRetry(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing arguments. Usage: --headless rebase-and-retry <taskId>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  const workflowId = deps.orchestrator.getTask(taskId)?.config.workflowId;
  if (!workflowId) throw new Error(`Task "${taskId}" has no workflow`);
  await preemptWorkflowExecution(workflowId, deps);

  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  const started = await rebaseAndRetry(taskId, { ...deps, taskExecutor: te });
  const runnable = started.filter(t => t.status === 'running');
  if (runnable.length > 0) {
    await te.executeTasks(runnable);
  }
  const topup = await executeGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor: te,
    logger: deps.logger,
    context: 'headless.rebase-and-retry',
    alreadyDispatched: runnable,
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
  await waitForCompletion(deps.orchestrator, workflowId, undefined, autoFix.isBusy);
  autoFix.unsubscribe();

  const tasksStarted = runnable.length;
  process.stdout.write(`Rebase-and-retry: resetting workflow from current HEAD (${tasksStarted} task(s))\n`);
}

async function headlessRecreateWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowId) {
    throw new Error('Missing arguments. Usage: --headless recreate <workflowId>');
  }
  await preemptWorkflowExecution(workflowId, deps);
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
    await waitForCompletion(deps.orchestrator, workflowId, undefined, autoFix.isBusy);
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
    if (runnable.length > 0) {
      await te.executeTasks(runnable);
    }
    topup = await executeGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.recreate-task',
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
    process.stdout.write('[headless] --no-track enabled: recreate-task accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  await waitForCompletion(deps.orchestrator, workflowId, undefined, autoFix.isBusy);
  autoFix.unsubscribe();
}

async function headlessRetryWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowId) {
    throw new Error('Missing arguments. Usage: --headless restart <workflowId>');
  }
  deps.logger.info(`headlessRetryWorkflow begin workflow="${workflowId}" noTrack=${deps.noTrack ? 'true' : 'false'}`, {
    module: 'headless',
  });
  const shouldPreempt = workflowHasActiveExecution(workflowId, deps);
  if (shouldPreempt) {
    await preemptWorkflowExecution(workflowId, deps);
    deps.logger.info(`headlessRetryWorkflow preempt complete workflow="${workflowId}"`, { module: 'headless' });
  } else {
    deps.logger.info(`headlessRetryWorkflow preempt skipped workflow="${workflowId}"`, { module: 'headless' });
  }
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
    process.stdout.write('[headless] --no-track enabled: restart accepted; exiting without tracking.\n');
    return;
  }

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
      context: 'headless.retry-workflow',
      alreadyDispatched: runnable,
    });
  } finally {
    remoteFetchForPool.enabled = true;
  }
  if (runnable.length + topup.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await waitForCompletion(deps.orchestrator, workflowId, undefined, autoFix.isBusy);
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

async function preemptWorkflowExecution(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (deps.preemptWorkflowExecution) {
    await deps.preemptWorkflowExecution(workflowId);
    return;
  }
  if (typeof deps.commandService.cancelWorkflow !== 'function') return;
  const envelope = makeEnvelope('cancel-workflow', 'headless', 'workflow', { workflowId });
  const result = await deps.commandService.cancelWorkflow(envelope);
  if (!result.ok) {
    const message = result.error.message;
    if (message.includes('No tasks found for workflow')) return;
    throw new Error(message);
  }
}

async function headlessEdit(taskId: string, newCommand: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !newCommand) throw new Error('Missing arguments. Usage: --headless edit <taskId> <newCommand>');
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;

  const envelope = makeEnvelope('edit-task-command', 'headless', 'task', { taskId, newCommand });
  const result = await deps.commandService.editTaskCommand(envelope);
  if (!result.ok) throw new Error(result.error.message);
  process.stdout.write(`Edited task "${taskId}" command → "${newCommand}"\n`);

  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);
  await taskExecutor.executeTasks(result.data);
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set command accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  await waitForCompletion(deps.orchestrator, restored.workflowId, undefined, autoFix.isBusy);
  autoFix.unsubscribe();
}

async function headlessEditExecutor(taskId: string, executorType: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !executorType) throw new Error('Missing arguments. Usage: --headless edit-executor <taskId> <executorType>');
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;

  const envelope = makeEnvelope('edit-task-type', 'headless', 'task', { taskId, executorType });
  const result = await deps.commandService.editTaskType(envelope);
  if (!result.ok) throw new Error(result.error.message);
  process.stdout.write(`Edited task "${taskId}" executor → "${executorType}"\n`);

  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);
  await taskExecutor.executeTasks(result.data);
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set executor accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  await waitForCompletion(deps.orchestrator, restored.workflowId, undefined, autoFix.isBusy);
  autoFix.unsubscribe();
}

async function headlessEditAgent(taskId: string, agentName: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !agentName) throw new Error('Missing arguments. Usage: --headless edit-agent <taskId> <claude|codex>');
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;

  const envelope = makeEnvelope('edit-task-agent', 'headless', 'task', { taskId, agentName });
  const result = await deps.commandService.editTaskAgent(envelope);
  if (!result.ok) throw new Error(result.error.message);
  process.stdout.write(`Edited task "${taskId}" agent → "${agentName}"\n`);

  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);
  await taskExecutor.executeTasks(result.data);
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set agent accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  await waitForCompletion(deps.orchestrator, restored.workflowId, undefined, autoFix.isBusy);
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
  process.stdout.write(`Cancelled ${cmdResult.data.cancelled.length} task(s): [${cmdResult.data.cancelled.join(', ')}]\n`);
  if (cmdResult.data.runningCancelled.length > 0) {
    process.stdout.write(`Killed running: [${cmdResult.data.runningCancelled.join(', ')}]\n`);
  }
}

async function headlessCancelWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowId) throw new Error('Missing workflowId. Usage: --headless cancel-workflow <workflowId>');

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

  const envelope = makeEnvelope('cancel-workflow', 'headless', 'workflow', { workflowId });
  const cmdResult = await deps.commandService.cancelWorkflow(envelope);
  if (!cmdResult.ok) throw new Error(cmdResult.error.message);
  process.stdout.write(`Cancelled ${cmdResult.data.cancelled.length} task(s) in workflow "${workflowId}": [${cmdResult.data.cancelled.join(', ')}]\n`);
  if (cmdResult.data.runningCancelled.length > 0) {
    process.stdout.write(`Killed running: [${cmdResult.data.runningCancelled.join(', ')}]\n`);
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
  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);
  await setWorkflowMergeMode(workflowId, mergeMode, {
    orchestrator: deps.orchestrator,
    persistence: deps.persistence,
    taskExecutor,
  });
  const wf = deps.persistence.loadWorkflow(workflowId);
  process.stdout.write(`Merge mode updated for ${workflowId}: ${wf?.mergeMode ?? '?'}\n`);
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

  const api = startApiServer({
    logger: deps.logger,
    orchestrator,
    persistence,
    executorRegistry: deps.executorRegistry,
    taskExecutor,
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
    const hasHumanBlocked = tasks.some((t) => settledStatuses.includes(t.status) && t.status !== 'completed');
    if (noneRunning && hasHumanBlocked && !hasBackgroundWork?.()) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

// ── Headless Delegation ──────────────────────────────────────
