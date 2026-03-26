/**
 * Headless CLI logic extracted from main.ts.
 *
 * All functions that implement `--headless <command>` live here.
 * They receive shared services via a `HeadlessDeps` object instead of
 * accessing module-level variables directly.
 *
 * Business logic (orchestrator mutations) lives in workflow-actions.ts.
 * This file handles CLI parsing, TaskExecutor lifecycle, and output formatting.
 */

import { Orchestrator } from '@invoker/core';
import type { TaskDelta, TaskState, TaskStateChanges } from '@invoker/core';
import { SQLiteAdapter } from '@invoker/persistence';
import { resolve as resolvePath } from 'node:path';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { FamiliarRegistry, TaskExecutor, GitHubMergeGateProvider } from '@invoker/executors';
import type { InvokerConfig } from './config.js';
import { backupPlan } from './plan-backup.js';
import { startApiServer } from './api-server.js';
import {
  rebaseAndRetry,
  rejectTask,
  restartTask as sharedRestartTask,
  editTaskCommand as sharedEditTaskCommand,
  editTaskType as sharedEditTaskType,
  selectExperiment as sharedSelectExperiment,
} from './workflow-actions.js';

export { bumpGenerationAndRestart } from './workflow-actions.js';

// ── HeadlessDeps interface ───────────────────────────────────

export interface HeadlessDeps {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  familiarRegistry: FamiliarRegistry;
  messageBus: MessageBus;
  repoRoot: string;
  invokerConfig: InvokerConfig;
  initServices: () => Promise<void>;
  wireSlackBot: (deps: {
    executor: TaskExecutor;
    logFn: (source: string, level: string, message: string) => void;
    onPlanLoaded?: () => void;
  }) => Promise<any>;
  waitForApproval?: boolean;
}

// ── ANSI Helpers ─────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';

// ── Shared Helpers ───────────────────────────────────────────

function headlessHeartbeat(taskId: string, deps: Pick<HeadlessDeps, 'persistence'>): void {
  const now = new Date();
  try { deps.persistence.updateTask(taskId, { execution: { lastHeartbeatAt: now } }); } catch { /* db locked */ }
}

function createHeadlessExecutor(
  deps: HeadlessDeps,
  callbackOverrides?: Partial<ConstructorParameters<typeof TaskExecutor>[0]['callbacks']>,
): TaskExecutor {
  return new TaskExecutor({
    orchestrator: deps.orchestrator,
    persistence: deps.persistence,
    familiarRegistry: deps.familiarRegistry,
    cwd: deps.repoRoot,
    defaultBranch: deps.invokerConfig.defaultBranch,
    remoteTargets: deps.invokerConfig.remoteTargets,
    mergeGateProvider: new GitHubMergeGateProvider(),
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

function wireHeadlessApproveHook(deps: HeadlessDeps, te: TaskExecutor): void {
  deps.orchestrator.setBeforeApproveHook(async (task) => {
    if (task.config.isMergeNode && task.config.workflowId) {
      const workflow = deps.persistence.loadWorkflow(task.config.workflowId);
      if (workflow?.mergeMode === "github") return;
      await te.approveMerge(task.config.workflowId);
    }
  });
}

// ── Headless Command Router ──────────────────────────────────

export async function runHeadless(args: string[], deps: HeadlessDeps): Promise<void> {
  const command = args[0];

  switch (command) {
    case 'run':
      await headlessRun(args[1], deps, deps.waitForApproval);
      break;
    case 'list':
      await headlessList(deps);
      break;
    case 'resume':
      await headlessResume(args[1], deps, deps.waitForApproval);
      break;
    case 'status':
      await headlessStatus(deps);
      break;
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
    case 'restart':
      await headlessRestart(args[1], deps);
      break;
    case 'fix':
      await headlessFix(args[1], deps);
      break;
    case 'rebase-and-retry':
      await headlessRebaseAndRetry(args[1], deps);
      break;
    case 'edit':
      await headlessEdit(args[1], args.slice(2).join(' '), deps);
      break;
    case 'edit-type':
      await headlessEditType(args[1], args[2], deps);
      break;
    case 'audit':
      await headlessAudit(args[1], deps);
      break;
    case 'cancel':
      await headlessCancel(args[1], deps);
      break;
    case 'queue':
      await headlessQueue(deps);
      break;
    case 'query-select':
      await headlessQuerySelect(args[1], deps);
      break;
    case 'delete-all':
      deps.persistence.deleteAllWorkflows();
      console.log('All workflows deleted.');
      break;
    case 'slack':
      await headlessSlack(deps);
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

${BOLD}Usage:${RESET}
  ./submit-plan.sh <plan.yaml>                        Run a plan (recommended)
  electron dist/main.js --headless run <plan.yaml>    Load and execute plan
  electron dist/main.js --headless list               List all saved workflows
  electron dist/main.js --headless resume <id>        Resume incomplete workflow
  electron dist/main.js --headless status             Show current task states
  electron dist/main.js --headless approve <taskId>   Approve a task
  electron dist/main.js --headless reject <id> [why]  Reject a task
  electron dist/main.js --headless input <id> <text>  Provide input to task
  electron dist/main.js --headless select <id> <exp>  Select winning experiment
  electron dist/main.js --headless restart <id>       Restart a failed/stuck task
  electron dist/main.js --headless fix <taskId>       Fix a failed task with Claude
  electron dist/main.js --headless edit <id> <cmd>    Edit task command and re-run
  electron dist/main.js --headless cancel <taskId>    Cancel task + all downstream
  electron dist/main.js --headless queue              Show queue status & utilization
  electron dist/main.js --headless audit <taskId>     Print event history
  electron dist/main.js --headless slack              Start Slack bot (long-running)

${BOLD}Options:${RESET}
  --wait-for-approval    Keep running until PR approval (use with 'run' or 'resume')
`);
}

// ── Headless Commands ────────────────────────────────────────

async function headlessRun(planPath: string, deps: HeadlessDeps, waitForApproval?: boolean): Promise<void> {
  const { orchestrator, messageBus, repoRoot, invokerConfig } = deps;
  if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');

  const { readFile } = await import('node:fs/promises');
  const { parsePlanFile } = await import('./plan-parser.js');
  const { formatTaskStatus, formatWorkflowStatus } = await import('./formatter.js');

  const yamlSource = await readFile(planPath, 'utf-8');
  const plan = await parsePlanFile(planPath, repoRoot);
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

  const api = startApiServer({ orchestrator, persistence: deps.persistence, familiarRegistry: deps.familiarRegistry, taskExecutor });

  const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
  orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
  const currentWorkflowId = orchestrator.getWorkflowIds().find((id) => !wfIdsBefore.has(id));

  const started = orchestrator.startExecution();
  await taskExecutor.executeTasks(started);

  await waitForCompletion(orchestrator, currentWorkflowId, waitForApproval);

  await api.close().catch(() => {});

  const status = orchestrator.getWorkflowStatus(currentWorkflowId);
  console.log(`\n${formatWorkflowStatus(status)}`);

  const mergeTask = orchestrator.getAllTasks().find(
    t => t.config.workflowId === currentWorkflowId && t.config.isMergeNode,
  );
  if (mergeTask?.execution?.prUrl) {
    console.log(`\nPull Request: ${mergeTask.execution.prUrl}`);
  }

  if (status.failed > 0) process.exitCode = 1;
}

async function headlessResume(workflowId: string, deps: HeadlessDeps, waitForApproval?: boolean): Promise<void> {
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

  const api = startApiServer({ orchestrator, persistence: deps.persistence, familiarRegistry: deps.familiarRegistry, taskExecutor });

  orchestrator.syncFromDb(workflowId);

  // Relaunch tasks stuck in 'running' from a previous session
  const orphanRestarted: TaskState[] = [];
  for (const task of orchestrator.getAllTasks()) {
    if (task.status === 'running') {
      console.log(`[headless] relaunching orphaned running task "${task.id}"`);
      const restarted = orchestrator.restartTask(task.id);
      orphanRestarted.push(...restarted.filter(t => t.status === 'running'));
    }
  }

  const started = orchestrator.startExecution();
  await taskExecutor.executeTasks([...orphanRestarted, ...started]);
  await waitForCompletion(orchestrator, undefined, waitForApproval);

  await api.close().catch(() => {});

  const status = orchestrator.getWorkflowStatus();
  console.log(`\n${formatWorkflowStatus(status)}`);

  if (status.failed > 0) process.exitCode = 1;
}

async function headlessList(deps: Pick<HeadlessDeps, 'persistence'>): Promise<void> {
  const { formatWorkflowList } = await import('./formatter.js');
  const workflows = deps.persistence.listWorkflows();
  console.log(formatWorkflowList(workflows));
}

async function headlessStatus(deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>): Promise<void> {
  const { orchestrator, persistence } = deps;
  const { formatTaskStatus, formatWorkflowStatus } = await import('./formatter.js');
  const workflows = persistence.listWorkflows();
  if (workflows.length === 0) {
    console.log('No workflows found. Run a plan first.');
    return;
  }
  const latest = workflows[0];
  orchestrator.resumeWorkflow(latest.id);
  const tasks = orchestrator.getAllTasks();
  for (const task of tasks) console.log(formatTaskStatus(task));
  const status = orchestrator.getWorkflowStatus();
  console.log(`\n${formatWorkflowStatus(status)}`);
}

async function headlessApprove(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing taskId.');
  restoreWorkflowForTask(taskId, deps);
  const te = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, te);
  const started = await deps.orchestrator.approve(taskId);
  const runnable = started.filter(t => t.status === 'running');
  if (runnable.length > 0) await te.executeTasks(runnable);
  console.log(`Approved task: ${taskId}`);
}

function headlessReject(taskId: string, deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>, reason?: string): void {
  if (!taskId) throw new Error('Missing taskId.');
  restoreWorkflowForTask(taskId, deps);
  rejectTask(taskId, deps, reason);
  console.log(`Rejected task: ${taskId}${reason ? ` (reason: ${reason})` : ''}`);
}

function headlessInput(taskId: string, text: string, deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>): void {
  if (!taskId || !text) throw new Error('Missing arguments. Usage: --headless input <taskId> <text>');
  restoreWorkflowForTask(taskId, deps);
  deps.orchestrator.provideInput(taskId, text);
  console.log(`Input provided to task: ${taskId}`);
}

async function headlessSelect(taskId: string, experimentId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !experimentId) throw new Error('Missing arguments. Usage: --headless select <taskId> <expId>');
  const workflowId = restoreWorkflowForTask(taskId, deps);
  sharedSelectExperiment(taskId, experimentId, deps);
  console.log(`Selected experiment ${experimentId} for task: ${taskId}`);

  const taskExecutor = createHeadlessExecutor(deps);
  const started = deps.orchestrator.resumeWorkflow(workflowId);
  await taskExecutor.executeTasks(started);
  await waitForCompletion(deps.orchestrator, undefined, undefined);
}

async function headlessRestart(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing arguments. Usage: --headless restart <taskId>');
  restoreWorkflowForTask(taskId, deps);

  const started = sharedRestartTask(taskId, deps);
  const runnable = started.filter(t => t.status === 'running');
  console.log(`Restarted task "${taskId}" — ${runnable.length} task(s) to execute`);

  if (runnable.length === 0) return;

  const taskExecutor = createHeadlessExecutor(deps);
  await taskExecutor.executeTasks(runnable);
  await waitForCompletion(deps.orchestrator, undefined, undefined);
}

async function headlessFix(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing taskId. Usage: --headless fix <taskId>');
  restoreWorkflowForTask(taskId, deps);

  const te = createHeadlessExecutor(deps);
  const { savedError } = deps.orchestrator.beginConflictResolution(taskId);
  try {
    const output = deps.persistence.getTaskOutput(taskId);
    await te.fixWithClaude(taskId, output);
    deps.orchestrator.setFixAwaitingApproval(taskId, savedError);
    console.log(`Fix applied for task: ${taskId}. Use 'approve ${taskId}' or 'reject ${taskId}' to finalize.`);
  } catch (err) {
    deps.orchestrator.revertConflictResolution(taskId, savedError);
    throw err;
  }
}

async function headlessRebaseAndRetry(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing arguments. Usage: --headless rebase-and-retry <taskId>');
  restoreWorkflowForTask(taskId, deps);

  const started = await rebaseAndRetry(taskId, deps);
  const runnable = started.filter(t => t.status === 'running');
  console.log(`Rebase-and-retry: resetting workflow from current HEAD (${runnable.length} task(s))`);

  if (runnable.length === 0) return;

  const te = createHeadlessExecutor(deps);
  await te.executeTasks(runnable);
  await waitForCompletion(deps.orchestrator, deps.orchestrator.getTask(taskId)?.config.workflowId, undefined);
}

async function headlessEdit(taskId: string, newCommand: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !newCommand) throw new Error('Missing arguments. Usage: --headless edit <taskId> <newCommand>');
  restoreWorkflowForTask(taskId, deps);

  const started = sharedEditTaskCommand(taskId, newCommand, deps);
  console.log(`Edited task "${taskId}" command → "${newCommand}"`);

  const taskExecutor = createHeadlessExecutor(deps);
  await taskExecutor.executeTasks(started);
  await waitForCompletion(deps.orchestrator, undefined, undefined);
}

async function headlessEditType(taskId: string, familiarType: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !familiarType) throw new Error('Missing arguments. Usage: --headless edit-type <taskId> <familiarType>');
  restoreWorkflowForTask(taskId, deps);

  const started = sharedEditTaskType(taskId, familiarType, deps);
  console.log(`Edited task "${taskId}" familiarType → "${familiarType}"`);

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

async function headlessAudit(taskId: string | undefined, deps: Pick<HeadlessDeps, 'persistence'>): Promise<void> {
  const { formatEventLog } = await import('./formatter.js');
  if (!taskId) throw new Error('Usage: --headless audit <taskId>');
  const events = deps.persistence.getEvents(taskId);
  console.log(formatEventLog(events));
}

async function headlessCancel(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing taskId. Usage: --headless cancel <taskId>');
  restoreWorkflowForTask(taskId, deps);

  const result = deps.orchestrator.cancelTask(taskId);
  console.log(`Cancelled ${result.cancelled.length} task(s): [${result.cancelled.join(', ')}]`);
  if (result.runningCancelled.length > 0) {
    console.log(`Killed running: [${result.runningCancelled.join(', ')}]`);
  }
}

async function headlessQueue(deps: HeadlessDeps): Promise<void> {
  const { formatQueueStatus } = await import('./formatter.js');
  const workflows = deps.persistence.listWorkflows();
  if (workflows.length > 0) {
    deps.orchestrator.resumeWorkflow(workflows[0].id);
  }
  const status = deps.orchestrator.getQueueStatus();
  console.log(formatQueueStatus(status));
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

  const api = startApiServer({ orchestrator, persistence, familiarRegistry: deps.familiarRegistry, taskExecutor });

  const slack = await wireSlackBot({
    executor: taskExecutor,
    logFn,
    onPlanLoaded: () => {},
  });

  logFn('slack', 'info', 'Slack bot is running (headless, using TaskExecutor). Press Ctrl+C to stop.');

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

function restoreWorkflowForTask(taskId: string, deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>): string {
  const { orchestrator, persistence } = deps;
  const workflows = persistence.listWorkflows();
  for (const wf of workflows) {
    const tasks = persistence.loadTasks(wf.id);
    if (tasks.some(t => t.id === taskId)) {
      orchestrator.resumeWorkflow(wf.id);
      return wf.id;
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
      : ['completed', 'failed', 'needs_input', 'awaiting_approval', 'blocked', 'stale'];
    const allSettled = tasks.every((t) => settledStatuses.includes(t.status));
    if (allSettled) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

// ── Headless Delegation ──────────────────────────────────────

/**
 * Try to delegate 'run' command to a GUI process. Returns true if delegated, false if no GUI available.
 */
export async function tryDelegateRun(planPath: string, messageBus: MessageBus, waitForApproval?: boolean): Promise<boolean> {
  return tryDelegate('headless.run', { planPath: resolvePath(planPath) }, messageBus, waitForApproval);
}

/**
 * Try to delegate 'resume' command to a GUI process. Returns true if delegated, false if no GUI available.
 */
export async function tryDelegateResume(workflowId: string, messageBus: MessageBus, waitForApproval?: boolean): Promise<boolean> {
  return tryDelegate('headless.resume', { workflowId }, messageBus, waitForApproval);
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
      // Real error, rethrow
      throw err;
    }

    // Delegation successful
    targetWorkflowId = response.workflowId;
    console.log(`Delegated to GUI — workflow: ${targetWorkflowId}`);

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
    if (mergeTask?.execution?.prUrl) {
      console.log(`\nPull Request: ${mergeTask.execution.prUrl}`);
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
      : ['completed', 'failed', 'needs_input', 'awaiting_approval', 'blocked', 'stale'];
    const allSettled = taskArray.every((t) => settledStatuses.includes(t.status));
    if (allSettled) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
