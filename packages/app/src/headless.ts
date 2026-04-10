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

import { Orchestrator, CommandService } from '@invoker/workflow-core';
import type { TaskDelta, TaskState } from '@invoker/workflow-core';
import { makeEnvelope } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import { createDeleteAllSnapshot } from './delete-all-snapshot.js';
import { resolve as resolvePath } from 'node:path';
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
import { startApiServer } from './api-server.js';
import {
  rebaseAndRetry,
  resolveConflictAction,
  restartTask as sharedRestartTask,
  recreateWorkflow as sharedRecreateWorkflow,
  recreateTask as sharedRecreateTask,
  cancelWorkflow as sharedCancelWorkflow,
  retryWorkflow as sharedRetryWorkflow,
  editTaskCommand as sharedEditTaskCommand,
  editTaskType as sharedEditTaskType,
  editTaskAgent as sharedEditTaskAgent,
  setTaskExternalGatePolicies as sharedSetTaskExternalGatePolicies,
  selectExperiment as sharedSelectExperiment,
  setWorkflowMergeMode,
} from './workflow-actions.js';
import { openExternalTerminalForTask } from './open-terminal-for-task.js';

export { bumpGenerationAndRecreate } from './workflow-actions.js';

// ── HeadlessDeps interface ───────────────────────────────────

export interface HeadlessDeps {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  executorRegistry: ExecutorRegistry;
  messageBus: MessageBus;
  repoRoot: string;
  invokerConfig: InvokerConfig;
  initServices: () => Promise<void>;
  executionAgentRegistry?: AgentRegistry;
  wireSlackBot: (deps: {
    executor: TaskRunner;
    logFn: (source: string, level: string, message: string) => void;
    onPlanLoaded?: () => void;
  }) => Promise<any>;
  waitForApproval?: boolean;
  noTrack?: boolean;
}

// ── ANSI Helpers ─────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

// ── Shared Helpers ───────────────────────────────────────────

function headlessHeartbeat(taskId: string, deps: Pick<HeadlessDeps, 'persistence'>): void {
  const now = new Date();
  try { deps.persistence.updateTask(taskId, { execution: { lastHeartbeatAt: now } }); } catch { /* db locked */ }
}

function createHeadlessExecutor(
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
          console.error(`[output] Failed to persist output for ${taskId}:`, err);
        }
      },
      onHeartbeat: (taskId) => headlessHeartbeat(taskId, deps),
      ...callbackOverrides,
    },
  });
}

function wireHeadlessApproveHook(deps: HeadlessDeps, te: TaskRunner): void {
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
    throw new Error('Missing query sub-command. Usage: --headless query <workflows|tasks|task|queue|audit|session>');
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
        case 'label': console.log(formatAsLabel(workflows)); break;
        case 'json':  console.log(formatAsJson(workflows.map(serializeWorkflow))); break;
        case 'jsonl': console.log(formatAsJsonl(workflows.map(serializeWorkflow))); break;
        default:      console.log(formatWorkflowList(workflows)); break;
      }
      break;
    }
    case 'tasks': {
      const { orchestrator, persistence } = deps;
      const workflows = persistence.listWorkflows();
      if (workflows.length === 0) {
        console.log('No workflows found. Run a plan first.');
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
        case 'label': console.log(formatAsLabel(allTasks)); break;
        case 'json':  console.log(formatAsJson(allTasks.map(serializeTask))); break;
        case 'jsonl': console.log(formatAsJsonl(allTasks.map(serializeTask))); break;
        default: {
          for (const task of allTasks) console.log(formatTaskStatus(task));
          const status = orchestrator.getWorkflowStatus();
          console.log(`\n${formatWorkflowStatus(status)}`);
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
        case 'label': console.log(task.id); break;
        case 'json':  console.log(formatAsJson(serializeTask(task))); break;
        case 'jsonl': console.log(formatAsJsonl([serializeTask(task)])); break;
        default:      console.log(task.status); break;
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
          console.log(ids.join('\n'));
          break;
        }
        case 'json':  console.log(formatAsJson(status)); break;
        case 'jsonl': {
          for (const t of status.running) console.log(JSON.stringify({ ...t, state: 'running' }));
          for (const t of status.queued) console.log(JSON.stringify({ ...t, state: 'queued' }));
          break;
        }
        default: console.log(formatQueueStatus(status)); break;
      }
      break;
    }
    case 'audit': {
      const taskId = flags.positional[0];
      if (!taskId) throw new Error('Usage: --headless query audit <taskId>');
      const events = deps.persistence.getEvents(taskId);

      switch (flags.output) {
        case 'label': console.log(events.map(e => `${e.taskId}:${e.eventType}`).join('\n')); break;
        case 'json':  console.log(formatAsJson(events.map(serializeEvent))); break;
        case 'jsonl': console.log(formatAsJsonl(events.map(serializeEvent))); break;
        default:      console.log(formatEventLog(events)); break;
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
    default:
      throw new Error(`Unknown query sub-command: "${subCommand}". Use: workflows, tasks, task, queue, audit, session`);
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

// ── Headless Command Router ──────────────────────────────────

export async function runHeadless(args: string[], deps: HeadlessDeps): Promise<void> {
  const command = args[0];

  switch (command) {
    // ── New grouped commands ──
    case 'query':
      await headlessQuery(args.slice(1), deps);
      break;
    case 'set':
      await headlessSet(args.slice(1), deps);
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
      headlessReject(args[1], deps, args.slice(2).join(' ') || undefined);
      break;
    case 'input':
      headlessInput(args[1], args.slice(2).join(' '), deps);
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
      console.log('All workflows deleted.');
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

function printHeadlessUsage(): void {
  console.log(`${BOLD}invoker${RESET} — Headless workflow runner (Electron)

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
  set merge-mode <workflowId> <mode>                  manual | automatic | github | external_review
  set gate-policy <taskId> <wfId> [depTaskId] <policy>
                                                      policy: completed | review_ready

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
  backupPlan(plan, yamlSource);
  console.log(`${BOLD}Loading plan: ${plan.name}${RESET}`);
  console.log(`Tasks: ${plan.tasks.length}\n`);

  messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
    if (delta.type === 'updated') {
      const task = orchestrator.getTask(delta.taskId);
      if (task) console.log(formatTaskStatus(task));
    } else if (delta.type === 'created') {
      console.log(formatTaskStatus(delta.task));
    }
  });

  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);

  const api = startApiServer({ orchestrator, persistence: deps.persistence, executorRegistry: deps.executorRegistry, taskExecutor });

  const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
  orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
  const currentWorkflowId = orchestrator.getWorkflowIds().find((id) => !wfIdsBefore.has(id));
  if (currentWorkflowId) console.log(`Workflow ID: ${currentWorkflowId}`);

  const started = orchestrator.startExecution();
  await taskExecutor.executeTasks(started);

  if (noTrack) {
    console.log('[headless] --no-track enabled: submission accepted; exiting without tracking.');
    await api.close().catch(() => {});
    return;
  }

  await waitForCompletion(orchestrator, currentWorkflowId, waitForApproval);

  await api.close().catch(() => {});

  const status = orchestrator.getWorkflowStatus(currentWorkflowId);
  console.log(`\n${formatWorkflowStatus(status)}`);

  const mergeTask = orchestrator.getAllTasks().find(
    t => t.config.workflowId === currentWorkflowId && t.config.isMergeNode,
  );
  if (mergeTask?.execution?.reviewUrl) {
    console.log(`\nPull Request: ${mergeTask.execution.reviewUrl}`);
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

  console.log(`${BOLD}Resuming workflow: ${workflowId}${RESET}\n`);

  messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
    if (delta.type === 'updated') {
      const task = orchestrator.getTask(delta.taskId);
      if (task) console.log(formatTaskStatus(task));
    } else if (delta.type === 'created') {
      console.log(formatTaskStatus(delta.task));
    }
  });

  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);

  const api = startApiServer({ orchestrator, persistence: deps.persistence, executorRegistry: deps.executorRegistry, taskExecutor });

  orchestrator.syncFromDb(workflowId);

  // Relaunch tasks stuck in 'running' from a previous session
  const orphanRestarted: TaskState[] = [];
  for (const task of orchestrator.getAllTasks()) {
    if (task.status === 'running' || task.status === 'fixing_with_ai') {
      console.log(`[headless] relaunching orphaned in-flight task "${task.id}" (${task.status})`);
      const restarted = orchestrator.restartTask(task.id);
      orphanRestarted.push(...restarted.filter(t => t.status === 'running'));
    }
  }

  const started = orchestrator.startExecution();
  await taskExecutor.executeTasks([...orphanRestarted, ...started]);

  if (noTrack) {
    console.log('[headless] --no-track enabled: resume accepted; exiting without tracking.');
    await api.close().catch(() => {});
    return;
  }

  await waitForCompletion(orchestrator, undefined, waitForApproval);

  await api.close().catch(() => {});

  const status = orchestrator.getWorkflowStatus();
  console.log(`\n${formatWorkflowStatus(status)}`);

  if (status.failed > 0) process.exitCode = 1;
}

async function headlessApprove(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing taskId.');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  const te = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, te);
  const cs = new CommandService(deps.orchestrator);
  const envelope = makeEnvelope('approve', 'headless', 'task', { taskId });
  const result = await cs.approve(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const started = result.data;
  const postFixMerge = started.filter(t => t.status === 'running' && t.config.isMergeNode && t.id === taskId);
  for (const task of postFixMerge) {
    await te.publishAfterFix(task);
  }
  const runnable = started.filter(t => t.status === 'running' && !(t.config.isMergeNode && t.id === taskId));
  if (runnable.length > 0) await te.executeTasks(runnable);
  console.log(`Approved task: ${taskId}`);
}

function headlessReject(taskId: string, deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>, reason?: string): void {
  if (!taskId) throw new Error('Missing taskId.');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  const cs = new CommandService(deps.orchestrator);
  const envelope = makeEnvelope('reject', 'headless', 'task', { taskId, reason });
  const result = cs.reject(envelope);
  if (!result.ok) throw new Error(result.error.message);
  console.log(`Rejected task: ${taskId}${reason ? ` (reason: ${reason})` : ''}`);
}

function headlessInput(taskId: string, text: string, deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>): void {
  if (!taskId || !text) throw new Error('Missing arguments. Usage: --headless input <taskId> <text>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;
  deps.orchestrator.provideInput(taskId, text);
  console.log(`Input provided to task: ${taskId}`);
}

async function headlessSelect(taskId: string, experimentId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !experimentId) throw new Error('Missing arguments. Usage: --headless select <taskId> <expId>');
  const { workflowId, resolvedTaskId } = restoreWorkflowForTask(taskId, deps);
  sharedSelectExperiment(resolvedTaskId, experimentId, deps);
  console.log(`Selected experiment ${experimentId} for task: ${resolvedTaskId}`);

  const taskExecutor = createHeadlessExecutor(deps);
  const started = deps.orchestrator.resumeWorkflow(workflowId);
  await taskExecutor.executeTasks(started);
  await waitForCompletion(deps.orchestrator, undefined, undefined);
}

async function headlessRestart(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing arguments. Usage: --headless restart <taskId>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  const started = sharedRestartTask(taskId, deps);
  const runnable = started.filter(t => t.status === 'running');
  console.log(`Restarted task "${taskId}" — ${runnable.length} task(s) to execute`);

  if (runnable.length === 0) return;

  const taskExecutor = createHeadlessExecutor(deps);
  await taskExecutor.executeTasks(runnable);
  await waitForCompletion(deps.orchestrator, undefined, undefined);
}

async function headlessFix(taskId: string, deps: HeadlessDeps, agentArg?: string): Promise<void> {
  if (!taskId) throw new Error('Missing taskId. Usage: --headless fix <taskId> [claude|codex]');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  const te = createHeadlessExecutor(deps);
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
    deps.orchestrator.setFixAwaitingApproval(taskId, savedError);
    console.log(`Fix applied for task: ${taskId} (${agent}). Use 'approve ${taskId}' or 'reject ${taskId}' to finalize.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.persistence.appendTaskOutput(taskId, `\n[Fix with AI] Failed: ${msg}`);
    deps.orchestrator.revertConflictResolution(taskId, savedError, msg);
    throw err;
  }
}

async function headlessResolveConflict(taskId: string, deps: HeadlessDeps, agentArg?: string): Promise<void> {
  if (!taskId) throw new Error('Missing taskId. Usage: --headless resolve-conflict <taskId> [claude|codex]');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  const te = createHeadlessExecutor(deps);
  const agent = (agentArg ?? 'claude').toLowerCase();
  await resolveConflictAction(taskId, { ...deps, taskExecutor: te }, agent);
  console.log(`Conflict resolved for task: ${taskId} (${agent}). Use 'approve ${taskId}' or 'reject ${taskId}' to finalize.`);
}

async function headlessRebaseAndRetry(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing arguments. Usage: --headless rebase-and-retry <taskId>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  const te = createHeadlessExecutor(deps);
  const started = await rebaseAndRetry(taskId, { ...deps, taskExecutor: te });
  const runnable = started.filter(t => t.status === 'running');
  console.log(`Rebase-and-retry: resetting workflow from current HEAD (${runnable.length} task(s))`);

  if (runnable.length === 0) return;

  await te.executeTasks(runnable);
  await waitForCompletion(deps.orchestrator, deps.orchestrator.getTask(taskId)?.config.workflowId, undefined);
}

async function headlessRecreateWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowId) {
    throw new Error('Missing arguments. Usage: --headless recreate <workflowId>');
  }
  const started = sharedRecreateWorkflow(workflowId, { persistence: deps.persistence, orchestrator: deps.orchestrator });
  const runnable = started.filter(t => t.status === 'running');
  console.log(`Recreate workflow "${workflowId}" — ${runnable.length} task(s) to execute (pool fetch skipped)`);
  if (runnable.length === 0) return;

  const te = createHeadlessExecutor(deps);
  remoteFetchForPool.enabled = false;
  try {
    await te.executeTasks(runnable);
  } finally {
    remoteFetchForPool.enabled = true;
  }
  await waitForCompletion(deps.orchestrator, workflowId, undefined);
}

async function headlessRecreateTask(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) {
    throw new Error('Missing arguments. Usage: --headless recreate-task <taskId>');
  }
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  const started = sharedRecreateTask(taskId, { persistence: deps.persistence, orchestrator: deps.orchestrator });
  const runnable = started.filter(t => t.status === 'running');
  const workflowId = deps.orchestrator.getTask(taskId)?.config.workflowId;
  console.log(`Recreate task "${taskId}" (+ downstream) — ${runnable.length} task(s) to execute (pool fetch skipped)`);
  if (runnable.length === 0) return;

  const te = createHeadlessExecutor(deps);
  remoteFetchForPool.enabled = false;
  try {
    await te.executeTasks(runnable);
  } finally {
    remoteFetchForPool.enabled = true;
  }
  await waitForCompletion(deps.orchestrator, workflowId, undefined);
}

async function headlessRetryWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowId) {
    throw new Error('Missing arguments. Usage: --headless restart <workflowId>');
  }
  const started = sharedRetryWorkflow(workflowId, { orchestrator: deps.orchestrator });
  const runnable = started.filter(t => t.status === 'running');
  console.log(`Retry workflow "${workflowId}" — ${runnable.length} task(s) to re-execute (completed tasks preserved)`);
  if (runnable.length === 0) return;

  const te = createHeadlessExecutor(deps);
  remoteFetchForPool.enabled = false;
  try {
    await te.executeTasks(runnable);
  } finally {
    remoteFetchForPool.enabled = true;
  }
  await waitForCompletion(deps.orchestrator, workflowId, undefined);
}

async function headlessEdit(taskId: string, newCommand: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !newCommand) throw new Error('Missing arguments. Usage: --headless edit <taskId> <newCommand>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  const started = sharedEditTaskCommand(taskId, newCommand, deps);
  console.log(`Edited task "${taskId}" command → "${newCommand}"`);

  const taskExecutor = createHeadlessExecutor(deps);
  await taskExecutor.executeTasks(started);
  await waitForCompletion(deps.orchestrator, undefined, undefined);
}

async function headlessEditExecutor(taskId: string, executorType: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !executorType) throw new Error('Missing arguments. Usage: --headless edit-executor <taskId> <executorType>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  const started = sharedEditTaskType(taskId, executorType, deps);
  console.log(`Edited task "${taskId}" executor → "${executorType}"`);

  const taskExecutor = createHeadlessExecutor(deps);
  await taskExecutor.executeTasks(started);
  await waitForCompletion(deps.orchestrator, undefined, undefined);
}

async function headlessEditAgent(taskId: string, agentName: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !agentName) throw new Error('Missing arguments. Usage: --headless edit-agent <taskId> <claude|codex>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  const started = sharedEditTaskAgent(taskId, agentName, deps);
  console.log(`Edited task "${taskId}" agent → "${agentName}"`);

  const taskExecutor = createHeadlessExecutor(deps);
  await taskExecutor.executeTasks(started);
  await waitForCompletion(deps.orchestrator, undefined, undefined);
}

async function headlessQuerySelect(taskId: string, deps: Pick<HeadlessDeps, 'persistence'>): Promise<void> {
  if (!taskId) throw new Error('Missing taskId.');
  const selected = deps.persistence.getSelectedExperiment(taskId);
  console.log(selected
    ? `Selected experiment for ${taskId}: ${selected}`
    : `No experiment selected for ${taskId}`);
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
          console.log(`Recovered agent session from event log: ${sessionId}`);
          break;
        }
      } catch {
        // Ignore malformed payload JSON
      }
    }
  }

  if (!sessionId) {
    console.log(`No agent session for task "${taskId}"`);
    return;
  }

  console.log(`agent=${agentName} sessionId=${sessionId}`);

  const allTasks = deps.orchestrator.getAllTasks();
  const messages = await resolveAgentSession(sessionId, agentName, deps.executionAgentRegistry, allTasks);
  if (!messages) {
    console.log('Session file not found');
    return;
  }
  for (const msg of messages) {
    console.log(`[${msg.role}] ${msg.content}`);
  }
}

async function headlessCancel(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing taskId. Usage: --headless cancel <taskId>');
  taskId = restoreWorkflowForTask(taskId, deps).resolvedTaskId;

  const result = deps.orchestrator.cancelTask(taskId);
  console.log(`Cancelled ${result.cancelled.length} task(s): [${result.cancelled.join(', ')}]`);
  if (result.runningCancelled.length > 0) {
    console.log(`Killed running: [${result.runningCancelled.join(', ')}]`);
  }
}

async function headlessCancelWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowId) throw new Error('Missing workflowId. Usage: --headless cancel-workflow <workflowId>');
  const result = sharedCancelWorkflow(workflowId, { orchestrator: deps.orchestrator });
  console.log(`Cancelled ${result.cancelled.length} task(s) in workflow "${workflowId}": [${result.cancelled.join(', ')}]`);
  if (result.runningCancelled.length > 0) {
    console.log(`Killed running: [${result.runningCancelled.join(', ')}]`);
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
    runningTaskReason: 'Task is still running. View output in logs.',
  });
  if (result.opened) {
    console.log(`Opened terminal for task: ${taskId}`);
  } else {
    console.error(`Could not open terminal: ${result.reason}`);
    process.exitCode = 1;
  }
}

async function headlessDeleteWorkflow(workflowId: string, deps: Pick<HeadlessDeps, 'orchestrator'>): Promise<void> {
  if (!workflowId) throw new Error('Missing workflowId. Usage: --headless delete-workflow <workflowId>');
  deps.orchestrator.deleteWorkflow(workflowId);
  console.log(`Deleted workflow: ${workflowId}`);
}

async function headlessSetMergeMode(
  workflowId: string,
  mergeMode: string,
  deps: HeadlessDeps,
): Promise<void> {
  if (!workflowId || !mergeMode) {
    throw new Error(
      'Missing arguments. Usage: --headless set-merge-mode <workflowId> <manual|automatic|github|external_review>',
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
  console.log(`Merge mode updated for ${workflowId}: ${wf?.mergeMode ?? '?'}`);
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

  const started = sharedSetTaskExternalGatePolicies(
    taskId,
    [{ workflowId, taskId: depTaskId, gatePolicy }],
    deps,
  );
  const runnable = started.filter((t) => t.status === 'running');
  if (runnable.length > 0) {
    const taskExecutor = createHeadlessExecutor(deps);
    await taskExecutor.executeTasks(runnable);
  }
  console.log(
    `Updated gate policy for ${taskId}: ${workflowId}/${depTaskId} -> ${gatePolicy} (${runnable.length} task(s) started)`,
  );
}

async function headlessSlack(deps: HeadlessDeps): Promise<void> {
  const { orchestrator, persistence, initServices, wireSlackBot } = deps;

  const logFn = (source: string, level: string, message: string) => {
    const prefix = level === 'error' ? `${RED}[${source}]${RESET}` : `[${source}]`;
    console.log(`${prefix} ${message}`);
    persistence.writeActivityLog(source, level, message);
  };

  await initServices();

  const taskExecutor = createHeadlessExecutor(deps, {
    onComplete: (taskId) => {
      logFn('exec', 'info', `Task "${taskId}" completed`);
    },
  });
  wireHeadlessApproveHook(deps, taskExecutor);

  const api = startApiServer({ orchestrator, persistence, executorRegistry: deps.executorRegistry, taskExecutor });

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

async function waitForCompletion(orchestrator: Orchestrator, workflowId?: string, waitForApproval?: boolean): Promise<void> {
  const maxWaitMs = waitForApproval ? 86_400_000 : 1_800_000; // 24 hours if waiting for approval, else 30 minutes
  const pollIntervalMs = 100;
  const start = Date.now();

  if (waitForApproval) {
    console.log('[headless] Waiting for PR approval (--wait-for-approval)...');
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
    if (allSettled) return;
    // Also settle if nothing is running and at least one task awaits human action.
    // Pending merge gates can't progress until their upstream is approved.
    const noneRunning = !tasks.some(
      (t) => t.status === 'running' || t.status === 'fixing_with_ai',
    );
    const hasHumanBlocked = tasks.some((t) => settledStatuses.includes(t.status) && t.status !== 'completed');
    if (noneRunning && hasHumanBlocked) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

// ── Headless Delegation ──────────────────────────────────────

/**
 * Try to delegate 'run' command to a GUI process. Returns true if delegated, false if no GUI available.
 */
export async function tryDelegateRun(
  planPath: string,
  messageBus: MessageBus,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<boolean> {
  return tryDelegate('headless.run', { planPath: resolvePath(planPath) }, messageBus, waitForApproval, noTrack);
}

/**
 * Try to delegate 'resume' command to a GUI process. Returns true if delegated, false if no GUI available.
 */
export async function tryDelegateResume(
  workflowId: string,
  messageBus: MessageBus,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<boolean> {
  return tryDelegate('headless.resume', { workflowId }, messageBus, waitForApproval, noTrack);
}

/**
 * Try to delegate a mutating headless command to a GUI process.
 * Returns true if delegated, false if no GUI is available.
 */
export async function tryDelegateExec(
  args: string[],
  messageBus: MessageBus,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<boolean> {
  const DELEGATION_TIMEOUT = Symbol('delegation-timeout');
  const timeoutPromise = new Promise<typeof DELEGATION_TIMEOUT>((_, reject) => {
    setTimeout(() => reject(DELEGATION_TIMEOUT), 5000);
  });

  try {
    await Promise.race([
      messageBus.request('headless.exec', { args, waitForApproval, noTrack }),
      timeoutPromise,
    ]);
    return true;
  } catch (err) {
    if (err === DELEGATION_TIMEOUT) {
      return false;
    }
    if (err instanceof Error && err.message.includes('No request handler registered for channel')) {
      return false;
    }
    throw err;
  }
}

/**
 * Core delegation logic: send request to GUI, stream updates, wait for completion.
 * Returns true if delegated successfully, false if no GUI is available (fall back to standalone).
 */
async function tryDelegate(
  channel: string,
  payload: unknown,
  messageBus: MessageBus,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<boolean> {
  const { formatTaskStatus } = await import('./formatter.js');

  // Local task state tracking
  const tasks = new Map<string, TaskState>();
  let targetWorkflowId: string | undefined;

  // Subscribe to task deltas BEFORE sending request (critical to not miss initial 'created' deltas)
  const deltaUnsub = messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
    if (delta.type === 'created') {
      const task = delta.task;
      if (!targetWorkflowId || task.config.workflowId === targetWorkflowId) {
        tasks.set(task.id, task);
        console.log(formatTaskStatus(task));
      }
    } else if (delta.type === 'updated') {
      const existing = tasks.get(delta.taskId);
      if (existing) {
        // Merge changes into existing task (same pattern as main.ts setupGuiMode)
        const { config: cfgChanges, execution: execChanges, ...topLevel } = delta.changes;
        const updated: TaskState = {
          ...existing,
          ...topLevel,
          config: { ...existing.config, ...cfgChanges },
          execution: { ...existing.execution, ...execChanges },
        };
        tasks.set(delta.taskId, updated);
        console.log(formatTaskStatus(updated));
      }
    } else if (delta.type === 'removed') {
      tasks.delete(delta.taskId);
    }
  });

  // Subscribe to task output for live streaming
  const outputUnsub = messageBus.subscribe<{ taskId: string; data: string }>(Channels.TASK_OUTPUT, ({ taskId, data }) => {
    if (tasks.has(taskId)) {
      process.stdout.write(`\x1b[2m[${taskId}]\x1b[0m ${data}`);
    }
  });

  try {
    // Send request with timeout (5 seconds) to detect if GUI is available
    const DELEGATION_TIMEOUT = Symbol('delegation-timeout');
    const timeoutPromise = new Promise<typeof DELEGATION_TIMEOUT>((_, reject) => {
      setTimeout(() => reject(DELEGATION_TIMEOUT), 5000);
    });

    let response: { workflowId: string; tasks: TaskState[] };
    try {
      response = await Promise.race([
        messageBus.request<typeof payload, typeof response>(channel, payload),
        timeoutPromise,
      ]) as { workflowId: string; tasks: TaskState[] };
    } catch (err) {
      if (err === DELEGATION_TIMEOUT) {
        // No GUI available, fall back to standalone
        return false;
      }
      if (err instanceof Error && err.message.includes('No request handler registered for channel')) {
        // Connected peer is not a GUI process (or handler not yet wired); fall back to standalone.
        return false;
      }
      // Real error, rethrow
      throw err;
    }

    // Delegation successful
    targetWorkflowId = response.workflowId;
    console.log(`Delegated to GUI — workflow: ${targetWorkflowId}`);

    if (noTrack) {
      console.log('[headless] --no-track enabled: delegated submission accepted; exiting without tracking.');
      return true;
    }

    // Seed local map from response tasks (for tasks not yet received via delta)
    for (const task of response.tasks) {
      if (!tasks.has(task.id)) {
        tasks.set(task.id, task);
      }
    }

    // Wait for settlement
    await waitForDelegatedSettlement(tasks, targetWorkflowId, waitForApproval);

    // Print final summary
    const taskArray = Array.from(tasks.values());
    const completedCount = taskArray.filter(t => t.status === 'completed').length;
    const failedCount = taskArray.filter(t => t.status === 'failed').length;
    console.log(`\n${BOLD}Summary:${RESET} ${completedCount} completed, ${failedCount} failed`);

    // Check for PR URL
    const mergeTask = taskArray.find(t => t.config.isMergeNode);
    if (mergeTask?.execution?.reviewUrl) {
      console.log(`\nPull Request: ${mergeTask.execution.reviewUrl}`);
    }

    // Set exit code if any tasks failed
    if (failedCount > 0) {
      process.exitCode = 1;
    }

    return true;
  } finally {
    // Always unsubscribe
    deltaUnsub();
    outputUnsub();
  }
}

/**
 * Wait for all tasks in the workflow to reach a settled state.
 * Polls the local task map every 500ms.
 */
async function waitForDelegatedSettlement(
  tasks: Map<string, TaskState>,
  workflowId: string,
  waitForApproval?: boolean,
): Promise<void> {
  const maxWaitMs = waitForApproval ? 86_400_000 : 1_800_000; // 24 hours if waiting for approval, else 30 minutes
  const pollIntervalMs = 500;
  const start = Date.now();

  if (waitForApproval) {
    console.log('[headless] Waiting for PR approval (--wait-for-approval)...');
  }

  while (Date.now() - start < maxWaitMs) {
    const taskArray = Array.from(tasks.values()).filter(t => t.config.workflowId === workflowId);
    const settledStatuses = waitForApproval
      ? ['completed', 'failed', 'needs_input', 'blocked', 'stale']
      : ['completed', 'failed', 'needs_input', 'awaiting_approval', 'review_ready', 'blocked', 'stale'];
    const allSettled = taskArray.every((t) => settledStatuses.includes(t.status));
    if (allSettled) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
