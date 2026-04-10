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
 *   electron dist/main.js --headless restart-workflow <workflowId>
 *   electron dist/main.js --headless rebase-and-retry <taskId>
 *   electron dist/main.js --headless fix <taskId>
 *   electron dist/main.js --headless resolve-conflict <taskId>
 *   electron dist/main.js --headless edit <taskId> <newCommand>
 *   electron dist/main.js --headless edit-executor <taskId> <executorType>
 *   electron dist/main.js --headless edit-agent <taskId> <claude|codex>
 *   electron dist/main.js --headless cancel <taskId>
 *   electron dist/main.js --headless set-merge-mode <workflowId> <mode>
 *   electron dist/main.js --headless queue
 *   electron dist/main.js --headless audit <taskId>
 *
 * Using the same Electron binary for both modes provides a consistent runtime.
 */

import './main-process-file-log.js';

import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron';
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';

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

import { Orchestrator, CommandService } from '@invoker/workflow-core';
import type {
  PlanDefinition,
  TaskDelta,
  TaskReplacementDef,
  TaskState,
  TaskStateChanges,
} from '@invoker/workflow-core';
import { makeEnvelope } from '@invoker/contracts';
import { SQLiteAdapter, ConversationRepository, SqliteTaskRepository } from '@invoker/data-store';
import { IpcBus, Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import {
  ExecutorRegistry, TaskRunner,
  DockerExecutor, WorktreeExecutor, SshExecutor, GitHubMergeGateProvider, ReviewProviderRegistry,
  RESTART_TO_BRANCH_TRACE,
  remoteFetchForPool,
  registerBuiltinAgents,
  type Executor, type ExecutorHandle,
} from '@invoker/execution-engine';
import type { TaskOutputData } from './types.js';
import { loadConfig, resolveSecretsFilePath, type InvokerConfig } from './config.js';
import {
  createDeleteAllSnapshot,
  createHourlySnapshot,
  resolveInvokerHomeRoot,
} from './delete-all-snapshot.js';
import { isHeadlessMutatingCommand, isHeadlessReadOnlyCommand } from './headless-command-classification.js';
import { backupPlan } from './plan-backup.js';
// applyPlanDefinitionDefaults removed — parsePlan() applies defaults internally
import { startApiServer, type ApiServer } from './api-server.js';
import { runHeadless, tryDelegateRun, tryDelegateResume, tryDelegateExec, resolveAgentSession } from './headless.js';
import {
  rebaseAndRetry,
  recreateWorkflow as sharedRecreateWorkflow,
  recreateTask as sharedRecreateTask,
  cancelWorkflow as sharedCancelWorkflow,
  retryWorkflow as sharedRetryWorkflow,
  resolveConflictAction,
  selectExperiments as sharedSelectExperiments,
  setWorkflowMergeMode,
  editTaskAgent as sharedEditTaskAgent,
  setTaskExternalGatePolicies as sharedSetTaskExternalGatePolicies,
} from './workflow-actions.js';
import { spawn, execSync } from 'node:child_process';
import { openExternalTerminalForTask } from './open-terminal-for-task.js';
import { createRequire } from 'node:module';
import { acquireDbWriterLock, type DbWriterLockResult } from './db-writer-lock.js';

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

// Parse --no-track / --do-not-track flag
const noTrackIndex = cliArgs.findIndex((arg) => arg === '--no-track' || arg === '--do-not-track');
const noTrack = noTrackIndex !== -1;
if (noTrack) {
  cliArgs = [...cliArgs.slice(0, noTrackIndex), ...cliArgs.slice(noTrackIndex + 1)];
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
let executorRegistry: ExecutorRegistry;
let orchestrator: Orchestrator;
let commandService: CommandService;
let hourlyBackupInterval: ReturnType<typeof setInterval> | null = null;
let writerLock: DbWriterLockResult | null = null;

// Repo root: 3 levels up from packages/app/dist/
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const invokerConfig: InvokerConfig = loadConfig();

function assertDeleteAllEnabled(): void {
  if (process.env.INVOKER_ALLOW_DELETE_ALL === '1') return;
  throw new Error(
    'delete-all is disabled by default. Set INVOKER_ALLOW_DELETE_ALL=1 to enable it explicitly.',
  );
}

interface InitServicesOptions {
  readOnly?: boolean;
  executionAgentRegistry?: import('@invoker/execution-engine').AgentRegistry;
}

async function initServices(options?: InitServicesOptions): Promise<void> {
  messageBus = new IpcBus();
  const invokerHomeRoot = resolveInvokerHomeRoot();
  mkdirSync(invokerHomeRoot, { recursive: true });
  const readOnly = options?.readOnly === true;
  const dbPath = path.join(invokerHomeRoot, 'invoker.db');
  if (!readOnly) {
    writerLock = acquireDbWriterLock(dbPath);
  }
  persistence = await SQLiteAdapter.create(dbPath, {
    readOnly,
    ownerCapability: !readOnly, // writable mode requires owner capability
  });
  if (!readOnly && !hourlyBackupInterval) {
    const hourlyMs = Number(process.env.INVOKER_HOURLY_BACKUP_MS ?? 60 * 60 * 1000);
    if (Number.isFinite(hourlyMs) && hourlyMs > 0) {
      hourlyBackupInterval = setInterval(() => {
        try {
          const snapshot = createHourlySnapshot(invokerHomeRoot);
          if (snapshot) {
            console.log(`[backup] hourly snapshot: ${snapshot}`);
          } else {
            console.log('[backup] hourly snapshot skipped: DB file does not exist yet');
          }
        } catch (err) {
          console.error(
            `[backup] hourly snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }, hourlyMs);
      hourlyBackupInterval.unref?.();
      console.log(`[backup] hourly snapshots enabled (interval=${hourlyMs}ms)`);
    }
  }
  executorRegistry = new ExecutorRegistry();
  executorRegistry.register(
    'worktree',
    new WorktreeExecutor({
      worktreeBaseDir: path.resolve(invokerHomeRoot, 'worktrees'),
      cacheDir: path.resolve(invokerHomeRoot, 'repos'),
      maxWorktrees: 5,
      agentRegistry: options?.executionAgentRegistry,
    }),
  );
  const taskRepository = new SqliteTaskRepository(persistence);
  orchestrator = new Orchestrator({
    persistence, messageBus,
    taskRepository,
    maxConcurrency: invokerConfig.maxConcurrency,
    executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
  });
  commandService = new CommandService(orchestrator);

  orchestrator.syncAllFromDb();
  const initLog = isHeadless
    ? (...args: unknown[]) => { process.stderr.write(args.join(' ') + '\n'); }
    : console.log;
  const workflows = persistence.listWorkflows();
  for (const wf of workflows) {
    const tasks = persistence.loadTasks(wf.id);
    initLog(`[init] DB workflow "${wf.id}" (${wf.name}): ${tasks.length} tasks`);
  }
  initLog(`[init] Orchestrator graph has ${orchestrator.getAllTasks().length} tasks across ${workflows.length} workflows`);
}

// ── Load @invoker/surfaces at runtime ────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadSurfaces(): any {
  const req = createRequire(__filename);
  return req('@invoker/surfaces');
}

// ── Shared Slack Bot Wiring ──────────────────────────────────

interface SlackBotDeps {
  executor: TaskRunner;
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
  let repoUrl = process.env.INVOKER_REPO_URL;
  if (!repoUrl) {
    try {
      repoUrl = execSync('git remote get-url origin', { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      deps.logFn('slack', 'warn', 'Could not detect repoUrl from git remote; plans will require repoUrl in YAML');
    }
  }

  const slack = new surfaces.SlackSurface({
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    channelId: process.env.SLACK_CHANNEL_ID!,
    cursorCommand: process.env.CURSOR_COMMAND ?? 'agent',
    model: process.env.CURSOR_MODEL,
    workingDir: repoRoot,
    conversationRepo,
    defaultBranch: invokerConfig.defaultBranch,
    repoUrl,
    log: deps.logFn,
    planningTimeoutSeconds: invokerConfig.planningTimeoutSeconds,
    planningHeartbeatIntervalSeconds: invokerConfig.planningHeartbeatIntervalSeconds,
  });

  await slack.start(async (command: any) => {
    deps.logFn('trace', 'info', `slackBot: command received — type=${command.type}`);
    switch (command.type) {
      case 'approve': {
        const env = makeEnvelope('approve', 'surface', 'task', { taskId: command.taskId as string });
        const approveResult = await commandService.approve(env);
        if (!approveResult.ok) throw new Error(approveResult.error.message);
        const approveStarted = approveResult.data;
        const pfm = approveStarted.filter(t => t.status === 'running' && t.config.isMergeNode && t.id === command.taskId);
        for (const task of pfm) {
          deps.executor.publishAfterFix(task).catch(err => {
            console.error(`[slack] approve: publishAfterFix failed for "${task.id}":`, err);
          });
        }
        const runnable = approveStarted.filter(t => t.status === 'running' && !(t.config.isMergeNode && t.id === command.taskId));
        if (runnable.length > 0) await deps.executor.executeTasks(runnable);
        break;
      }
      case 'reject': {
        const env = makeEnvelope('reject', 'surface', 'task', { taskId: command.taskId as string, reason: command.reason as string | undefined });
        const rejectResult = commandService.reject(env);
        if (!rejectResult.ok) throw new Error(rejectResult.error.message);
        break;
      }
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
        const { parsePlan } = await import('./plan-parser.js');
        const planText = command.planText as string;
        const plan = parsePlan(planText);
        deps.logFn('trace', 'info', `slackBot: loading plan "${plan.name}" (${plan.tasks.length} tasks)`);
        deps.onStartPlan?.();
        deps.onPlanLoaded?.(plan);
        backupPlan(plan);
        orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
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
    const agentRegistry = registerBuiltinAgents();
    const command = cliArgs[0];
    const readOnlyMode = isHeadlessReadOnlyCommand(cliArgs);
    const mutatingMode = isHeadlessMutatingCommand(cliArgs);
    const standaloneMode = process.env.INVOKER_HEADLESS_STANDALONE === '1';

    // Try delegation for mutating commands first (owner mode).
    // In standalone mode we skip delegation and run locally.
    if (mutatingMode && !standaloneMode) {
      const delegationBus = new IpcBus();
      try {
        await delegationBus.ready();

        let delegated = false;
        if (command === 'run') {
          const planPath = cliArgs[1];
          if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');
          delegated = await tryDelegateRun(planPath, delegationBus, waitForApproval, noTrack);
        } else if (command === 'resume') {
          const workflowId = cliArgs[1];
          if (!workflowId) throw new Error('Missing workflowId. Usage: --headless resume <id>');
          delegated = await tryDelegateResume(workflowId, delegationBus, waitForApproval, noTrack);
        } else {
          delegated = await tryDelegateExec(cliArgs, delegationBus, waitForApproval, noTrack);
        }

        if (delegated) {
          // Successfully delegated to GUI
          delegationBus.disconnect();
          process.exit(process.exitCode ?? 0);
        }

        // Delegation failed: no owner handler available.
        delegationBus.disconnect();
        if (!standaloneMode) {
          console.error(
            `${RED}Error:${RESET} Mutation command "${command}" requires an owner process (GUI or standalone headless).\n` +
            `\n${BOLD}Options:${RESET}\n` +
            `  1. Start the GUI process first: ${BOLD}electron dist/main.js${RESET}\n` +
            `  2. Run in standalone mode: ${BOLD}INVOKER_HEADLESS_STANDALONE=1 electron dist/main.js --headless ${cliArgs.join(' ')}${RESET}\n` +
            `\nStandalone mode opens a writable database. Only use it when no other process is accessing the database.`
          );
          process.exit(1);
        }
      } catch (err) {
        console.error(`${RED}Delegation error:${RESET} ${err instanceof Error ? err.message : String(err)}`);
        delegationBus.disconnect();
        process.exit(1);
      }
    }

    let exitCode = 0;
    try {
      // Standalone mode: initialize services and run headless
      await initServices({
        readOnly: readOnlyMode,
        executionAgentRegistry: agentRegistry,
      });

      const headlessDeps = {
        orchestrator, persistence, executorRegistry, messageBus,
        repoRoot, invokerConfig, initServices, wireSlackBot,
        waitForApproval,
        noTrack,
        executionAgentRegistry: agentRegistry,
      };

      // In standalone owner mode, serve delegated mutation requests from peer headless processes.
      if (standaloneMode && messageBus) {
        messageBus.onRequest('headless.exec', async (req: unknown) => {
          const { args, waitForApproval: delegatedWait, noTrack: delegatedNoTrack } =
            req as { args: string[]; waitForApproval?: boolean; noTrack?: boolean };
          if (!Array.isArray(args) || args.length === 0) {
            throw new Error('Missing delegated headless command arguments');
          }
          await runHeadless(args, {
            ...headlessDeps,
            waitForApproval: delegatedWait,
            noTrack: delegatedNoTrack,
          });
          return { ok: true };
        });
      }

      await runHeadless(cliArgs, headlessDeps);
    } catch (err) {
      console.error(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}`);
      exitCode = 1;
    } finally {
      if (persistence) persistence.close();
      if (writerLock) writerLock.release();
      if (messageBus) messageBus.disconnect();
    }
    process.exit(exitCode);
  }).catch((err) => {
    console.error(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
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
  const agentRegistry = registerBuiltinAgents();
  let mainWindow: BrowserWindow | null = null;
  let taskExecutor: TaskRunner;
  let apiServer: ApiServer | null = null;
  const taskHandles = new Map<string, { handle: ExecutorHandle; executor: Executor }>();
  let dbPollInterval: ReturnType<typeof setInterval> | null = null;
  let activityPollInterval: ReturnType<typeof setInterval> | null = null;
  let uiPerfLogInterval: ReturnType<typeof setInterval> | null = null;
  const lastKnownTaskStates = new Map<string, string>();
  let lastKnownWorkflowCount = 0;
  let lastActivityLogId = 0;
  const uiPerfStats = {
    mainDeltaToUi: 0,
    dbPollCreated: 0,
    dbPollUpdatedAsCreated: 0,
    dbPollUpdatedAsUpdated: 0,
    rendererReports: 0,
    maxRendererEventLoopLagMs: 0,
    maxRendererLongTaskMs: 0,
  };

  // Focus existing window when a second instance is launched
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function rebuildTaskRunner(): void {
    taskExecutor = new TaskRunner({
      orchestrator,
      persistence,
      executorRegistry,
      executionAgentRegistry: agentRegistry,
      cwd: repoRoot,
      defaultBranch: invokerConfig.defaultBranch,
      dockerConfig: {
        imageName: invokerConfig.docker?.imageName,
        secretsFile: resolveSecretsFilePath(invokerConfig),
      },
      remoteTargetsProvider: () => loadConfig().remoteTargets ?? {},
      mergeGateProvider: new GitHubMergeGateProvider(),
      reviewProviderRegistry: (() => {
        const registry = new ReviewProviderRegistry();
        registry.register(new GitHubMergeGateProvider());
        return registry;
      })(),
      callbacks: {
        onOutput: (taskId, data) => {
          console.log(`[output] ${taskId}: ${data.trimEnd()}`);
          const outputData: TaskOutputData = { taskId, data };
          messageBus.publish(Channels.TASK_OUTPUT, outputData);
          try {
            persistence.appendTaskOutput(taskId, data);
            persistence.appendOutputChunk(taskId, data);
          } catch (err) {
            console.error(`[output] Failed to persist output for ${taskId}:`, err);
          }
        },
        onSpawned: (taskId, handle, executor) => {
          console.log(`[exec] Task "${taskId}" spawned (handle: ${handle.executionId})`);
          taskHandles.set(taskId, { handle, executor });
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
        if (workflow?.mergeMode === "external_review") return; // external review is the merge mechanism
        await taskExecutor.approveMerge(task.config.workflowId);
      }
    });
  }

  async function killRunningTask(taskId: string): Promise<void> {
    const entry = taskHandles.get(taskId);
    if (!entry) return;
    console.log(`[kill] Killing running task "${taskId}" before restart`);
    await entry.executor.kill(entry.handle);
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

  /** Cancel all active tasks in a workflow and kill any running processes. */
  async function performCancelWorkflow(workflowId: string): Promise<{ cancelled: string[]; runningCancelled: string[] }> {
    const result = sharedCancelWorkflow(workflowId, { orchestrator });
    for (const id of result.runningCancelled) {
      await killRunningTask(id);
    }
    return result;
  }

  function relaunchOrphansAndStartReady(logPrefix: string): TaskState[] {
    const orphanRestarted: TaskState[] = [];
    for (const task of orchestrator.getAllTasks()) {
      if (task.status === 'running' || task.status === 'fixing_with_ai') {
        console.log(`[${logPrefix}] relaunching orphaned in-flight task "${task.id}" (${task.status})`);
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
    try {
      await initServices({ executionAgentRegistry: agentRegistry });
    } catch (err) {
      console.error(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}`);
      app.quit();
      return;
    }

    rebuildTaskRunner();

    // ── IPC Delegation Handlers — headless → GUI ────────────────
    // Headless processes delegate write-heavy commands to the GUI process via IpcBus.
    messageBus.onRequest('headless.run', async (req: unknown) => {
      const { planPath } = req as { planPath: string };
      console.log(`[ipc-delegate] headless.run: "${planPath}"`);
      const { parsePlanFile } = await import('./plan-parser.js');
      const plan = await parsePlanFile(planPath);
      taskHandles.clear();
      backupPlan(plan);
      const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
      orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
      const workflowId = orchestrator.getWorkflowIds().find(id => !wfIdsBefore.has(id))!;
      const started = orchestrator.startExecution();
      console.log(`[ipc-delegate] started ${started.length} tasks for workflow "${workflowId}"`);
      await taskExecutor.executeTasks(started);
      const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
      return { workflowId, tasks };
    });

    messageBus.onRequest('headless.resume', async (req: unknown) => {
      const { workflowId } = req as { workflowId: string };
      console.log(`[ipc-delegate] headless.resume: "${workflowId}"`);
      orchestrator.syncFromDb(workflowId);

      const orphanRestarted: TaskState[] = [];
      for (const task of orchestrator.getAllTasks()) {
        if (
          (task.status === 'running' || task.status === 'fixing_with_ai') &&
          task.config.workflowId === workflowId
        ) {
          console.log(`[ipc-delegate] relaunching orphaned in-flight task "${task.id}" (${task.status})`);
          const started = orchestrator.restartTask(task.id);
          orphanRestarted.push(...started.filter(t => t.status === 'running'));
        }
      }

      const started = orchestrator.startExecution();
      const allStarted = [...orphanRestarted, ...started];
      console.log(`[ipc-delegate] started ${allStarted.length} tasks (${orphanRestarted.length} orphans relaunched, ${started.length} ready)`);
      await taskExecutor.executeTasks(allStarted);
      taskExecutor.resumeMergeGatePolling();
      const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
      return { workflowId, tasks };
    });

    messageBus.onRequest('headless.exec', async (req: unknown) => {
      const { args, waitForApproval: delegatedWait, noTrack: delegatedNoTrack } =
        req as { args: string[]; waitForApproval?: boolean; noTrack?: boolean };
      if (!Array.isArray(args) || args.length === 0) {
        throw new Error('Missing delegated headless command arguments');
      }
      console.log(`[ipc-delegate] headless.exec: "${args.join(' ')}"`);
      await runHeadless(args, {
        orchestrator, persistence, executorRegistry, messageBus,
        repoRoot, invokerConfig, initServices, wireSlackBot,
        waitForApproval: delegatedWait,
        noTrack: delegatedNoTrack,
        executionAgentRegistry: registerBuiltinAgents(),
      });
      return { ok: true };
    });

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
      executorRegistry,
      taskExecutor,
      killRunningTask,
      cancelTask: performCancelTask,
      cancelWorkflow: performCancelWorkflow,
    });

    const dbPath = path.join(resolveInvokerHomeRoot(), 'invoker.db');
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
      uiPerfStats.mainDeltaToUi += 1;
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

    uiPerfLogInterval = setInterval(() => {
      const snapshot = {
        ts: new Date().toISOString(),
        metric: 'main_delta_flow',
        ...uiPerfStats,
      };
      try {
        persistence.writeActivityLog('ui-perf-main', 'info', JSON.stringify(snapshot));
      } catch {
        // DB might be locked
      }
    }, 10000);

    messageBus.subscribe(Channels.TASK_OUTPUT, (data: unknown) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:task-output', data);
      }
    });

    // Register IPC handlers
    ipcMain.handle('invoker:load-plan', async (_event, planText: string) => {
      const { parsePlan } = await import('./plan-parser.js');
      const plan = parsePlan(planText);
      console.log(`[ipc] load-plan: "${plan.name}" (${plan.tasks.length} tasks)`);
      taskHandles.clear();
      backupPlan(plan);
      orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
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
      console.log(`[ipc] stop — destroying all executors`);
      await Promise.all(executorRegistry.getAll().map(f => f.destroyAll()));
      const allTasks = orchestrator.getAllTasks();
      for (const task of allTasks) {
        if (task.status === 'running' || task.status === 'fixing_with_ai') {
          console.log(`[ipc] stop — failing in-flight task "${task.id}" (${task.status})`);
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

      await Promise.all(executorRegistry.getAll().map(f => f.destroyAll()));
      const allTasks = orchestrator.getAllTasks();
      for (const task of allTasks) {
        if (task.status === 'running' || task.status === 'fixing_with_ai') {
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
    taskRepository: new SqliteTaskRepository(persistence),
    maxConcurrency: invokerConfig.maxConcurrency,
    executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
  });
      commandService = new CommandService(orchestrator);
      rebuildTaskRunner();
      taskHandles.clear();
    });

    ipcMain.handle('invoker:list-workflows', () => persistence.listWorkflows());

    ipcMain.handle('invoker:delete-all-workflows', () => {
      console.log('[ipc] delete-all-workflows');
      assertDeleteAllEnabled();
      const snapshot = createDeleteAllSnapshot(resolveInvokerHomeRoot());
      if (snapshot) {
        console.log(`[ipc] delete-all-workflows snapshot: ${snapshot}`);
      } else {
        console.log('[ipc] delete-all-workflows snapshot skipped: DB file does not exist yet');
      }
      orchestrator.deleteAllWorkflows();
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
        // Kill all running tasks belonging to the workflow (process management is outside orchestrator scope)
        const allTasks = orchestrator.getAllTasks();
        const workflowTasks = allTasks.filter(
          (t) =>
            t.config.workflowId === workflowId &&
            (t.status === 'running' || t.status === 'fixing_with_ai'),
        );
        for (const task of workflowTasks) {
          await killRunningTask(task.id);
        }

        // Single call: DB delete + memory clear + scheduler cleanup + removal deltas
        // The 'removed' deltas flow through the messageBus subscriber which handles
        // lastKnownTaskStates.delete() and IPC forwarding to the renderer.
        orchestrator.deleteWorkflow(workflowId);

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

    ipcMain.handle('invoker:get-tasks', (_event, forceRefresh?: boolean) => {
      if (forceRefresh) {
        orchestrator.syncAllFromDb();
      }
      const tasks = orchestrator.getAllTasks();
      const workflows = persistence.listWorkflows();
      if (forceRefresh) {
        lastKnownTaskStates.clear();
        for (const task of tasks) {
          lastKnownTaskStates.set(task.id, JSON.stringify(task));
        }
        lastKnownWorkflowCount = workflows.length;
      }
      console.log(
        `[ipc] get-tasks(forceRefresh=${forceRefresh ? 'true' : 'false'}) returning ${tasks.length} tasks, ${workflows.length} workflows`,
      );
      return { tasks, workflows };
    });
    ipcMain.handle('invoker:get-events', (_event, taskId: string) => persistence.getEvents(taskId));
    ipcMain.handle('invoker:get-status', () => orchestrator.getWorkflowStatus());
    ipcMain.handle('invoker:get-task-output', (_event, taskId: string) => persistence.getTaskOutput(taskId));

    ipcMain.handle('invoker:get-output-chunks', (_event, taskId: string) => persistence.getOutputChunks(taskId));

    ipcMain.handle('invoker:replay-output-from', (_event, taskId: string, fromOffset: number) =>
      persistence.replayOutputFrom(taskId, fromOffset)
    );

    ipcMain.handle('invoker:get-output-tail', (_event, taskId: string) => persistence.getOutputTail(taskId));

    ipcMain.handle('invoker:get-all-completed-tasks', () => {
      return persistence.loadAllCompletedTasks();
    });

    ipcMain.handle('invoker:get-claude-session', async (_event, sessionId: string) => {
      console.log(`[ipc] get-claude-session: "${sessionId}"`);
      try {
        const allTasks = orchestrator.getAllTasks();
        return await resolveAgentSession(sessionId, 'claude', agentRegistry, allTasks);
      } catch (err) {
        console.error(`[ipc] get-claude-session failed:`, err);
        return null;
      }
    });

    ipcMain.handle('invoker:get-agent-session', async (_event, sessionId: string, agentName?: string) => {
      console.log(`[ipc] get-agent-session: "${sessionId}" agent="${agentName ?? 'claude'}"`);
      try {
        const allTasks = orchestrator.getAllTasks();
        return await resolveAgentSession(sessionId, agentName ?? 'claude', agentRegistry, allTasks);
      } catch (err) {
        console.error(`[ipc] get-agent-session failed:`, err);
        return null;
      }
    });

    ipcMain.handle('invoker:provide-input', (_event, taskId: string, input: string) => {
      orchestrator.provideInput(taskId, input);
    });

    ipcMain.handle('invoker:approve', async (_event, taskId: string) => {
      console.log(`[ipc] approve: "${taskId}"`);
      const envelope = makeEnvelope('approve', 'ui', 'task', { taskId });
      const result = await commandService.approve(envelope);
      if (!result.ok) throw new Error(result.error.message);
      const started = result.data;
      console.log(`[ipc] approve: commandService returned ${started.length} started tasks: [${started.map(t => `${t.id}(${t.status})`).join(', ')}]`);

      const postFixMerge = started.filter(t => t.status === 'running' && t.config.isMergeNode && t.id === taskId);
      for (const task of postFixMerge) {
        console.log(`[ipc] approve: post-fix PR prep for merge gate "${task.id}"`);
        taskExecutor.publishAfterFix(task).catch(err => {
          console.error(`[ipc] approve: publishAfterFix failed for "${task.id}":`, err);
        });
      }

      const runnable = started.filter(t => t.status === 'running' && !(t.config.isMergeNode && t.id === taskId));
      console.log(`[ipc] approve: ${runnable.length} runnable after filter: [${runnable.map(t => t.id).join(', ')}]`);
      if (runnable.length > 0) await taskExecutor.executeTasks(runnable);
    });

    ipcMain.handle('invoker:reject', (_event, taskId: string, reason?: string) => {
      const envelope = makeEnvelope('reject', 'ui', 'task', { taskId, reason });
      const result = commandService.reject(envelope);
      if (!result.ok) throw new Error(result.error.message);
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
        console.log(
          `${RESTART_TO_BRANCH_TRACE} ipc invoker:restart-task after orchestrator.restartTask: count=${started.length} [${started.map((t) => `${t.id}(${t.status})`).join(', ')}]`,
        );
        const runnable = started.filter(t => t.status === 'running');
        console.log(
          `${RESTART_TO_BRANCH_TRACE} ipc invoker:restart-task runnable=${runnable.length} [${runnable.map((t) => t.id).join(', ') || '(none)'}] → taskExecutor.executeTasks`,
        );
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

    ipcMain.handle('invoker:cancel-workflow', async (_event, workflowId: string) => {
      console.log(`[ipc] cancel-workflow: "${workflowId}"`);
      try {
        return await performCancelWorkflow(workflowId);
      } catch (err) {
        console.error(`[ipc] cancel-workflow failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:get-queue-status', () => {
      return orchestrator.getQueueStatus();
    });

    ipcMain.handle('invoker:report-ui-perf', (_event, metric: string, data?: Record<string, unknown>) => {
      const payload = {
        ts: new Date().toISOString(),
        metric,
        ...(data ?? {}),
      };
      if (metric === 'renderer_event_loop_lag' && typeof data?.lagMs === 'number') {
        uiPerfStats.maxRendererEventLoopLagMs = Math.max(uiPerfStats.maxRendererEventLoopLagMs, data.lagMs);
      }
      if (metric === 'renderer_long_task' && typeof data?.durationMs === 'number') {
        uiPerfStats.maxRendererLongTaskMs = Math.max(uiPerfStats.maxRendererLongTaskMs, data.durationMs);
      }
      uiPerfStats.rendererReports += 1;
      try {
        persistence.writeActivityLog('ui-perf', 'info', JSON.stringify(payload));
      } catch {
        // DB might be locked
      }
    });

    ipcMain.handle('invoker:get-ui-perf-stats', () => ({
      ...uiPerfStats,
      ts: new Date().toISOString(),
    }));

    ipcMain.handle('invoker:recreate-workflow', async (_event, workflowId: string) => {
      console.log(`[ipc] recreate-workflow: "${workflowId}"`);
      try {
        const started = sharedRecreateWorkflow(workflowId, { persistence, orchestrator });
        const runnable = started.filter(t => t.status === 'running');
        remoteFetchForPool.enabled = false;
        try {
          await taskExecutor.executeTasks(runnable);
        } finally {
          remoteFetchForPool.enabled = true;
        }
      } catch (err) {
        console.error(`[ipc] recreate-workflow failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:recreate-task', async (_event, taskId: string) => {
      console.log(`[ipc] recreate-task: "${taskId}"`);
      try {
        const started = sharedRecreateTask(taskId, { persistence, orchestrator });
        const runnable = started.filter(t => t.status === 'running');
        remoteFetchForPool.enabled = false;
        try {
          await taskExecutor.executeTasks(runnable);
        } finally {
          remoteFetchForPool.enabled = true;
        }
      } catch (err) {
        console.error(`[ipc] recreate-task failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:retry-workflow', async (_event, workflowId: string) => {
      console.log(`[ipc] retry-workflow: "${workflowId}"`);
      try {
        const started = sharedRetryWorkflow(workflowId, { orchestrator });
        const runnable = started.filter(t => t.status === 'running');
        remoteFetchForPool.enabled = false;
        try {
          await taskExecutor.executeTasks(runnable);
        } finally {
          remoteFetchForPool.enabled = true;
        }
      } catch (err) {
        console.error(`[ipc] retry-workflow failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:rebase-and-retry', async (_event, taskId: string) => {
      console.log(`[ipc] rebase-and-retry: "${taskId}"`);
      try {
        const started = await rebaseAndRetry(taskId, {
          orchestrator,
          persistence,
          repoRoot,
          taskExecutor,
        });
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
      try {
        await setWorkflowMergeMode(workflowId, mergeMode, {
          orchestrator,
          persistence,
          taskExecutor,
        });
      } catch (err) {
        console.error(`[ipc] set-merge-mode failed: ${err}`);
        throw err;
      }
      const workflows = persistence.listWorkflows();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:workflows-changed', workflows);
      }
    });

    ipcMain.handle('invoker:approve-merge', async (_event, workflowId: string) => {
      console.log(`[ipc] approve-merge: "${workflowId}"`);
      try {
        const mergeTask = orchestrator.getMergeNode(workflowId);
        if (!mergeTask) throw new Error(`No merge node for workflow ${workflowId}`);
        const envelope = makeEnvelope('approve', 'ui', 'workflow', { taskId: mergeTask.id });
        const result = await commandService.approve(envelope);
        if (!result.ok) throw new Error(result.error.message);
        const started = result.data;
        const postFixMerge = started.filter(t => t.status === 'running' && t.config.isMergeNode && t.id === mergeTask.id);
        for (const task of postFixMerge) {
          taskExecutor.publishAfterFix(task).catch(err => {
            console.error(`[ipc] approve-merge: publishAfterFix failed for "${task.id}":`, err);
          });
        }
        const runnable = started.filter(t => t.status === 'running' && !(t.config.isMergeNode && t.id === mergeTask.id));
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
        t => t.config.isMergeNode && (t.status === 'review_ready' || t.status === 'awaiting_approval')
      );
      await Promise.all(
        awaitingMergeGates.map(t => taskExecutor.checkPrApprovalNow(t.id))
      );
    });

    ipcMain.handle('invoker:resolve-conflict', async (_event, taskId: string, agentName?: string) => {
      console.log(`[ipc] resolve-conflict: "${taskId}" agent=${agentName ?? 'claude'}`);
      try {
        await resolveConflictAction(taskId, {
          orchestrator,
          persistence,
          taskExecutor,
        }, agentName);
      } catch (err) {
        console.error(`[ipc] resolve-conflict failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:fix-with-agent', async (_event, taskId: string, agentName?: string) => {
      console.log(`[ipc] fix-with-agent: "${taskId}" agent=${agentName ?? 'claude'}`);
      const { savedError } = orchestrator.beginConflictResolution(taskId);
      try {
        const output = persistence.getTaskOutput(taskId);
        await taskExecutor.fixWithAgent(taskId, output, agentName, savedError);
        orchestrator.setFixAwaitingApproval(taskId, savedError);
      } catch (err) {
        console.error(`[ipc] fix-with-agent failed: ${err}`);
        const msg = err instanceof Error ? err.message : String(err);
        persistence.appendTaskOutput(taskId, `\n[Fix with ${agentName ?? 'Claude'}] Failed: ${msg}`);
        orchestrator.revertConflictResolution(taskId, savedError, msg);
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

    ipcMain.handle('invoker:edit-task-type', async (_event, taskId: string, executorType: string, remoteTargetId?: string) => {
      console.log(`[ipc] edit-task-type: "${taskId}" → "${executorType}" remoteTargetId=${remoteTargetId ?? 'none'}`);
      try {
        const started = orchestrator.editTaskType(taskId, executorType, remoteTargetId);
        const runnable = started.filter(t => t.status === 'running');
        await taskExecutor.executeTasks(runnable);
      } catch (err) {
        console.error(`[ipc] edit-task-type failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle('invoker:edit-task-agent', async (_event, taskId: string, agentName: string) => {
      console.log(`[ipc] edit-task-agent: "${taskId}" → "${agentName}"`);
      try {
        const started = sharedEditTaskAgent(taskId, agentName, { orchestrator });
        const runnable = started.filter(t => t.status === 'running');
        await taskExecutor.executeTasks(runnable);
      } catch (err) {
        console.error(`[ipc] edit-task-agent failed: ${err}`);
        throw err;
      }
    });

    ipcMain.handle(
      'invoker:set-task-external-gate-policies',
      async (
        _event,
        taskId: string,
        updates: Array<{ workflowId: string; taskId?: string; gatePolicy: 'completed' | 'review_ready' }>,
      ) => {
        console.log(`[ipc] set-task-external-gate-policies: "${taskId}" updates=${updates.length}`);
        try {
          const started = sharedSetTaskExternalGatePolicies(taskId, updates, { orchestrator });
          const runnable = started.filter((t) => t.status === 'running');
          if (runnable.length > 0) await taskExecutor.executeTasks(runnable);
        } catch (err) {
          console.error(`[ipc] set-task-external-gate-policies failed: ${err}`);
          throw err;
        }
      },
    );

    ipcMain.handle('invoker:get-remote-targets', () => {
      return Object.keys(loadConfig().remoteTargets ?? {});
    });

    ipcMain.handle('invoker:get-execution-agents', () => {
      return agentRegistry.listExecution().map(a => a.name);
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
              uiPerfStats.dbPollCreated += 1;
              mainWindow.webContents.send('invoker:task-delta', { type: 'created', task });
            } else if (prev !== snapshot) {
              const msg = `Task updated: ${task.id} (${task.status})`;
              console.log(`[db-poll] ${msg}`);
              try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
              lastKnownTaskStates.set(task.id, snapshot);
              uiPerfStats.dbPollUpdatedAsCreated += 1;
              mainWindow.webContents.send('invoker:task-delta', { type: 'created', task });
            }

            if (task.status === 'fixing_with_ai') continue;
            if (task.status === 'running') {
              if (task.execution?.isFixingWithAI) continue;
              const heartbeatTime = task.execution?.lastHeartbeatAt
                ? new Date(task.execution.lastHeartbeatAt as unknown as string | number).getTime()
                : null;
              const startedTime = task.execution?.startedAt
                ? new Date(task.execution.startedAt as unknown as string | number).getTime()
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
      return openExternalTerminalForTask({
        taskId,
        persistence,
        executorRegistry,
        executionAgentRegistry: agentRegistry,
        repoRoot,
        runningTaskReason:
          'Task is still running or being fixed with AI. View output in the terminal panel below.',
      });
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  }).catch((err) => {
    console.error(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}`);
    app.quit();
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
    if (uiPerfLogInterval) clearInterval(uiPerfLogInterval);
    if (hourlyBackupInterval) {
      clearInterval(hourlyBackupInterval);
      hourlyBackupInterval = null;
    }
    if (executorRegistry) {
      await Promise.all(executorRegistry.getAll().map(f => f.destroyAll()));
    }
    if (orchestrator) {
      for (const task of orchestrator.getAllTasks()) {
        if (task.status === 'running' || task.status === 'fixing_with_ai') {
          orchestrator.handleWorkerResponse({
            requestId: `quit-${task.id}`,
            actionId: task.id,
            status: 'failed',
            outputs: { exitCode: 1, error: 'Application quit' },
          });
        }
      }
    }
    if (persistence) persistence.close();
    if (writerLock) writerLock.release();
    if (messageBus) messageBus.disconnect();
  });

  // ── Slack Bot (embedded in GUI process) ──────────────────
  async function startSlackBot(
    executor: TaskRunner,
    handles: Map<string, { handle: ExecutorHandle; executor: Executor }>,
  ): Promise<void> {
    const logFn = (source: string, level: string, message: string) => {
      const prefix = level === 'error' ? `${RED}[${source}]${RESET}` : `[${source}]`;
      console.log(`${prefix} ${message}`);
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
