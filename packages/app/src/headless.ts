/**
 * Headless CLI logic extracted from main.ts.
 *
 * All functions that implement `--headless <command>` live here.
 * They receive shared services via a `HeadlessDeps` object instead of
 * accessing module-level variables directly.
 */

import { Orchestrator } from '@invoker/core';
import type { TaskDelta, TaskState } from '@invoker/core';
import { SQLiteAdapter } from '@invoker/persistence';
import { LocalBus, Channels } from '@invoker/transport';
import { FamiliarRegistry, TaskExecutor, GitHubMergeGateProvider } from '@invoker/executors';
import type { InvokerConfig } from './config.js';
import { backupPlan } from './plan-backup.js';
import { startApiServer } from './api-server.js';
import { spawn } from 'node:child_process';

// ── HeadlessDeps interface ───────────────────────────────────

export interface HeadlessDeps {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  familiarRegistry: FamiliarRegistry;
  messageBus: LocalBus;
  repoRoot: string;
  invokerConfig: InvokerConfig;
  initServices: () => void;
  wireSlackBot: (deps: {
    executor: TaskExecutor;
    logFn: (source: string, level: string, message: string) => void;
    onPlanLoaded?: () => void;
  }) => Promise<any>;
}

// ── ANSI Helpers ─────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';

// ── Headless Implementation ──────────────────────────────────

function headlessHeartbeat(taskId: string, deps: Pick<HeadlessDeps, 'persistence'>): void {
  const now = new Date();
  try { deps.persistence.updateTask(taskId, { execution: { lastHeartbeatAt: now } }); } catch { /* db locked */ }
}

export async function runHeadless(args: string[], deps: HeadlessDeps): Promise<void> {
  const command = args[0];

  switch (command) {
    case 'run':
      await headlessRun(args[1], deps);
      break;
    case 'list':
      await headlessList(deps);
      break;
    case 'resume':
      await headlessResume(args[1], deps);
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
  electron dist/main.js --headless edit <id> <cmd>    Edit task command and re-run
  electron dist/main.js --headless audit <taskId>     Print event history
  electron dist/main.js --headless slack              Start Slack bot (long-running)
`);
}

async function headlessRun(planPath: string, deps: HeadlessDeps): Promise<void> {
  const { orchestrator, persistence, familiarRegistry, messageBus, repoRoot, invokerConfig } = deps;
  if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');

  const { readFile } = await import('node:fs/promises');
  const { parsePlanFile } = await import('./plan-parser.js');
  const { formatTaskStatus, formatWorkflowStatus } = await import('./formatter.js');

  const yamlSource = await readFile(planPath, 'utf-8');
  const plan = await parsePlanFile(planPath, repoRoot);
  backupPlan(plan, yamlSource);
  console.log(`${BOLD}Loading plan: ${plan.name}${RESET}`);
  console.log(`Tasks: ${plan.tasks.length}\n`);

  // Subscribe to deltas for live output
  messageBus.subscribe<TaskDelta>(Channels.TASK_DELTA, (delta) => {
    if (delta.type === 'updated') {
      const task = orchestrator.getTask(delta.taskId);
      if (task) console.log(formatTaskStatus(task));
    } else if (delta.type === 'created') {
      console.log(formatTaskStatus(delta.task));
    }
  });

  const taskExecutor = new TaskExecutor({
    orchestrator,
    persistence,
    familiarRegistry,
    cwd: repoRoot,
    defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
    mergeGateProvider: new GitHubMergeGateProvider(),
    callbacks: {
      onOutput: (taskId, data) => {
        process.stdout.write(`\x1b[2m[${taskId}]\x1b[0m ${data}`);
      },
      onHeartbeat: (taskId) => headlessHeartbeat(taskId, deps),
    },
  });
  orchestrator.setBeforeApproveHook(async (task) => {
    if (task.config.isMergeNode && task.config.workflowId) {
      const workflow = persistence.loadWorkflow(task.config.workflowId);
      if (workflow?.mergeMode === "github") return; // PR is the merge mechanism
      await taskExecutor.approveMerge(task.config.workflowId);
    }
  });

  const api = startApiServer({ orchestrator, persistence, familiarRegistry, taskExecutor });

  const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
  orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
  const currentWorkflowId = orchestrator.getWorkflowIds().find((id) => !wfIdsBefore.has(id));

  const started = orchestrator.startExecution();
  await taskExecutor.executeTasks(started);

  // Wait for all tasks in this workflow to settle
  await waitForCompletion(orchestrator, currentWorkflowId);

  await api.close().catch(() => {});

  const status = orchestrator.getWorkflowStatus(currentWorkflowId);
  console.log(`\n${formatWorkflowStatus(status)}`);

  // Print PR URL if the merge gate created one
  const mergeTask = orchestrator.getAllTasks().find(
    t => t.config.workflowId === currentWorkflowId && t.config.isMergeNode,
  );
  if (mergeTask?.execution?.prUrl) {
    console.log(`\nPull Request: ${mergeTask.execution.prUrl}`);
  }

  // onFinish is now handled by the merge node in the TaskExecutor
  if (status.failed > 0) process.exitCode = 1;
}

async function headlessResume(workflowId: string, deps: HeadlessDeps): Promise<void> {
  const { orchestrator, persistence, familiarRegistry, messageBus, repoRoot, invokerConfig } = deps;
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

  const taskExecutor = new TaskExecutor({
    orchestrator,
    persistence,
    familiarRegistry,
    cwd: repoRoot,
    defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
    mergeGateProvider: new GitHubMergeGateProvider(),
    callbacks: {
      onOutput: (taskId, data) => {
        process.stdout.write(`\x1b[2m[${taskId}]\x1b[0m ${data}`);
      },
      onHeartbeat: (taskId) => headlessHeartbeat(taskId, deps),
    },
  });
  orchestrator.setBeforeApproveHook(async (task) => {
    if (task.config.isMergeNode && task.config.workflowId) {
      const workflow = persistence.loadWorkflow(task.config.workflowId);
      if (workflow?.mergeMode === "github") return; // PR is the merge mechanism
      await taskExecutor.approveMerge(task.config.workflowId);
    }
  });

  const api = startApiServer({ orchestrator, persistence, familiarRegistry, taskExecutor });

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
  await waitForCompletion(orchestrator);

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
  const { orchestrator, persistence, familiarRegistry, repoRoot, invokerConfig } = deps;
  if (!taskId) throw new Error('Missing taskId.');
  restoreWorkflowForTask(taskId, deps);
  const te = new TaskExecutor({ orchestrator, persistence, familiarRegistry, cwd: repoRoot, defaultBranch: invokerConfig.defaultBranch, mergeGateProvider: new GitHubMergeGateProvider() });
  orchestrator.setBeforeApproveHook(async (task) => {
    if (task.config.isMergeNode && task.config.workflowId) {
      const workflow = persistence.loadWorkflow(task.config.workflowId);
      if (workflow?.mergeMode === "github") return; // PR is the merge mechanism
      await te.approveMerge(task.config.workflowId);
    }
  });
  await orchestrator.approve(taskId);
  console.log(`Approved task: ${taskId}`);
}

function headlessReject(taskId: string, deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>, reason?: string): void {
  if (!taskId) throw new Error('Missing taskId.');
  restoreWorkflowForTask(taskId, deps);
  deps.orchestrator.reject(taskId, reason);
  console.log(`Rejected task: ${taskId}${reason ? ` (reason: ${reason})` : ''}`);
}

function headlessInput(taskId: string, text: string, deps: Pick<HeadlessDeps, 'orchestrator' | 'persistence'>): void {
  if (!taskId || !text) throw new Error('Missing arguments. Usage: --headless input <taskId> <text>');
  restoreWorkflowForTask(taskId, deps);
  deps.orchestrator.provideInput(taskId, text);
  console.log(`Input provided to task: ${taskId}`);
}

async function headlessSelect(taskId: string, experimentId: string, deps: HeadlessDeps): Promise<void> {
  const { orchestrator, persistence, familiarRegistry, repoRoot, invokerConfig } = deps;
  if (!taskId || !experimentId) throw new Error('Missing arguments. Usage: --headless select <taskId> <expId>');
  const workflowId = restoreWorkflowForTask(taskId, deps);
  orchestrator.selectExperiment(taskId, experimentId);
  console.log(`Selected experiment ${experimentId} for task: ${taskId}`);

  // Resume execution
  const taskExecutor = new TaskExecutor({
    orchestrator,
    persistence,
    familiarRegistry,
    cwd: repoRoot,
    defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
    mergeGateProvider: new GitHubMergeGateProvider(),
    callbacks: {
      onOutput: (tid, data) => {
        process.stdout.write(`\x1b[2m[${tid}]\x1b[0m ${data}`);
      },
      onHeartbeat: (tid) => headlessHeartbeat(tid, deps),
    },
  });

  const started = orchestrator.resumeWorkflow(workflowId);
  await taskExecutor.executeTasks(started);
  await waitForCompletion(orchestrator);
}

async function headlessRestart(taskId: string, deps: HeadlessDeps): Promise<void> {
  const { orchestrator, persistence, familiarRegistry, repoRoot, invokerConfig } = deps;
  if (!taskId) throw new Error('Missing arguments. Usage: --headless restart <taskId>');
  restoreWorkflowForTask(taskId, deps);

  const started = orchestrator.restartTask(taskId);
  const runnable = started.filter(t => t.status === 'running');
  console.log(`Restarted task "${taskId}" — ${runnable.length} task(s) to execute`);

  if (runnable.length === 0) return;

  const taskExecutor = new TaskExecutor({
    orchestrator,
    persistence,
    familiarRegistry,
    cwd: repoRoot,
    defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
    mergeGateProvider: new GitHubMergeGateProvider(),
    callbacks: {
      onOutput: (tid, data) => {
        process.stdout.write(`\x1b[2m[${tid}]\x1b[0m ${data}`);
      },
      onHeartbeat: (tid) => headlessHeartbeat(tid, deps),
    },
  });

  await taskExecutor.executeTasks(runnable);
  await waitForCompletion(orchestrator);
}

async function headlessRebaseAndRetry(taskId: string, deps: HeadlessDeps): Promise<void> {
  const { orchestrator, persistence, familiarRegistry, repoRoot, invokerConfig } = deps;
  if (!taskId) throw new Error('Missing arguments. Usage: --headless rebase-and-retry <taskId>');
  const workflowId = restoreWorkflowForTask(taskId, deps);

  const task = orchestrator.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const mergeTask = orchestrator.getAllTasks().find(
    t => t.config.workflowId === workflowId && t.config.isMergeNode,
  );

  const workflow = persistence.loadWorkflow(workflowId);
  const te = new TaskExecutor({
    orchestrator,
    persistence,
    familiarRegistry,
    cwd: repoRoot,
    defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
    mergeGateProvider: new GitHubMergeGateProvider(),
    callbacks: {
      onOutput: (tid, data) => {
        process.stdout.write(`\x1b[2m[${tid}]\x1b[0m ${data}`);
      },
      onHeartbeat: (tid) => headlessHeartbeat(tid, deps),
    },
  });

  const baseBranch = workflow?.baseBranch ?? invokerConfig.defaultBranch ?? await te.detectDefaultBranch();
  const result = await te.rebaseTaskBranches(workflowId, baseBranch);

  console.log(`Rebase result: ${result.success ? 'clean' : 'conflicts'}`);
  if (result.rebasedBranches.length > 0) {
    console.log(`  Rebased: ${result.rebasedBranches.join(', ')}`);
  }
  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.join('; ')}`);
  }

  let runnable: ReturnType<typeof orchestrator.restartTask>;
  if (result.success && mergeTask) {
    runnable = orchestrator.restartTask(mergeTask.id).filter(t => t.status === 'running');
    console.log(`Clean rebase — restarting merge gate only (${runnable.length} task(s))`);
  } else {
    runnable = bumpGenerationAndRestart(workflowId, deps).filter(t => t.status === 'running');
    console.log(`Conflicting rebase — resetting entire DAG (${runnable.length} task(s))`);
  }

  if (runnable.length > 0) {
    await te.executeTasks(runnable);
    await waitForCompletion(orchestrator, workflowId);
  }
}

export function bumpGenerationAndRestart(workflowId: string, deps: Pick<HeadlessDeps, 'persistence' | 'orchestrator'>): TaskState[] {
  const { persistence, orchestrator } = deps;
  const workflow = persistence.loadWorkflow(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  const nextGen = (workflow.generation ?? 0) + 1;
  persistence.updateWorkflow(workflowId, { generation: nextGen });
  console.log(`[workflow] bumped generation to ${nextGen} for ${workflowId}`);
  return orchestrator.restartWorkflow(workflowId);
}

async function headlessEdit(taskId: string, newCommand: string, deps: HeadlessDeps): Promise<void> {
  const { orchestrator, persistence, familiarRegistry, repoRoot, invokerConfig } = deps;
  if (!taskId || !newCommand) throw new Error('Missing arguments. Usage: --headless edit <taskId> <newCommand>');
  const workflowId = restoreWorkflowForTask(taskId, deps);

  const started = orchestrator.editTaskCommand(taskId, newCommand);
  console.log(`Edited task "${taskId}" command → "${newCommand}"`);

  const taskExecutor = new TaskExecutor({
    orchestrator,
    persistence,
    familiarRegistry,
    cwd: repoRoot,
    defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
    mergeGateProvider: new GitHubMergeGateProvider(),
    callbacks: {
      onOutput: (tid, data) => {
        process.stdout.write(`\x1b[2m[${tid}]\x1b[0m ${data}`);
      },
      onHeartbeat: (tid) => headlessHeartbeat(tid, deps),
    },
  });

  await taskExecutor.executeTasks(started);
  await waitForCompletion(orchestrator);
}

async function headlessEditType(taskId: string, familiarType: string, deps: HeadlessDeps): Promise<void> {
  const { orchestrator, persistence, familiarRegistry, repoRoot, invokerConfig } = deps;
  if (!taskId || !familiarType) throw new Error('Missing arguments. Usage: --headless edit-type <taskId> <familiarType>');
  const workflowId = restoreWorkflowForTask(taskId, deps);

  const started = orchestrator.editTaskType(taskId, familiarType);
  console.log(`Edited task "${taskId}" familiarType → "${familiarType}"`);

  const taskExecutor = new TaskExecutor({
    orchestrator,
    persistence,
    familiarRegistry,
    cwd: repoRoot,
    defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
    mergeGateProvider: new GitHubMergeGateProvider(),
    callbacks: {
      onOutput: (tid, data) => {
        process.stdout.write(`\x1b[2m[${tid}]\x1b[0m ${data}`);
      },
      onHeartbeat: (tid) => headlessHeartbeat(tid, deps),
    },
  });

  await taskExecutor.executeTasks(started);
  await waitForCompletion(orchestrator);
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

async function headlessSlack(deps: HeadlessDeps): Promise<void> {
  const { orchestrator, persistence, familiarRegistry, repoRoot, invokerConfig, initServices, wireSlackBot } = deps;

  const logFn = (source: string, level: string, message: string) => {
    const prefix = level === 'error' ? `${RED}[${source}]${RESET}` : `[${source}]`;
    console.log(`${prefix} ${message}`);
    persistence.writeActivityLog(source, level, message);
  };

  initServices();

  const taskExecutor = new TaskExecutor({
    orchestrator,
    persistence,
    familiarRegistry,
    cwd: repoRoot,
    defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
    mergeGateProvider: new GitHubMergeGateProvider(),
    callbacks: {
      onOutput: (taskId, data) => {
        process.stdout.write(`\x1b[2m[${taskId}]\x1b[0m ${data}`);
      },
      onComplete: (taskId) => {
        logFn('exec', 'info', `Task "${taskId}" completed`);
      },
      onHeartbeat: (taskId) => headlessHeartbeat(taskId, deps),
    },
  });

  // BUG FIX: wireApproveHook() was called here but is only defined inside
  // setupGuiMode(), causing a ReferenceError at runtime. Inline the hook
  // setup instead, matching what headlessRun/headlessResume/headlessApprove do.
  orchestrator.setBeforeApproveHook(async (task) => {
    if (task.config.isMergeNode && task.config.workflowId) {
      const workflow = persistence.loadWorkflow(task.config.workflowId);
      if (workflow?.mergeMode === "github") return;
      await taskExecutor.approveMerge(task.config.workflowId);
    }
  });

  const api = startApiServer({ orchestrator, persistence, familiarRegistry, taskExecutor });

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

async function waitForCompletion(orchestrator: Orchestrator, workflowId?: string): Promise<void> {
  const maxWaitMs = 300_000; // 5 minutes
  const pollIntervalMs = 100;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    let tasks = orchestrator.getAllTasks();
    if (workflowId) {
      tasks = tasks.filter((t) => t.config.workflowId === workflowId);
    }
    const allSettled = tasks.every(
      (t) =>
        t.status === 'completed' ||
        t.status === 'failed' ||
        t.status === 'needs_input' ||
        t.status === 'awaiting_approval' ||
        t.status === 'blocked' ||
        t.status === 'stale',
    );
    if (allSettled) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function execCommand(cmd: string, args: string[], repoRoot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
    });
  });
}
