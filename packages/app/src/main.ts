/**
 * Electron Main Process — GUI + Headless CLI mode.
 *
 * GUI mode (default):
 *   electron dist/main.js
 *
 * Headless mode (same runtime, no window):
 *   electron dist/main.js --headless run <plan.yaml>
 *   electron dist/main.js --headless list
 *   electron dist/main.js --headless resume <workflowId>
 *   electron dist/main.js --headless status
 *   electron dist/main.js --headless approve <taskId>
 *   electron dist/main.js --headless reject <taskId> [reason]
 *   electron dist/main.js --headless input <taskId> <text>
 *   electron dist/main.js --headless select <taskId> <expId>
 *   electron dist/main.js --headless restart <taskId>
 *   electron dist/main.js --headless edit <taskId> <newCommand>
 *   electron dist/main.js --headless audit <taskId>
 *
 * Using the same Electron binary for both modes eliminates ABI mismatches
 * with native modules (better-sqlite3).
 */

import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import * as path from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';

// Work around Chromium shared-memory / zygote issues on Linux
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('no-zygote');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}

import { Orchestrator, UTILIZATION_MAX } from '@invoker/core';
import type { PlanDefinition, TaskDelta, TaskReplacementDef, TaskState, UtilizationRule } from '@invoker/core';
import { SQLiteAdapter, ConversationRepository } from '@invoker/persistence';
import { LocalBus, Channels } from '@invoker/transport';
import {
  LocalFamiliar, FamiliarRegistry, TaskExecutor,
  DockerFamiliar, WorktreeFamiliar,
  type Familiar, type FamiliarHandle, type PersistedTaskMeta,
} from '@invoker/executors';
import type { TaskOutputData } from './types.js';
import { loadConfig, type InvokerConfig } from './config.js';
import { backupPlan } from './plan-backup.js';
import { startApiServer, type ApiServer } from './api-server.js';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// ── Detect headless mode ─────────────────────────────────────

// Electron passes extra args after `--` or interleaves them.
// We look for `--headless` anywhere in process.argv.
const headlessIndex = process.argv.indexOf('--headless');
const isHeadless = headlessIndex !== -1;

// In headless mode, extract the CLI args after --headless
const cliArgs = isHeadless ? process.argv.slice(headlessIndex + 1) : [];

// Set app name early so Electron uses "invoker" as WM_CLASS (X11) and app_id (Wayland).
// --class tells Chromium to set WM_CLASS explicitly, preventing GNOME from
// grouping Invoker with other Electron apps (e.g. Slack).
app.name = 'invoker';
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', 'invoker');
}

// ── Shared state ─────────────────────────────────────────────

let messageBus: LocalBus;
let persistence: SQLiteAdapter;
let familiarRegistry: FamiliarRegistry;
let orchestrator: Orchestrator;

// Repo root: 3 levels up from packages/app/dist/
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const invokerConfig: InvokerConfig = loadConfig(repoRoot);

function resolveUtilizationRules(config: InvokerConfig): UtilizationRule[] {
  if (!config.utilizationRules) return [];
  return config.utilizationRules.map((r) => ({
    pattern: r.pattern,
    utilization: r.utilization === 'max' ? UTILIZATION_MAX : r.utilization,
  }));
}

function initServices(): void {
  messageBus = new LocalBus();
  const dbDir = process.env.NODE_ENV === 'test'
    ? path.join(homedir(), '.invoker', 'test')
    : path.join(homedir(), '.invoker');
  mkdirSync(dbDir, { recursive: true });
  persistence = new SQLiteAdapter(path.join(dbDir, 'invoker.db'));
  familiarRegistry = new FamiliarRegistry();
  familiarRegistry.register('local', new LocalFamiliar());
  orchestrator = new Orchestrator({
    persistence, messageBus,
    maxUtilization: 100,
    utilizationRules: resolveUtilizationRules(invokerConfig),
    defaultUtilization: invokerConfig.defaultUtilization,
  });

  orchestrator.syncAllFromDb();
  const workflows = persistence.listWorkflows();
  for (const wf of workflows) {
    const tasks = persistence.loadTasks(wf.id);
    console.log(`[init] DB workflow "${wf.id}" (${wf.name}): ${tasks.length} tasks`);
  }
  console.log(`[init] Orchestrator graph has ${orchestrator.getAllTasks().length} tasks across ${workflows.length} workflows`);
}

// ── Load @invoker/surfaces at runtime ────────────────────────
// Uses createRequire anchored to this file so Node resolves
// better-sqlite3 from packages/app/node_modules/ (not surfaces/).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadSurfaces(): any {
  const req = createRequire(__filename);
  return req('@invoker/surfaces');
}

// ── Shared Slack Bot Wiring ──────────────────────────────────

interface SlackBotDeps {
  executor: TaskExecutor;
  logFn: (source: string, level: string, message: string) => void;
  onStartPlan?: () => void;
  onPlanLoaded?: (plan: PlanDefinition) => void;
}

async function wireSlackBot(deps: SlackBotDeps): Promise<any> {
  // Load .env for Slack tokens
  try {
    const dotenv = await import('dotenv');
    dotenv.config({ path: path.resolve(repoRoot, '.env') });
  } catch {
    // dotenv not installed — rely on environment variables
  }

  const requiredVars = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_CHANNEL_ID'];
  for (const v of requiredVars) {
    if (!process.env[v]) throw new Error(`Missing env var: ${v}. Set it in .env or environment.`);
  }

  const surfaces = loadSurfaces();
  const conversationRepo = new ConversationRepository(persistence, {
    info: (msg) => { console.log(`[conversation-repo] ${msg}`); try { persistence.writeActivityLog('conversation-repo', 'info', msg); } catch { /* db locked */ } },
    warn: (msg) => { console.warn(`[conversation-repo] ${msg}`); try { persistence.writeActivityLog('conversation-repo', 'warn', msg); } catch { /* db locked */ } },
    error: (msg) => { console.error(`[conversation-repo] ${msg}`); try { persistence.writeActivityLog('conversation-repo', 'error', msg); } catch { /* db locked */ } },
  });
  const slack = new surfaces.SlackSurface({
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    channelId: process.env.SLACK_CHANNEL_ID!,
    cursorCommand: process.env.CURSOR_COMMAND ?? 'cursor',
    workingDir: repoRoot,
    conversationRepo,
    defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
    log: deps.logFn,
  });

  await slack.start(async (command: any) => {
    deps.logFn('trace', 'info', `slackBot: command received — type=${command.type}`);
    switch (command.type) {
      case 'approve':
        orchestrator.approve(command.taskId);
        break;
      case 'reject':
        orchestrator.reject(command.taskId, command.reason);
        break;
      case 'select_experiment': {
        const started = orchestrator.selectExperiment(command.taskId, command.experimentId);
        await deps.executor.executeTasks(started);
        break;
      }
      case 'provide_input':
        orchestrator.provideInput(command.taskId, command.input);
        break;
      case 'get_status':
        break;
      case 'start_plan': {
        deps.logFn('trace', 'info', `slackBot: loading plan "${command.plan.name}" (${command.plan.tasks.length} tasks)`);
        deps.onStartPlan?.();
        deps.onPlanLoaded?.(command.plan);
        backupPlan(command.plan);
        orchestrator.loadPlan(command.plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
        const started = orchestrator.startExecution();
        deps.logFn('trace', 'info', `slackBot: startExecution returned ${started.length} tasks: [${started.map((t: any) => t.id).join(', ')}]`);
        await deps.executor.executeTasks(started);
        break;
      }
    }
  });

  return slack;
}

// ── ANSI Helpers ─────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';

// ══════════════════════════════════════════════════════════════
// HEADLESS MODE
// ══════════════════════════════════════════════════════════════

if (isHeadless) {
  app.whenReady().then(async () => {
    initServices();
    try {
      await runHeadless(cliArgs);
    } catch (err) {
      console.error(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    persistence.close();
    messageBus.disconnect();
    process.exit(0);
  });
} else {
  // ══════════════════════════════════════════════════════════════
  // GUI MODE
  // ══════════════════════════════════════════════════════════════
  if (process.env.NODE_ENV !== 'test') {
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      app.quit();
    } else {
      setupGuiMode();
    }
  } else {
    setupGuiMode();
  }
}

// ── Headless Implementation ──────────────────────────────────

function headlessHeartbeat(taskId: string): void {
  const now = new Date();
  try { persistence.updateTask(taskId, { execution: { lastHeartbeatAt: now } }); } catch { /* db locked */ }
}

async function runHeadless(args: string[]): Promise<void> {
  const command = args[0];

  switch (command) {
    case 'run':
      await headlessRun(args[1]);
      break;
    case 'list':
      await headlessList();
      break;
    case 'resume':
      await headlessResume(args[1]);
      break;
    case 'status':
      await headlessStatus();
      break;
    case 'approve':
      headlessApprove(args[1]);
      break;
    case 'reject':
      headlessReject(args[1], args.slice(2).join(' ') || undefined);
      break;
    case 'input':
      headlessInput(args[1], args.slice(2).join(' '));
      break;
    case 'select':
      await headlessSelect(args[1], args[2]);
      break;
    case 'restart':
      await headlessRestart(args[1]);
      break;
    case 'rebase-and-retry':
      await headlessRebaseAndRetry(args[1]);
      break;
    case 'edit':
      await headlessEdit(args[1], args.slice(2).join(' '));
      break;
    case 'edit-type':
      await headlessEditType(args[1], args[2]);
      break;
    case 'audit':
      await headlessAudit(args[1]);
      break;
    case 'query-select':
      await headlessQuerySelect(args[1]);
      break;
    case 'delete-all':
      persistence.deleteAllWorkflows();
      console.log('All workflows deleted.');
      break;
    case 'slack':
      await headlessSlack();
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

async function headlessRun(planPath: string): Promise<void> {
  if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');

  const { readFile } = await import('node:fs/promises');
  const { parsePlanFile } = await import('./plan-parser.js');
  const { formatTaskStatus, formatWorkflowStatus } = await import('./formatter.js');

  const yamlSource = await readFile(planPath, 'utf-8');
  const plan = await parsePlanFile(planPath, repoRoot);
  backupPlan(plan, yamlSource);
  console.log(`${BOLD}Loading plan: ${plan.name}${RESET}`);
  console.log(`Tasks: ${plan.tasks.length}\n`);

  // Create feature branch if specified
  if (plan.featureBranch) {
    try {
      await execCommand('git', ['checkout', '-b', plan.featureBranch]);
      console.log(`Created branch: ${plan.featureBranch}`);
    } catch {
      await execCommand('git', ['checkout', plan.featureBranch]);
      console.log(`Switched to existing branch: ${plan.featureBranch}`);
    }
  }

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
    callbacks: {
      onOutput: (taskId, data) => {
        process.stdout.write(`\x1b[2m[${taskId}]\x1b[0m ${data}`);
      },
      onHeartbeat: headlessHeartbeat,
    },
  });

  const api = startApiServer({ orchestrator, persistence, familiarRegistry, taskExecutor });

  const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
  orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
  const currentWorkflowId = orchestrator.getWorkflowIds().find((id) => !wfIdsBefore.has(id));

  const started = orchestrator.startExecution();
  await taskExecutor.executeTasks(started);

  // Wait for all tasks in this workflow to settle
  await waitForCompletion(currentWorkflowId);

  await api.close().catch(() => {});

  const status = orchestrator.getWorkflowStatus(currentWorkflowId);
  console.log(`\n${formatWorkflowStatus(status)}`);

  // onFinish is now handled by the merge node in the TaskExecutor
  if (status.failed > 0) process.exitCode = 1;
}

async function headlessResume(workflowId: string): Promise<void> {
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
    callbacks: {
      onOutput: (taskId, data) => {
        process.stdout.write(`\x1b[2m[${taskId}]\x1b[0m ${data}`);
      },
      onHeartbeat: headlessHeartbeat,
    },
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
  await waitForCompletion();

  await api.close().catch(() => {});

  const status = orchestrator.getWorkflowStatus();
  console.log(`\n${formatWorkflowStatus(status)}`);

  if (status.failed > 0) process.exitCode = 1;
}

async function headlessList(): Promise<void> {
  const { formatWorkflowList } = await import('./formatter.js');
  const workflows = persistence.listWorkflows();
  console.log(formatWorkflowList(workflows));
}

async function headlessStatus(): Promise<void> {
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

function headlessApprove(taskId: string): void {
  if (!taskId) throw new Error('Missing taskId.');
  restoreWorkflowForTask(taskId);
  orchestrator.approve(taskId);
  console.log(`Approved task: ${taskId}`);
}

function headlessReject(taskId: string, reason?: string): void {
  if (!taskId) throw new Error('Missing taskId.');
  restoreWorkflowForTask(taskId);
  orchestrator.reject(taskId, reason);
  console.log(`Rejected task: ${taskId}${reason ? ` (reason: ${reason})` : ''}`);
}

function headlessInput(taskId: string, text: string): void {
  if (!taskId || !text) throw new Error('Missing arguments. Usage: --headless input <taskId> <text>');
  restoreWorkflowForTask(taskId);
  orchestrator.provideInput(taskId, text);
  console.log(`Input provided to task: ${taskId}`);
}

async function headlessSelect(taskId: string, experimentId: string): Promise<void> {
  if (!taskId || !experimentId) throw new Error('Missing arguments. Usage: --headless select <taskId> <expId>');
  const workflowId = restoreWorkflowForTask(taskId);
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
    callbacks: {
      onOutput: (tid, data) => {
        process.stdout.write(`\x1b[2m[${tid}]\x1b[0m ${data}`);
      },
      onHeartbeat: headlessHeartbeat,
    },
  });

  const started = orchestrator.resumeWorkflow(workflowId);
  await taskExecutor.executeTasks(started);
  await waitForCompletion();
}

async function headlessRestart(taskId: string): Promise<void> {
  if (!taskId) throw new Error('Missing arguments. Usage: --headless restart <taskId>');
  restoreWorkflowForTask(taskId);

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
    callbacks: {
      onOutput: (tid, data) => {
        process.stdout.write(`\x1b[2m[${tid}]\x1b[0m ${data}`);
      },
      onHeartbeat: headlessHeartbeat,
    },
  });

  await taskExecutor.executeTasks(runnable);
  await waitForCompletion();
}

async function headlessRebaseAndRetry(taskId: string): Promise<void> {
  if (!taskId) throw new Error('Missing arguments. Usage: --headless rebase-and-retry <taskId>');
  const workflowId = restoreWorkflowForTask(taskId);

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
    callbacks: {
      onOutput: (tid, data) => {
        process.stdout.write(`\x1b[2m[${tid}]\x1b[0m ${data}`);
      },
      onHeartbeat: headlessHeartbeat,
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
    runnable = bumpGenerationAndRestart(workflowId).filter(t => t.status === 'running');
    console.log(`Conflicting rebase — resetting entire DAG (${runnable.length} task(s))`);
  }

  if (runnable.length > 0) {
    await te.executeTasks(runnable);
    await waitForCompletion(workflowId);
  }
}

function bumpGenerationAndRestart(workflowId: string): TaskState[] {
  const workflow = persistence.loadWorkflow(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  const nextGen = (workflow.generation ?? 0) + 1;
  persistence.updateWorkflow(workflowId, { generation: nextGen });
  console.log(`[workflow] bumped generation to ${nextGen} for ${workflowId}`);
  return orchestrator.restartWorkflow(workflowId);
}

async function headlessEdit(taskId: string, newCommand: string): Promise<void> {
  if (!taskId || !newCommand) throw new Error('Missing arguments. Usage: --headless edit <taskId> <newCommand>');
  const workflowId = restoreWorkflowForTask(taskId);

  const started = orchestrator.editTaskCommand(taskId, newCommand);
  console.log(`Edited task "${taskId}" command → "${newCommand}"`);

  const taskExecutor = new TaskExecutor({
    orchestrator,
    persistence,
    familiarRegistry,
    cwd: repoRoot,
    defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
    callbacks: {
      onOutput: (tid, data) => {
        process.stdout.write(`\x1b[2m[${tid}]\x1b[0m ${data}`);
      },
      onHeartbeat: headlessHeartbeat,
    },
  });

  await taskExecutor.executeTasks(started);
  await waitForCompletion();
}

async function headlessEditType(taskId: string, familiarType: string): Promise<void> {
  if (!taskId || !familiarType) throw new Error('Missing arguments. Usage: --headless edit-type <taskId> <familiarType>');
  const workflowId = restoreWorkflowForTask(taskId);

  const started = orchestrator.editTaskType(taskId, familiarType);
  console.log(`Edited task "${taskId}" familiarType → "${familiarType}"`);

  const taskExecutor = new TaskExecutor({
    orchestrator,
    persistence,
    familiarRegistry,
    cwd: repoRoot,
    defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
    callbacks: {
      onOutput: (tid, data) => {
        process.stdout.write(`\x1b[2m[${tid}]\x1b[0m ${data}`);
      },
      onHeartbeat: headlessHeartbeat,
    },
  });

  await taskExecutor.executeTasks(started);
  await waitForCompletion();
}

async function headlessQuerySelect(taskId: string): Promise<void> {
  if (!taskId) throw new Error('Missing taskId.');
  const selected = persistence.getSelectedExperiment(taskId);
  console.log(selected
    ? `Selected experiment for ${taskId}: ${selected}`
    : `No experiment selected for ${taskId}`);
}

async function headlessAudit(taskId?: string): Promise<void> {
  const { formatEventLog } = await import('./formatter.js');
  if (!taskId) throw new Error('Usage: --headless audit <taskId>');
  const events = persistence.getEvents(taskId);
  console.log(formatEventLog(events));
}

async function headlessSlack(): Promise<void> {
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
    callbacks: {
      onOutput: (taskId, data) => {
        process.stdout.write(`\x1b[2m[${taskId}]\x1b[0m ${data}`);
      },
      onComplete: (taskId) => {
        logFn('exec', 'info', `Task "${taskId}" completed`);
      },
      onHeartbeat: headlessHeartbeat,
    },
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

function restoreWorkflowForTask(taskId: string): string {
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

async function waitForCompletion(workflowId?: string): Promise<void> {
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

function execCommand(cmd: string, args: string[]): Promise<string> {
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

// ══════════════════════════════════════════════════════════════
// GUI MODE
// ══════════════════════════════════════════════════════════════

function setupGuiMode(): void {
  let mainWindow: BrowserWindow | null = null;
  let taskExecutor: TaskExecutor;
  let apiServer: ApiServer | null = null;
  const taskHandles = new Map<string, { handle: FamiliarHandle; familiar: Familiar }>();
  let dbPollInterval: ReturnType<typeof setInterval> | null = null;
  let activityPollInterval: ReturnType<typeof setInterval> | null = null;
  const lastKnownTaskStates = new Map<string, string>();
  let lastKnownWorkflowCount = 0;
  let lastActivityLogId = 0;

  // Focus existing window when a second instance is launched
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function rebuildTaskExecutor(): void {
    taskExecutor = new TaskExecutor({
      orchestrator,
      persistence,
      familiarRegistry,
      cwd: repoRoot,
      defaultBranch: invokerConfig.defaultBranch,
    disableLocalExecutorExceptMergeGate: invokerConfig.disableLocalExecutorExceptMergeGate,
      callbacks: {
        onOutput: (taskId, data) => {
          console.log(`[output] ${taskId}: ${data.trimEnd()}`);
          const outputData: TaskOutputData = { taskId, data };
          messageBus.publish(Channels.TASK_OUTPUT, outputData);
          try {
            persistence.appendTaskOutput(taskId, data);
          } catch (err) {
            console.error(`[output] Failed to persist output for ${taskId}:`, err);
          }
        },
        onSpawned: (taskId, handle, familiar) => {
          console.log(`[exec] Task "${taskId}" spawned (handle: ${handle.executionId})`);
          taskHandles.set(taskId, { handle, familiar });
        },
        onComplete: (taskId) => {
          console.log(`[exec] Task "${taskId}" completed`);
        },
        onHeartbeat: (taskId) => {
          const now = new Date();
          try { persistence.updateTask(taskId, { execution: { lastHeartbeatAt: now } }); } catch { /* db locked */ }
          messageBus.publish(Channels.TASK_DELTA, {
            type: 'updated' as const,
            taskId,
            changes: { execution: { lastHeartbeatAt: now } },
          });
        },
      },
    });
  }

  async function killRunningTask(taskId: string): Promise<void> {
    const entry = taskHandles.get(taskId);
    if (!entry) return;
    console.log(`[kill] Killing running task "${taskId}" before restart`);
    await entry.familiar.kill(entry.handle);
    taskHandles.delete(taskId);
  }

  function createWindow(): void {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      show: process.env.NODE_ENV !== 'test',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
      title: 'Invoker',
    });

    if (process.platform !== 'linux') {
      const iconPath = path.join(__dirname, 'assets', 'icons', 'png', '256x256.png');
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) mainWindow.setIcon(icon);
    }

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      mainWindow.loadURL(devUrl);
    } else {
      const uiDistPath = path.join(__dirname, '..', '..', 'ui', 'dist', 'index.html');
      mainWindow.loadFile(uiDistPath).catch(() => {
        mainWindow?.loadURL(
          `data:text/html,<html><body style="background:#1a1a2e;color:#eee;font-family:system-ui;padding:2rem"><h1>Invoker</h1><p>UI not built yet. Run: <code>pnpm --filter @invoker/ui build</code></p></body></html>`,
        );
      });
    }

    mainWindow.on('closed', () => { mainWindow = null; });
  }

  app.whenReady().then(() => {
    initServices();

    rebuildTaskExecutor();

    // Relaunch tasks stuck in 'running' from a previous session —
    // the child processes are gone after restart, so respawn them.
    if (invokerConfig.disableAutoRunOnStartup) {
      console.log('[init] auto-run on startup disabled by config — skipping orphan relaunch');
    } else {
      const orphanStarted: TaskState[] = [];
      for (const task of orchestrator.getAllTasks()) {
        if (task.status === 'running') {
          console.log(`[init] relaunching orphaned running task "${task.id}"`);
          const started = orchestrator.restartTask(task.id);
          orphanStarted.push(...started.filter(t => t.status === 'running'));
        }
      }
      if (orphanStarted.length > 0) {
        console.log(`[init] relaunched ${orphanStarted.length} orphaned tasks: [${orphanStarted.map(t => t.id).join(', ')}]`);
        taskExecutor.executeTasks(orphanStarted);
      }
    }

    apiServer = startApiServer({
      orchestrator,
      persistence,
      familiarRegistry,
      taskExecutor,
      killRunningTask,
    });

    const dbPath = path.join(homedir(), '.invoker', 'invoker.db');
    console.log(`[init] Database: ${dbPath}`);
    console.log(`[init] Repo root: ${repoRoot}`);

    // ── Start Slack bot if env vars are configured ───
    startSlackBot(taskExecutor, taskHandles).catch((err) => {
      console.log(`[slack] Not started: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Forward deltas to renderer and keep snapshot cache in sync so
    // the db-poll doesn't re-emit deltas the messageBus already delivered.
    messageBus.subscribe(Channels.TASK_DELTA, (delta: unknown) => {
      console.log(`[delta→ui]`, JSON.stringify(delta));
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:task-delta', delta);
      }
      const d = delta as TaskDelta;
      if (d.type === 'created') {
        lastKnownTaskStates.set(d.task.id, JSON.stringify(d.task));
      } else if (d.type === 'updated') {
        const existing = lastKnownTaskStates.get(d.taskId);
        if (existing) {
          const task = { ...JSON.parse(existing), ...d.changes };
          lastKnownTaskStates.set(d.taskId, JSON.stringify(task));
        }
      } else if (d.type === 'removed') {
        lastKnownTaskStates.delete(d.taskId);
      }
    });

    messageBus.subscribe(Channels.TASK_OUTPUT, (data: unknown) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:task-output', data);
      }
    });

    // Register IPC handlers
    ipcMain.handle('invoker:load-plan', (_event, plan: PlanDefinition) => {
      console.log(`[ipc] load-plan: "${plan.name}" (${plan.tasks.length} tasks)`);
      taskHandles.clear();
      backupPlan(plan);
      orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
    });

    ipcMain.handle('invoker:start', async () => {
      console.log(`[ipc] start`);
      const started = orchestrator.startExecution();
      console.log(`[ipc] startExecution returned ${started.length} tasks:`, started.map(t => t.id));
      await taskExecutor.executeTasks(started);
      return started;
    });

    ipcMain.handle('invoker:resume-workflow', async () => {
      const workflows = persistence.listWorkflows();
      if (workflows.length === 0) {
        console.log(`[ipc] resume-workflow: no workflows found`);
        return null;
      }
      orchestrator.syncAllFromDb();

      // Relaunch tasks stuck in 'running' from a previous session —
      // the child processes are gone after restart, so respawn them.
      const orphanRestarted: TaskState[] = [];
      for (const task of orchestrator.getAllTasks()) {
        if (task.status === 'running') {
          console.log(`[ipc] resume-workflow: relaunching orphaned running task "${task.id}"`);
          const restarted = orchestrator.restartTask(task.id);
          orphanRestarted.push(...restarted.filter(t => t.status === 'running'));
        }
      }

      const allStarted: any[] = [...orphanRestarted];
      for (const wf of workflows) {
        if (wf.status === 'completed' || wf.status === 'failed') continue;
        const started = orchestrator.startExecution();
        allStarted.push(...started);
      }
      const tasks = orchestrator.getAllTasks();
      for (const task of tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('invoker:task-delta', { type: 'created', task });
        }
      }
      console.log(`[ipc] resume-workflow: ${tasks.length} tasks loaded across ${workflows.length} workflows, ${allStarted.length} started`);
      await taskExecutor.executeTasks(allStarted);
      return { workflow: workflows[0], taskCount: tasks.length, startedCount: allStarted.length };
    });

    ipcMain.handle('invoker:stop', async () => {
      console.log(`[ipc] stop — destroying all familiars`);
      await Promise.all(familiarRegistry.getAll().map(f => f.destroyAll()));
      const allTasks = orchestrator.getAllTasks();
      for (const task of allTasks) {
        if (task.status === 'running') {
          console.log(`[ipc] stop — failing running task "${task.id}"`);
          orchestrator.handleWorkerResponse({
            requestId: `stop-${task.id}`,
            actionId: task.id,
            status: 'failed',
            outputs: { exitCode: 1, error: 'Stopped by user' },
          });
        }
      }
    });

    ipcMain.handle('invoker:clear', async () => {
      console.log(`[ipc] clear — stopping all tasks and resetting DAG`);
      // Capture current workflow before destroying state
      const workflows = persistence.listWorkflows();
      const currentWorkflowId = workflows.length > 0 ? workflows[0].id : null;

      await Promise.all(familiarRegistry.getAll().map(f => f.destroyAll()));
      const allTasks = orchestrator.getAllTasks();
      for (const task of allTasks) {
        if (task.status === 'running') {
          orchestrator.handleWorkerResponse({
            requestId: `clear-${task.id}`,
            actionId: task.id,
            status: 'failed',
            outputs: { exitCode: 1, error: 'Cleared by user' },
          });
        }
      }

      // Mark the workflow as failed in the DB so it doesn't stay "running" forever
      if (currentWorkflowId) {
        persistence.updateWorkflow(currentWorkflowId, {
          status: 'failed',
          updatedAt: new Date().toISOString(),
        });
      }

      orchestrator = new Orchestrator({
    persistence, messageBus,
    maxUtilization: 100,
    utilizationRules: resolveUtilizationRules(invokerConfig),
    defaultUtilization: invokerConfig.defaultUtilization,
  });
      rebuildTaskExecutor();
      taskHandles.clear();
    });

    ipcMain.handle('invoker:list-workflows', () => persistence.listWorkflows());

    ipcMain.handle('invoker:delete-all-workflows', () => {
      console.log('[ipc] delete-all-workflows');
      persistence.deleteAllWorkflows();
      orchestrator = new Orchestrator({
    persistence, messageBus,
    maxUtilization: 100,
    utilizationRules: resolveUtilizationRules(invokerConfig),
    defaultUtilization: invokerConfig.defaultUtilization,
  });
      rebuildTaskExecutor();
      taskHandles.clear();
      lastKnownTaskStates.clear();
      lastKnownWorkflowCount = 0;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:workflows-changed', []);
      }
    });

    ipcMain.handle('invoker:load-workflow', (_event, workflowId: string) => {
      console.log(`[ipc] load-workflow: "${workflowId}"`);
      // Sync orchestrator so mutations (restart, approve, etc.) work on this workflow
      orchestrator.syncFromDb(workflowId);
      const tasks = persistence.loadTasks(workflowId);
      const workflow = persistence.loadWorkflow(workflowId);
      console.log(`[ipc] load-workflow: found ${tasks.length} tasks for "${workflow?.name ?? workflowId}"`);
      for (const task of tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('invoker:task-delta', { type: 'created', task });
        }
      }
      return { workflow, tasks };
    });

    ipcMain.handle('invoker:get-tasks', () => {
      const tasks = orchestrator.getAllTasks();
      const workflows = persistence.listWorkflows();
      console.log(`[ipc] get-tasks returning ${tasks.length} tasks, ${workflows.length} workflows`);
      return { tasks, workflows };
    });
    ipcMain.handle('invoker:get-events', (_event, taskId: string) => persistence.getEvents(taskId));
    ipcMain.handle('invoker:get-status', () => orchestrator.getWorkflowStatus());
    ipcMain.handle('invoker:get-task-output', (_event, taskId: string) => persistence.getTaskOutput(taskId));

    ipcMain.handle('invoker:get-all-completed-tasks', () => {
      return persistence.loadAllCompletedTasks();
    });

    ipcMain.handle('invoker:provide-input', (_event, taskId: string, input: string) => {
      orchestrator.provideInput(taskId, input);
    });

    ipcMain.handle('invoker:approve', async (_event, taskId: string) => {
      const task = orchestrator.getTask(taskId);
      if (task?.execution.pendingFixError !== undefined) {
        const started = orchestrator.restartTask(taskId);
        const runnable = started.filter(t => t.status === 'running');
        await taskExecutor.executeTasks(runnable);
      } else {
        orchestrator.approve(taskId);
      }
    });

    ipcMain.handle('invoker:reject', (_event, taskId: string, reason?: string) => {
      const task = orchestrator.getTask(taskId);
      if (task?.execution.pendingFixError !== undefined) {
        orchestrator.revertConflictResolution(taskId, task.execution.pendingFixError);
      } else {
        orchestrator.reject(taskId, reason);
      }
    });

    ipcMain.handle('invoker:select-experiment', async (_event, taskId: string, experimentId: string | string[]) => {
      const ids = Array.isArray(experimentId) ? experimentId : [experimentId];
      console.log(`[ipc] select-experiment: "${taskId}" experimentIds=${JSON.stringify(ids)}`);
      try {
        if (ids.length === 1) {
          const newlyStarted = orchestrator.selectExperiment(taskId, ids[0]);
          await taskExecutor.executeTasks(newlyStarted);
        } else {
          const { branch, commit } = await taskExecutor.mergeExperimentBranches(taskId, ids);
          const newlyStarted = orchestrator.selectExperiments(taskId, ids, branch, commit);
          await taskExecutor.executeTasks(newlyStarted);
        }
      } catch (err) {
        console.error(`[ipc] select-experiment failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:restart-task', async (_event, taskId: string) => {
      console.log(`[ipc] restart-task: "${taskId}"`);
      try {
        await killRunningTask(taskId);
        const started = orchestrator.restartTask(taskId);
        const runnable = started.filter(t => t.status === 'running');
        await taskExecutor.executeTasks(runnable);
      } catch (err) {
        console.error(`[ipc] restart-task failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:restart-workflow', async (_event, workflowId: string) => {
      console.log(`[ipc] restart-workflow: "${workflowId}"`);
      try {
        const started = bumpGenerationAndRestart(workflowId);
        const runnable = started.filter(t => t.status === 'running');
        await taskExecutor.executeTasks(runnable);
      } catch (err) {
        console.error(`[ipc] restart-workflow failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:rebase-and-retry', async (_event, taskId: string) => {
      console.log(`[ipc] rebase-and-retry: "${taskId}"`);
      try {
        const task = orchestrator.getTask(taskId);
        if (!task) throw new Error(`Task ${taskId} not found`);
        if (!task.config.workflowId) throw new Error(`Task ${taskId} has no associated workflow`);

        const workflowId = task.config.workflowId;
        const mergeTask = orchestrator.getAllTasks().find(
          t => t.config.workflowId === workflowId && t.config.isMergeNode,
        );

        const workflow = persistence.loadWorkflow(workflowId);
        const baseBranch = workflow?.baseBranch ?? invokerConfig.defaultBranch ?? await taskExecutor.detectDefaultBranch();

        const result = await taskExecutor.rebaseTaskBranches(workflowId, baseBranch);

        if (result.success && mergeTask) {
          // Clean rebase: restart merge gate only
          const started = orchestrator.restartTask(mergeTask.id);
          const runnable = started.filter(t => t.status === 'running');
          await taskExecutor.executeTasks(runnable);
        } else {
          // Conflicting rebase or no merge gate: reset entire DAG
          console.log(`[ipc] rebase-and-retry: resetting entire workflow ${workflowId}`);
          const started = bumpGenerationAndRestart(workflowId);
          const runnable = started.filter(t => t.status === 'running');
          await taskExecutor.executeTasks(runnable);
        }

        return result;
      } catch (err) {
        console.error(`[ipc] rebase-and-retry failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:set-merge-branch', async (_event, workflowId: string, baseBranch: string) => {
      console.log(`[ipc] set-merge-branch: workflow="${workflowId}" → "${baseBranch}"`);
      try {
        persistence.updateWorkflow(workflowId, { baseBranch });

        const tasks = persistence.loadTasks(workflowId);
        const mergeTask = tasks.find(t => t.config.isMergeNode);
        if (mergeTask) {
          const started = orchestrator.restartTask(mergeTask.id);
          const runnable = started.filter(t => t.status === 'running');
          await taskExecutor.executeTasks(runnable);
        }
      } catch (err) {
        console.error(`[ipc] set-merge-branch failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:approve-merge', async (_event, workflowId: string) => {
      console.log(`[ipc] approve-merge: "${workflowId}"`);
      try {
        const mergeTask = orchestrator.getMergeNode(workflowId);
        if (!mergeTask) throw new Error(`No merge node for workflow ${workflowId}`);
        await taskExecutor.approveMerge(workflowId);
        orchestrator.approve(mergeTask.id);
      } catch (err) {
        console.error(`[ipc] approve-merge failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:resolve-conflict', async (_event, taskId: string) => {
      console.log(`[ipc] resolve-conflict: "${taskId}"`);
      const { savedError } = orchestrator.beginConflictResolution(taskId);
      try {
        await taskExecutor.resolveConflictWithClaude(taskId);
        const started = orchestrator.restartTask(taskId);
        const runnable = started.filter(t => t.status === 'running');
        await taskExecutor.executeTasks(runnable);
      } catch (err) {
        console.error(`[ipc] resolve-conflict failed: ${err}`);
        orchestrator.revertConflictResolution(taskId, savedError);
        throw err;
      }
    });

    ipcMain.handle('invoker:fix-with-claude', async (_event, taskId: string) => {
      console.log(`[ipc] fix-with-claude: "${taskId}"`);
      const { savedError } = orchestrator.beginConflictResolution(taskId);
      try {
        const output = persistence.getTaskOutput(taskId);
        await taskExecutor.fixWithClaude(taskId, output);
        orchestrator.setFixAwaitingApproval(taskId, savedError);
      } catch (err) {
        console.error(`[ipc] fix-with-claude failed: ${err}`);
        orchestrator.revertConflictResolution(taskId, savedError);
        throw err;
      }
    });


    ipcMain.handle('invoker:edit-task-command', async (_event, taskId: string, newCommand: string) => {
      console.log(`[ipc] edit-task-command: "${taskId}" → "${newCommand}"`);
      try {
        const started = orchestrator.editTaskCommand(taskId, newCommand);
        const runnable = started.filter(t => t.status === 'running');
        await taskExecutor.executeTasks(runnable);
      } catch (err) {
        console.error(`[ipc] edit-task-command failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:edit-task-type', async (_event, taskId: string, familiarType: string) => {
      console.log(`[ipc] edit-task-type: "${taskId}" → "${familiarType}"`);
      try {
        const started = orchestrator.editTaskType(taskId, familiarType);
        const runnable = started.filter(t => t.status === 'running');
        await taskExecutor.executeTasks(runnable);
      } catch (err) {
        console.error(`[ipc] edit-task-type failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:replace-task', async (_event, taskId: string, replacementTasks: unknown[]) => {
      console.log(`[ipc] replace-task: "${taskId}" with ${replacementTasks.length} replacement(s)`);
      try {
        const started = orchestrator.replaceTask(taskId, replacementTasks as TaskReplacementDef[]);
        const runnable = started.filter((t: { status: string }) => t.status === 'running');
        await taskExecutor.executeTasks(runnable);
        return started;
      } catch (err) {
        console.error(`[ipc] replace-task failed: ${err}`);
        throw err;
      }
    });

    // ── DB Polling — detect external workflow changes ───
    dbPollInterval = setInterval(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        const workflows = persistence.listWorkflows();

        if (workflows.length !== lastKnownWorkflowCount) {
          const msg = `Workflow count changed: ${lastKnownWorkflowCount} → ${workflows.length}`;
          console.log(`[db-poll] ${msg}`);
          try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
          lastKnownWorkflowCount = workflows.length;
          mainWindow.webContents.send('invoker:workflows-changed', workflows);

          orchestrator.syncAllFromDb();
          console.log(`[db-poll] Synced orchestrator for all ${workflows.length} workflows`);
          lastKnownTaskStates.clear();
        }

        const STALE_HEARTBEAT_MS = 5 * 60 * 1000;
        const now = Date.now();

        for (const wf of workflows) {
          if (wf.status === 'completed' || wf.status === 'failed') continue;
          const tasks = persistence.loadTasks(wf.id);
          for (const task of tasks) {
            const snapshot = JSON.stringify(task);
            const prev = lastKnownTaskStates.get(task.id);
            if (!prev) {
              const msg = `New task: ${task.id} (${task.status})`;
              console.log(`[db-poll] ${msg}`);
              try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
              lastKnownTaskStates.set(task.id, snapshot);
              mainWindow.webContents.send('invoker:task-delta', { type: 'created', task });
            } else if (prev !== snapshot) {
              const msg = `Task updated: ${task.id} (${task.status})`;
              console.log(`[db-poll] ${msg}`);
              try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
              lastKnownTaskStates.set(task.id, snapshot);
              mainWindow.webContents.send('invoker:task-delta', { type: 'created', task });
            }

            if (task.status === 'running') {
              const heartbeatTime = task.execution?.lastHeartbeatAt
                ? new Date(task.execution.lastHeartbeatAt as string | number).getTime()
                : null;
              const startedTime = task.execution?.startedAt
                ? new Date(task.execution.startedAt as string | number).getTime()
                : null;
              const referenceTime = heartbeatTime ?? startedTime;

              if (referenceTime && (now - referenceTime) > STALE_HEARTBEAT_MS) {
                const ageSeconds = Math.round((now - referenceTime) / 1000);
                const source = heartbeatTime ? 'last heartbeat' : 'started';
                console.warn(`[db-poll] Stale running task "${task.id}": ${source} ${ageSeconds}s ago, restarting`);
                try { persistence.writeActivityLog('db-poll', 'warn', `Stale running task "${task.id}": ${source} ${ageSeconds}s ago, restarting`); } catch { /* db locked */ }
                try {
                  await killRunningTask(task.id);
                  const restarted = orchestrator.restartTask(task.id);
                  const runnable = restarted.filter(t => t.status === 'running');
                  await taskExecutor.executeTasks(runnable);
                } catch (err) {
                  console.error(`[db-poll] Failed to restart stale task "${task.id}":`, err);
                }
              }
            }
          }
        }
      } catch {
        // DB might be locked — skip this tick
      }
    }, 2000);

    // ── Activity Log Polling — detect Slack/external activity ───
    activityPollInterval = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        const entries = persistence.getActivityLogs(lastActivityLogId);
        if (entries.length > 0) {
          lastActivityLogId = entries[entries.length - 1].id;
          mainWindow.webContents.send('invoker:activity-log', entries);
        }
      } catch {
        // DB might be locked — skip this tick
      }
    }, 2000);

    ipcMain.handle('invoker:get-activity-logs', () => {
      return persistence.getActivityLogs(0);
    });

    // ── External terminal launcher ──────────────────────────────
    ipcMain.handle('invoker:open-terminal', (_event, taskId: string): { opened: boolean; reason?: string } => {
      console.log(`[open-terminal] invoked for task="${taskId}"`);
      const taskStatus = persistence.getTaskStatus(taskId);
      console.log(`[open-terminal] task="${taskId}" status="${taskStatus}"`);
      if (taskStatus === 'running') {
        console.log(`[open-terminal] BLOCKED task="${taskId}" — still running`);
        return { opened: false, reason: 'Task is still running. View output in the terminal panel below.' };
      }

      const meta: PersistedTaskMeta = {
        taskId,
        familiarType: persistence.getFamiliarType(taskId) ?? 'local',
        claudeSessionId: persistence.getClaudeSessionId(taskId) ?? undefined,
        containerId: persistence.getContainerId(taskId) ?? undefined,
        workspacePath: persistence.getWorkspacePath(taskId) ?? undefined,
        branch: persistence.getBranch(taskId) ?? undefined,
      };
      console.log(`[open-terminal] task="${taskId}" meta=${JSON.stringify(meta)}`);

      // Resolve the familiar, lazy-registering if needed
      let familiar = familiarRegistry.get(meta.familiarType);
      if (!familiar) {
        console.log(`[open-terminal] task="${taskId}" familiar type="${meta.familiarType}" not registered, lazy-registering`);
        if (meta.familiarType === 'docker') {
          const docker = new DockerFamiliar({ workspaceDir: repoRoot });
          familiarRegistry.register('docker', docker);
          familiar = docker;
        } else if (meta.familiarType === 'worktree') {
          const invokerHome = path.resolve(homedir(), '.invoker');
          const worktree = new WorktreeFamiliar({
            repoDir: repoRoot,
            worktreeBaseDir: path.resolve(invokerHome, 'worktrees'),
            cacheDir: path.resolve(invokerHome, 'repos'),
          });
          familiarRegistry.register('worktree', worktree);
          familiar = worktree;
        } else {
          familiar = familiarRegistry.get('local') ?? familiarRegistry.getDefault();
        }
      }
      console.log(`[open-terminal] task="${taskId}" resolved familiar type="${familiar.type}"`);

      let spec: { cwd?: string; command?: string; args?: string[] };
      try {
        spec = familiar.getRestoredTerminalSpec(meta);
        console.log(`[open-terminal] task="${taskId}" getRestoredTerminalSpec returned: ${JSON.stringify(spec)}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.log(`[open-terminal] task="${taskId}" getRestoredTerminalSpec THREW: ${reason}`);
        return { opened: false, reason };
      }

      const cwd = spec.cwd ?? repoRoot;
      console.log(`[open-terminal] task="${taskId}" final cwd="${cwd}" spec=${JSON.stringify(spec)}`);

      const onTerminalClose = () => {
        if (!cwd || cwd === repoRoot) return;
        try {
          const { execSync } = require('node:child_process');
          execSync('git diff HEAD --quiet', { cwd, stdio: 'ignore' });
          console.log(`[dirty-detect] task="${taskId}" — no changes detected`);
        } catch {
          console.log(`[dirty-detect] task="${taskId}" — changes detected, forking subtree`);
          try {
            orchestrator.forkDirtySubtree(taskId);
          } catch (err) {
            console.error(`[dirty-detect] forkDirtySubtree failed:`, err);
          }
        }
      };

      if (process.platform === 'linux') {
        const cleanEnv: Record<string, string> = {};
        const keep = ['HOME', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY',
          'SHELL', 'USER', 'TERM', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'LANG',
          'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'];
        for (const k of keep) {
          if (process.env[k]) cleanEnv[k] = process.env[k]!;
        }
        cleanEnv.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
        if (!cleanEnv.TERM) cleanEnv.TERM = 'xterm-256color';

        // x-terminal-emulator wrappers (e.g. gnome-terminal.wrapper) silently
        // drop --working-directory. Use -e with an explicit cd instead.
        const cmdStr = spec.command
          ? [spec.command, ...(spec.args ?? [])].map(a => `'${a}'`).join(' ')
          : undefined;
        const isClaudeSession = spec.command === 'claude';
        const suffix = isClaudeSession
          ? '; exec bash'
          : '; echo ""; echo "Exit code: $?"; echo "Press Enter to close..."; read';
        const termArgs = cmdStr
          ? ['-e', 'bash', '-c', `cd '${cwd}' && ${cmdStr}${suffix}`]
          : ['-e', 'bash', '-c', `cd '${cwd}' && exec bash`];

        console.log(`[open-terminal] spawning x-terminal-emulator with args: ${JSON.stringify(termArgs)}`);
        const child = spawn('x-terminal-emulator', termArgs, {
          detached: true,
          stdio: 'ignore',
          env: cleanEnv,
        });
        child.on('close', onTerminalClose);
        child.unref();
      } else if (process.platform === 'darwin') {
        if (spec.command) {
          const fullCmd = [spec.command, ...(spec.args ?? [])].join(' ');
          const child = spawn('osascript', [
            '-e', `tell application "Terminal" to do script "${fullCmd}"`,
          ], { detached: true, stdio: 'ignore' });
          child.on('close', onTerminalClose);
          child.unref();
        } else {
          const child = spawn('open', ['-a', 'Terminal', cwd], {
            detached: true,
            stdio: 'ignore',
          });
          child.on('close', onTerminalClose);
          child.unref();
        }
      }
      return { opened: true };
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', async () => {
    if (apiServer) await apiServer.close().catch(() => {});
    if (dbPollInterval) clearInterval(dbPollInterval);
    if (activityPollInterval) clearInterval(activityPollInterval);
    await Promise.all(familiarRegistry.getAll().map(f => f.destroyAll()));
    for (const task of orchestrator.getAllTasks()) {
      if (task.status === 'running') {
        orchestrator.handleWorkerResponse({
          requestId: `quit-${task.id}`,
          actionId: task.id,
          status: 'failed',
          outputs: { exitCode: 1, error: 'Application quit' },
        });
      }
    }
    persistence.close();
    messageBus.disconnect();
  });

  // ── Slack Bot (embedded in GUI process) ──────────────────
  async function startSlackBot(
    executor: TaskExecutor,
    handles: Map<string, { handle: FamiliarHandle; familiar: Familiar }>,
  ): Promise<void> {
    const logFile = path.join(homedir(), '.invoker', 'invoker.log');
    const logFn = (source: string, level: string, message: string) => {
      const prefix = level === 'error' ? `${RED}[${source}]${RESET}` : `[${source}]`;
      console.log(`${prefix} ${message}`);
      try { appendFileSync(logFile, `${new Date().toISOString()} [${source}] ${level}: ${message}\n`); } catch { /* ignore */ }
      try { persistence.writeActivityLog(source, level, message); } catch { /* db locked */ }
    };

    await wireSlackBot({
      executor,
      logFn,
      onStartPlan: () => handles.clear(),
      onPlanLoaded: () => {},
    });

    logFn('slack', 'info', 'Slack bot started (embedded in GUI)');
  }
}
