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
 *   electron dist/main.js --headless fix <taskId>
 *   electron dist/main.js --headless edit <taskId> <newCommand>
 *   electron dist/main.js --headless cancel <taskId>
 *   electron dist/main.js --headless queue
 *   electron dist/main.js --headless audit <taskId>
 *
 * Using the same Electron binary for both modes provides a consistent runtime.
 */

import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron';
import * as path from 'node:path';
import { mkdirSync, appendFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

// Prevent desktop-wide freezes on Linux (Chromium GPU + X11/Wayland compositors).
// Defense-in-depth: API-level disable, command-line flags, and env var (LIBGL_ALWAYS_SOFTWARE).
if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('no-zygote');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

import { Orchestrator, UTILIZATION_MAX } from '@invoker/core';
import type {
  PlanDefinition,
  TaskDelta,
  TaskReplacementDef,
  TaskState,
  TaskStateChanges,
  UtilizationRule,
} from '@invoker/core';
import { SQLiteAdapter, ConversationRepository } from '@invoker/persistence';
import { IpcBus, Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import {
  FamiliarRegistry, TaskExecutor,
  DockerFamiliar, WorktreeFamiliar, SshFamiliar, GitHubMergeGateProvider,
  type Familiar, type FamiliarHandle, type PersistedTaskMeta,
} from '@invoker/executors';
import type { TaskOutputData } from './types.js';
import { loadConfig, type InvokerConfig } from './config.js';
import { backupPlan } from './plan-backup.js';
import { applyPlanDefinitionDefaults } from './plan-parser.js';
import { startApiServer, type ApiServer } from './api-server.js';
import { runHeadless } from './headless.js';
import {
  rebaseAndRetry,
  rejectTask,
  restartWorkflow as sharedRestartWorkflow,
  selectExperiments as sharedSelectExperiments,
} from './workflow-actions.js';
import { spawn } from 'node:child_process';
import {
  buildLinuxXTerminalBashScript,
  buildMacOSOsascriptArgs,
  spawnDetachedTerminal,
} from './terminal-external-launch.js';
import { createRequire } from 'node:module';

// ── Detect headless mode ─────────────────────────────────────

// Electron passes extra args after `--` or interleaves them.
// We look for `--headless` anywhere in process.argv.
const headlessIndex = process.argv.indexOf('--headless');
const isHeadless = headlessIndex !== -1;

// In headless mode, extract the CLI args after --headless
let cliArgs = isHeadless ? process.argv.slice(headlessIndex + 1) : [];

// Parse --wait-for-approval flag
const waitForApprovalIndex = cliArgs.indexOf('--wait-for-approval');
const waitForApproval = waitForApprovalIndex !== -1;
if (waitForApproval) {
  cliArgs = [...cliArgs.slice(0, waitForApprovalIndex), ...cliArgs.slice(waitForApprovalIndex + 1)];
}

// Set app name early so Electron uses "invoker" as WM_CLASS (X11) and app_id (Wayland).
// --class tells Chromium to set WM_CLASS explicitly, preventing GNOME from
// grouping Invoker with other Electron apps (e.g. Slack).
app.name = 'invoker';
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', 'invoker');
}

// ── Shared state ─────────────────────────────────────────────

let messageBus: MessageBus;
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


async function initServices(): Promise<void> {
  messageBus = new IpcBus();
  const dbDir = process.env.INVOKER_DB_DIR
    ?? (process.env.NODE_ENV === 'test'
      ? path.join(homedir(), '.invoker', 'test')
      : path.join(homedir(), '.invoker'));
  mkdirSync(dbDir, { recursive: true });
  persistence = await SQLiteAdapter.create(path.join(dbDir, 'invoker.db'));
  familiarRegistry = new FamiliarRegistry();
  const invokerHomeInit = process.env.INVOKER_DB_DIR
    ?? path.join(homedir(), '.invoker');
  familiarRegistry.register(
    'worktree',
    new WorktreeFamiliar({
      repoDir: repoRoot,
      worktreeBaseDir: path.resolve(invokerHomeInit, 'worktrees'),
      cacheDir: path.resolve(invokerHomeInit, 'repos'),
      maxWorktrees: 5,
    }),
  );
  orchestrator = new Orchestrator({
    persistence, messageBus,
    maxConcurrency: invokerConfig.maxConcurrency,
    utilizationRules: resolveUtilizationRules(invokerConfig),
    defaultUtilization: invokerConfig.defaultUtilization,
    executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
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
    log: deps.logFn,
    planningTimeoutSeconds: invokerConfig.planningTimeoutSeconds,
    planningHeartbeatIntervalSeconds: invokerConfig.planningHeartbeatIntervalSeconds,
  });

  await slack.start(async (command: any) => {
    deps.logFn('trace', 'info', `slackBot: command received — type=${command.type}`);
    switch (command.type) {
      case 'approve':
        await orchestrator.approve(command.taskId);
        break;
      case 'reject':
        rejectTask(command.taskId, { orchestrator }, command.reason);
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
    await initServices();
    try {
      await runHeadless(cliArgs, {
        orchestrator, persistence, familiarRegistry, messageBus,
        repoRoot, invokerConfig, initServices, wireSlackBot,
        waitForApproval,
      });
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
      remoteTargets: invokerConfig.remoteTargets,
      mergeGateProvider: new GitHubMergeGateProvider(),
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
    wireApproveHook();
  }

  function wireApproveHook(): void {
    orchestrator.setBeforeApproveHook(async (task) => {
      if (task.config.isMergeNode && task.config.workflowId) {
        const workflow = persistence.loadWorkflow(task.config.workflowId);
        if (workflow?.mergeMode === "github") return; // PR is the merge mechanism
        await taskExecutor.approveMerge(task.config.workflowId);
      }
    });
  }

  async function killRunningTask(taskId: string): Promise<void> {
    const entry = taskHandles.get(taskId);
    if (!entry) return;
    console.log(`[kill] Killing running task "${taskId}" before restart`);
    await entry.familiar.kill(entry.handle);
    taskHandles.delete(taskId);
  }

  /** Cancel a task and cascade-kill all downstream DAG dependents. Shared by IPC, headless, and API. */
  async function performCancelTask(taskId: string): Promise<{ cancelled: string[]; runningCancelled: string[] }> {
    const result = orchestrator.cancelTask(taskId);
    for (const id of result.runningCancelled) {
      await killRunningTask(id);
    }
    return result;
  }

  function relaunchOrphansAndStartReady(logPrefix: string): TaskState[] {
    const orphanRestarted: TaskState[] = [];
    for (const task of orchestrator.getAllTasks()) {
      if (task.status === 'running') {
        console.log(`[${logPrefix}] relaunching orphaned running task "${task.id}"`);
        const started = orchestrator.restartTask(task.id);
        orphanRestarted.push(...started.filter(t => t.status === 'running'));
      }
    }

    const readyStarted = orchestrator.startExecution();
    const allStarted = [...orphanRestarted, ...readyStarted];
    if (allStarted.length > 0) {
      console.log(`[${logPrefix}] started ${allStarted.length} tasks (${orphanRestarted.length} orphans relaunched, ${readyStarted.length} ready): [${allStarted.map(t => t.id).join(', ')}]`);
    }
    return allStarted;
  }

  function createWindow(): void {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      // Hidden windows in NODE_ENV=test avoid focus stealing; visual proof sets CAPTURE_MODE and needs a real compositor path for screenshots.
      show: process.env.NODE_ENV !== 'test' || Boolean(process.env.CAPTURE_MODE),
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

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) {
        const browserCmd = invokerConfig.browser;
        if (browserCmd) {
          spawn(browserCmd, [url], { detached: true, stdio: 'ignore' }).unref();
        } else {
          const chromeCmd: [string, string[]] = process.platform === 'darwin'
            ? ['open', ['-a', 'Google Chrome', url]]
            : process.platform === 'win32'
              ? ['cmd', ['/c', 'start', 'chrome', url]]
              : ['google-chrome', [url]];
          try {
            spawn(chromeCmd[0], chromeCmd[1], { detached: true, stdio: 'ignore' }).unref();
          } catch {
            shell.openExternal(url);
          }
        }
      }
      return { action: 'deny' as const };
    });
  }

  app.whenReady().then(async () => {
    await initServices();

    rebuildTaskExecutor();

    let startupAutoRunBlocked = !!invokerConfig.disableAutoRunOnStartup;

    // Relaunch orphaned running tasks and start any pending-but-ready tasks.
    if (invokerConfig.disableAutoRunOnStartup) {
      console.log('[init] auto-run on startup disabled by config — skipping orphan relaunch');
    } else {
      const allStarted = relaunchOrphansAndStartReady('init');
      if (allStarted.length > 0) {
        taskExecutor.executeTasks(allStarted);
      }
      taskExecutor.resumeMergeGatePolling();
    }

    apiServer = startApiServer({
      orchestrator,
      persistence,
      familiarRegistry,
      taskExecutor,
      killRunningTask,
    });

    const dbPath = process.env.INVOKER_DB_DIR
      ? path.join(process.env.INVOKER_DB_DIR, 'invoker.db')
      : path.join(homedir(), '.invoker', 'invoker.db');
    console.log(`[init] Database: ${dbPath}`);
    console.log(`[init] Repo root: ${repoRoot}`);
    console.log(`[init] Config: disableAutoRunOnStartup=${invokerConfig.disableAutoRunOnStartup ?? false}`);

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
          const prev = JSON.parse(existing);
          const { config: cfgChanges, execution: execChanges, ...topLevel } = d.changes;
          const task = {
            ...prev,
            ...topLevel,
            config: { ...prev.config, ...cfgChanges },
            execution: { ...prev.execution, ...execChanges },
          };
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
      const normalized = applyPlanDefinitionDefaults(plan, repoRoot);
      orchestrator.loadPlan(normalized, { allowGraphMutation: invokerConfig.allowGraphMutation });
    });

    if (process.env.NODE_ENV === 'test') {
      ipcMain.handle(
        'invoker:inject-task-states',
        async (_event, updates: Array<{ taskId: string; changes: TaskStateChanges }>) => {
          for (const { taskId, changes } of updates) {
            persistence.updateTask(taskId, changes);
            messageBus.publish(Channels.TASK_DELTA, {
              type: 'updated',
              taskId,
              changes,
            } satisfies TaskDelta);
          }
          orchestrator.syncAllFromDb();
        },
      );
    }

    ipcMain.handle('invoker:start', async () => {
      console.log(`[ipc] start`);
      const started = orchestrator.startExecution();
      console.log(`[ipc] startExecution returned ${started.length} tasks:`, started.map(t => t.id));
      await taskExecutor.executeTasks(started);
      return started;
    });

    ipcMain.handle('invoker:resume-workflow', async () => {
      startupAutoRunBlocked = false;
      const workflows = persistence.listWorkflows();
      if (workflows.length === 0) {
        console.log(`[ipc] resume-workflow: no workflows found`);
        return null;
      }
      orchestrator.syncAllFromDb();

      const allStarted = relaunchOrphansAndStartReady('resume-workflow');
      const tasks = orchestrator.getAllTasks();
      for (const task of tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('invoker:task-delta', { type: 'created', task });
        }
      }
      console.log(`[ipc] resume-workflow: ${tasks.length} tasks loaded across ${workflows.length} workflows, ${allStarted.length} started`);
      await taskExecutor.executeTasks(allStarted);
      taskExecutor.resumeMergeGatePolling();
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
    maxConcurrency: invokerConfig.maxConcurrency,
    utilizationRules: resolveUtilizationRules(invokerConfig),
    defaultUtilization: invokerConfig.defaultUtilization,
    executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
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
    maxConcurrency: invokerConfig.maxConcurrency,
    utilizationRules: resolveUtilizationRules(invokerConfig),
    defaultUtilization: invokerConfig.defaultUtilization,
    executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
  });
      rebuildTaskExecutor();
      taskHandles.clear();
      lastKnownTaskStates.clear();
      lastKnownWorkflowCount = 0;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:workflows-changed', []);
      }
    });

    ipcMain.handle('invoker:delete-workflow', async (_event, workflowId: string) => {
      console.log(`[ipc] delete-workflow: "${workflowId}"`);
      try {
        // Kill all running tasks belonging to the workflow
        const allTasks = orchestrator.getAllTasks();
        const workflowTasks = allTasks.filter(
          (t) => t.config.workflowId === workflowId && t.status === 'running',
        );
        for (const task of workflowTasks) {
          await killRunningTask(task.id);
        }

        // Delete from DB
        persistence.deleteWorkflow(workflowId);

        // Update in-memory state
        orchestrator.removeWorkflow(workflowId);

        // Clean up task handles and last known states
        for (const task of allTasks.filter((t) => t.config.workflowId === workflowId)) {
          lastKnownTaskStates.delete(task.id);
          // Send removal deltas
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('invoker:task-delta', {
              type: 'removed',
              taskId: task.id,
            });
          }
        }

        // Update workflow count and send workflows-changed
        const workflows = persistence.listWorkflows();
        lastKnownWorkflowCount = workflows.length;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('invoker:workflows-changed', workflows);
        }
      } catch (err) {
        console.error(`[ipc] delete-workflow failed: ${err}`);
        throw err;
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

    ipcMain.handle('invoker:get-claude-session', (_event, sessionId: string) => {
      console.log(`[ipc] get-claude-session: "${sessionId}"`);
      try {
        const claudeProjectsDir = path.join(homedir(), '.claude', 'projects');
        if (!existsSync(claudeProjectsDir)) return null;

        const projectDirs = readdirSync(claudeProjectsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        let jsonlPath: string | null = null;
        for (const dir of projectDirs) {
          const candidate = path.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
          if (existsSync(candidate)) {
            jsonlPath = candidate;
            break;
          }
        }
        if (!jsonlPath) return null;

        const raw = readFileSync(jsonlPath, 'utf-8');
        const messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> = [];

        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message?.content) {
              const content = typeof entry.message.content === 'string'
                ? entry.message.content
                : JSON.stringify(entry.message.content);
              messages.push({
                role: 'user',
                content,
                timestamp: entry.timestamp ?? '',
              });
            } else if (entry.type === 'assistant' && entry.message?.content) {
              const blocks = Array.isArray(entry.message.content)
                ? entry.message.content
                : [entry.message.content];
              const text = blocks
                .filter((b: any) => typeof b === 'string' || b?.type === 'text')
                .map((b: any) => typeof b === 'string' ? b : b.text ?? '')
                .join('\n');
              if (text) {
                messages.push({
                  role: 'assistant',
                  content: text,
                  timestamp: entry.timestamp ?? '',
                });
              }
            }
          } catch {
            // Skip malformed lines
          }
        }

        return messages;
      } catch (err) {
        console.error(`[ipc] get-claude-session failed:`, err);
        return null;
      }
    });

    ipcMain.handle('invoker:provide-input', (_event, taskId: string, input: string) => {
      orchestrator.provideInput(taskId, input);
    });

    ipcMain.handle('invoker:approve', async (_event, taskId: string) => {
      console.log(`[ipc] approve: "${taskId}"`);
      const started = await orchestrator.approve(taskId);
      console.log(`[ipc] approve: orchestrator returned ${started.length} started tasks: [${started.map(t => `${t.id}(${t.status})`).join(', ')}]`);
      const runnable = started.filter(t => t.status === 'running');
      console.log(`[ipc] approve: ${runnable.length} runnable after filter: [${runnable.map(t => t.id).join(', ')}]`);
      if (runnable.length > 0) await taskExecutor.executeTasks(runnable);
    });

    ipcMain.handle('invoker:reject', (_event, taskId: string, reason?: string) => {
      rejectTask(taskId, { orchestrator }, reason);
    });

    ipcMain.handle('invoker:select-experiment', async (_event, taskId: string, experimentId: string | string[]) => {
      const ids = Array.isArray(experimentId) ? experimentId : [experimentId];
      console.log(`[ipc] select-experiment: "${taskId}" experimentIds=${JSON.stringify(ids)}`);
      try {
        const newlyStarted = await sharedSelectExperiments(taskId, ids, { orchestrator, taskExecutor });
        await taskExecutor.executeTasks(newlyStarted);
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

    ipcMain.handle('invoker:cancel-task', async (_event, taskId: string) => {
      console.log(`[ipc] cancel-task: "${taskId}"`);
      try {
        return await performCancelTask(taskId);
      } catch (err) {
        console.error(`[ipc] cancel-task failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:get-queue-status', () => {
      return orchestrator.getQueueStatus();
    });

    ipcMain.handle('invoker:restart-workflow', async (_event, workflowId: string) => {
      console.log(`[ipc] restart-workflow: "${workflowId}"`);
      try {
        const started = sharedRestartWorkflow(workflowId, { persistence, orchestrator });
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
        const started = await rebaseAndRetry(taskId, { orchestrator, persistence, repoRoot });
        const runnable = started.filter(t => t.status === 'running');
        await taskExecutor.executeTasks(runnable);
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

    ipcMain.handle('invoker:set-merge-mode', async (_event, workflowId: string, mergeMode: string) => {
      console.log(`[ipc] set-merge-mode: workflow="${workflowId}" → "${mergeMode}"`);
      persistence.updateWorkflow(workflowId, { mergeMode: mergeMode as any });
      const workflows = persistence.listWorkflows();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:workflows-changed', workflows);
      }

      try {
        const tasks = persistence.loadTasks(workflowId);
        const mergeTask = tasks.find(t => t.config.isMergeNode);
        if (mergeTask && (mergeTask.status === 'completed' || mergeTask.status === 'awaiting_approval')) {
          const started = orchestrator.restartTask(mergeTask.id);
          const runnable = started.filter(t => t.status === 'running');
          await taskExecutor.executeTasks(runnable);
        }
      } catch (err) {
        console.error(`[ipc] set-merge-mode restart failed: ${err}`);
      }
    });

    ipcMain.handle('invoker:approve-merge', async (_event, workflowId: string) => {
      console.log(`[ipc] approve-merge: "${workflowId}"`);
      try {
        const mergeTask = orchestrator.getMergeNode(workflowId);
        if (!mergeTask) throw new Error(`No merge node for workflow ${workflowId}`);
        const started = await orchestrator.approve(mergeTask.id);
        const runnable = started.filter(t => t.status === 'running');
        if (runnable.length > 0) await taskExecutor.executeTasks(runnable);
      } catch (err) {
        console.error(`[ipc] approve-merge failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:check-pr-statuses', async () => {
      console.log(`[ipc] check-pr-statuses`);
      await taskExecutor.checkMergeGateStatuses();
    });

    ipcMain.handle('invoker:check-pr-status', async () => {
      const tasks = orchestrator.getAllTasks();
      const awaitingMergeGates = tasks.filter(
        t => t.config.isMergeNode && t.status === 'awaiting_approval'
      );
      await Promise.all(
        awaitingMergeGates.map(t => taskExecutor.checkPrApprovalNow(t.id))
      );
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

    ipcMain.handle('invoker:edit-task-type', async (_event, taskId: string, familiarType: string, remoteTargetId?: string) => {
      console.log(`[ipc] edit-task-type: "${taskId}" → "${familiarType}" remoteTargetId=${remoteTargetId ?? 'none'}`);
      try {
        const started = orchestrator.editTaskType(taskId, familiarType, remoteTargetId);
        const runnable = started.filter(t => t.status === 'running');
        await taskExecutor.executeTasks(runnable);
      } catch (err) {
        console.error(`[ipc] edit-task-type failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:get-remote-targets', () => {
      return Object.keys(invokerConfig.remoteTargets ?? {});
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
              if (task.execution?.isFixingWithAI) continue;
              const heartbeatTime = task.execution?.lastHeartbeatAt
                ? new Date(task.execution.lastHeartbeatAt as string | number).getTime()
                : null;
              const startedTime = task.execution?.startedAt
                ? new Date(task.execution.startedAt as string | number).getTime()
                : null;
              const referenceTime = heartbeatTime ?? startedTime;

              if (referenceTime && (now - referenceTime) > STALE_HEARTBEAT_MS) {
                if (startupAutoRunBlocked) {
                  console.log(`[db-poll] Stale running task "${task.id}": auto-run blocked by config, skipping restart`);
                  continue;
                }
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
    ipcMain.handle('invoker:open-terminal', async (_event, taskId: string): Promise<{ opened: boolean; reason?: string }> => {
      console.log(`[open-terminal] invoked for task="${taskId}"`);
      const taskStatus = persistence.getTaskStatus(taskId);
      console.log(`[open-terminal] task="${taskId}" status="${taskStatus}"`);
      if (taskStatus === 'running') {
        console.log(`[open-terminal] BLOCKED task="${taskId}" — still running`);
        return { opened: false, reason: 'Task is still running. View output in the terminal panel below.' };
      }

      const meta: PersistedTaskMeta = {
        taskId,
        familiarType: persistence.getFamiliarType(taskId) ?? 'worktree',
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
            maxWorktrees: 5,
          });
          familiarRegistry.register('worktree', worktree);
          familiar = worktree;
        } else if (meta.familiarType === 'ssh') {
          const targetId = persistence.getRemoteTargetId?.(taskId);
          const target = targetId ? invokerConfig.remoteTargets?.[targetId] : undefined;
          if (target) {
            familiar = new SshFamiliar(target);
          } else {
            familiar = familiarRegistry.getDefault();
          }
        } else {
          familiar = familiarRegistry.getDefault();
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
          console.log(`[dirty-detect] task="${taskId}" — changes detected (downstream staleness derived from attempt lineage)`);
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

        const bashScript = buildLinuxXTerminalBashScript(spec, cwd);
        const termArgs = ['-e', 'bash', '-c', bashScript];

        console.log(`[open-terminal] spawning x-terminal-emulator with args: ${JSON.stringify(termArgs)}`);
        const linuxResult = await spawnDetachedTerminal('x-terminal-emulator', termArgs, { env: cleanEnv }, onTerminalClose);
        console.log(`[open-terminal] task="${taskId}" result=${JSON.stringify(linuxResult)}`);
        return linuxResult;
      }

      if (process.platform === 'darwin') {
        if (spec.command) {
          const osaArgs = buildMacOSOsascriptArgs(spec, cwd);
          console.log(`[open-terminal] spawning osascript with args: ${JSON.stringify(osaArgs)}`);
          const osaResult = await spawnDetachedTerminal('osascript', osaArgs, {}, onTerminalClose);
          console.log(`[open-terminal] task="${taskId}" result=${JSON.stringify(osaResult)}`);
          return osaResult;
        }
        console.log(`[open-terminal] spawning open -a Terminal cwd="${cwd}"`);
        const openResult = await spawnDetachedTerminal('open', ['-a', 'Terminal', cwd], {}, onTerminalClose);
        console.log(`[open-terminal] task="${taskId}" result=${JSON.stringify(openResult)}`);
        return openResult;
      }

      return { opened: false, reason: `External terminal is not supported on platform: ${process.platform}` };
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
