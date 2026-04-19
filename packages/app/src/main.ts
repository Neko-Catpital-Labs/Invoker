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
 *   electron dist/main.js --headless retry-task <taskId>
 *   electron dist/main.js --headless retry <workflowId>
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

import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron';
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';

const enableTestCompositor = process.env.INVOKER_E2E_ENABLE_COMPOSITOR === '1' || Boolean(process.env.CAPTURE_MODE);

// Prevent desktop-wide freezes on Linux (Chromium GPU + X11/Wayland compositors).
// Defense-in-depth: API-level disable, command-line flags, and env var (LIBGL_ALWAYS_SOFTWARE).
if (process.platform === 'linux' && !enableTestCompositor) {
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
import type { WorkResponse } from '@invoker/contracts';
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
import type { Logger } from '@invoker/contracts';
import { FileAndDbLogger } from './logger.js';
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
import {
  runHeadless,
  tryDelegateRun,
  tryDelegateResume,
  tryDelegateExec,
  resolveAgentSession,
  createHeadlessExecutor,
  wireHeadlessApproveHook,
  type HeadlessDeps,
} from './headless.js';
import {
  approveTask as sharedApproveTask,
  rebaseAndRetry,
  recreateWorkflow as sharedRecreateWorkflow,
  recreateTask as sharedRecreateTask,
  resolveConflictAction,
  selectExperiments as sharedSelectExperiments,
  setWorkflowMergeMode,
  finalizeAppliedFix,
} from './workflow-actions.js';
import { spawn, execSync } from 'node:child_process';
import { openExternalTerminalForTask } from './open-terminal-for-task.js';
import { createRequire } from 'node:module';
import { acquireDbWriterLock, type DbWriterLockResult } from './db-writer-lock.js';
import { applyDelta } from './delta-merge.js';
import { shouldSkipAutoFixForError } from './auto-fix-gating.js';
import { buildAutoFixSkipOutput, getAutoFixDispatchDecision, getAutoFixEnqueueDecision } from './auto-fix-session.js';
import { ensureSqliteFlushDebounceForOwner } from './sqlite-flush-policy.js';
import type { WorkflowMutationPriority } from './workflow-mutation-coordinator.js';
import { PersistedWorkflowMutationCoordinator } from './persisted-workflow-mutation-coordinator.js';
import { dispatchTasksIfNeeded, executeGlobalTopup, finalizeMutationWithGlobalTopup } from './global-topup.js';
import { computeDeferredLaunchTiming } from './deferred-runnable.js';
import { preemptWorkflowBeforeMutation, type WorkflowCancelResult } from './workflow-preemption.js';
import { relaunchOrphansAndStartReady } from './orphan-relaunch.js';
import { listOpenFixIntentsForTask } from './auto-fix-intents.js';

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
let dispatcherTaskExecutor: Pick<TaskRunner, 'executeTasks'> | null = null;

function setDispatcherTaskExecutor(executor: Pick<TaskRunner, 'executeTasks'> | null): void {
  dispatcherTaskExecutor = executor;
}

function dispatchStartedTasks(tasks: TaskState[]): void {
  if (tasks.length === 0 || !dispatcherTaskExecutor) return;
  void dispatcherTaskExecutor.executeTasks(tasks).catch((err) => {
    logger.error(`[dispatcher] executeTasks failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`, {
      module: 'dispatch',
    });
  });
}
let workflowMutationCoordinator: PersistedWorkflowMutationCoordinator | null = null;
const workflowMutationDispatcher = new Map<string, (...args: unknown[]) => Promise<unknown>>();
let hourlyBackupInterval: ReturnType<typeof setInterval> | null = null;
let writerLock: DbWriterLockResult | null = null;
const workflowMutationOwnerId = `owner-${process.pid}-${Date.now()}`;
const appProcessStartedAt = Date.now();
const DEFAULT_MAX_CONCURRENT_WORKFLOW_DRAINS = 8;

function resolveMaxConcurrentWorkflowDrains(): number {
  const raw = process.env.INVOKER_MAX_CONCURRENT_WORKFLOW_DRAINS;
  if (!raw) {
    return DEFAULT_MAX_CONCURRENT_WORKFLOW_DRAINS;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  process.stderr.write(
    `[workflow-mutation-coordinator] ignoring invalid INVOKER_MAX_CONCURRENT_WORKFLOW_DRAINS="${raw}", using default ${DEFAULT_MAX_CONCURRENT_WORKFLOW_DRAINS}\n`,
  );
  return DEFAULT_MAX_CONCURRENT_WORKFLOW_DRAINS;
}

const maxConcurrentWorkflowDrains = resolveMaxConcurrentWorkflowDrains();

interface GuiMutationPayload {
  channel: string;
  args: unknown[];
}

interface HeadlessRunMutationPayload {
  planPath: string;
}

interface HeadlessResumeMutationPayload {
  workflowId: string;
}

interface HeadlessExecMutationPayload {
  args: string[];
  waitForApproval?: boolean;
  noTrack?: boolean;
}

// Root logger: created early in initServices() once persistence is available.
// Before initServices(), use the pre-init logger (file-only, no DB).
let logger: Logger = new FileAndDbLogger({ module: 'main' });

process.on('uncaughtException', (err) => {
  try {
    logger.error(`uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`, { module: 'process' });
  } catch {
    console.error('[process] uncaughtException:', err);
  }
});

process.on('unhandledRejection', (reason) => {
  try {
    logger.error(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`, { module: 'process' });
  } catch {
    console.error('[process] unhandledRejection:', reason);
  }
});

// Repo root: 3 levels up from packages/app/dist/
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const invokerConfig: InvokerConfig = (() => {
  try {
    return loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
})();

async function maybeDelayWorkflowResumeForTest(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') return;
  const raw = process.env.INVOKER_TEST_RESUME_PENDING_DELAY_MS;
  if (!raw) return;
  const delayMs = Number(raw);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function assertDeleteAllEnabled(): void {
  if (process.env.INVOKER_ALLOW_DELETE_ALL === '1') return;
  throw new Error(
    'delete-all is disabled by default. Set INVOKER_ALLOW_DELETE_ALL=1 to enable it explicitly.',
  );
}

interface InitServicesOptions {
  readOnly?: boolean;
  executionAgentRegistry?: import('@invoker/execution-engine').AgentRegistry;
  startupSyncMode?: 'all' | 'none';
}

async function initServices(options?: InitServicesOptions): Promise<void> {
  messageBus = new IpcBus();
  const invokerHomeRoot = resolveInvokerHomeRoot();
  mkdirSync(invokerHomeRoot, { recursive: true });
  const readOnly = options?.readOnly === true;
  const dbPath = path.join(invokerHomeRoot, 'invoker.db');
  ensureSqliteFlushDebounceForOwner(process.env, readOnly);
  if (!readOnly) {
    writerLock = acquireDbWriterLock(dbPath);
  }
  persistence = await SQLiteAdapter.create(dbPath, {
    readOnly,
    ownerCapability: !readOnly, // writable mode requires owner capability
  });
  // Upgrade root logger with DB persistence now that SQLiteAdapter is ready.
  logger = new FileAndDbLogger({ module: 'main' }, { persistence });
  if (!readOnly && !hourlyBackupInterval) {
    const hourlyMs = Number(process.env.INVOKER_HOURLY_BACKUP_MS ?? 60 * 60 * 1000);
    if (Number.isFinite(hourlyMs) && hourlyMs > 0) {
      hourlyBackupInterval = setInterval(() => {
        try {
          const snapshot = createHourlySnapshot(invokerHomeRoot);
          if (snapshot) {
            logger.info(`hourly snapshot: ${snapshot}`, { module: 'backup' });
          } else {
            logger.info('hourly snapshot skipped: DB file does not exist yet', { module: 'backup' });
          }
        } catch (err) {
          logger.error(
            `hourly snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
            { module: 'backup' },
          );
        }
      }, hourlyMs);
      hourlyBackupInterval.unref?.();
      logger.info(`hourly snapshots enabled (interval=${hourlyMs}ms)`, { module: 'backup' });
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
    defaultAutoFixRetries: invokerConfig.autoFixRetries,
    executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
    deferRunningUntilLaunch: true,
    taskDispatcher: dispatchStartedTasks,
  });
  commandService = new CommandService(orchestrator);

  const startupSyncMode = options?.startupSyncMode ?? 'all';
  const initLog = isHeadless
    ? (...args: unknown[]) => { process.stderr.write(args.join(' ') + '\n'); }
    : (msg: string) => { logger.info(msg, { module: 'init' }); };
  const workflows = persistence.listWorkflows();
  if (startupSyncMode === 'all') {
    try {
      orchestrator.syncAllFromDb();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`workflow invariant violation during startup sync: ${message}`, {
        module: 'init',
        error: message,
      });
      throw err;
    }
  }
  initLog(`[init] Loaded ${workflows.length} workflows from DB`);
  if (startupSyncMode === 'all') {
    initLog(`[init] Orchestrator graph has ${orchestrator.getAllTasks().length} tasks across ${workflows.length} workflows`);
  } else {
    initLog('[init] Orchestrator startup sync deferred to GUI bootstrap');
  }
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
  approveTaskAction?: (taskId: string) => Promise<void>;
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
  const repoLogger = logger.child({ module: 'conversation-repo' });
  const conversationRepo = new ConversationRepository(persistence, {
    info: (msg) => { repoLogger.info(msg); },
    warn: (msg) => { repoLogger.warn(msg); },
    error: (msg) => { repoLogger.error(msg); },
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
        const taskId = command.taskId as string;
        if (deps.approveTaskAction) {
          await deps.approveTaskAction(taskId);
          break;
        }
        await sharedApproveTask(taskId, {
          orchestrator,
          taskExecutor: deps.executor,
          approve: async (approvedTaskId) => {
            const result = await commandService.approve(
              makeEnvelope('approve', 'surface', 'task', { taskId: approvedTaskId }),
            );
            if (!result.ok) throw new Error(result.error.message);
            return result.data;
          },
          resumeAfterFixApproval: async (approvedTaskId) => {
            const result = await commandService.resumeTaskAfterFixApproval(
              makeEnvelope('approve', 'surface', 'task', { taskId: approvedTaskId }),
            );
            if (!result.ok) throw new Error(result.error.message);
            return result.data;
          },
        });
        break;
      }
      case 'reject': {
        const env = makeEnvelope('reject', 'surface', 'task', { taskId: command.taskId as string, reason: command.reason as string | undefined });
        const rejectResult = await commandService.reject(env);
        if (!rejectResult.ok) throw new Error(rejectResult.error.message);
        break;
      }
      case 'select_experiment': {
        const started = orchestrator.selectExperiment(command.taskId, command.experimentId);
        await dispatchTasksIfNeeded({
          orchestrator,
          taskExecutor: deps.executor,
          tasks: started,
          logger,
          context: 'slack.select-experiment',
        });
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
        backupPlan(plan, undefined, logger);
        orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
        const started = orchestrator.startExecution();
        deps.logFn('trace', 'info', `slackBot: startExecution returned ${started.length} tasks: [${started.map((t: any) => t.id).join(', ')}]`);
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
      // Delegating headless commands must never become the IPC server.
      // Otherwise a transient submitter can steal the transport socket away
      // from the actual GUI/standalone mutation owner.
      const delegationBus = new IpcBus(undefined, { allowServe: false });
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
          return; // Guard: process.exit() may not halt in Electron async context
        }

        // Delegation failed: no owner handler available.
        delegationBus.disconnect();
        if (!standaloneMode) {
          process.stderr.write(
            `${RED}Error:${RESET} Mutation command "${command}" requires an owner process (GUI or standalone headless).\n` +
            `\n${BOLD}Options:${RESET}\n` +
            `  1. Start the GUI process first: ${BOLD}electron dist/main.js${RESET}\n` +
            `  2. Run in standalone mode: ${BOLD}INVOKER_HEADLESS_STANDALONE=1 electron dist/main.js --headless ${cliArgs.join(' ')}${RESET}\n` +
            `\nStandalone mode opens a writable database. Only use it when no other process is accessing the database.\n`
          );
          process.exit(1);
          return; // Guard: process.exit() may not halt in Electron async context
        }
      } catch (err) {
        process.stderr.write(`${RED}Delegation error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
        delegationBus.disconnect();
        process.exit(1);
        return; // Guard: process.exit() may not halt in Electron async context
      }
    }

    let exitCode = 0;
    try {
      // Standalone mode: initialize services and run headless
      await initServices({
        readOnly: readOnlyMode,
        executionAgentRegistry: agentRegistry,
      });

      const headlessDeps: HeadlessDeps = {
        logger,
        orchestrator, persistence, executorRegistry, messageBus,
        repoRoot, invokerConfig, initServices, wireSlackBot,
        commandService,
        setTaskDispatcherExecutor: setDispatcherTaskExecutor,
        getUiPerfStats: () => ({
          ts: new Date().toISOString(),
          mainDeltaToUi: 0,
          dbPollCreated: 0,
          dbPollUpdatedAsCreated: 0,
          dbPollUpdatedAsUpdated: 0,
          rendererReports: 0,
          maxRendererEventLoopLagMs: 0,
          maxRendererLongTaskMs: 0,
        }),
        resetUiPerfStats: () => {},
        waitForApproval,
        noTrack,
        executionAgentRegistry: agentRegistry,
      };

      const createStandaloneTaskExecutor = (): TaskRunner => {
        const executor = createHeadlessExecutor(headlessDeps);
        setDispatcherTaskExecutor(executor);
        wireHeadlessApproveHook(headlessDeps, executor);
        return executor;
      };

      const executeStandaloneGuiMutation = async (payload: GuiMutationPayload): Promise<unknown> => {
        switch (payload.channel) {
          case 'invoker:load-plan': {
            const planText = String(payload.args[0] ?? '');
            const { parsePlan } = await import('./plan-parser.js');
            const plan = parsePlan(planText);
            backupPlan(plan, undefined, logger);
            orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
            return undefined;
          }
          case 'invoker:start': {
            const executor = createStandaloneTaskExecutor();
            const started = orchestrator.startExecution();
            await dispatchTasksIfNeeded({
              orchestrator,
              taskExecutor: executor,
              tasks: started,
              logger,
              context: 'standalone.invoker:start',
            });
            return started;
          }
          case 'invoker:set-merge-branch': {
            const workflowId = String(payload.args[0]);
            const baseBranch = String(payload.args[1]);
            persistence.updateWorkflow(workflowId, { baseBranch });
            const tasks = persistence.loadTasks(workflowId);
            const mergeTask = tasks.find((task) => task.config.isMergeNode);
            if (!mergeTask) return undefined;
            const started = orchestrator.restartTask(mergeTask.id);
            void started;
            return undefined;
          }
          case 'invoker:replace-task': {
            const taskId = String(payload.args[0]);
            const replacementTasks = payload.args[1] as TaskReplacementDef[];
            const envelope = makeEnvelope('replace-task', 'ui', 'task', { taskId, replacementTasks });
            const result = await commandService.replaceTask(envelope);
            if (!result.ok) throw new Error(result.error.message);
            const executor = createStandaloneTaskExecutor();
            await dispatchTasksIfNeeded({
              orchestrator,
              taskExecutor: executor,
              tasks: result.data,
              logger,
              context: 'standalone.replace-task',
            });
            return result.data;
          }
          case 'invoker:check-pr-statuses': {
            const executor = createStandaloneTaskExecutor();
            await executor.checkMergeGateStatuses();
            return undefined;
          }
          case 'invoker:check-pr-status': {
            const executor = createStandaloneTaskExecutor();
            const tasks = orchestrator.getAllTasks();
            const awaitingMergeGates = tasks.filter(
              (task) => task.config.isMergeNode && (task.status === 'review_ready' || task.status === 'awaiting_approval'),
            );
            await Promise.all(awaitingMergeGates.map((task) => executor.checkPrApprovalNow(task.id)));
            return undefined;
          }
          case 'invoker:select-experiment': {
            const taskId = String(payload.args[0]);
            const experimentId = payload.args[1] as string | string[];
            const ids = Array.isArray(experimentId) ? experimentId : [experimentId];
            const executor = createStandaloneTaskExecutor();
            if (ids.length === 1) {
              const envelope = makeEnvelope('select-experiment', 'ui', 'task', { taskId, experimentId: ids[0] });
              const result = await commandService.selectExperiment(envelope);
              if (!result.ok) throw new Error(result.error.message);
              await dispatchTasksIfNeeded({
                orchestrator,
                taskExecutor: executor,
                tasks: result.data,
                logger,
                context: 'standalone.select-experiment.single',
              });
              return undefined;
            }
            const newlyStarted = await sharedSelectExperiments(taskId, ids, { orchestrator, taskExecutor: executor });
            await dispatchTasksIfNeeded({
              orchestrator,
              taskExecutor: executor,
              tasks: newlyStarted,
              logger,
              context: 'standalone.select-experiment.multi',
            });
            return undefined;
          }
          case 'invoker:set-task-external-gate-policies': {
            const taskId = String(payload.args[0]);
            const updates = payload.args[1] as Array<{ workflowId: string; taskId?: string; gatePolicy: 'completed' | 'review_ready' }>;
            const envelope = makeEnvelope('set-gate-policies', 'ui', 'task', { taskId, updates });
            const result = await commandService.setTaskExternalGatePolicies(envelope);
            if (!result.ok) throw new Error(result.error.message);
            const executor = createStandaloneTaskExecutor();
            await dispatchTasksIfNeeded({
              orchestrator,
              taskExecutor: executor,
              tasks: result.data,
              logger,
              context: 'standalone.set-task-external-gate-policies',
            });
            return undefined;
          }
          default:
            throw new Error(`Unsupported GUI mutation for standalone owner: ${payload.channel}`);
        }
      };

      // In standalone owner mode, serve delegated requests from peer headless processes.
      if (standaloneMode && messageBus) {
        const standaloneOwnerIdleTimeoutMs = Number.parseInt(
          process.env.INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS ?? '2000',
          10,
        );
        let standaloneOwnerLastActivityAt = Date.now();
        const noteStandaloneOwnerActivity = (): void => {
          standaloneOwnerLastActivityAt = Date.now();
        };
        headlessDeps.isStandaloneOwnerIdle = () => {
          const idleForMs = Date.now() - standaloneOwnerLastActivityAt;
          if (idleForMs < standaloneOwnerIdleTimeoutMs) return false;
          const hasQueuedOrRunningMutations =
            persistence.listWorkflowMutationIntents(undefined, ['queued', 'running']).length > 0;
          if (hasQueuedOrRunningMutations) return false;
          return !orchestrator.getAllTasks().some(
            (task) => task.status === 'running' || task.status === 'fixing_with_ai',
          );
        };

        const classifyStandaloneHeadlessExecMutation = (
          payload: HeadlessExecMutationPayload,
        ): { workflowId?: string; priority: WorkflowMutationPriority } => {
          const [command, arg0] = payload.args;
          if (!command) return { priority: 'normal' };

          const standaloneWorkflowIdForTaskArg = (taskIdArg: unknown): string | undefined => {
            const taskId = String(taskIdArg);
            return orchestrator.getTask(taskId)?.config.workflowId;
          };

          switch (command) {
            case 'retry':
              return {
                workflowId: standaloneWorkflowIdForTaskArg(arg0) ?? (arg0 === undefined ? undefined : String(arg0)),
                priority: 'high',
              };
            case 'recreate':
            case 'cancel-workflow':
              return { workflowId: arg0 === undefined ? undefined : String(arg0), priority: 'high' };
            case 'rebase':
            case 'cancel':
            case 'recreate-task':
              return { workflowId: standaloneWorkflowIdForTaskArg(arg0), priority: 'high' };
            case 'approve':
            case 'reject':
            case 'select':
            case 'fix':
            case 'resolve-conflict':
              return { workflowId: standaloneWorkflowIdForTaskArg(arg0), priority: 'normal' };
            default:
              return { priority: 'normal' };
          }
        };

        const runStandaloneWorkflowMutation = async <T>(
          workflowId: string | undefined,
          priority: WorkflowMutationPriority,
          channel: string,
          args: unknown[],
          op: () => Promise<T>,
        ): Promise<T> => {
          if (!workflowId) return op();
          if (!workflowMutationCoordinator) {
            throw new Error('Workflow mutation coordinator is unavailable');
          }
          if (!workflowMutationDispatcher.has(channel)) {
            throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
          }
          return workflowMutationCoordinator.enqueue<T>(workflowId, priority, channel, args);
        };

        messageBus.onRequest('headless.run', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          const { planPath } = req as { planPath: string };
          await runHeadless(['run', planPath], {
            ...headlessDeps,
            waitForApproval: false,
            noTrack: true,
          });
          return { ok: true };
        });
        messageBus.onRequest('headless.owner-ping', async () => {
          noteStandaloneOwnerActivity();
          return {
            ok: true,
            ownerId: workflowMutationOwnerId,
            mode: 'standalone',
          };
        });
        messageBus.onRequest('headless.query', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          const { kind, reset } = req as { kind?: string; reset?: boolean };
          if (kind !== 'ui-perf') {
            throw new Error(`Unsupported headless query: ${String(kind)}`);
          }
          if (reset) {
            headlessDeps.resetUiPerfStats?.();
          }
          return {
            ownerMode: 'standalone',
            ...(headlessDeps.getUiPerfStats?.() ?? {}),
          };
        });
        messageBus.onRequest('headless.resume', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          const { workflowId } = req as { workflowId: string };
          await runHeadless(['resume', workflowId], {
            ...headlessDeps,
            waitForApproval: false,
            noTrack: true,
          });
          return { ok: true };
        });
        messageBus.onRequest('headless.exec', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          const { args, waitForApproval: delegatedWait, noTrack: delegatedNoTrack } =
            req as { args: string[]; waitForApproval?: boolean; noTrack?: boolean };
          if (!Array.isArray(args) || args.length === 0) {
            throw new Error('Missing delegated headless command arguments');
          }
          const payload: HeadlessExecMutationPayload = {
            args,
            waitForApproval: delegatedWait,
            noTrack: delegatedNoTrack,
          };
          const { workflowId, priority } = classifyStandaloneHeadlessExecMutation(payload);
          if (delegatedNoTrack && workflowId && workflowMutationCoordinator) {
            const intentId = workflowMutationCoordinator.submit(workflowId, priority, 'headless.exec', [payload], {
              deferDrain: true,
            });
            return { ok: true, intentId };
          }
          await runStandaloneWorkflowMutation(workflowId, priority, 'headless.exec', [payload], async () => {
            await runHeadless(args, {
              ...headlessDeps,
              waitForApproval: delegatedWait,
              noTrack: delegatedNoTrack,
            });
          });
          return { ok: true };
        });
      }

      await runHeadless(cliArgs, headlessDeps);
    } catch (err) {
      process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
      exitCode = 1;
    } finally {
      if (persistence) persistence.close();
      if (writerLock) writerLock.release();
      if (messageBus) messageBus.disconnect();
    }
    process.exit(exitCode);
  }).catch((err) => {
    process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
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
  let taskExecutor: TaskRunner | null = null;
  setDispatcherTaskExecutor(null);
  let apiServer: ApiServer | null = null;
  let ownerMode = true;
  const taskHandles = new Map<string, { handle: ExecutorHandle; executor: Executor }>();
  const launchingTasks = new Set<string>();
  const guiMutationHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  let dbPollInterval: ReturnType<typeof setInterval> | null = null;
  let activityPollInterval: ReturnType<typeof setInterval> | null = null;
  let uiPerfLogInterval: ReturnType<typeof setInterval> | null = null;
  const lastKnownTaskStates = new Map<string, string>();
  const deferredWorkflowLaunches = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    taskIds: string[];
    firstScheduledAtMs: number;
  }>();
  const cancelDeferredWorkflowLaunch = (workflowId: string, reason: string): void => {
    const pending = deferredWorkflowLaunches.get(workflowId);
    if (!pending) return;
    clearTimeout(pending.timer);
    deferredWorkflowLaunches.delete(workflowId);
    logger.info(
      `cancelled deferred runnable launch workflow="${workflowId}" reason="${reason}" tasks=[${pending.taskIds.join(',')}]`,
      { module: 'ipc-delegate' },
    );
  };
  const pendingOutputBuffers = new Map<string, string[]>();
  const outputFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingUiTaskDeltas: TaskDelta[] = [];
  let uiTaskDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastKnownWorkflowCount = 0;
  let lastActivityLogId = 0;
  let startupWorkflowId: string | null = null;
  let allWorkflowsHydrated = false;
  let backgroundHydrationStarted = false;
  let backgroundHydrationScheduled = false;
  let uiInteractive = false;
  let deferredStartupTriggered = false;
  const traceUiDeltaFlow = process.env.INVOKER_TRACE_UI_DELTA === '1';
  const traceDbPollPerTask = process.env.INVOKER_TRACE_DB_POLL === '1';
  const traceTaskOutput = process.env.INVOKER_TRACE_TASK_OUTPUT === '1';
  const runningHeartbeatTopupMs = Number.parseInt(
    process.env.INVOKER_RUNNING_HEARTBEAT_TOPUP_MS ?? '30000',
    10,
  ) || 30000;
  const launchingStallTimeoutMs = Number.parseInt(
    process.env.INVOKER_LAUNCHING_STALL_TIMEOUT_MS ?? '60000',
    10,
  ) || 60000;
  const uiPerfStats = {
    mainDeltaToUi: 0,
    dbPollCreated: 0,
    dbPollUpdatedAsCreated: 0,
    dbPollUpdatedAsUpdated: 0,
    rendererReports: 0,
    maxRendererEventLoopLagMs: 0,
    maxRendererLongTaskMs: 0,
  };
  const startupMarks = new Map<string, number>();
  const recordStartupMark = (phase: string, extra?: Record<string, unknown>): void => {
    const elapsedMs = Date.now() - appProcessStartedAt;
    startupMarks.set(phase, elapsedMs);
    const payload = {
      ts: new Date().toISOString(),
      metric: 'startup_phase',
      phase,
      elapsedMs,
      ...(extra ?? {}),
    };
    logger.info(`startup phase ${phase} elapsed=${elapsedMs}ms`, { module: 'startup' });
    try {
      persistence.writeActivityLog('startup-phase', 'info', JSON.stringify(payload));
    } catch {
      // best effort; db can be locked during startup
    }
  };

  const resetUiPerfStats = (): void => {
    uiPerfStats.mainDeltaToUi = 0;
    uiPerfStats.dbPollCreated = 0;
    uiPerfStats.dbPollUpdatedAsCreated = 0;
    uiPerfStats.dbPollUpdatedAsUpdated = 0;
    uiPerfStats.rendererReports = 0;
    uiPerfStats.maxRendererEventLoopLagMs = 0;
    uiPerfStats.maxRendererLongTaskMs = 0;
  };

  const getUiPerfStats = (): Record<string, unknown> => ({
    ...uiPerfStats,
    startupMarks: Object.fromEntries(startupMarks.entries()),
    ts: new Date().toISOString(),
  });

  const flushTaskOutput = (taskId: string): void => {
    const timer = outputFlushTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      outputFlushTimers.delete(taskId);
    }
    const chunks = pendingOutputBuffers.get(taskId);
    if (!chunks || chunks.length === 0) {
      return;
    }
    pendingOutputBuffers.delete(taskId);
    const data = chunks.join('');
    if (traceTaskOutput) {
      logger.info(`${taskId}: ${data.trimEnd()}`, { module: 'output' });
    }
    const outputData: TaskOutputData = { taskId, data };
    messageBus.publish(Channels.TASK_OUTPUT, outputData);
    try {
      persistence.appendTaskOutput(taskId, data);
      persistence.appendOutputChunk(taskId, data);
    } catch (err) {
      logger.error(`Failed to persist output for ${taskId}: ${err}`, { module: 'output' });
    }
  };

  const enqueueTaskOutput = (taskId: string, data: string): void => {
    const chunks = pendingOutputBuffers.get(taskId) ?? [];
    chunks.push(data);
    pendingOutputBuffers.set(taskId, chunks);
    if (outputFlushTimers.has(taskId)) {
      return;
    }
    const timer = setTimeout(() => flushTaskOutput(taskId), 100);
    timer.unref?.();
    outputFlushTimers.set(taskId, timer);
  };

  const flushUiTaskDeltas = (): void => {
    if (uiTaskDeltaFlushTimer) {
      clearTimeout(uiTaskDeltaFlushTimer);
      uiTaskDeltaFlushTimer = null;
    }
    if (!mainWindow || mainWindow.isDestroyed() || !uiInteractive || pendingUiTaskDeltas.length === 0) {
      pendingUiTaskDeltas.length = 0;
      return;
    }
    const batch = pendingUiTaskDeltas.splice(0, pendingUiTaskDeltas.length);
    if (batch.length === 1) {
      mainWindow.webContents.send('invoker:task-delta', batch[0]);
      return;
    }
    mainWindow.webContents.send('invoker:task-delta-batch', batch);
  };

  const sendTaskDeltaToRenderer = (delta: TaskDelta): void => {
    if (!mainWindow || mainWindow.isDestroyed() || !uiInteractive) {
      return;
    }
    pendingUiTaskDeltas.push(delta);
    if (uiTaskDeltaFlushTimer) {
      return;
    }
    uiTaskDeltaFlushTimer = setTimeout(() => flushUiTaskDeltas(), 25);
    uiTaskDeltaFlushTimer.unref?.();
  };

  const buildAutoFixQueueSnapshot = (taskId: string): Record<string, unknown> => {
    const workflowId = workflowIdForTaskArg(taskId);
    if (!workflowId) {
      return {
        workflowId: null,
        openIntentCountForWorkflow: 0,
        openFixIntentCountForWorkflow: 0,
        openFixIntentCountForTask: 0,
        openFixIntentForTask: false,
        openFixIntentHead: null,
        openFixIntentPreview: [],
      };
    }
    const openIntents = persistence.listWorkflowMutationIntents(workflowId, ['queued', 'running']);
    const openFixIntents = openIntents.filter((intent) => (
      intent.channel === 'invoker:fix-with-agent' || intent.channel === 'headless.exec'
    ));
    const openTaskFixIntents = listOpenFixIntentsForTask(openIntents, taskId);
    return {
      workflowId,
      openIntentCountForWorkflow: openIntents.length,
      openFixIntentCountForWorkflow: openFixIntents.length,
      openFixIntentCountForTask: openTaskFixIntents.length,
      openFixIntentForTask: openTaskFixIntents.length > 0,
      openFixIntentHead: openTaskFixIntents[0]
        ? {
          id: openTaskFixIntents[0].id,
          status: openTaskFixIntents[0].status,
          channel: openTaskFixIntents[0].channel,
        }
        : null,
      openFixIntentPreview: openTaskFixIntents.slice(0, 5).map((intent) => ({
        id: intent.id,
        status: intent.status,
        channel: intent.channel,
      })),
    };
  };

  const logAutoFixDebug = (
    taskId: string,
    phase: string,
    details: Record<string, unknown> = {},
  ): void => {
    const task = orchestrator.getTask(taskId);
    const payload = {
      phase,
      status: task?.status ?? 'missing',
      autoFixAttempts: task?.execution.autoFixAttempts ?? null,
      ...buildAutoFixQueueSnapshot(taskId),
      ...details,
    };
    persistence.logEvent?.(taskId, 'debug.auto-fix', payload);
    logger.info(
      `[auto-fix-debug] task="${taskId}" phase=${phase} payload=${JSON.stringify(payload)}`,
      { module: 'auto-fix' },
    );
  };

  const executeFixWithAgentMutation = async (
    taskId: string,
    agentName?: string,
    source: 'ipc' | 'auto-fix' = 'ipc',
  ): Promise<TaskState[]> => {
    logger.info(
      `fix-with-agent: "${taskId}" agent=${agentName ?? 'claude'} source=${source} route=fixWithAgent`,
      { module: 'ipc' },
    );
    if (source === 'auto-fix') {
      const dispatchDecision = getAutoFixDispatchDecision(orchestrator, taskId);
      if (!dispatchDecision.shouldDispatch) {
        logAutoFixDebug(taskId, 'dispatch-stale-skip', {
          reason: dispatchDecision.reason,
          status: dispatchDecision.status,
          autoFixAttempts: dispatchDecision.autoFixAttempts,
          dispositionReason: dispatchDecision.dispositionReason,
        });
        const skipOutput = buildAutoFixSkipOutput(
          orchestrator.getTask(taskId),
          dispatchDecision.reason,
          dispatchDecision.dispositionReason,
        );
        if (skipOutput) {
          persistence.appendTaskOutput(taskId, skipOutput);
        }
        return [];
      }
      const task = dispatchDecision.task;
      const attemptsBefore = task?.execution.autoFixAttempts ?? 0;
      const attemptsAfter = attemptsBefore + 1;
      persistence.updateTask(taskId, {
        execution: {
          autoFixAttempts: attemptsAfter,
        },
      });
      logAutoFixDebug(taskId, 'dispatch-attempt-bumped', { attemptsBefore, attemptsAfter });
    }
    const { savedError } = orchestrator.beginConflictResolution(taskId);
    try {
      const output = persistence.getTaskOutput(taskId);
      await requireTaskExecutor().fixWithAgent(taskId, output, agentName, savedError);
      const result = await finalizeAppliedFix(taskId, savedError, {
        orchestrator,
        taskExecutor: requireTaskExecutor(),
        autoApproveAIFixes: invokerConfig.autoApproveAIFixes,
      });
      return result.started;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorLabel = source === 'auto-fix' ? 'Auto-fix' : `Fix with ${agentName ?? 'Claude'}`;
      persistence.appendTaskOutput(taskId, `\n[${errorLabel}] Failed: ${msg}`);
      orchestrator.revertConflictResolution(taskId, savedError, msg);
      throw err;
    }
  };

  const scheduleAutoFix = (taskId: string): void => {
    logAutoFixDebug(taskId, 'schedule-enter');
    if (!workflowMutationCoordinator) {
      logAutoFixDebug(taskId, 'schedule-skip', { reason: 'no-workflow-mutation-coordinator' });
      return;
    }
    if (!workflowMutationDispatcher.has('invoker:fix-with-agent')) {
      logAutoFixDebug(taskId, 'schedule-skip', { reason: 'fix-handler-not-ready' });
      return;
    }
    const workflowId = workflowIdForTaskArg(taskId);
    if (!workflowId) {
      logAutoFixDebug(taskId, 'schedule-skip', { reason: 'workflow-not-found' });
      return;
    }
    const enqueueDecision = getAutoFixEnqueueDecision(orchestrator, persistence, workflowId, taskId);
    if (!enqueueDecision.shouldEnqueue) {
      logAutoFixDebug(taskId, 'schedule-skip', {
        reason: enqueueDecision.reason,
        status: enqueueDecision.status,
        existingIntentIds: enqueueDecision.existingIntentIds,
        dispositionReason: enqueueDecision.dispositionReason,
      });
      const skipOutput = buildAutoFixSkipOutput(
        orchestrator.getTask(taskId),
        enqueueDecision.reason,
        enqueueDecision.dispositionReason,
      );
      if (skipOutput) {
        persistence.appendTaskOutput(taskId, skipOutput);
      }
      return;
    }
    const configuredAgent = loadConfig().autoFixAgent?.trim();
    const selectedAgent = configuredAgent && configuredAgent.length > 0 ? configuredAgent : undefined;
    logAutoFixDebug(taskId, 'schedule-enqueue');
    logAutoFixDebug(taskId, 'schedule-enqueued');
    void runWorkflowMutation(
      workflowId,
      'normal',
      'invoker:fix-with-agent',
      [taskId, selectedAgent],
      async () => executeFixWithAgentMutation(taskId, selectedAgent, 'auto-fix'),
    )
      .then(() => {
        logAutoFixDebug(taskId, 'schedule-dispatch-finished');
      })
      .catch((err) => {
        logAutoFixDebug(taskId, 'schedule-dispatch-error', {
          error: err instanceof Error ? err.stack ?? err.message : String(err),
        });
      });
  };

  const parseExecutionDate = (value: unknown): Date | undefined => {
    if (!value) return undefined;
    if (value instanceof Date) return value;
    if (typeof value !== 'string') return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
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
          enqueueTaskOutput(taskId, data);
        },
        onLaunchStart: (taskId, executor) => {
          launchingTasks.add(taskId);
          logger.info(`Task "${taskId}" launch started (executor: ${executor.type})`, { module: 'exec' });
        },
        onLaunchFailed: (taskId, error, executor) => {
          launchingTasks.delete(taskId);
          logger.error(
            `Task "${taskId}" launch failed before spawn (executor: ${executor.type}): ${error.message}`,
            { module: 'exec' },
          );
        },
        onSpawned: (taskId, handle, executor) => {
          launchingTasks.delete(taskId);
          flushTaskOutput(taskId);
          logger.info(
            `Task "${taskId}" spawned (handle: ${handle.executionId}, executor: ${executor.type}, workspace: ${handle.workspacePath ?? 'none'}, branch: ${handle.branch ?? 'none'})`,
            { module: 'exec' },
          );
          taskHandles.set(taskId, { handle, executor });
        },
        onComplete: (taskId, response) => {
          flushTaskOutput(taskId);
          logger.info(
            `Task "${taskId}" completion callback received (status: ${response.status}, generation: ${response.executionGeneration}, exitCode: ${response.outputs.exitCode ?? 'none'})`,
            { module: 'exec' },
          );
        },
        onHeartbeat: (taskId) => {
          const now = new Date();
          const task = orchestrator.getTask(taskId);
          const previousHeartbeat = task?.execution.lastHeartbeatAt instanceof Date
            ? task.execution.lastHeartbeatAt
            : task?.execution.lastHeartbeatAt
              ? new Date(task.execution.lastHeartbeatAt)
              : undefined;
          const heartbeatGapMs = previousHeartbeat ? now.getTime() - previousHeartbeat.getTime() : undefined;
          try { persistence.updateTask(taskId, { execution: { lastHeartbeatAt: now } }); } catch { /* db locked */ }
          messageBus.publish(Channels.TASK_DELTA, {
            type: 'updated' as const,
            taskId,
            changes: { execution: { lastHeartbeatAt: now } },
          });
          logger.info(
            `Heartbeat for "${taskId}" (status: ${task?.status ?? 'unknown'}, generation: ${task?.execution.generation ?? 'unknown'}, gapMs: ${heartbeatGapMs ?? 'first'})`,
            { module: 'heartbeat' },
          );
        },
      },
    });
    setDispatcherTaskExecutor(taskExecutor);
    wireApproveHook();
  }

  function wireApproveHook(): void {
    orchestrator.setBeforeApproveHook(async (task) => {
      if (task.config.isMergeNode && task.config.workflowId && task.execution.pendingFixError === undefined) {
        const workflow = persistence.loadWorkflow(task.config.workflowId);
        if (workflow?.mergeMode === "external_review") return; // external review is the merge mechanism
        await requireTaskExecutor().approveMerge(task.config.workflowId);
      }
    });
  }

  async function killRunningTask(taskId: string): Promise<void> {
    const entry = taskHandles.get(taskId);
    if (!entry) return;
    logger.info(`Killing running task "${taskId}" before restart`, { module: 'kill' });
    await entry.executor.kill(entry.handle);
    taskHandles.delete(taskId);
  }

  /** Cancel a task and cascade-kill all downstream DAG dependents. Shared by IPC, headless, and API. */
  async function performCancelTask(taskId: string): Promise<{ cancelled: string[]; runningCancelled: string[] }> {
    const envelope = makeEnvelope('cancel-task', 'ui', 'task', { taskId });
    const cmdResult = await commandService.cancelTask(envelope);
    if (!cmdResult.ok) throw new Error(cmdResult.error.message);
    for (const id of cmdResult.data.runningCancelled) {
      await killRunningTask(id);
    }
    return cmdResult.data;
  }

  /** Cancel all active tasks in a workflow and kill any running processes. */
  async function performCancelWorkflow(workflowId: string): Promise<{ cancelled: string[]; runningCancelled: string[] }> {
    logger.info(`performCancelWorkflow begin workflow="${workflowId}"`, { module: 'kill' });
    const envelope = makeEnvelope('cancel-workflow', 'ui', 'workflow', { workflowId });
    const cmdResult = await commandService.cancelWorkflow(envelope);
    if (!cmdResult.ok) throw new Error(cmdResult.error.message);
    logger.info(
      `performCancelWorkflow commandService complete workflow="${workflowId}" cancelled=${cmdResult.data.cancelled.length} runningCancelled=${cmdResult.data.runningCancelled.length}`,
      { module: 'kill' },
    );
    for (const id of cmdResult.data.runningCancelled) {
      logger.info(`performCancelWorkflow killing running task "${id}"`, { module: 'kill' });
      await killRunningTask(id);
    }
    logger.info(`performCancelWorkflow end workflow="${workflowId}"`, { module: 'kill' });
    return cmdResult.data;
  }

  async function preemptTaskSubgraph(taskId: string): Promise<void> {
    try {
      await performCancelTask(taskId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already completed') || message.includes('already stale')) {
        logger.info(`preemptTaskSubgraph skipped for "${taskId}": ${message}`, { module: 'ipc' });
        return;
      }
      throw err;
    }
  }

  async function preemptWorkflowExecution(workflowId: string): Promise<WorkflowCancelResult> {
    try {
      logger.info(`preemptWorkflowExecution begin for "${workflowId}"`, { module: 'ipc' });
      const result = await performCancelWorkflow(workflowId);
      logger.info(`preemptWorkflowExecution end for "${workflowId}"`, { module: 'ipc' });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('No tasks found for workflow')) {
        logger.info(`preemptWorkflowExecution skipped for "${workflowId}": ${message}`, { module: 'ipc' });
        return { cancelled: [], runningCancelled: [] };
      }
      throw err;
    }
  }

  function requireTaskExecutor(): TaskRunner {
    if (!taskExecutor) {
      throw new Error('Mutation execution is unavailable in read-only follower mode');
    }
    return taskExecutor;
  }

  async function executeHeadlessRun(payload: HeadlessRunMutationPayload): Promise<unknown> {
    const { parsePlanFile } = await import('./plan-parser.js');
    const plan = await parsePlanFile(payload.planPath);
    taskHandles.clear();
    backupPlan(plan, undefined, logger);
    const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
    orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
    const workflowId = orchestrator.getWorkflowIds().find(id => !wfIdsBefore.has(id))!;
    const started = orchestrator.startExecution();
    logger.info(`started ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
    const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
    return { workflowId, tasks };
  }

  async function executeHeadlessResume(payload: HeadlessResumeMutationPayload): Promise<unknown> {
    const { workflowId } = payload;
    orchestrator.syncFromDb(workflowId);

    const allStarted = relaunchOrphansAndStartReady(orchestrator, logger, 'ipc-delegate', workflowId);
    if (allStarted.length > 0) {
      dispatchTasksIfNeeded({
        orchestrator,
        taskExecutor: requireTaskExecutor() as TaskRunner,
        tasks: allStarted,
        logger,
        context: 'ipc-delegate.headless.resume',
      }).catch(err => {
        logger.error(`headless.resume: executeTasks failed for "${workflowId}": ${err}`, { module: 'ipc-delegate' });
      });
    }
    requireTaskExecutor().resumeMergeGatePolling();
    const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
    return { workflowId, tasks };
  }

  async function executeHeadlessExec(payload: HeadlessExecMutationPayload): Promise<unknown> {
    logger.info(`executeHeadlessExec begin args="${payload.args.join(' ')}" noTrack=${payload.noTrack ? 'true' : 'false'}`, {
      module: 'ipc-delegate',
    });
    const headlessCommand = String(payload.args[0] ?? '');
    const headlessTarget = String(payload.args[1] ?? '');
    if (
      (headlessCommand === 'recreate' || headlessCommand === 'retry')
      && /^wf-[^/]+$/.test(headlessTarget)
    ) {
      cancelDeferredWorkflowLaunch(headlessTarget, `headless.${headlessCommand}`);
    }
    await runHeadless(payload.args, {
      logger,
      orchestrator, persistence, executorRegistry, messageBus,
      commandService,
      repoRoot, invokerConfig, initServices, wireSlackBot,
      setTaskDispatcherExecutor: setDispatcherTaskExecutor,
      waitForApproval: payload.waitForApproval,
      noTrack: payload.noTrack,
      preemptTaskSubgraph: (taskId: string) => preemptTaskSubgraph(taskId),
      preemptWorkflowExecution: (workflowId: string) => preemptWorkflowExecution(workflowId),
      deferRunnableTasks: (tasks: TaskState[], workflowId?: string) => {
        const filteredTasks = tasks;
        const crossWorkflowTasks = workflowId
          ? tasks.filter((task) => task.config.workflowId !== workflowId)
          : [];
        if (crossWorkflowTasks.length > 0) {
          logger.info(
            `deferRunnableTasks dispatching cross-workflow runnable tasks for workflow="${workflowId}": ${crossWorkflowTasks.map((task) => `${task.id}(${task.config.workflowId ?? 'unknown'})`).join(', ')}`,
            { module: 'ipc-delegate' },
          );
        }
        if (filteredTasks.length === 0) {
          return;
        }
        // Keep this path timer-based for now: it is a low-blast-radius, mutation-safe
        // way to decouple no-track command handling from heavy executor startup while
        // still coalescing rapid restarts. We are considering an RxJS/backpressure
        // scheduler refactor for richer queue semantics, but that is a broader design
        // change than this targeted starvation fix.
        const deferDelayMs = Number.parseInt(process.env.INVOKER_DEFER_RUNNABLE_DELAY_MS ?? '25', 10) || 25;
        const maxCoalesceMs = Number.parseInt(
          process.env.INVOKER_DEFER_RUNNABLE_MAX_COALESCE_MS ?? String(Math.max(1000, deferDelayMs)),
          10,
        ) || Math.max(1000, deferDelayMs);
        const launchKey = workflowId ?? filteredTasks.map((task) => task.id).sort().join('|');
        const existingLaunch = deferredWorkflowLaunches.get(launchKey);
        const nowMs = Date.now();
        const timing = computeDeferredLaunchTiming({
          existingFirstScheduledAtMs: existingLaunch?.firstScheduledAtMs,
          nowMs,
          deferDelayMs,
          maxCoalesceMs,
        });
        if (existingLaunch) {
          clearTimeout(existingLaunch.timer);
          logger.info(
            `deferRunnableTasks coalesce workflow="${workflowId ?? 'unknown'}" previousCount=${existingLaunch.taskIds.length} nextCount=${filteredTasks.length} delayMs=${timing.delayMs} maxCoalesceMs=${maxCoalesceMs}`,
            { module: 'ipc-delegate' },
          );
        }
        logger.info(
          `deferRunnableTasks schedule workflow="${workflowId ?? 'unknown'}" count=${filteredTasks.length} delayMs=${timing.delayMs} ids=${filteredTasks.map((task) => task.id).join(',')}`,
          { module: 'ipc-delegate' },
        );
        const launch = setTimeout(() => {
          deferredWorkflowLaunches.delete(launchKey);
          logger.info(
            `deferRunnableTasks start workflow="${workflowId ?? 'unknown'}" count=${filteredTasks.length}`,
            { module: 'ipc-delegate' },
          );
          remoteFetchForPool.enabled = false;
          void requireTaskExecutor().executeTasks(filteredTasks)
            .then(() => {
              logger.info(
                `deferRunnableTasks complete workflow="${workflowId ?? 'unknown'}" count=${filteredTasks.length}`,
                { module: 'ipc-delegate' },
              );
            })
            .catch((err) => {
              logger.error(
                `background delegated workflow execution failed for ${workflowId ?? filteredTasks.map((t) => t.id).join(', ')}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
                { module: 'ipc-delegate' },
              );
            })
            .finally(() => {
              remoteFetchForPool.enabled = true;
            });
        }, timing.delayMs);
        launch.unref?.();
        deferredWorkflowLaunches.set(launchKey, {
          timer: launch,
          taskIds: filteredTasks.map((task) => task.id),
          firstScheduledAtMs: timing.firstScheduledAtMs,
        });
      },
      executionAgentRegistry: registerBuiltinAgents(),
    });
    logger.info(`executeHeadlessExec end args="${payload.args.join(' ')}"`, { module: 'ipc-delegate' });
    return { ok: true };
  }

  function workflowIdForTaskArg(taskIdArg: unknown): string | undefined {
    const taskId = String(taskIdArg);
    return orchestrator.getTask(taskId)?.config.workflowId;
  }

  function classifyHeadlessExecMutation(payload: HeadlessExecMutationPayload): {
    workflowId?: string;
    priority: WorkflowMutationPriority;
  } {
    const [command, arg0] = payload.args;
    if (!command) return { priority: 'normal' };

    switch (command) {
      case 'retry':
        return { workflowId: workflowIdForTaskArg(arg0) ?? (arg0 === undefined ? undefined : String(arg0)), priority: 'high' };
      case 'recreate':
      case 'cancel-workflow':
        return { workflowId: arg0, priority: 'high' };
      case 'rebase':
      case 'cancel':
      case 'recreate-task':
        return { workflowId: workflowIdForTaskArg(arg0), priority: 'high' };
      case 'approve':
      case 'reject':
      case 'select':
      case 'fix':
      case 'resolve-conflict':
        return { workflowId: workflowIdForTaskArg(arg0), priority: 'normal' };
      default:
        return { priority: 'normal' };
    }
  }

  async function runWorkflowMutation<T>(
    workflowId: string | undefined,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
    op: () => Promise<T>,
  ): Promise<T> {
    if (!workflowId) return op();
    if (!workflowMutationCoordinator) {
      throw new Error('Workflow mutation coordinator is unavailable');
    }
    if (!workflowMutationDispatcher.has(channel)) {
      throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
    }
    return workflowMutationCoordinator.enqueue<T>(workflowId, priority, channel, args);
  }

  function translateGuiMutationToHeadless(payload: GuiMutationPayload):
    | { channel: 'headless.run'; request: HeadlessRunMutationPayload }
    | { channel: 'headless.resume'; request: HeadlessResumeMutationPayload }
    | { channel: 'headless.exec'; request: HeadlessExecMutationPayload }
    | null {
    const [arg0, arg1, arg2] = payload.args;
    switch (payload.channel) {
      case 'invoker:stop':
        return { channel: 'headless.exec', request: { args: ['stop'] } };
      case 'invoker:clear':
        return { channel: 'headless.exec', request: { args: ['clear'] } };
      case 'invoker:resume-workflow': {
        const workflows = persistence.listWorkflows();
        const workflowId = workflows[0]?.id;
        if (!workflowId) return null;
        return { channel: 'headless.resume', request: { workflowId } };
      }
      case 'invoker:delete-all-workflows':
        return { channel: 'headless.exec', request: { args: ['delete-all'] } };
      case 'invoker:delete-workflow':
        return { channel: 'headless.exec', request: { args: ['delete', String(arg0)] } };
      case 'invoker:provide-input':
        return { channel: 'headless.exec', request: { args: ['input', String(arg0), String(arg1)] } };
      case 'invoker:approve':
        return { channel: 'headless.exec', request: { args: ['approve', String(arg0)] } };
      case 'invoker:reject':
        return arg1 === undefined
          ? { channel: 'headless.exec', request: { args: ['reject', String(arg0)] } }
          : { channel: 'headless.exec', request: { args: ['reject', String(arg0), String(arg1)] } };
      case 'invoker:select-experiment':
        if (Array.isArray(arg1)) return null;
        return { channel: 'headless.exec', request: { args: ['select', String(arg0), String(arg1)] } };
      case 'invoker:restart-task':
        return { channel: 'headless.exec', request: { args: ['retry-task', String(arg0)] } };
      case 'invoker:cancel-task':
        return { channel: 'headless.exec', request: { args: ['cancel', String(arg0)] } };
      case 'invoker:cancel-workflow':
        return { channel: 'headless.exec', request: { args: ['cancel-workflow', String(arg0)] } };
      case 'invoker:recreate-workflow':
        return { channel: 'headless.exec', request: { args: ['recreate', String(arg0)] } };
      case 'invoker:recreate-task':
        return { channel: 'headless.exec', request: { args: ['recreate-task', String(arg0)] } };
      case 'invoker:retry-workflow':
        return { channel: 'headless.exec', request: { args: ['retry', String(arg0)] } };
      case 'invoker:rebase-and-retry':
        return { channel: 'headless.exec', request: { args: ['rebase', String(arg0)] } };
      case 'invoker:set-merge-mode':
        return { channel: 'headless.exec', request: { args: ['set', 'merge-mode', String(arg0), String(arg1)] } };
      case 'invoker:approve-merge': {
        const workflowId = String(arg0);
        const mergeTask = persistence.loadTasks(workflowId).find((task) => task.config.isMergeNode);
        if (!mergeTask) return null;
        return { channel: 'headless.exec', request: { args: ['approve', mergeTask.id] } };
      }
      case 'invoker:resolve-conflict':
        return arg1 === undefined
          ? { channel: 'headless.exec', request: { args: ['resolve-conflict', String(arg0)] } }
          : { channel: 'headless.exec', request: { args: ['resolve-conflict', String(arg0), String(arg1)] } };
      case 'invoker:fix-with-agent':
        return arg1 === undefined
          ? { channel: 'headless.exec', request: { args: ['fix', String(arg0)] } }
          : { channel: 'headless.exec', request: { args: ['fix', String(arg0), String(arg1)] } };
      case 'invoker:edit-task-command':
        return { channel: 'headless.exec', request: { args: ['set', 'command', String(arg0), String(arg1)] } };
      case 'invoker:edit-task-type':
        return { channel: 'headless.exec', request: { args: ['set', 'executor', String(arg0), String(arg1)] } };
      case 'invoker:edit-task-agent':
        return { channel: 'headless.exec', request: { args: ['set', 'agent', String(arg0), String(arg1)] } };
      case 'invoker:set-task-external-gate-policies': {
        const taskId = String(arg0);
        const updates = Array.isArray(arg1) ? arg1 as Array<{ workflowId: string; taskId?: string; gatePolicy: 'completed' | 'review_ready' }> : [];
        if (updates.length !== 1) return null;
        const update = updates[0];
        if (!update) return null;
        const args = ['set', 'gate-policy', taskId, update.workflowId];
        if (update.taskId) args.push(update.taskId);
        args.push(update.gatePolicy);
        return { channel: 'headless.exec', request: { args } };
      }
      default:
        return null;
    }
  }

  async function performSharedApproveTask(
    taskId: string,
    source: 'ui' | 'surface' | 'api',
    scope: 'task' | 'workflow' = 'task',
  ): Promise<{ started: TaskState[] }> {
    const envelope = makeEnvelope('approve', source === 'api' ? 'surface' : source, scope, { taskId });
    return sharedApproveTask(taskId, {
      orchestrator,
      taskExecutor: requireTaskExecutor(),
      approve: async (approvedTaskId) => {
        const result = await commandService.approve({ ...envelope, payload: { taskId: approvedTaskId } });
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
      resumeAfterFixApproval: async (approvedTaskId) => {
        const result = await commandService.resumeTaskAfterFixApproval({ ...envelope, payload: { taskId: approvedTaskId } });
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
    });
  }

  function registerGuiMutationHandler<TResult = unknown>(
    channel: string,
    handler: (...args: unknown[]) => Promise<TResult>,
  ): void {
    guiMutationHandlers.set(channel, handler as (...args: unknown[]) => Promise<unknown>);
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      if (ownerMode) {
        return handler(...args);
      }
      const translated = translateGuiMutationToHeadless({ channel, args });
      if (!translated) {
        throw new Error(`No owner delegation route is available for ${channel}`);
      }
      try {
        return await messageBus.request<typeof translated.request, TResult>(translated.channel, translated.request);
      } catch (err) {
        if (err instanceof Error && err.message.includes('No request handler registered for channel')) {
          throw new Error('No mutation owner is available');
        }
        throw err;
      }
    });
  }

  function registerWorkflowScopedGuiMutationHandler<TResult = unknown>(
    channel: string,
    resolveWorkflowId: (...args: unknown[]) => string | undefined,
    priority: WorkflowMutationPriority,
    handler: (...args: unknown[]) => Promise<TResult>,
  ): void {
    workflowMutationDispatcher.set(channel, (...args: unknown[]) => handler(...args));
    registerGuiMutationHandler(channel, async (...args: unknown[]) => {
      const workflowId = resolveWorkflowId(...args);
      return runWorkflowMutation(workflowId, priority, channel, args, () => handler(...args));
    });
  }

  function createWindow(): void {
    recordStartupMark('createWindow.begin');
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      // Show explicitly after load/timeout rather than relying on Electron's
      // implicit initial map behavior, which has regressed on some Linux/X11
      // sessions and leaves the BrowserWindow unmapped.
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
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

    mainWindow.webContents.on('did-finish-load', () => {
      logger.info('main window did-finish-load', { module: 'window' });
      recordStartupMark('window.did-finish-load');
    });

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      logger.error(
        `main window did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`,
        { module: 'window' },
      );
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      logger.error(
        `main window render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`,
        { module: 'window' },
      );
    });

    const shouldShowWindow = process.env.NODE_ENV !== 'test' || enableTestCompositor;
    if (shouldShowWindow) {
      let showTriggered = false;
      const showWindow = (): void => {
        if (!mainWindow || mainWindow.isDestroyed() || showTriggered) return;
        showTriggered = true;
        logger.info('main window show()', { module: 'window' });
        recordStartupMark('window.show');
        mainWindow.show();
        mainWindow.focus();
        uiInteractive = true;
        recordStartupMark('ui.interactive');
        startDeferredStartupWork();
      };

      mainWindow.once('ready-to-show', showWindow);
      setTimeout(showWindow, 1500).unref?.();
    } else {
      uiInteractive = true;
      recordStartupMark('ui.interactive');
      startDeferredStartupWork();
    }

    mainWindow.on('closed', () => {
      logger.info('main window closed', { module: 'window' });
      mainWindow = null;
    });

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

  function seedUiSnapshotCache(): void {
    lastKnownWorkflowCount = persistence.listWorkflows().length;
    lastKnownTaskStates.clear();
    for (const task of orchestrator.getAllTasks()) {
      lastKnownTaskStates.set(task.id, JSON.stringify(task));
    }
  }

  function listWorkflowsByStartupRecency() {
    return [...persistence.listWorkflows()].sort((left, right) => {
      const rightTs = Date.parse(right.updatedAt ?? '') || 0;
      const leftTs = Date.parse(left.updatedAt ?? '') || 0;
      if (rightTs !== leftTs) {
        return rightTs - leftTs;
      }
      return right.createdAt.localeCompare(left.createdAt);
    });
  }

  function bootstrapInitialWorkflowState(): void {
    const workflows = listWorkflowsByStartupRecency();
    lastKnownWorkflowCount = workflows.length;
    startupWorkflowId = workflows[0]?.id ?? null;
    allWorkflowsHydrated = workflows.length <= 1;
    if (!startupWorkflowId) {
      logger.info('[init] No workflows available for initial startup bootstrap', { module: 'init' });
      return;
    }
    try {
      orchestrator.syncFromDb(startupWorkflowId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`workflow invariant violation during initial workflow bootstrap: ${message}`, {
        module: 'init',
        error: message,
        workflowId: startupWorkflowId,
      });
      throw err;
    }
    logger.info(
      `[init] Bootstrapped startup workflow "${startupWorkflowId}" with ${orchestrator.getAllTasks().length} tasks (${workflows.length} workflows total)`,
      { module: 'init' },
    );
    recordStartupMark('startup.initial-workflow.ready', {
      workflowId: startupWorkflowId,
      taskCount: orchestrator.getAllTasks().length,
      workflowCount: workflows.length,
    });
  }

  function publishOrchestratorSnapshotToRenderer(): void {
    const workflows = persistence.listWorkflows();
    const tasks = orchestrator.getAllTasks();
    const previousTaskIds = new Set(lastKnownTaskStates.keys());
    lastKnownTaskStates.clear();
    for (const task of tasks) {
      const snapshot = JSON.stringify(task);
      previousTaskIds.delete(task.id);
      lastKnownTaskStates.set(task.id, snapshot);
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendTaskDeltaToRenderer({ type: 'created', task });
      }
    }
    lastKnownWorkflowCount = workflows.length;
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const removedTaskId of previousTaskIds) {
        sendTaskDeltaToRenderer({ type: 'removed', taskId: removedTaskId });
      }
      mainWindow.webContents.send('invoker:workflows-changed', workflows);
    }
  }

  function startBackgroundHydration(reason: string): void {
    if (backgroundHydrationStarted || backgroundHydrationScheduled || allWorkflowsHydrated) {
      return;
    }
    const hydrateDelayMs = Number.parseInt(process.env.INVOKER_BACKGROUND_HYDRATE_DELAY_MS ?? '10000', 10) || 10000;
    backgroundHydrationScheduled = true;
    setTimeout(() => {
      backgroundHydrationScheduled = false;
      backgroundHydrationStarted = true;
      const workflows = listWorkflowsByStartupRecency();
      const remainingWorkflowIds = workflows
        .map((workflow) => workflow.id)
        .filter((workflowId) => workflowId !== startupWorkflowId);
      if (remainingWorkflowIds.length === 0) {
        allWorkflowsHydrated = true;
        backgroundHydrationStarted = false;
        recordStartupMark('background-hydration.end', {
          reason,
          workflowCount: workflows.length,
          taskCount: orchestrator.getAllTasks().length,
        });
        return;
      }
      try {
        recordStartupMark('background-hydration.start', {
          reason,
          startupWorkflowId,
          remainingWorkflowCount: remainingWorkflowIds.length,
        });
      } catch (err) {
        backgroundHydrationStarted = false;
        logger.error(
          `background hydration failed before scheduling: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
          { module: 'init' },
        );
        return;
      }

      const hydrateNext = (index: number): void => {
        if (index >= remainingWorkflowIds.length) {
          allWorkflowsHydrated = true;
          backgroundHydrationStarted = false;
          if (ownerMode && !invokerConfig.disableAutoRunOnStartup) {
            const newlyStarted = relaunchOrphansAndStartReady(orchestrator, logger, 'background-hydration');
            if (newlyStarted.length > 0) {
              void dispatchTasksIfNeeded({
                orchestrator,
                taskExecutor: requireTaskExecutor(),
                tasks: newlyStarted,
                logger,
                context: 'background-hydration',
              });
            }
            requireTaskExecutor().resumeMergeGatePolling();
          }
          publishOrchestratorSnapshotToRenderer();
          recordStartupMark('background-hydration.end', {
            reason,
            workflowCount: workflows.length,
            taskCount: orchestrator.getAllTasks().length,
          });
          return;
        }

        const workflowId = remainingWorkflowIds[index];
        try {
          orchestrator.hydrateWorkflowFromDb(workflowId);
          recordStartupMark('background-hydration.workflow', {
            workflowId,
            index: index + 1,
            total: remainingWorkflowIds.length,
          });
        } catch (err) {
          backgroundHydrationStarted = false;
          logger.error(
            `background hydration failed for workflow "${workflowId}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
            { module: 'init' },
          );
          return;
        }

        setTimeout(() => hydrateNext(index + 1), 0).unref?.();
      };

      hydrateNext(0);
    }, hydrateDelayMs).unref?.();
  }

  function startDeferredStartupWork(): void {
    if (deferredStartupTriggered) return;
    deferredStartupTriggered = true;
    recordStartupMark('deferred-startup.begin');
    const startupPollDelayMs = Number.parseInt(process.env.INVOKER_STARTUP_POLL_DELAY_MS ?? '10000', 10) || 10000;

    setTimeout(() => {
      if (!ownerMode) return;

      apiServer = startApiServer({
        logger,
        orchestrator,
        persistence,
        executorRegistry,
        taskExecutor: requireTaskExecutor(),
        autoApproveAIFixes: invokerConfig.autoApproveAIFixes,
        approveTaskAction: async (taskId: string) => {
          const workflowId = orchestrator.getTask(taskId)?.config.workflowId;
          return runWorkflowMutation(workflowId, 'normal', 'api:approve-task', [taskId], async () => {
            const { started } = await performSharedApproveTask(taskId, 'api');
            await finalizeMutationWithGlobalTopup({
              orchestrator,
              taskExecutor: requireTaskExecutor(),
              logger,
              context: 'api.tasks.approve',
              started,
            });
            return { started };
          });
        },
        killRunningTask,
        cancelTask: performCancelTask,
        cancelWorkflow: performCancelWorkflow,
      });
      recordStartupMark('api-server.started');

      if (ownerMode && workflowMutationCoordinator) {
        try {
          persistence.requeueExpiredWorkflowMutationLeases();
          logger.info('requeued expired workflow mutation leases on startup', { module: 'init' });
        } catch (err) {
          logger.error(
            `requeueExpiredWorkflowMutationLeases failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
            { module: 'init' },
          );
        }
        if (process.env.INVOKER_RESUME_WORKFLOW_MUTATIONS_ON_STARTUP === '1') {
          void (async () => {
            try {
              await maybeDelayWorkflowResumeForTest();
              await workflowMutationCoordinator.resumePending();
            } catch (err) {
              logger.error(
                `resumePending failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
                { module: 'init' },
              );
            }
          })();
        } else {
          logger.info('startup workflow mutation drain deferred; queued intents remain durable until explicit activity', {
            module: 'init',
          });
        }
      }

      startSlackBot(requireTaskExecutor(), taskHandles).catch((err) => {
        logger.info(`Not started: ${err instanceof Error ? err.message : String(err)}`, { module: 'slack' });
      });

      setTimeout(() => {
        dbPollInterval = setInterval(() => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          try {
            const workflows = persistence.listWorkflows();

            if (workflows.length !== lastKnownWorkflowCount) {
              const msg = `Workflow count changed: ${lastKnownWorkflowCount} → ${workflows.length}`;
              logger.info(msg, { module: 'db-poll' });
              try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
              lastKnownWorkflowCount = workflows.length;
              mainWindow.webContents.send('invoker:workflows-changed', workflows);

              if (allWorkflowsHydrated) {
                orchestrator.syncAllFromDb();
                logger.info(`Synced orchestrator for all ${workflows.length} workflows`, { module: 'db-poll' });
              }
            }

            for (const wf of workflows) {
              if (wf.status === 'completed' || wf.status === 'failed') continue;
              const tasks = persistence.loadTasks(wf.id);
              for (const loadedTask of tasks) {
                let task = loadedTask;
                const now = new Date();
                const previousHeartbeat = parseExecutionDate(task.execution.lastHeartbeatAt);

                if (task.status === 'running') {
                  if (!previousHeartbeat || now.getTime() - previousHeartbeat.getTime() >= runningHeartbeatTopupMs) {
                    persistence.updateTask(task.id, { execution: { lastHeartbeatAt: now } });
                    messageBus.publish(Channels.TASK_DELTA, {
                      type: 'updated' as const,
                      taskId: task.id,
                      changes: { execution: { lastHeartbeatAt: now } },
                    });
                    task = {
                      ...task,
                      execution: {
                        ...task.execution,
                        lastHeartbeatAt: now,
                      },
                    };
                  }

                  const launchStartedAt = parseExecutionDate(task.execution.launchStartedAt)
                    ?? parseExecutionDate(task.execution.startedAt);
                  const launchAgeMs = launchStartedAt ? now.getTime() - launchStartedAt.getTime() : 0;
                  const launchStalled =
                    task.execution.phase === 'launching'
                    && launchStartedAt !== undefined
                    && launchAgeMs >= launchingStallTimeoutMs
                    && !taskHandles.has(task.id)
                    && !launchingTasks.has(task.id);
                  if (launchStalled) {
                    const launchError =
                      `Launch stalled: task remained in running/launching for ${Math.floor(launchingStallTimeoutMs / 1000)}s without a spawned execution handle`;
                    logger.info(
                      `[launch-stall] detected task="${task.id}" phase=${task.execution.phase} launchAgeMs=${launchAgeMs} handlePresent=false`,
                      { module: 'db-poll' },
                    );
                    const failedResponse: WorkResponse = {
                      requestId: `launch-stall-${task.id}-${now.getTime()}`,
                      actionId: task.id,
                      attemptId: task.execution.selectedAttemptId,
                      executionGeneration: task.execution.generation ?? 0,
                      status: 'failed',
                      outputs: {
                        exitCode: 1,
                        error: launchError,
                      },
                    };
                    logger.error(`[launch-stall] forcing failure for "${task.id}": ${launchError}`, { module: 'db-poll' });
                    orchestrator.handleWorkerResponse(failedResponse);
                    continue;
                  }
                }

                const snapshot = JSON.stringify(task);
                const prev = lastKnownTaskStates.get(task.id);
                if (!prev) {
                  if (traceDbPollPerTask) {
                    const msg = `New task: ${task.id} (${task.status})`;
                    logger.info(msg, { module: 'db-poll' });
                    try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
                  }
                  lastKnownTaskStates.set(task.id, snapshot);
                  uiPerfStats.dbPollCreated += 1;
                  sendTaskDeltaToRenderer({ type: 'created', task });
                } else if (prev !== snapshot) {
                  if (traceDbPollPerTask) {
                    const msg = `Task updated: ${task.id} (${task.status})`;
                    logger.info(msg, { module: 'db-poll' });
                    try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
                  }
                  lastKnownTaskStates.set(task.id, snapshot);
                  uiPerfStats.dbPollUpdatedAsCreated += 1;
                  sendTaskDeltaToRenderer({ type: 'created', task });
                }
              }
            }
          } catch {
            // DB might be locked — skip this tick
          }
        }, 2000);

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
      }, startupPollDelayMs).unref?.();
    }, 0);
  }

  app.whenReady().then(async () => {
    recordStartupMark('app.whenReady');
    ownerMode = true;
    try {
      recordStartupMark('initServices.start');
      await initServices({ executionAgentRegistry: agentRegistry, startupSyncMode: 'none' });
      recordStartupMark('initServices.end', { ownerMode: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('[db-writer-lock]')) {
        process.stderr.write(`${RED}Error:${RESET} ${message}\n`);
        app.quit();
        return;
      }
      recordStartupMark('initServices.readOnly.start');
      await initServices({ readOnly: true, executionAgentRegistry: agentRegistry, startupSyncMode: 'none' });
      ownerMode = false;
      recordStartupMark('initServices.readOnly.end', { ownerMode: false });
    }

    if (ownerMode) {
      rebuildTaskRunner();
      workflowMutationCoordinator = new PersistedWorkflowMutationCoordinator(
        persistence,
        workflowMutationOwnerId,
        async (channel: string, args: unknown[]) => {
          const handler = workflowMutationDispatcher.get(channel);
          if (!handler) {
            throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
          }
          return handler(...args);
        },
        { maxConcurrentWorkflowDrains },
      );
    } else {
      logger.info('GUI launched in follower mode; mutation execution is delegated to the current owner', {
        module: 'init',
      });
    }

    // ── IPC Delegation Handlers — headless → GUI ────────────────
    // Headless processes delegate write-heavy commands to the GUI process via IpcBus.
    if (ownerMode) {
      workflowMutationDispatcher.set('headless.exec', async (payloadArg: unknown) => {
        return executeHeadlessExec(payloadArg as HeadlessExecMutationPayload);
      });
      workflowMutationDispatcher.set('api:approve-task', async (taskIdArg: unknown) => {
        await performSharedApproveTask(String(taskIdArg), 'api');
      });
      workflowMutationDispatcher.set('surface:approve-task', async (taskIdArg: unknown) => {
        await performSharedApproveTask(String(taskIdArg), 'surface');
      });
      messageBus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: workflowMutationOwnerId,
        mode: 'gui',
      }));
      messageBus.onRequest('headless.query', async (req: unknown) => {
        const { kind, reset } = req as { kind?: string; reset?: boolean };
        if (kind !== 'ui-perf') {
          throw new Error(`Unsupported headless query: ${String(kind)}`);
        }
        if (reset) {
          resetUiPerfStats();
        }
        return {
          ownerMode: 'gui',
          ...getUiPerfStats(),
        };
      });
      messageBus.onRequest('headless.run', async (req: unknown) => {
        const { planPath } = req as { planPath: string };
        logger.info(`headless.run: "${planPath}"`, { module: 'ipc-delegate' });
        return executeHeadlessRun({ planPath });
      });

      messageBus.onRequest('headless.resume', async (req: unknown) => {
        const { workflowId } = req as { workflowId: string };
        logger.info(`headless.resume: "${workflowId}"`, { module: 'ipc-delegate' });
        return executeHeadlessResume({ workflowId });
      });

      messageBus.onRequest('headless.exec', async (req: unknown) => {
        const { args, waitForApproval: delegatedWait, noTrack: delegatedNoTrack } =
          req as { args: string[]; waitForApproval?: boolean; noTrack?: boolean };
        if (!Array.isArray(args) || args.length === 0) {
          throw new Error('Missing delegated headless command arguments');
        }
        logger.info(`headless.exec: "${args.join(' ')}"`, { module: 'ipc-delegate' });
        const payload: HeadlessExecMutationPayload = {
          args,
          waitForApproval: delegatedWait,
          noTrack: delegatedNoTrack,
        };
        const { workflowId, priority } = classifyHeadlessExecMutation(payload);
        if (delegatedNoTrack && workflowId && workflowMutationCoordinator) {
          const intentId = workflowMutationCoordinator.submit(workflowId, priority, 'headless.exec', [payload], {
            deferDrain: true,
          });
          logger.info(
            `headless.exec accepted workflow="${workflowId}" intent=${intentId} noTrack=true priority=${priority}`,
            { module: 'ipc-delegate' },
          );
          return { ok: true, intentId };
        }
        return runWorkflowMutation(workflowId, priority, 'headless.exec', [payload], async () => executeHeadlessExec(payload));
      });
      logger.info(`owner-ipc-ready ownerId=${workflowMutationOwnerId}`, { module: 'ipc-delegate' });
      recordStartupMark('owner-ipc-ready');
    }

    bootstrapInitialWorkflowState();

    // Relaunch orphaned running tasks and start any pending-but-ready tasks.
    if (!ownerMode) {
      logger.info('follower mode startup: auto-run and orphan relaunch disabled', { module: 'init' });
    } else if (invokerConfig.disableAutoRunOnStartup) {
      logger.info('auto-run on startup disabled by config — skipping orphan relaunch', { module: 'init' });
    } else {
      const allStarted = relaunchOrphansAndStartReady(orchestrator, logger, 'init');
      if (allStarted.length > 0) {
        void dispatchTasksIfNeeded({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          tasks: allStarted,
          logger,
          context: 'init',
        });
      }
      requireTaskExecutor().resumeMergeGatePolling();
    }

    const dbPath = path.join(resolveInvokerHomeRoot(), 'invoker.db');
    logger.info(`Database: ${dbPath}`, { module: 'init' });
    logger.info(`Repo root: ${repoRoot}`, { module: 'init' });
    logger.info(`Config: disableAutoRunOnStartup=${invokerConfig.disableAutoRunOnStartup ?? false}`, { module: 'init' });
    recordStartupMark('startup.ready-for-window');

    // Forward deltas to renderer and keep snapshot cache in sync so
    // the db-poll doesn't re-emit deltas the messageBus already delivered.
    messageBus.subscribe(Channels.TASK_DELTA, (delta: unknown) => {
      uiPerfStats.mainDeltaToUi += 1;
      if (traceUiDeltaFlow) {
        logger.debug(`delta→ui: ${JSON.stringify(delta)}`, { module: 'ui' });
      }
      sendTaskDeltaToRenderer(delta as TaskDelta);

      const d = delta as TaskDelta;
      const deltaTaskId = d.type === 'updated' || d.type === 'removed'
        ? d.taskId
        : undefined;
      if (d.type === 'updated' && d.changes.status === 'failed') {
        const cancellationError = shouldSkipAutoFixForError(d.changes.execution?.error);
        const shouldAutoFixFromOrchestrator = orchestrator.shouldAutoFix(d.taskId);
        logAutoFixDebug(d.taskId, 'delta-failed', {
          shouldSkipForCancellation: cancellationError,
          shouldAutoFixFromOrchestrator,
        });
        if (!cancellationError && shouldAutoFixFromOrchestrator && deltaTaskId) {
          logAutoFixDebug(deltaTaskId, 'delta-trigger-schedule');
          scheduleAutoFix(deltaTaskId);
        }
      }

      applyDelta(d, lastKnownTaskStates, orchestrator);
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
      if (mainWindow && !mainWindow.isDestroyed() && uiInteractive) {
        mainWindow.webContents.send('invoker:task-output', data);
      }
    });

    // Register IPC handlers
    ipcMain.on('invoker:get-bootstrap-state-sync', (event) => {
      event.returnValue = {
        tasks: orchestrator.getAllTasks(),
        workflows: listWorkflowsByStartupRecency(),
        initialWorkflowId: startupWorkflowId,
        appStartedAtEpochMs: appProcessStartedAt,
      };
    });

    registerGuiMutationHandler('invoker:load-plan', async (planTextArg: unknown) => {
      const planText = String(planTextArg);
      const { parsePlan } = await import('./plan-parser.js');
      const plan = parsePlan(planText);
      logger.info(`load-plan: "${plan.name}" (${plan.tasks.length} tasks)`, { module: 'ipc' });
      taskHandles.clear();
      backupPlan(plan, undefined, logger);
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

    registerGuiMutationHandler('invoker:start', async () => {
      logger.info('start', { module: 'ipc' });
      const started = orchestrator.startExecution();
      logger.info(`startExecution returned ${started.length} tasks: [${started.map(t => t.id).join(', ')}]`, { module: 'ipc' });
      await dispatchTasksIfNeeded({
        orchestrator,
        taskExecutor: requireTaskExecutor(),
        tasks: started,
        logger,
        context: 'ipc.start',
      });
      return started;
    });

    registerGuiMutationHandler('invoker:resume-workflow', async () => {
      const workflows = persistence.listWorkflows();
      if (workflows.length === 0) {
        logger.info('resume-workflow: no workflows found', { module: 'ipc' });
        return null;
      }
      orchestrator.syncAllFromDb();

      const allStarted = relaunchOrphansAndStartReady(orchestrator, logger, 'resume-workflow');
      const tasks = orchestrator.getAllTasks();
      for (const task of tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        if (mainWindow && !mainWindow.isDestroyed()) {
          sendTaskDeltaToRenderer({ type: 'created', task });
        }
      }
      logger.info(`resume-workflow: ${tasks.length} tasks loaded across ${workflows.length} workflows, ${allStarted.length} started`, { module: 'ipc' });
      if (allStarted.length > 0) {
        void dispatchTasksIfNeeded({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          tasks: allStarted,
          logger,
          context: 'ipc.resume-workflow',
        });
      }
      requireTaskExecutor().resumeMergeGatePolling();
      return { workflow: workflows[0], taskCount: tasks.length, startedCount: allStarted.length };
    });

    registerGuiMutationHandler('invoker:stop', async () => {
      logger.info('stop — destroying all executors', { module: 'ipc' });
      await Promise.all(executorRegistry.getAll().map(f => f.destroyAll()));
      const allTasks = orchestrator.getAllTasks();
      for (const task of allTasks) {
        if (task.status === 'running' || task.status === 'fixing_with_ai') {
          logger.info(`stop — failing in-flight task "${task.id}" (${task.status})`, { module: 'ipc' });
          orchestrator.handleWorkerResponse({
            requestId: `stop-${task.id}`,
            actionId: task.id,
            executionGeneration: task.execution.generation ?? 0,
            status: 'failed',
            outputs: { exitCode: 1, error: 'Stopped by user' },
          });
        }
      }
    });

    registerGuiMutationHandler('invoker:clear', async () => {
      logger.info('clear — stopping all tasks and resetting DAG', { module: 'ipc' });
      const workflows = persistence.listWorkflows();

      for (const workflow of workflows) {
        try {
          await performCancelWorkflow(workflow.id);
        } catch (err) {
          logger.error(`clear: failed to cancel workflow "${workflow.id}": ${err}`, { module: 'ipc' });
        }
      }
      await Promise.all(executorRegistry.getAll().map(f => f.destroyAll().catch(() => undefined)));

      orchestrator = new Orchestrator({
        persistence,
        messageBus,
        taskRepository: new SqliteTaskRepository(persistence),
        maxConcurrency: invokerConfig.maxConcurrency,
        defaultAutoFixRetries: invokerConfig.autoFixRetries,
        executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
        deferRunningUntilLaunch: true,
        taskDispatcher: dispatchStartedTasks,
      });
      commandService = new CommandService(orchestrator);
      rebuildTaskRunner();
      taskHandles.clear();
    });

    ipcMain.handle('invoker:list-workflows', () => persistence.listWorkflows());

    registerGuiMutationHandler('invoker:delete-all-workflows', async () => {
      logger.info('delete-all-workflows', { module: 'ipc' });
      assertDeleteAllEnabled();
      const snapshot = createDeleteAllSnapshot(resolveInvokerHomeRoot());
      if (snapshot) {
        logger.info(`delete-all-workflows snapshot: ${snapshot}`, { module: 'ipc' });
      } else {
        logger.info('delete-all-workflows snapshot skipped: DB file does not exist yet', { module: 'ipc' });
      }
      orchestrator.deleteAllWorkflows();
      taskHandles.clear();
      lastKnownTaskStates.clear();
      lastKnownWorkflowCount = 0;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:workflows-changed', []);
      }
    });

    registerGuiMutationHandler('invoker:delete-workflow', async (workflowIdArg: unknown) => {
      const workflowId = String(workflowIdArg);
      logger.info(`delete-workflow: "${workflowId}"`, { module: 'ipc' });
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

        // Serialized via CommandService: DB delete + memory clear + scheduler cleanup + removal deltas
        const envelope = makeEnvelope('delete-workflow', 'ui', 'workflow', { workflowId });
        const result = await commandService.deleteWorkflow(envelope);
        if (!result.ok) throw new Error(result.error.message);

        // Update workflow count and send workflows-changed
        const workflows = persistence.listWorkflows();
        lastKnownWorkflowCount = workflows.length;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('invoker:workflows-changed', workflows);
        }
      } catch (err) {
        logger.error(`delete-workflow failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    ipcMain.handle('invoker:load-workflow', (_event, workflowId: string) => {
      logger.info(`load-workflow: "${workflowId}"`, { module: 'ipc' });
      // Sync orchestrator so mutations (restart, approve, etc.) work on this workflow
      orchestrator.syncFromDb(workflowId);
      const tasks = persistence.loadTasks(workflowId);
      const workflow = persistence.loadWorkflow(workflowId);
      logger.info(`load-workflow: found ${tasks.length} tasks for "${workflow?.name ?? workflowId}"`, { module: 'ipc' });
      for (const task of tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        if (mainWindow && !mainWindow.isDestroyed()) {
          sendTaskDeltaToRenderer({ type: 'created', task });
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
        const previousTaskIds = new Set(lastKnownTaskStates.keys());
        lastKnownTaskStates.clear();
        for (const task of tasks) {
          lastKnownTaskStates.set(task.id, JSON.stringify(task));
          previousTaskIds.delete(task.id);
          if (mainWindow && !mainWindow.isDestroyed()) {
            sendTaskDeltaToRenderer({ type: 'created', task });
          }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          for (const removedTaskId of previousTaskIds) {
            sendTaskDeltaToRenderer({ type: 'removed', taskId: removedTaskId });
          }
          mainWindow.webContents.send('invoker:workflows-changed', workflows);
        }
        lastKnownWorkflowCount = workflows.length;
      }
      logger.info(
        `get-tasks(forceRefresh=${forceRefresh ? 'true' : 'false'}) returning ${tasks.length} tasks, ${workflows.length} workflows`,
        { module: 'ipc' },
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
      logger.info(`get-claude-session: "${sessionId}"`, { module: 'ipc' });
      try {
        const allTasks = orchestrator.getAllTasks();
        return await resolveAgentSession(sessionId, 'claude', agentRegistry, allTasks);
      } catch (err) {
        logger.error(`get-claude-session failed: ${err}`, { module: 'ipc' });
        return null;
      }
    });

    ipcMain.handle('invoker:get-agent-session', async (_event, sessionId: string, agentName?: string) => {
      logger.info(`get-agent-session: "${sessionId}" agent="${agentName ?? 'claude'}"`, { module: 'ipc' });
      try {
        const allTasks = orchestrator.getAllTasks();
        return await resolveAgentSession(sessionId, agentName ?? 'claude', agentRegistry, allTasks);
      } catch (err) {
        logger.error(`get-agent-session failed: ${err}`, { module: 'ipc' });
        return null;
      }
    });

    registerGuiMutationHandler('invoker:provide-input', async (taskIdArg: unknown, inputArg: unknown) => {
      const taskId = String(taskIdArg);
      const input = String(inputArg);
      const envelope = makeEnvelope('provide-input', 'ui', 'task', { taskId, input });
      const result = await commandService.provideInput(envelope);
      if (!result.ok) throw new Error(result.error.message);
    });

    registerWorkflowScopedGuiMutationHandler(
      'invoker:approve',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`approve: "${taskId}"`, { module: 'ipc' });
      const { started } = await performSharedApproveTask(taskId, 'ui');
      logger.info(`approve: commandService returned ${started.length} started tasks: [${started.map(t => `${t.id}(${t.status})`).join(', ')}]`, { module: 'ipc' });
      await finalizeMutationWithGlobalTopup({
        orchestrator,
        taskExecutor: requireTaskExecutor(),
        logger,
        context: 'ipc.approve',
        started,
      });
      },
    );

    registerGuiMutationHandler('invoker:reject', async (taskIdArg: unknown, reasonArg?: unknown) => {
      const taskId = String(taskIdArg);
      const reason = reasonArg === undefined ? undefined : String(reasonArg);
      const envelope = makeEnvelope('reject', 'ui', 'task', { taskId, reason });
      const result = await commandService.reject(envelope);
      if (!result.ok) throw new Error(result.error.message);
    });

    registerGuiMutationHandler('invoker:select-experiment', async (taskIdArg: unknown, experimentIdArg: unknown) => {
      const taskId = String(taskIdArg);
      const experimentId = experimentIdArg as string | string[];
      const ids = Array.isArray(experimentId) ? experimentId : [experimentId];
      logger.info(`select-experiment: "${taskId}" experimentIds=${JSON.stringify(ids)}`, { module: 'ipc' });
      try {
        if (ids.length === 1) {
          // Single-select: serialized via CommandService
          const envelope = makeEnvelope('select-experiment', 'ui', 'task', { taskId, experimentId: ids[0] });
          const result = await commandService.selectExperiment(envelope);
          if (!result.ok) throw new Error(result.error.message);
          await dispatchTasksIfNeeded({
            orchestrator,
            taskExecutor: requireTaskExecutor(),
            tasks: result.data,
            logger,
            context: 'ipc.select-experiment.single',
          });
        } else {
          // Multi-select: needs taskExecutor for branch merge, stays in workflow-actions
          const newlyStarted = await sharedSelectExperiments(taskId, ids, { orchestrator, taskExecutor: requireTaskExecutor() });
          await dispatchTasksIfNeeded({
            orchestrator,
            taskExecutor: requireTaskExecutor(),
            tasks: newlyStarted,
            logger,
            context: 'ipc.select-experiment.multi',
          });
        }
      } catch (err) {
        logger.error(`select-experiment failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    registerWorkflowScopedGuiMutationHandler(
      'invoker:restart-task',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'high',
      async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`restart-task: "${taskId}"`, { module: 'ipc' });
      try {
        await preemptTaskSubgraph(taskId);
        const envelope = makeEnvelope('restart-task', 'ui', 'task', { taskId });
        const result = await commandService.restartTask(envelope);
        if (!result.ok) throw new Error(result.error.message);
        const started = result.data;
        logger.info(
          `${RESTART_TO_BRANCH_TRACE} ipc invoker:restart-task after commandService.restartTask: count=${started.length} [${started.map((t) => `${t.id}(${t.status})`).join(', ')}]`,
          { module: 'ipc' },
        );
        const runnable = started.filter(t => t.status === 'running');
        logger.info(
          `${RESTART_TO_BRANCH_TRACE} ipc invoker:restart-task runnable=${runnable.length} [${runnable.map((t) => t.id).join(', ') || '(none)'}] → taskExecutor.executeTasks`,
          { module: 'ipc' },
        );
        await executeGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.restart-task',
          alreadyDispatched: runnable,
        });
      } catch (err) {
        logger.error(`restart-task failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:cancel-task',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'high',
      async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`cancel-task: "${taskId}"`, { module: 'ipc' });
      try {
        const result = await performCancelTask(taskId);
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.cancel-task',
        });
        return result;
      } catch (err) {
        logger.error(`cancel-task failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:cancel-workflow',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'high',
      async (workflowIdArg: unknown) => {
      const workflowId = String(workflowIdArg);
      logger.info(`cancel-workflow: "${workflowId}"`, { module: 'ipc' });
      try {
        const result = await preemptWorkflowBeforeMutation(workflowId, {
          preemptWorkflowExecution,
          logger,
          context: 'ipc.cancel-workflow',
        });
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.cancel-workflow',
        });
        return result;
      } catch (err) {
        logger.error(`cancel-workflow failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

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
      if (metric === 'startup_graph_visible') {
        startBackgroundHydration('startup_graph_visible');
      }
      try {
        persistence.writeActivityLog('ui-perf', 'info', JSON.stringify(payload));
      } catch {
        // DB might be locked
      }
    });

    ipcMain.handle('invoker:get-ui-perf-stats', () => ({
      ...getUiPerfStats(),
    }));

    registerWorkflowScopedGuiMutationHandler(
      'invoker:recreate-workflow',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'high',
      async (workflowIdArg: unknown) => {
      const workflowId = String(workflowIdArg);
      cancelDeferredWorkflowLaunch(workflowId, 'ipc.recreate-workflow');
      logger.info(`recreate-workflow: "${workflowId}"`, { module: 'ipc' });
      try {
        await preemptWorkflowBeforeMutation(workflowId, {
          preemptWorkflowExecution,
          logger,
          context: 'ipc.recreate-workflow',
        });
        const started = sharedRecreateWorkflow(workflowId, { persistence, orchestrator });
        const runnable = started.filter(t => t.status === 'running');
        remoteFetchForPool.enabled = false;
        try {
          await executeGlobalTopup({
            orchestrator,
            taskExecutor: requireTaskExecutor(),
            logger,
            context: 'ipc.recreate-workflow',
            alreadyDispatched: runnable,
          });
        } finally {
          remoteFetchForPool.enabled = true;
        }
      } catch (err) {
        logger.error(`recreate-workflow failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:recreate-task',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'high',
      async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`recreate-task: "${taskId}"`, { module: 'ipc' });
      try {
        await preemptTaskSubgraph(taskId);
        const started = sharedRecreateTask(taskId, { persistence, orchestrator });
        const runnable = started.filter(t => t.status === 'running');
        remoteFetchForPool.enabled = false;
        try {
          await executeGlobalTopup({
            orchestrator,
            taskExecutor: requireTaskExecutor(),
            logger,
            context: 'ipc.recreate-task',
            alreadyDispatched: runnable,
          });
        } finally {
          remoteFetchForPool.enabled = true;
        }
      } catch (err) {
        logger.error(`recreate-task failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:retry-workflow',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'high',
      async (workflowIdArg: unknown) => {
      const workflowId = String(workflowIdArg);
      cancelDeferredWorkflowLaunch(workflowId, 'ipc.retry-workflow');
      logger.info(`retry-workflow: "${workflowId}"`, { module: 'ipc' });
      try {
        await preemptWorkflowBeforeMutation(workflowId, {
          preemptWorkflowExecution,
          logger,
          context: 'ipc.retry-workflow',
        });
        const envelope = makeEnvelope('retry-workflow', 'ui', 'workflow', { workflowId });
        const result = await commandService.retryWorkflow(envelope);
        if (!result.ok) throw new Error(result.error.message);
        const runnable = result.data.filter(t => t.status === 'running');
        remoteFetchForPool.enabled = false;
        try {
          await executeGlobalTopup({
            orchestrator,
            taskExecutor: requireTaskExecutor(),
            logger,
            context: 'ipc.retry-workflow',
            alreadyDispatched: runnable,
          });
        } finally {
          remoteFetchForPool.enabled = true;
        }
      } catch (err) {
        logger.error(`retry-workflow failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:rebase-and-retry',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'high',
      async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`rebase-and-retry: "${taskId}"`, { module: 'ipc' });
      try {
        const workflowId = workflowIdForTaskArg(taskIdArg);
        if (workflowId) {
          await preemptWorkflowBeforeMutation(workflowId, {
            preemptWorkflowExecution,
            logger,
            context: 'ipc.rebase-and-retry',
          });
        }
        const started = await rebaseAndRetry(taskId, {
          orchestrator,
          persistence,
          repoRoot,
          taskExecutor: requireTaskExecutor(),
        });
        const runnable = started.filter(t => t.status === 'running');
        await executeGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.rebase-and-retry',
          alreadyDispatched: runnable,
        });
      } catch (err) {
        logger.error(`rebase-and-retry failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerGuiMutationHandler('invoker:set-merge-branch', async (workflowIdArg: unknown, baseBranchArg: unknown) => {
      const workflowId = String(workflowIdArg);
      const baseBranch = String(baseBranchArg);
      logger.info(`set-merge-branch: workflow="${workflowId}" → "${baseBranch}"`, { module: 'ipc' });
      try {
        persistence.updateWorkflow(workflowId, { baseBranch });

        const tasks = persistence.loadTasks(workflowId);
        const mergeTask = tasks.find(t => t.config.isMergeNode);
        if (mergeTask) {
          const started = orchestrator.restartTask(mergeTask.id);
          void started;
        }
      } catch (err) {
        logger.error(`set-merge-branch failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    registerGuiMutationHandler('invoker:set-merge-mode', async (workflowIdArg: unknown, mergeModeArg: unknown) => {
      const workflowId = String(workflowIdArg);
      const mergeMode = String(mergeModeArg);
      logger.info(`set-merge-mode: workflow="${workflowId}" → "${mergeMode}"`, { module: 'ipc' });
      try {
        await setWorkflowMergeMode(workflowId, mergeMode, {
          orchestrator,
          persistence,
          taskExecutor: requireTaskExecutor(),
        });
      } catch (err) {
        logger.error(`set-merge-mode failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      const workflows = persistence.listWorkflows();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:workflows-changed', workflows);
      }
    });

    registerWorkflowScopedGuiMutationHandler(
      'invoker:approve-merge',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'normal',
      async (workflowIdArg: unknown) => {
      const workflowId = String(workflowIdArg);
      logger.info(`approve-merge: "${workflowId}"`, { module: 'ipc' });
      try {
        const mergeTask = orchestrator.getMergeNode(workflowId);
        if (!mergeTask) throw new Error(`No merge node for workflow ${workflowId}`);
        const { started } = await performSharedApproveTask(mergeTask.id, 'ui', 'workflow');
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.approve-merge',
          started,
        });
      } catch (err) {
        logger.error(`approve-merge failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerGuiMutationHandler('invoker:check-pr-statuses', async () => {
      logger.info('check-pr-statuses', { module: 'ipc' });
      await requireTaskExecutor().checkMergeGateStatuses();
    });

    registerGuiMutationHandler('invoker:check-pr-status', async () => {
      const tasks = orchestrator.getAllTasks();
      const awaitingMergeGates = tasks.filter(
        t => t.config.isMergeNode && (t.status === 'review_ready' || t.status === 'awaiting_approval')
      );
      await Promise.all(
        awaitingMergeGates.map(t => requireTaskExecutor().checkPrApprovalNow(t.id))
      );
    });

    registerWorkflowScopedGuiMutationHandler(
      'invoker:resolve-conflict',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, agentNameArg?: unknown) => {
      const taskId = String(taskIdArg);
      const agentName = agentNameArg === undefined ? undefined : String(agentNameArg);
      logger.info(
        `resolve-conflict: "${taskId}" agent=${agentName ?? 'claude'} source=ipc route=resolveConflictAction`,
        { module: 'ipc' },
      );
      try {
        const result = await resolveConflictAction(taskId, {
          orchestrator,
          persistence,
          taskExecutor: requireTaskExecutor(),
          autoApproveAIFixes: invokerConfig.autoApproveAIFixes,
        }, agentName);
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.resolve-conflict',
          started: result.started,
        });
      } catch (err) {
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.resolve-conflict.failure',
        });
        logger.error(`resolve-conflict failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:fix-with-agent',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, agentNameArg?: unknown) => {
      const taskId = String(taskIdArg);
      const agentName = agentNameArg === undefined ? undefined : String(agentNameArg);
      try {
        const started = await executeFixWithAgentMutation(taskId, agentName, 'ipc');
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.fix-with-agent',
          started,
        });
      } catch (err) {
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.fix-with-agent.failure',
        });
        logger.error(`fix-with-agent failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );


    registerGuiMutationHandler('invoker:edit-task-command', async (taskIdArg: unknown, newCommandArg: unknown) => {
      const taskId = String(taskIdArg);
      const newCommand = String(newCommandArg);
      logger.info(`edit-task-command: "${taskId}" → "${newCommand}"`, { module: 'ipc' });
      try {
        const envelope = makeEnvelope('edit-task-command', 'ui', 'task', { taskId, newCommand });
        const result = await commandService.editTaskCommand(envelope);
        if (!result.ok) throw new Error(result.error.message);
        const runnable = result.data.filter(t => t.status === 'running');
        void runnable;
      } catch (err) {
        logger.error(`edit-task-command failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    registerGuiMutationHandler('invoker:edit-task-type', async (taskIdArg: unknown, executorTypeArg: unknown, remoteTargetIdArg?: unknown) => {
      const taskId = String(taskIdArg);
      const executorType = String(executorTypeArg);
      const remoteTargetId = remoteTargetIdArg === undefined ? undefined : String(remoteTargetIdArg);
      logger.info(`edit-task-type: "${taskId}" → "${executorType}" remoteTargetId=${remoteTargetId ?? 'none'}`, { module: 'ipc' });
      try {
        const envelope = makeEnvelope('edit-task-type', 'ui', 'task', { taskId, executorType, remoteTargetId });
        const result = await commandService.editTaskType(envelope);
        if (!result.ok) throw new Error(result.error.message);
        const runnable = result.data.filter(t => t.status === 'running');
        void runnable;
      } catch (err) {
        logger.error(`edit-task-type failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    registerGuiMutationHandler('invoker:edit-task-agent', async (taskIdArg: unknown, agentNameArg: unknown) => {
      const taskId = String(taskIdArg);
      const agentName = String(agentNameArg);
      logger.info(`edit-task-agent: "${taskId}" → "${agentName}"`, { module: 'ipc' });
      try {
        const envelope = makeEnvelope('edit-task-agent', 'ui', 'task', { taskId, agentName });
        const result = await commandService.editTaskAgent(envelope);
        if (!result.ok) throw new Error(result.error.message);
        const runnable = result.data.filter(t => t.status === 'running');
        void runnable;
      } catch (err) {
        logger.error(`edit-task-agent failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    registerGuiMutationHandler(
      'invoker:set-task-external-gate-policies',
      async (taskIdArg: unknown, updatesArg: unknown) => {
        const taskId = String(taskIdArg);
        const updates = updatesArg as Array<{ workflowId: string; taskId?: string; gatePolicy: 'completed' | 'review_ready' }>;
        logger.info(`set-task-external-gate-policies: "${taskId}" updates=${updates.length}`, { module: 'ipc' });
        try {
          const envelope = makeEnvelope('set-gate-policies', 'ui', 'task', { taskId, updates });
          const result = await commandService.setTaskExternalGatePolicies(envelope);
          if (!result.ok) throw new Error(result.error.message);
          const runnable = result.data.filter((t) => t.status === 'running');
          void runnable;
        } catch (err) {
          logger.error(`set-task-external-gate-policies failed: ${err}`, { module: 'ipc' });
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

    registerGuiMutationHandler('invoker:replace-task', async (taskIdArg: unknown, replacementTasksArg: unknown) => {
      const taskId = String(taskIdArg);
      const replacementTasks = replacementTasksArg as unknown[];
      logger.info(`replace-task: "${taskId}" with ${replacementTasks.length} replacement(s)`, { module: 'ipc' });
      try {
        const envelope = makeEnvelope('replace-task', 'ui', 'task', {
          taskId,
          replacementTasks: replacementTasks as TaskReplacementDef[],
        });
        const result = await commandService.replaceTask(envelope);
        if (!result.ok) throw new Error(result.error.message);
        const runnable = result.data.filter((t) => t.status === 'running');
        void runnable;
        return result.data;
      } catch (err) {
        logger.error(`replace-task failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    // ── DB Polling — detect external workflow changes ───
    ipcMain.handle('invoker:get-activity-logs', () => {
      return persistence.getActivityLogs(0);
    });

    // ── External terminal launcher ──────────────────────────────
    ipcMain.handle('invoker:open-terminal', async (_event, taskId: string): Promise<{ opened: boolean; reason?: string }> => {
      logger.info(`invoked for task="${taskId}"`, { module: 'open-terminal' });
      return openExternalTerminalForTask({
        taskId,
        persistence,
        executorRegistry,
        executionAgentRegistry: agentRegistry,
        repoRoot,
        logger,
        runningTaskReason:
          'Task is still running or being fixed with AI. View output in the terminal panel below.',
      });
    });

    seedUiSnapshotCache();
    createWindow();
    recordStartupMark('createWindow.end');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  }).catch((err) => {
    process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
    app.quit();
  });

  app.on('window-all-closed', () => {
    logger.info('window-all-closed', { module: 'window' });
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  let isQuitting = false;
  app.on('before-quit', async (event) => {
    if (isQuitting) return;
    isQuitting = true;
    logger.info('before-quit begin', { module: 'process' });
    event.preventDefault();

    const safetyTimer = setTimeout(() => {
      console.error('[quit] Cleanup timed out after 10s, forcing exit');
      process.exit(1);
    }, 10_000);

    try {
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
              executionGeneration: task.execution.generation ?? 0,
              status: 'failed',
              outputs: { exitCode: 1, error: 'Application quit' },
            });
          }
        }
      }
      if (persistence) persistence.close();
      if (writerLock) writerLock.release();
      if (messageBus) messageBus.disconnect();
    } finally {
      clearTimeout(safetyTimer);
      logger.info('before-quit end -> app.exit(0)', { module: 'process' });
      app.exit(0);
    }
  });

  // ── Slack Bot (embedded in GUI process) ──────────────────
  async function startSlackBot(
    executor: TaskRunner,
    handles: Map<string, { handle: ExecutorHandle; executor: Executor }>,
  ): Promise<void> {
    const logFn = (source: string, level: string, message: string) => {
      const logMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
      logger[logMethod](message, { module: source });
      try { persistence.writeActivityLog(source, level, message); } catch { /* db locked */ }
    };

    await wireSlackBot({
      executor,
      logFn,
      approveTaskAction: async (taskId: string) => {
        const workflowId = orchestrator.getTask(taskId)?.config.workflowId;
        await runWorkflowMutation(workflowId, 'normal', 'surface:approve-task', [taskId], async () => {
          await performSharedApproveTask(taskId, 'surface');
        });
      },
      onStartPlan: () => handles.clear(),
      onPlanLoaded: () => {},
    });

    logFn('slack', 'info', 'Slack bot started (embedded in GUI)');
  }
}
