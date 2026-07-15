/** Electron Main Process — GUI + Headless CLI mode. */

import { app, dialog, ipcMain, Menu, type BrowserWindow } from 'electron';
import * as path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { config as loadDotenv } from 'dotenv';
import {
  computeGuiRuntimeStatus,
  configureEarlyElectronApp,
  createDaemonOwnerLossController,
  formatGuiOwnerBootstrapFallbackMessage,
  guiOwnerBootstrapTimeoutMs,
  isMutationOwnerUnavailableError,
  shouldTreatAsDaemonOwnerLoss,
  registerGuiLifecycleHandlers,
  resolveGuiOwnerPreference,
  runElectronReadyBootstrap,
  shouldRefreshGuiOwnerRoute,
  startGuiModeBootstrap,
  startMainProcessBootstrap,
} from './bootstrap/app-bootstrap.js';
import { createStartupWorkflowCache } from './bootstrap/startup-workflow-cache.js';

const enableTestCompositor = process.env.INVOKER_E2E_ENABLE_COMPOSITOR === '1' || Boolean(process.env.CAPTURE_MODE);
const hideE2eWindow = process.env.NODE_ENV === 'test' && process.env.INVOKER_E2E_HIDE_WINDOW !== '0';
const earlyHeadlessMode = process.argv.includes('--headless')
  || process.argv.includes('--install-skills')
  || process.argv.slice(2).includes('install-skills');

configureEarlyElectronApp({ app, enableTestCompositor, isHeadless: earlyHeadlessMode });

// Isolate userData (and with it the single-instance lock) for e2e runs so a
// test instance can launch alongside a normally running Invoker.
if (process.env.INVOKER_USER_DATA_DIR) {
  app.setPath('userData', process.env.INVOKER_USER_DATA_DIR);
}

import {
  Orchestrator,
  CommandService,
  OrchestratorError,
  OrchestratorErrorCode,
  buildWorkflowInvalidationDeps,
} from '@invoker/workflow-core';
import type {
  TaskDelta,
  TaskReplacementDef,
  TaskState,
  TaskStateChanges,
} from '@invoker/workflow-core';
import {
  makeEnvelope,
  resolveInvokerIpcSocketPath,
  resolveRepoRoot,
} from '@invoker/contracts';
import type {
  BundledSkillsInstallMode,
  InAppPlanRequest,
  InAppPlanningCreateSessionRequest,
  InAppPlanningChatRequest,
  InAppPlanningResetRequest,
  InAppPlanningSubmitRequest,
  Logger,
  StartReadyRequest,
  StartReadyResult,
  WorkflowMutationAcceptedResult,
} from '@invoker/contracts';
import { ConversationRepository, SqliteTaskRepository } from '@invoker/data-store';
import type { SQLiteAdapter } from '@invoker/data-store';
import { IpcBus, Channels } from '@invoker/transport';
import {
  WorkspaceProbeAdapter,
  ContainerProbeAdapter,
  SessionProbeAdapter,
  TerminalLauncherAdapter,
} from '@invoker/runtime-adapters';
import { composeRuntimeServices, composeHeadlessStartup } from '@invoker/runtime-service';
import type { RuntimeServices } from '@invoker/runtime-service';
import type { MessageBus } from '@invoker/transport';
import {
  ExecutorRegistry,
  TaskRunner,
  WorktreeExecutor,
  CI_FAILURE_WORKER_KIND,
  initializeShellEnvironment,
  createAutoFixAttemptLedger,
  createWorkerRegistry,
  GitHubMergeGateProvider,
  PR_STATUS_WORKER_KIND,
  E2E_AUTOFIX_WORKER_KIND,
  registerBuiltinAgents,
  registerBuiltinWorkers,
  parseRequeueMutationArgs,
  parseRequeueEscalateMutationArgs,
  reconcileTerminalWorkerActionsOnStartup,
  type AgentRegistry,
  type WorkerRegistry,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import { FileAndDbLogger } from './logger.js';
import {
  DEFAULT_SLACK_HARNESS_PRESETS,
  loadConfig,
  resolveAutoFixExecutionModel,
  resolveConfigFileState,
  resolveEmbeddedTerminalBackendConfig,
  resolvePrMaintenanceWorkerConfig,
  type EmbeddedTerminalBackendConfig,
  type InvokerConfig,
} from './config.js';
import {
  resolveAutoApproveAIFixes,
  resolveAutoFixRetries,
} from './autofix-defaults.js';
import {
  DEFAULT_WORKTREE_MAX_CONCURRENCY,
  assertExecutionCapacityInvariant,
  resolveEffectiveMaxConcurrency,
  shouldFatalOnExecutionCapacityOvercommit,
} from './execution-capacity.js';
import {
  createHourlySnapshot,
  resolveInvokerHomeRoot,
} from './delete-all-snapshot.js';
import { openMainProcessDatabase } from './viewer-db-boundary.js';
import {
  isHeadlessMutatingCommand,
  isHeadlessReadOnlyCommand,
  resolveHeadlessTargetWorkflowId,
} from './headless-command-classification.js';
import { backupPlan } from './plan-backup.js';
import { startApiServer, type ApiServer } from './api-server.js';
import { WorkflowMutationFacade } from './workflow-mutation-facade.js';
import {
  runHeadless,
  isDelegated,
  tryDelegateRun,
  tryDelegateResume,
  resolveDelegationTimeoutMs,
  tryDelegateExec,
  tryDelegateQuery,
  createHeadlessExecutor,
  wireHeadlessApproveHook,
  type HeadlessDeps,
} from './headless.js';
import { parseReviewGatePrNumber, repairReviewGateCiByPr } from './review-gate-ci-repair-command.js';
import { resolveRefreshTaskGraphSnapshot } from './refresh-task-graph.js';
import {
  startStandaloneLaunchDispatcher,
  type StandaloneLaunchDispatcherController,
} from './headless-standalone-launch-dispatcher.js';
import {
  approveTask as sharedApproveTask,
  deleteAllWorkflows as sharedDeleteAllWorkflows,
  rejectTask as sharedRejectTask,
  selectExperiments as sharedSelectExperiments,
} from './workflow-actions.js';
import { execSync } from 'node:child_process';
import { resolveTaskTerminalSpec } from './open-terminal-for-task.js';
import {
  createBashTerminalBackend,
  createPtyTerminalBackend,
  EmbeddedTerminalManager,
  type EmbeddedTerminalBackend,
} from './embedded-terminal-manager.js';
import { collectSystemDiagnostics } from './system-diagnostics.js';
import { installBundledSkills, resolveBundledSkillsStatus } from './bundled-skills.js';
import {
  maybeAutoInstallCli,
  updateInvokerCli,
  type CliInstallerContext,
} from './cli-installer.js';
import { resolveBundledCliPath } from './cli-helper.js';
import { buildAppMenuTemplate } from './app-menu.js';
import { acquireDbWriterLock, type DbWriterLockResult } from './db-writer-lock.js';
import { CoalescedWorkflowMetadataPublisher } from './workflow-metadata-invalidation.js';
import type { WorkflowMutationPriority } from './workflow-mutation-coordinator.js';
import { PersistedWorkflowMutationCoordinator } from './persisted-workflow-mutation-coordinator.js';
import { submitWorkflowMutationOrAcknowledgeDeleted } from './workflow-mutation-submit.js';
import type { WorkflowMutationContext } from './persisted-workflow-mutation-coordinator.js';
import { LaunchDispatcher } from './launch-dispatcher.js';
import {
  isTaskInFlightForForcedStop,
  reconcileOrphanedInFlightTasksOnBoot,
} from './reconcile-orphaned-running-tasks.js';
import { recoverWorkflowMutationsOnStartup } from './workflow-mutation-startup.js';
import {
  dispatchStartedTasksWithGlobalTopup,
} from './global-topup.js';
import { preserveCrashedInFlightTasks } from './crash-preserved-tasks.js';


import {
  buildHeadlessFixArgs,
  parseFixWithAgentMutationArgs,
} from './auto-fix-intents.js';
import { persistShutdownDiagnostic } from './shutdown-diagnostic.js';
import { buildCurrentActionGraphSnapshot } from './action-graph-snapshot.js';
import { answerOwnerHeadlessQuery, buildOwnerReadQueryHandlers } from './owner-read-query.js';
import { registerExternalWorkersFromConfig } from './external-worker-loader.js';
import {
  AUTO_STARTED_OWNER_WORKER_KINDS,
  createLocalWorkerStatusSnapshot,
  createWorkerRuntimeController,
  type WorkerRuntimeController,
} from './worker-control.js';
import { runStartReady } from './start-ready.js';
import { startSurfaceEventRelay } from './surface-event-relay.js';
import { createTaskGraphEventPublisher } from './task-graph-event-publisher.js';
import { buildWebInvokerDispatch } from './web/web-invoker-dispatch.js';
import { startWebBridge, resolveWebUiDistDir, type WebBridge } from './web/web-bridge-server.js';
import { resolveWebToken, resolveWebHost, resolveWebPort } from './web/start-web-surface.js';
import {
  createGuiMutationRegistrars,
  registerBootstrapStateIpc,
  type GuiMutationPayload,
  type GuiMutationRegistrationContext,
  type WorkflowScopedGuiMutationRegistrationContext,
} from './ipc/ipc-registration.js';
import {
  createGuiMutationTaskActions,
  registerGuiMutationIpcHandlers,
  type GuiMutationTaskActions,
} from './ipc/gui-mutation-handlers.js';
import { createTaskDeltaStreamSequence } from './task-delta-stream-sequence.js';
import {
  createTerminalUiPerfCounters,
  createTerminalUiPerfReporter,
  createTerminalUiPerfSink,
  resetTerminalUiPerfCounters,
} from './terminal-ui-perf.js';
import {
  createRendererUiPerfCounters,
  resetRendererUiPerfCounters,
} from './renderer-ui-perf.js';
import {
  registerPlanningTerminalSessionIpcHandlers,
  registerTerminalSessionIpcHandlers,
  registerTerminalSessionPersistence,
} from './terminal-session-ipc.js';
import { startLifecycleEventBridge, type LifecycleEventBridge } from './lifecycle-event-bridge.js';
import { seedMainProcessHitchFixture } from './main-process-hitch-fixture.js';
import { seedStressFixture, type StressFixtureOptions } from './stress-fixture.js';
import {
  executeNoTrackHeadlessBatch,
  type HeadlessBatchExecRequest,
  type HeadlessExecMutationPayload,
} from './headless-batch-exec.js';
import {
  spawnDetachedStandaloneOwner,
  tryAcquireOwnerBootstrapLock,
} from './headless-owner-bootstrap.js';
import {
  createInAppPlanningChatSessions,
  createPlanningChatSession,
  createPlanningCommandBuilderFromRegistry,
  listPlanningChatSessions,
  planFromGoal as planFromGoalInApp,
  resetPlanningChat,
  restorePlanningChatSessions,
  sendPlanningChatMessage,
  submitPlanningChatDraft,
} from './in-app-planner.js';
import { discoverOwner, isStandaloneCapable } from './owner-endpoint.js';
import {
  killRunningTaskExecution,
  rebuildTaskRunner as rebuildTaskRunnerWiring,
  requireWiredTaskRunner,
  type TaskHandleMap,
} from './execution/task-runner-wiring.js';
import {
  createMainWindow,
  registerMainWindowActivateHandler,
  registerMainWindowSecondInstanceHandler,
} from './window/window-lifecycle.js';
import { createRendererTaskFeed } from './window/renderer-task-feed.js';
import { tryAcquireGuiInstanceLock, type GuiInstanceLock } from './gui-instance-lock.js';
import { logProcessError } from './process-error-handling.js';


function submitRegisteredOwnerWorkerMutation(
  workflowId: string,
  priority: WorkflowMutationPriority,
  channel: string,
  mutationArgs: unknown[],
  options?: { deferDrain?: boolean },
): number {
  if (!workflowMutationCoordinator) {
    throw new Error('Workflow mutation coordinator is unavailable');
  }
  if (!workflowMutationDispatcher.has(channel)) {
    throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
  }
  return workflowMutationCoordinator.submit(workflowId, priority, channel, mutationArgs, options);
}
const autoFixAttemptLedger = createAutoFixAttemptLedger();


function buildRegisteredOwnerWorkerDeps(
  store: WorkerRuntimeDependencies['store'],
  checkMergeGateStatuses: NonNullable<WorkerRuntimeDependencies['reviewGate']>['checkMergeGateStatuses'],
): WorkerRuntimeDependencies {
  const remoteTargets = Object.entries(invokerConfig.remoteTargets ?? {}).map(([name, target]) => ({
    name,
    connection: {
      host: target.host,
      user: target.user,
      sshKeyPath: target.sshKeyPath,
      port: target.port,
    },
    remotePath: '~/.invoker',
  }));

  return {
    store,
    submitter: {
      submit: submitRegisteredOwnerWorkerMutation,
    },
    logger,
    messageBus,
    reviewGate: {
      checkMergeGateStatuses,
    },
    mergeGateProvider: new GitHubMergeGateProvider(),
    autoFix: {
      defaultAutoFixRetries: resolveAutoFixRetries(invokerConfig),
      attemptLedger: autoFixAttemptLedger,
      getAutoFixAgent: () => invokerConfig.autoFixAgent,
      getAutoFixExecutionModel: () => resolveAutoFixExecutionModel(invokerConfig),
    },
    requeue: {
      stallRequeueRetries: invokerConfig.stallRequeueRetries,
      stallRequeueBackoffMs: invokerConfig.stallRequeueBackoffMs,
    },
    prMaintenance: resolvePrMaintenanceWorkerConfig(invokerConfig),
    diskHeadroom: {
      localPath: resolveInvokerHomeRoot(),
      remoteTargets,
    },
    e2eAutoFix: { intervalMs: invokerConfig.e2eAutoFixIntervalMs },
    autoApprove: {
      enabled: resolveAutoApproveAIFixes(invokerConfig),
    },
  };
}
function createRegisteredWorkerRegistry(): WorkerRegistry<WorkerRuntimeDependencies> {
  const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
  return registerExternalWorkersFromConfig(invokerConfig.externalWorkers, registry);
}

declare const __BUILD_SHA__: string | undefined;
declare const __BUILD_VERSION__: string | undefined;

// ── Detect headless mode ─────────────────────────────────────

// Electron passes extra args after `--` or interleaves them.
// We look for `--headless` anywhere in process.argv.
const headlessIndex = process.argv.indexOf('--headless');
const directInstallSkills = process.argv.includes('--install-skills') || process.argv.slice(2).includes('install-skills');
const isHeadless = headlessIndex !== -1 || directInstallSkills;

// In headless mode, extract the CLI args after --headless
let cliArgs = headlessIndex !== -1
  ? process.argv.slice(headlessIndex + 1)
  : directInstallSkills
    ? ['install-skills']
    : [];

const waitForApprovalIndex = cliArgs.indexOf('--wait-for-approval');
const waitForApproval = waitForApprovalIndex !== -1;
if (waitForApproval) {
  cliArgs = [...cliArgs.slice(0, waitForApprovalIndex), ...cliArgs.slice(waitForApprovalIndex + 1)];
}

const noTrackIndex = cliArgs.findIndex((arg) => arg === '--no-track' || arg === '--do-not-track');
const noTrack = noTrackIndex !== -1;
if (noTrack) {
  cliArgs = [...cliArgs.slice(0, noTrackIndex), ...cliArgs.slice(noTrackIndex + 1)];
}

let messageBus: MessageBus;
let persistence: SQLiteAdapter;
let executorRegistry: ExecutorRegistry;
let orchestrator: Orchestrator;
let commandService: CommandService;
// Latest TaskRunner reference for invalidation deps. CommandService is
// constructed in initServices before TaskRunner exists, so the deps
// resolve via this getter at cancel-in-flight time.
let latestTaskExecutor: TaskRunner | null = null;
let guiUsingDaemonOwner = false;
let guiDaemonOwnerConnectionLost = false;

function buildCommandServiceInvalidationDeps() {
  return buildWorkflowInvalidationDeps({
    orchestrator,
    requireWorkflow: (workflowId) => {
      const workflow = persistence.loadWorkflow(workflowId);
      if (!workflow) {
        throw new OrchestratorError(
          OrchestratorErrorCode.WORKFLOW_NOT_FOUND,
          `Workflow ${workflowId} not found`,
        );
      }
      return workflow;
    },
    setWorkflowGeneration: (workflowId, generation) => {
      persistence.updateWorkflow(workflowId, { generation });
    },
    killActiveExecution: async (taskId) => {
      await latestTaskExecutor?.killActiveExecution(taskId);
    },
    prepareFreshBase: async (workflowId, workflow) => {
      if (!latestTaskExecutor || !workflow.repoUrl) return undefined;
      return latestTaskExecutor.preparePoolForRebaseRetry(
        workflowId,
        workflow.repoUrl,
        workflow.baseBranch,
      );
    },
    fixApprove: async (taskId) => {
      const result = await sharedApproveTask(taskId, {
        orchestrator,
        taskExecutor: latestTaskExecutor ?? undefined,
      });
      return result.started;
    },
    fixReject: (taskId) => {
      sharedRejectTask(taskId, { orchestrator });
      return [];
    },
  });
}
let runtimeServices: RuntimeServices;
let workflowMutationCoordinator: PersistedWorkflowMutationCoordinator | null = null;
let launchDispatcher: LaunchDispatcher | null = null;
const workflowMutationDispatcher = new Map<string, (...args: unknown[]) => Promise<unknown>>();
/**
 * The mutation context for the currently executing workflow mutation.
 * Set by the coordinator dispatch callback before invoking the handler,
 * cleared afterward. Allows fix-with-agent and conflict-resolution
 * handlers to read the AbortSignal without changing every handler signature.
 */
let activeMutationContext: WorkflowMutationContext | undefined;
let hourlyBackupInterval: ReturnType<typeof setInterval> | null = null;
let writerLock: DbWriterLockResult | null = null;
const workflowMutationOwnerId = `owner-${process.pid}-${Date.now()}`;
const appProcessStartedAt = Date.now();

interface HeadlessRunMutationPayload {
  planPath: string;
  traceId?: string;
}

interface HeadlessResumeMutationPayload {
  workflowId: string;
  traceId?: string;
}

type HeadlessOwnerMode = 'standalone' | 'gui';
function headlessExecLogFields(
  payload: HeadlessExecMutationPayload,
  mode: HeadlessOwnerMode,
  extra: Record<string, string | number | undefined> = {},
): string {
  const fields: Record<string, string | number | undefined> = {
    trace: payload.traceId ?? '<none>',
    args: `"${payload.args.join(' ')}"`,
    noTrack: payload.noTrack ? 'true' : 'false',
    ...extra,
    coordinator: workflowMutationCoordinator ? 'true' : 'false',
    mode,
  };
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value ?? '<none>'}`)
    .join(' ');
}

function logHeadlessExecReceived(payload: HeadlessExecMutationPayload, mode: HeadlessOwnerMode): void {
  logger.info(
    `headless.exec received ${headlessExecLogFields(payload, mode, { ownerId: workflowMutationOwnerId })}`,
    { module: 'ipc-delegate' },
  );
}

function acknowledgeNoTrackHeadlessExec(
  payload: HeadlessExecMutationPayload,
  workflowId: string | undefined,
  priority: WorkflowMutationPriority,
  mode: HeadlessOwnerMode,
): WorkflowMutationAcceptedResult | undefined {
  logger.info(
    `headless.exec decision ${headlessExecLogFields(payload, mode, { workflow: `"${workflowId ?? '<none>'}"`, priority })}`,
    { module: 'ipc-delegate' },
  );

  if (!payload.noTrack) return undefined;

  if (workflowId && workflowMutationCoordinator) {
    const result = submitWorkflowMutationOrAcknowledgeDeleted(workflowId, priority, 'headless.exec', [payload], {
      coordinator: workflowMutationCoordinator,
      workflowExists: (id) => Boolean(persistence.loadWorkflow(id)),
      logger,
      deferDrain: true,
    });
    logger.info(
      `headless.exec accepted ${headlessExecLogFields(payload, mode, { workflow: `"${workflowId}"`, intent: result.intentId, priority })}`,
      { module: 'ipc-delegate' },
    );
    return result;
  }

  const reason = !workflowId ? 'workflow-not-resolved' : 'coordinator-unavailable';
  logger.error(
    `headless.exec rejected ${headlessExecLogFields(payload, mode, { reason, workflow: `"${workflowId ?? '<none>'}"` })}`,
    { module: 'ipc-delegate' },
  );
  throw new Error(`Fire-and-forget headless.exec could not be queued: ${reason}`);
}

let logger: Logger = new FileAndDbLogger({ module: 'main' });
let guiInstanceLock: GuiInstanceLock | null = null;
const buildSha = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev';
const buildVersion = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev';
logger.info(`Invoker ${buildVersion} (${buildSha})`, { module: 'startup' });

process.on('uncaughtException', (err) => {
  logProcessError('uncaughtException', err, { logger, fallbackConsole: console });
});

process.on('unhandledRejection', (reason) => {
  logProcessError('unhandledRejection', reason, { logger, fallbackConsole: console });
});

const repoRoot = resolveRepoRoot(__dirname, { fallback: process.resourcesPath });

// Load secrets from ~/.invoker/.env (canonical) then the repo .env BEFORE any startup guard
// reads process.env. dotenv never overrides vars already set in the real environment.
function loadInvokerEnvFiles(): void {
  for (const envPath of [path.join(homedir(), '.invoker', '.env'), path.resolve(repoRoot, '.env')]) {
    if (existsSync(envPath)) loadDotenv({ path: envPath });
  }
}
loadInvokerEnvFiles();
const invokerConfig: InvokerConfig = (() => {
  try {
    return loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
})();

async function discoverStandaloneOwnerForGui(waitMs: number): Promise<boolean> {
  let ownerBus = new IpcBus(undefined, { allowServe: false });
  try {
    await ownerBus.ready();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const owner = await discoverOwner(ownerBus, 500);
      if (isStandaloneCapable(owner)) {
        logger.info(`daemon owner ready ownerId=${owner.ownerId}`, { module: 'init' });
        return true;
      }
      ownerBus.disconnect();
      ownerBus = new IpcBus(undefined, { allowServe: false });
      await ownerBus.ready();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  } finally {
    ownerBus.disconnect();
  }
}

async function ensureStandaloneOwnerForGui(): Promise<void> {
  if (await discoverStandaloneOwnerForGui(2_000)) return;

  const invokerHomeRoot = resolveInvokerHomeRoot();
  const timeoutMs = guiOwnerBootstrapTimeoutMs();
  const bootstrapLock = tryAcquireOwnerBootstrapLock(invokerHomeRoot);
  try {
    if (bootstrapLock) {
      logger.info('spawning daemon owner for GUI client mode', { module: 'init' });
      spawnDetachedStandaloneOwner(repoRoot);
    } else {
      logger.info('waiting for daemon owner bootstrap held by another process', { module: 'init' });
    }
    if (await discoverStandaloneOwnerForGui(timeoutMs)) return;
  } finally {
    bootstrapLock?.release();
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for daemon owner`);
}

let guiOwnerRouteRefreshPromise: Promise<void> | null = null;
const daemonOwnerLoss = createDaemonOwnerLossController({
  getState: () => ({ usingDaemonOwner: guiUsingDaemonOwner, connectionLost: guiDaemonOwnerConnectionLost }),
  setState: (state) => { guiUsingDaemonOwner = state.usingDaemonOwner; guiDaemonOwnerConnectionLost = state.connectionLost; },
  warn: (message) => logger.warn(message, { module: 'ipc' }),
});
const markDaemonOwnerUnavailable = (reason: string) => daemonOwnerLoss.markUnavailable(reason);

async function refreshGuiMutationOwnerRoute(): Promise<void> {
  const ownerPreference = resolveGuiOwnerPreference();
  if (!shouldRefreshGuiOwnerRoute(ownerPreference, guiUsingDaemonOwner)) return;
  if (!guiOwnerRouteRefreshPromise) {
    guiOwnerRouteRefreshPromise = (async () => {
      try {
        if (ownerPreference === 'daemon') {
          await ensureStandaloneOwnerForGui();
        } else if (!await discoverStandaloneOwnerForGui(2_000)) {
          markDaemonOwnerUnavailable('daemon owner discovery timed out');
          throw new Error('No mutation owner is available');
        }
      } catch (err) {
        if (shouldTreatAsDaemonOwnerLoss(err)) {
          markDaemonOwnerUnavailable(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
      const previousMessageBus = typeof messageBus === 'undefined' ? null : messageBus;
      const refreshedMessageBus = new IpcBus(undefined, { allowServe: false });
      await refreshedMessageBus.ready();
      messageBus = refreshedMessageBus;
      previousMessageBus?.disconnect();
      daemonOwnerLoss.restoreDaemonOwner();
      logger.info('refreshed daemon owner IPC route for GUI mutation', { module: 'ipc-delegate' });
    })().finally(() => {
      guiOwnerRouteRefreshPromise = null;
    });
  }
  await guiOwnerRouteRefreshPromise;
}

function getSafeInvokerConfigForLogging(config: InvokerConfig): Record<string, unknown> {
  const safeConfig = { ...config } as Record<string, unknown> & {
    docker?: InvokerConfig['docker'];
    imageStorage?: InvokerConfig['imageStorage'];
    r2?: unknown;
  };
  delete safeConfig.r2;
  if (safeConfig.imageStorage) {
    safeConfig.imageStorage = {
      ...safeConfig.imageStorage,
      accessKeyId: '<redacted>',
      secretAccessKey: '<redacted>',
    };
  }
  if (safeConfig.docker?.secretsFile) {
    safeConfig.docker = { ...safeConfig.docker, secretsFile: '<redacted>' };
  }
  return safeConfig;
}

const effectiveMaxConcurrency = resolveEffectiveMaxConcurrency(invokerConfig.maxConcurrency);

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
  /**
   * GUI viewer mode: never open `invoker.db`. A writable owner is always present
   * in this mode, so the renderer's reads delegate to the owner over IPC and
   * live updates arrive via TASK_DELTA/TASK_OUTPUT. We back the in-process
   * services with a private empty in-memory database so no `-shm` is mapped on
   * the real file — that is what lets the owner run WAL exclusive locking and be
   * immune to the `-shm` truncation SIGBUS. Implies non-owner (readOnly) semantics.
   */
  detachedViewer?: boolean;
  executionAgentRegistry?: AgentRegistry;
  startupSyncMode?: 'all' | 'none';
}

function buildBundledSkillsContext() {
  return {
    isPackaged: app.isPackaged,
    repoRoot,
    resourcesPath: process.resourcesPath,
  };
}

function getBundledSkillsStatus() {
  return resolveBundledSkillsStatus(buildBundledSkillsContext());
}

function installPackagedSkills(mode: BundledSkillsInstallMode = 'install') {
  return installBundledSkills(buildBundledSkillsContext(), mode);
}

function buildCliInstallerContext(): CliInstallerContext {
  return {
    isPackaged: app.isPackaged,
    bundledCliPath: resolveBundledCliPath({ isPackaged: app.isPackaged }),
    appVersion: app.getVersion(),
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
  };
}

function resolveSetupCliPath(): string {
  return resolveBundledCliPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir: path.join(__dirname, '..'),
  });
}

function updateInvokerCliFromMenu(): void {
  const result = updateInvokerCli(buildCliInstallerContext());
  const detail = result.ok
    ? result.updated
      ? `invoker-cli ${app.getVersion()} installed to ${result.installedTo}.${result.status.warning ? `\n\n${result.status.warning}` : ''}`
      : `invoker-cli is already up to date (${app.getVersion()}) at ${result.installedTo}.`
    : `Update failed: ${result.error}`;
  void dialog.showMessageBox({
    type: result.ok ? 'info' : 'error',
    message: 'Update invoker-cli',
    detail,
  });
}

async function initServices(options?: InitServicesOptions): Promise<void> {
  const invokerHomeRoot = resolveInvokerHomeRoot();
  mkdirSync(invokerHomeRoot, { recursive: true });
  const detachedViewer = options?.detachedViewer === true;
  // Detached viewer mode is a non-owner mode (no writer lock, no backups).
  const readOnly = options?.readOnly === true || detachedViewer;
  const previousMessageBus = typeof messageBus === 'undefined' ? null : messageBus;
  previousMessageBus?.disconnect();
  const serviceMessageBus = new IpcBus(undefined, { allowServe: !readOnly });
  await serviceMessageBus.ready();
  messageBus = serviceMessageBus;
  const dbPath = path.join(invokerHomeRoot, 'invoker.db');
  if (!readOnly) {
    writerLock = acquireDbWriterLock(dbPath, `main:initServices pid=${process.pid}`);
  }
  persistence = await openMainProcessDatabase({
    dbPath,
    detachedViewer,
    readOnly,
    exclusiveLocking: process.env.INVOKER_DISABLE_EXCLUSIVE_LOCKING !== '1'
      && process.env.INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK !== '1',
  });
  // Upgrade root logger with DB persistence now that SQLiteAdapter is ready.
  logger = new FileAndDbLogger({ module: 'main' }, { persistence });
  // Surface auto-restore / empty-fallback loudly so a silent quarantine can never
  // repeat the "boot shows zero tasks with no explanation" incident. Owner-only
  // adapters carry `corruptionRecovery`; detached viewers never do.
  if (persistence.corruptionRecovery) {
    const { detectedAt, quarantinedPath, restoredFromSnapshot } = persistence.corruptionRecovery;
    if (restoredFromSnapshot) {
      logger.warn(
        `[db-recovery] Corrupt database quarantined to ${quarantinedPath} at ${detectedAt}; ` +
          `auto-restored from clean hourly snapshot ${restoredFromSnapshot}. ` +
          'Activity between the snapshot timestamp and the corruption event is lost.',
        { module: 'db-recovery' },
      );
    } else {
      logger.error(
        `[db-recovery] Corrupt database quarantined to ${quarantinedPath} at ${detectedAt}; ` +
          'NO clean hourly snapshot available — started with an empty database. ' +
          `Historical rows may still be recoverable from ${quarantinedPath} via sqlite3 .recover.`,
        { module: 'db-recovery' },
      );
    }
  }
  const shellEnv = await initializeShellEnvironment();
  if (process.platform === 'darwin') {
    const suffix = shellEnv.reason ? ` (${shellEnv.reason})` : '';
    logger.info(
      `[init] shell environment ${shellEnv.status} via ${shellEnv.shell}; PATH=${shellEnv.path}${suffix}`,
      { module: 'init' },
    );
  }
  if (!readOnly && !hourlyBackupInterval) {
    const hourlyMs = Number(process.env.INVOKER_HOURLY_BACKUP_MS ?? 60 * 60 * 1000);
    if (Number.isFinite(hourlyMs) && hourlyMs > 0) {
      const backupViaOwner = (dest: string) => persistence.backupTo(dest);
      hourlyBackupInterval = setInterval(() => {
        void (async () => {
          try {
            // Refuse to propagate a corrupt image into the snapshot ring. Once
            // the live DB is damaged, every subsequent hourly snapshot rewrites
            // the ring with the corrupt file, so the next boot has no clean
            // candidate for `SQLiteAdapter.create`'s auto-restore invariant. A
            // failed quick_check MUST skip that hour and log loudly.
            if (!persistence.quickCheck()) {
              logger.error(
                'hourly snapshot skipped: source DB failed PRAGMA quick_check. ' +
                  'The snapshot ring is preserved so the next boot can auto-restore from the last clean image.',
                { module: 'backup' },
              );
              return;
            }
            const snapshot = await createHourlySnapshot(invokerHomeRoot, backupViaOwner);
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
        })();
      }, hourlyMs);
      hourlyBackupInterval.unref?.();
      logger.info(`hourly snapshots enabled (interval=${hourlyMs}ms)`, { module: 'backup' });
    }
  }

  // Compose runtime services from persistence-backed adapters.
  // Headless startup routes through composeHeadlessStartup so the
  // headless path has an explicit composition entry point.
  const executionAgentRegistry = options?.executionAgentRegistry ?? registerBuiltinAgents();
  const runtimeServiceDeps = {
    workspaceProbe: new WorkspaceProbeAdapter(persistence),
    containerProbe: new ContainerProbeAdapter(persistence),
    sessionProbe: new SessionProbeAdapter(persistence),
    terminalLauncher: new TerminalLauncherAdapter({
      resumeCommandResolver: (agentName, sessionId) => {
        const agent = executionAgentRegistry.getOrThrow(agentName);
        const resume = agent.buildResumeArgs(sessionId);
        return { command: resume.cmd, args: resume.args };
      },
    }),
  };
  runtimeServices = isHeadless
    ? composeHeadlessStartup(runtimeServiceDeps)
    : composeRuntimeServices(runtimeServiceDeps);

  executorRegistry = new ExecutorRegistry();
  executorRegistry.register(
    'worktree',
    new WorktreeExecutor({
      worktreeBaseDir: path.resolve(invokerHomeRoot, 'worktrees'),
      cacheDir: path.resolve(invokerHomeRoot, 'repos'),
      maxWorktrees: effectiveMaxConcurrency,
      agentRegistry: executionAgentRegistry,
    }),
  );
  const taskRepository = new SqliteTaskRepository(persistence);
  orchestrator = new Orchestrator({
    persistence, messageBus,
    taskRepository,
    maxConcurrency: effectiveMaxConcurrency,
    defaultAutoFixRetries: resolveAutoFixRetries(invokerConfig),
    executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
    defaultPoolId: invokerConfig.defaultPoolId,
    availablePoolIds: Object.keys(invokerConfig.executionPools ?? {}),
    deferRunningUntilLaunch: true,
  });
  commandService = new CommandService(
    orchestrator,
    buildCommandServiceInvalidationDeps(),
  );

  const startupSyncMode = options?.startupSyncMode ?? 'all';
  const initLog = isHeadless
    ? (msg: string, meta?: Record<string, unknown>) => {
      process.stderr.write(meta ? `${msg} ${JSON.stringify(meta)}\n` : `${msg}\n`);
    }
    : (msg: string, meta?: Record<string, unknown>) => { logger.info(msg, { ...meta, module: 'init' }); };
  initLog('Effective configuration', { config: getSafeInvokerConfigForLogging(invokerConfig) });
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


const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

function startHeadlessMode(): void {
  const runHeadlessMain = async (): Promise<void> => {
    const agentRegistry = registerBuiltinAgents();
    const planningChatSessions = createInAppPlanningChatSessions();
    const planningCommandBuilder = createPlanningCommandBuilderFromRegistry(agentRegistry);
    const command = cliArgs[0];
    const readOnlyMode = isHeadlessReadOnlyCommand(cliArgs);
    const mutatingMode = isHeadlessMutatingCommand(cliArgs);
    const standaloneMode = process.env.INVOKER_HEADLESS_STANDALONE === '1' || command === 'owner-serve';
    const ownsHeadlessShutdown = standaloneMode && !readOnlyMode && command === 'owner-serve';

    // Try delegation for mutating commands first (owner mode).
    // In standalone mode we skip delegation and run locally.
    if (mutatingMode && !standaloneMode) {
      // Delegating headless commands must never become the IPC server.
      // Otherwise a transient submitter can steal the transport socket away
      // from the actual shared mutation owner.
      const delegationBus = new IpcBus(undefined, { allowServe: false });
      try {
        await delegationBus.ready();

        let delegated = false;
        if (command === 'run') {
          const planPath = cliArgs[1];
          if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');
          delegated = isDelegated(await tryDelegateRun(planPath, delegationBus, waitForApproval, noTrack));
        } else if (command === 'resume') {
          const workflowId = cliArgs[1];
          if (!workflowId) throw new Error('Missing workflowId. Usage: --headless resume <id>');
          delegated = isDelegated(await tryDelegateResume(workflowId, delegationBus, waitForApproval, noTrack));
        } else {
          const timeoutMs = noTrack ? undefined : await resolveDelegationTimeoutMs(cliArgs);
          delegated = isDelegated(await tryDelegateExec(cliArgs, delegationBus, waitForApproval, noTrack, timeoutMs));
        }

        if (delegated) {
          // Successfully delegated to owner
          delegationBus.disconnect();
          process.exit(process.exitCode ?? 0);
          return; // Guard: process.exit() may not halt in Electron async context
        }

        // Delegation failed: no owner handler available.
        delegationBus.disconnect();
        if (!standaloneMode) {
          process.stderr.write(
            `${RED}Error:${RESET} Mutation command "${command}" requires a running owner process.\n` +
            `\n${BOLD}Options:${RESET}\n` +
            `  1. Start the interactive process: ${BOLD}electron dist/main.js${RESET}\n` +
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

    if (readOnlyMode && command !== 'owner-serve') {
      const delegationBus = new IpcBus(undefined, { allowServe: false });
      try {
        await delegationBus.ready();
        const delegated = await tryDelegateQuery(delegationBus, { kind: 'cli-query', args: cliArgs }, 5_000);
        delegationBus.disconnect();
        if (delegated && typeof delegated.output === 'string') {
          process.stdout.write(delegated.output);
          process.exit(0);
          return;
        }
      } catch (err) {
        delegationBus.disconnect();
        process.stderr.write(`${RED}Delegation error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
        return;
      }
    }

    let exitCode = 0;
    let workerRuntimeController: WorkerRuntimeController | null = null;
    let lifecycleEventBridge: LifecycleEventBridge | null = null;
    let standaloneLaunchDispatcherController: StandaloneLaunchDispatcherController | null = null;
    try {
      // Standalone mode: initialize services and run headless
      await initServices({
        readOnly: readOnlyMode,
        executionAgentRegistry: agentRegistry,
      });

      if (!readOnlyMode && orchestrator && persistence) {
        const orphaned = reconcileOrphanedInFlightTasksOnBoot({
          orchestrator,
          persistence,
        });
        if (orphaned.length > 0) {
          logger.info(
            `failed ${orphaned.length} orphaned in-flight task(s) left by a previous owner crash`,
            { module: 'init', taskIds: orphaned.map((task) => task.id) },
          );
        }
      }

      const headlessDeps = {
        logger,
        orchestrator, persistence, executorRegistry, messageBus,
        repoRoot, invokerConfig, initServices,
        commandService,
        getUiPerfStats: () => ({
          ts: new Date().toISOString(),
          mainDeltaToUi: 0,
          dbPollCreated: 0,
          dbPollUpdatedAsCreated: 0,
          dbPollUpdatedAsUpdated: 0,
          ...createRendererUiPerfCounters(),
        }),
        resetUiPerfStats: () => {},
        getWorkerStatus: () => workerRuntimeController?.snapshot() ?? createLocalWorkerStatusSnapshot({
          registry: createRegisteredWorkerRegistry(),
          persistence,
          autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
        }),
        waitForApproval,
        noTrack,
        executionAgentRegistry: agentRegistry,
        getBundledSkillsStatus,
        installBundledSkills: installPackagedSkills,
        repairReviewGateCi: (prArg: string) => repairReviewGateCiByPr(prArg, {
          persistence,
          repoRoot,
          policy: {
            store: persistence,
            submitter: { submit: submitRegisteredOwnerWorkerMutation },
            logger,
            defaultAutoFixRetries: resolveAutoFixRetries(invokerConfig),
            getAutoFixAgent: () => invokerConfig.autoFixAgent,
            getAutoFixExecutionModel: () => resolveAutoFixExecutionModel(invokerConfig),
            attemptLedger: autoFixAttemptLedger,
          },
        }),
        runtimeServices,
        appRootDir: __dirname,
      } as HeadlessDeps;

      const createStandaloneTaskExecutor = (): TaskRunner => {
        const executor = createHeadlessExecutor(headlessDeps);
        wireHeadlessApproveHook(headlessDeps, executor);
        return executor;
      };

      const executeStandaloneHeadlessRun = async (payload: HeadlessRunMutationPayload): Promise<unknown> => {
        const { applyConfiguredPlanDefaults, parsePlanFile } = await import('./plan-parser.js');
        const plan = applyConfiguredPlanDefaults(await parsePlanFile(payload.planPath));
        backupPlan(plan, undefined, logger);
        const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
        orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
        const workflowId = orchestrator.getWorkflowIds().find((id) => !wfIdsBefore.has(id));
        if (!workflowId) {
          throw new Error(`Failed to resolve workflow id for delegated plan: ${payload.planPath}`);
        }
        const started = orchestrator.startExecution();
        logger.info(`standalone started ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
        const tasks = orchestrator.getAllTasks().filter((task) => task.config.workflowId === workflowId);
        return { workflowId, tasks };
      };


      const executeStandaloneHeadlessResume = async (payload: HeadlessResumeMutationPayload): Promise<unknown> => {
        const { workflowId } = payload;
        const started = orchestrator.resumeWorkflow(workflowId);
        void started;
        logger.info(`standalone resumed ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
        const tasks = orchestrator.getAllTasks().filter((task) => task.config.workflowId === workflowId);
        return { workflowId, tasks };
      };

      const loadGeneratedPlan = async (
        planText: string,
      ): Promise<{ planName: string; workflowId: string; workflowIds?: string[]; workflowCount?: number }> => {
        const { applyConfiguredPlanDefaults, parsePlanSubmissionBundle } = await import('./plan-parser.js');
        const submission = parsePlanSubmissionBundle(planText);
        const existingWorkflowIds = new Set(persistence.listWorkflows().map((workflow) => workflow.id));
        const loadedWorkflowIds: string[] = [];
        let upstream: { workflowId: string; featureBranch: string } | undefined;

        for (const parsedPlan of submission.plans) {
          let plan = applyConfiguredPlanDefaults(parsedPlan);
          if (upstream) {
            plan = {
              ...plan,
              baseBranch: upstream.featureBranch,
              externalDependencies: [
                ...(plan.externalDependencies ?? []),
                {
                  workflowId: upstream.workflowId,
                  taskId: '__merge__',
                  requiredStatus: 'completed',
                  gatePolicy: 'review_ready',
                } as const,
              ],
            };
          }
          backupPlan(plan, undefined, logger);
          orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
          const workflow = persistence.listWorkflows().find((candidate) => !existingWorkflowIds.has(candidate.id));
          if (!workflow) {
            throw new Error('Loaded plan did not create a workflow.');
          }
          existingWorkflowIds.add(workflow.id);
          loadedWorkflowIds.push(workflow.id);
          upstream = { workflowId: workflow.id, featureBranch: workflow.featureBranch ?? plan.featureBranch ?? plan.baseBranch ?? 'main' };
        }

        const workflowId = loadedWorkflowIds[loadedWorkflowIds.length - 1];
        if (!workflowId) {
          throw new Error('Loaded plan did not create a workflow.');
        }

        return {
          planName: submission.name,
          workflowId,
          workflowIds: loadedWorkflowIds,
          workflowCount: loadedWorkflowIds.length,
        };
      };

      const planningConversationRepo = new ConversationRepository(persistence, {
        info: (message) => logger.info(message, { module: 'planning-chat' }),
        warn: (message) => logger.warn(message, { module: 'planning-chat' }),
        error: (message) => logger.error(message, { module: 'planning-chat' }),
      });
      await restorePlanningChatSessions(persistence.listInAppPlanningSessions(), {
        config: invokerConfig,
        workingDir: repoRoot,
        sessions: planningChatSessions,
        planningCommandBuilder,
        loadGeneratedPlan,
        conversationRepo: planningConversationRepo,
        planningSessionStore: readOnlyMode ? undefined : persistence,
      });

      const executeStandaloneGuiMutation = async (payload: GuiMutationPayload): Promise<unknown> => {
        switch (payload.channel) {
          case 'invoker:clear': {
            logger.info('clear — stopping all tasks and resetting daemon DAG', { module: 'ipc-delegate' });
            await sharedDeleteAllWorkflows({ logger, orchestrator, taskExecutor: undefined });
            await Promise.all(executorRegistry.getAll().map(f => f.destroyAll().catch(() => undefined)));
            orchestrator = new Orchestrator({
              persistence,
              messageBus,
              taskRepository: new SqliteTaskRepository(persistence),
              maxConcurrency: effectiveMaxConcurrency,
              defaultAutoFixRetries: resolveAutoFixRetries(invokerConfig),
              executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
              defaultPoolId: invokerConfig.defaultPoolId,
              availablePoolIds: Object.keys(invokerConfig.executionPools ?? {}),
              deferRunningUntilLaunch: true,
            });
            commandService = new CommandService(
              orchestrator,
              buildCommandServiceInvalidationDeps(),
            );
            return undefined;
          }
          case 'invoker:plan-from-goal': {
            return planFromGoalInApp(payload.args[0] as InAppPlanRequest, {
              config: invokerConfig,
              workingDir: repoRoot,
              loadGeneratedPlan,
              planningCommandBuilder,
              conversationRepo: planningConversationRepo,
            });
          }
          case 'invoker:planning-chat-create': {
            return createPlanningChatSession(payload.args[0] as InAppPlanningCreateSessionRequest | undefined, {
              config: invokerConfig,
              workingDir: repoRoot,
              sessions: planningChatSessions,
              planningCommandBuilder,
              loadGeneratedPlan,
              conversationRepo: planningConversationRepo,
              planningSessionStore: readOnlyMode ? undefined : persistence,
            });
          }
          case 'invoker:planning-chat-list': {
            return listPlanningChatSessions({ sessions: planningChatSessions });
          }
          case 'invoker:planning-chat-send': {
            return sendPlanningChatMessage(payload.args[0] as InAppPlanningChatRequest, {
              config: invokerConfig,
              workingDir: repoRoot,
              sessions: planningChatSessions,
              planningCommandBuilder,
              loadGeneratedPlan,
              conversationRepo: planningConversationRepo,
              planningSessionStore: readOnlyMode ? undefined : persistence,
            });
          }
          case 'invoker:planning-chat-submit': {
            return submitPlanningChatDraft(payload.args[0] as InAppPlanningSubmitRequest, {
              sessions: planningChatSessions,
              loadGeneratedPlan,
              planningSessionStore: readOnlyMode ? undefined : persistence,
            });
          }
          case 'invoker:planning-chat-reset': {
            return resetPlanningChat(payload.args[0] as InAppPlanningResetRequest, {
              sessions: planningChatSessions,
              planningSessionStore: readOnlyMode ? undefined : persistence,
            });
          }
          case 'invoker:load-plan': {
            const planText = String(payload.args[0] ?? '');
            await loadGeneratedPlan(planText);
            return undefined;
          }
          case 'invoker:stop': {
            logger.info('stop — destroying all daemon executors', { module: 'ipc-delegate' });
            const failInFlightTasks = (): void => {
              const allTasks = orchestrator.getAllTasks();
              for (const task of allTasks) {
                if (isTaskInFlightForForcedStop(task)) {
                  logger.info(`stop — failing in-flight task "${task.id}" (${task.status})`, { module: 'ipc-delegate' });
                  persistShutdownDiagnostic(task, persistence, { forcedStopReason: 'Stopped by user' });
                  orchestrator.handleWorkerResponse({
                    requestId: `stop-${task.id}`,
                    actionId: task.id,
                    attemptId: task.execution.selectedAttemptId,
                    executionGeneration: task.execution.generation ?? 0,
                    status: 'failed',
                    outputs: { exitCode: 1, error: 'Stopped by user' },
                  });
                }
              }
            };
            failInFlightTasks();
            await Promise.all(executorRegistry.getAll().map(f => f.destroyAll()));
            failInFlightTasks();
            return undefined;
          }
          case 'invoker:start-worker': {
            if (!workerRuntimeController) {
              throw new Error('Worker runtime controller is unavailable');
            }
            return workerRuntimeController.start(String(payload.args[0]));
          }
          case 'invoker:stop-worker': {
            if (!workerRuntimeController) {
              throw new Error('Worker runtime controller is unavailable');
            }
            return workerRuntimeController.stop(String(payload.args[0]));
          }
          case 'invoker:inject-task-states': {
            if (process.env.NODE_ENV !== 'test') {
              throw new Error('inject-task-states is only available in tests');
            }
            const updates = payload.args[0] as Array<{ taskId: string; changes: TaskStateChanges }>;
            for (const { taskId, changes } of updates) {
              persistence.updateTask(taskId, changes);
            }
            orchestrator.syncAllFromDb();
            return undefined;
          }
          case 'invoker:seed-main-process-hitch-fixture': {
            if (process.env.NODE_ENV !== 'test') {
              throw new Error('seed-main-process-hitch-fixture is only available in tests');
            }
            const seeded = seedMainProcessHitchFixture(persistence);
            orchestrator.syncAllFromDb();
            return seeded;
          }
          case 'invoker:seed-stress-fixture': {
            if (process.env.NODE_ENV !== 'test') {
              throw new Error('seed-stress-fixture is only available in tests');
            }
            const options = payload.args[0] as StressFixtureOptions | undefined;
            const seeded = seedStressFixture(persistence, options);
            orchestrator.syncAllFromDb();
            return seeded;
          }
          case 'invoker:set-merge-branch': {
            const workflowId = String(payload.args[0]);
            const baseBranch = String(payload.args[1]);
            persistence.updateWorkflow(workflowId, { baseBranch });
            const tasks = persistence.loadTasks(workflowId);
            const mergeTask = tasks.find((task) => task.config.isMergeNode);
            if (!mergeTask) return undefined;
            const executor = createStandaloneTaskExecutor();
            const envelope = makeEnvelope('set-merge-branch', 'ui', 'task', { taskId: mergeTask.id });
            const result = await commandService.retryTask(envelope);
            if (!result.ok) throw new Error(result.error.message);
            const started = result.data;
            await dispatchStartedTasksWithGlobalTopup({
              orchestrator,
              taskExecutor: executor,
              logger,
              context: 'standalone.set-merge-branch',
              started,
              scopedTaskIds: [mergeTask.id],
            });
            return undefined;
          }
          case 'invoker:replace-task': {
            const taskId = String(payload.args[0]);
            const replacementTasks = payload.args[1] as TaskReplacementDef[];
            const envelope = makeEnvelope('replace-task', 'ui', 'task', { taskId, replacementTasks });
            const result = await commandService.replaceTask(envelope);
            if (!result.ok) throw new Error(result.error.message);
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
              return undefined;
            }
            await sharedSelectExperiments(taskId, ids, { orchestrator, taskExecutor: executor });
            return undefined;
          }
          case 'invoker:set-task-external-gate-policies': {
            const taskId = String(payload.args[0]);
            const updates = payload.args[1] as Array<{ workflowId: string; taskId?: string; gatePolicy: 'completed' | 'review_ready' }>;
            const envelope = makeEnvelope('set-gate-policies', 'ui', 'task', { taskId, updates });
            const result = await commandService.setTaskExternalGatePolicies(envelope);
            if (!result.ok) throw new Error(result.error.message);
            return undefined;
          }
          default:
            throw new Error(`Unsupported internal mutation for standalone owner: ${payload.channel}`);
        }
      };

      // In standalone owner mode, serve delegated requests from peer headless processes.
      if (standaloneMode && messageBus) {
        const standaloneOwnerIdleTimeoutMs = Number.parseInt(
          process.env.INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS ?? '0',
          10,
        );
        let standaloneOwnerLastActivityAt = Date.now();
        const noteStandaloneOwnerActivity = (): void => {
          standaloneOwnerLastActivityAt = Date.now();
        };
        headlessDeps.isStandaloneOwnerIdle = () => {
          if (!Number.isFinite(standaloneOwnerIdleTimeoutMs) || standaloneOwnerIdleTimeoutMs <= 0) {
            return false;
          }
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

          switch (command) {
            case 'set': {
              const [, subCommand, targetArg] = payload.args;
              switch (subCommand) {
                case 'workflow':
                case 'merge-mode':
                  return {
                    workflowId: targetArg === undefined ? undefined : String(targetArg),
                    priority: 'high',
                  };
                case 'command':
                case 'prompt':
                case 'executor':
                case 'agent':
                case 'fix-prompt':
                case 'fix-context':
                case 'gate-policy':
                case 'task':
                  return {
                    workflowId: targetArg === undefined ? undefined : standaloneWorkflowIdForTaskArg(targetArg),
                    priority: 'high',
                  };
                default:
                  return { priority: 'normal' };
              }
            }
            case 'resume':
            case 'retry':
              return {
                workflowId: arg0 === undefined ? undefined : standaloneWorkflowIdForTaskArg(arg0),
                priority: 'high',
              };
            case 'recreate':
            case 'cancel-workflow':
              return { workflowId: arg0 === undefined ? undefined : String(arg0), priority: 'high' };
            case 'rebase-retry':
            case 'rebase-recreate':
              return { workflowId: standaloneWorkflowIdForTaskArg(arg0), priority: 'high' };
            case 'cancel':
            case 'retry-task':
            case 'recreate-task':
            case 'delete-task':
              return { workflowId: standaloneWorkflowIdForTaskArg(arg0), priority: 'high' };
            case 'delete':
            case 'delete-workflow':
            case 'detach-workflow':
              return { workflowId: arg0 === undefined ? undefined : String(arg0), priority: 'high' };
            case 'approve':
            case 'reject':
            case 'select':
            case 'fix':
            case 'resolve-conflict':
              return { workflowId: standaloneWorkflowIdForTaskArg(arg0), priority: 'normal' };
            case 'repair-review-gate-ci':
              return { workflowId: standaloneWorkflowIdForReviewGatePrArg(arg0), priority: 'normal' };
            default:
              return { priority: 'normal' };
          }
        };

        const standaloneWorkflowIdForTaskArg = (taskIdArg: unknown): string => {
          return resolveHeadlessTargetWorkflowId(taskIdArg, persistence);
        };
        const standaloneWorkflowIdForReviewGatePrArg = (prArg: unknown): string | undefined => {
          const raw = prArg === undefined ? undefined : String(prArg);
          if (!raw) return undefined;
          const prNumber = parseReviewGatePrNumber(raw);
          if (!prNumber) return undefined;
          return persistence.findReviewGateByPr(prNumber)?.workflowId;
        };

        const runStandaloneWorkflowMutation = async <T>(
          workflowId: string | undefined,
          priority: WorkflowMutationPriority,
          channel: string,
          args: unknown[],
          op: () => Promise<T>,
        ): Promise<T> => {
          if (!workflowId) return op();
          if (!workflowMutationCoordinator || !workflowMutationDispatcher.has(channel)) {
            return op();
          }
          return workflowMutationCoordinator.enqueue<T>(workflowId, priority, channel, args);
        };

        if (!workflowMutationDispatcher.has('headless.exec')) {
          workflowMutationDispatcher.set('headless.exec', async (payloadArg: unknown) => {
            const payload = payloadArg as HeadlessExecMutationPayload;
            await runHeadless(payload.args, {
              ...headlessDeps,
              waitForApproval: payload.waitForApproval,
              noTrack: payload.noTrack,
              signal: activeMutationContext?.signal,
              mutationTiming: activeMutationContext?.mutationTiming,
            });
            return { ok: true };
          });
        }
        if (!workflowMutationDispatcher.has('invoker:start-ready')) {
          workflowMutationDispatcher.set('invoker:start-ready', async (requestArg: unknown) =>
            runStartReady(orchestrator, requestArg as StartReadyRequest | undefined),
          );
        }
        if (!workflowMutationDispatcher.has('invoker:fix-with-agent')) {
          workflowMutationDispatcher.set('invoker:fix-with-agent', async (...fixArgs: unknown[]) => {
            const { taskId, agentName, context } = parseFixWithAgentMutationArgs(fixArgs);
            const args = buildHeadlessFixArgs(taskId, agentName, context);
            await runHeadless(args, {
              ...headlessDeps,
              waitForApproval: false,
              noTrack: true,
              signal: activeMutationContext?.signal,
              mutationTiming: activeMutationContext?.mutationTiming,
            });
            return { ok: true };
          });
        }
        if (!workflowMutationDispatcher.has('invoker:requeue')) {
          workflowMutationDispatcher.set('invoker:requeue', async (...requeueArgs: unknown[]) => {
            const { taskId } = parseRequeueMutationArgs(requeueArgs);
            await runHeadless(['retry-task', taskId], {
              ...headlessDeps,
              waitForApproval: false,
              noTrack: true,
              signal: activeMutationContext?.signal,
              mutationTiming: activeMutationContext?.mutationTiming,
            });
            return { ok: true };
          });
        }
        if (!workflowMutationDispatcher.has('invoker:requeue-escalate')) {
          workflowMutationDispatcher.set('invoker:requeue-escalate', async (...escalateArgs: unknown[]) => {
            const { taskId, prompt } = parseRequeueEscalateMutationArgs(escalateArgs);
            const envelope = makeEnvelope('escalate-stalled', 'headless', 'task', { taskId, prompt });
            const result = await commandService.escalateStalledToNeedsInput(envelope);
            if (!result.ok) throw new Error(result.error.message);
            return { ok: true };
          });
        }
        if (!workflowMutationCoordinator) {
          workflowMutationCoordinator = new PersistedWorkflowMutationCoordinator(
            persistence,
            workflowMutationOwnerId,
            async (channel: string, args: unknown[], context) => {
              const handler = workflowMutationDispatcher.get(channel);
              if (!handler) {
                throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
              }
              activeMutationContext = context;
              try {
                return await handler(...args);
              } finally {
                activeMutationContext = undefined;
              }
            },
            { logger },
          );
        }


        const executeStandaloneHeadlessRun = async (
          payload: HeadlessRunMutationPayload,
        ): Promise<{ workflowId: string; tasks: TaskState[] }> => {
          const { applyConfiguredPlanDefaults, parsePlanFile } = await import('./plan-parser.js');
          const plan = applyConfiguredPlanDefaults(await parsePlanFile(payload.planPath));
          backupPlan(plan, undefined, logger);
          const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
          orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
          const workflowId = orchestrator.getWorkflowIds().find(id => !wfIdsBefore.has(id))!;
          const started = orchestrator.startExecution();
          logger.info(`started ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
          const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
          return { workflowId, tasks };
        };


        const executeStandaloneHeadlessResume = async (
          payload: HeadlessResumeMutationPayload,
        ): Promise<{ workflowId: string; tasks: TaskState[] }> => {
          const { workflowId } = payload;

          const allStarted = orchestrator.resumeWorkflow(workflowId);
          const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
          return { workflowId, tasks };
        };

        messageBus.onRequest('headless.run', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          const { planPath, traceId } = req as { planPath: string; traceId?: string };
          logger.info(
            `headless.run received trace=${traceId ?? '<none>'} planPath="${planPath}" ownerId=${workflowMutationOwnerId} mode=standalone`,
            { module: 'ipc-delegate' },
          );
          const result = await executeStandaloneHeadlessRun({ planPath });
          logger.info(
            `headless.run accepted trace=${traceId ?? '<none>'} workflow="${result.workflowId}" tasks=${result.tasks.length} mode=standalone`,
            { module: 'ipc-delegate' },
          );
          return result;
        });
        messageBus.onRequest('headless.owner-ping', async () => {
          noteStandaloneOwnerActivity();
          return {
            ok: true,
            ownerId: workflowMutationOwnerId,
            mode: 'standalone',
          };
        });
        messageBus.onRequest('headless.query', async (req: unknown) =>
          answerOwnerHeadlessQuery(req, buildOwnerReadQueryHandlers({
            ownerModeLabel: 'standalone',
            onActivity: noteStandaloneOwnerActivity,
            getUiPerfStats: () => headlessDeps.getUiPerfStats?.() ?? {},
            resetUiPerfStats: () => headlessDeps.resetUiPerfStats?.(),
            getStreamSequence: () => 0,
            getWorkerStatus: () => workerRuntimeController?.snapshot() ?? createLocalWorkerStatusSnapshot({
              registry: createRegisteredWorkerRegistry(),
              persistence,
              autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
            }),
            getWorkers: () => workerRuntimeController?.snapshot() ?? createLocalWorkerStatusSnapshot({
              registry: createRegisteredWorkerRegistry(),
              persistence,
              autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
            }),
            resolveInvokerHomeRoot,
            orchestrator,
            persistence,
            getActionGraphSnapshot: () =>
              buildCurrentActionGraphSnapshot({ orchestrator, persistence, invokerConfig }) as unknown as Record<string, unknown>,
          }), {
            orchestrator,
            persistence,
            invokerConfig,
            executionAgentRegistry: headlessDeps.executionAgentRegistry,
            getUiPerfStats: headlessDeps.getUiPerfStats,
            resetUiPerfStats: headlessDeps.resetUiPerfStats,
            getWorkerStatus: headlessDeps.getWorkerStatus,
          }));
        messageBus.onRequest('headless.resume', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          const { workflowId, traceId } = req as { workflowId: string; traceId?: string };
          logger.info(
            `headless.resume received trace=${traceId ?? '<none>'} workflowId="${workflowId}" ownerId=${workflowMutationOwnerId} mode=standalone`,
            { module: 'ipc-delegate' },
          );
          const result = await executeStandaloneHeadlessResume({ workflowId });
          logger.info(
            `headless.resume accepted trace=${traceId ?? '<none>'} workflow="${result.workflowId}" tasks=${result.tasks.length} mode=standalone`,
            { module: 'ipc-delegate' },
          );
          return result;
        });
        messageBus.onRequest('headless.exec', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          const { args, waitForApproval: delegatedWait, noTrack: delegatedNoTrack, traceId } =
            req as { args: string[]; waitForApproval?: boolean; noTrack?: boolean; traceId?: string };
          if (!Array.isArray(args) || args.length === 0) {
            throw new Error('Missing delegated headless command arguments');
          }
          const payload: HeadlessExecMutationPayload = {
            args,
            waitForApproval: delegatedWait,
            noTrack: delegatedNoTrack,
            traceId,
          };
          logHeadlessExecReceived(payload, 'standalone');
          const { workflowId, priority } = classifyStandaloneHeadlessExecMutation(payload);
          const acknowledgement = acknowledgeNoTrackHeadlessExec(payload, workflowId, priority, 'standalone');
          if (acknowledgement) return acknowledgement;
          await runStandaloneWorkflowMutation(workflowId, priority, 'headless.exec', [payload], async () => {
            await runHeadless(args, {
              ...headlessDeps,
              waitForApproval: delegatedWait,
              noTrack: delegatedNoTrack,
              signal: activeMutationContext?.signal,
              mutationTiming: activeMutationContext?.mutationTiming,
            });
          });
          return { ok: true };
        });
        messageBus.onRequest('headless.gui-mutation', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          return executeStandaloneGuiMutation(req as GuiMutationPayload);
        });

        lifecycleEventBridge = startLifecycleEventBridge({
          messageBus,
          getInitialTasks: () => orchestrator.getAllTasks(),
          getTask: (taskId) => orchestrator.getTask(taskId),
          logger,
        });

        startSurfaceEventRelay({
          messageBus,
          persistence,
          orchestrator,
          logWarn: (message) => logger.warn(message, { module: 'surface-relay' }),
        });

        workerRuntimeController = createWorkerRuntimeController({
          registry: createRegisteredWorkerRegistry(),
          deps: buildRegisteredOwnerWorkerDeps(
            persistence,
            async () => {
              await createStandaloneTaskExecutor().checkMergeGateStatuses();
            },
          ),
          autoStartKinds: invokerConfig.e2eAutoFixEnabled
            ? [...AUTO_STARTED_OWNER_WORKER_KINDS, E2E_AUTOFIX_WORKER_KIND]
            : AUTO_STARTED_OWNER_WORKER_KINDS,
          persistence,
          autoFixRetries: resolveAutoFixRetries(invokerConfig),
          canControl: () => !readOnlyMode,
        });
        const reconciledWorkerActions = reconcileTerminalWorkerActionsOnStartup(persistence);
        if (reconciledWorkerActions > 0) {
          logger.info(
            `reconciled ${reconciledWorkerActions} terminal worker action(s) on startup`,
            { module: 'init' },
          );
        }
        workerRuntimeController.startAutoStartedWorkers();

        // Owner discovery and exec handlers must exist before dispatch polling starts.
        if (!readOnlyMode) {
          standaloneLaunchDispatcherController = startStandaloneLaunchDispatcher({
            headlessDeps,
            ownerId: workflowMutationOwnerId,
            createTaskExecutor: createStandaloneTaskExecutor,
            setLatestTaskExecutor: (executor) => { latestTaskExecutor = executor; },
          });
        }

        void recoverWorkflowMutationsOnStartup({
          ownerMode: true,
          persistence,
          workflowMutationCoordinator: workflowMutationCoordinator ?? undefined,
          logger,
          maybeDelayResume: maybeDelayWorkflowResumeForTest,
        });
      }

      await runHeadless(cliArgs, headlessDeps);
    } catch (err) {
      process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
      exitCode = 1;
    } finally {
      standaloneLaunchDispatcherController?.stop();
      lifecycleEventBridge?.stop();
      await workerRuntimeController?.stopAll();
      if (ownsHeadlessShutdown && executorRegistry) {
        await Promise.all(executorRegistry.getAll().map(f => f.destroyAll().catch(() => undefined)));
      }
      if (ownsHeadlessShutdown && orchestrator) {
        for (const task of orchestrator.getAllTasks()) {
          if (isTaskInFlightForForcedStop(task)) {
            if (persistence) {
              persistShutdownDiagnostic(task, persistence, { forcedStopReason: 'Application quit' });
            }
            orchestrator.handleWorkerResponse({
              requestId: `quit-${task.id}`,
              actionId: task.id,
              attemptId: task.execution.selectedAttemptId,
              executionGeneration: task.execution.generation ?? 0,
              status: 'failed',
              outputs: { exitCode: 1, error: 'Application quit' },
            });
          }
        }
      }
      if (ownsHeadlessShutdown && persistence) {
        persistence.requeueRunningWorkflowMutationIntents();
      }
      if (persistence) persistence.close();
      if (writerLock) writerLock.release();
      if (messageBus) messageBus.disconnect();
    }
    process.exit(exitCode);
  };

  runElectronReadyBootstrap({
    app,
    run: runHeadlessMain,
    onError: (err) => {
      process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  });
}

startMainProcessBootstrap({
  isHeadless,
  startHeadlessMode,
  startGuiMode: () => startGuiModeBootstrap({
    app,
    isTest: process.env.NODE_ENV === 'test',
    acquireGuiLock: () => {
      guiInstanceLock = tryAcquireGuiInstanceLock(resolveInvokerHomeRoot());
      return guiInstanceLock;
    },
    notifyGuiAlreadyRunning: () => {
      dialog.showErrorBox(
        'Invoker is already running',
        'Only one Invoker GUI can run for this Invoker home. Use the existing window, or close it before opening another one.',
      );
    },
    setupGuiMode,
  }),
});

// ══════════════════════════════════════════════════════════════
// GUI MODE
// ══════════════════════════════════════════════════════════════

function createEmbeddedTerminalBackendFromConfig(
  backend: EmbeddedTerminalBackendConfig,
): EmbeddedTerminalBackend {
  // E2E fault injection: reproduce node-pty's synchronous spawn throw (e.g.
  // a spawn-helper binary without its exec bit) without mutating the shared
  // node_modules that parallel tests rely on.
  if (process.env.INVOKER_E2E_BREAK_TERMINAL_SPAWN === '1') {
    return {
      name: 'pty',
      spawn() {
        throw new Error('posix_spawnp failed. (injected by INVOKER_E2E_BREAK_TERMINAL_SPAWN)');
      },
    };
  }
  if (backend === 'bash') return createBashTerminalBackend();
  return createPtyTerminalBackend();
}

  function setupGuiMode(): void {
  const agentRegistry = registerBuiltinAgents();
  const planningChatSessions = createInAppPlanningChatSessions();
  const planningCommandBuilder = createPlanningCommandBuilderFromRegistry(agentRegistry);
  let mainWindow: BrowserWindow | null = null;
  let taskExecutor: TaskRunner | null = null;
  let workerRuntimeController: WorkerRuntimeController | null = null;
  let apiServer: ApiServer | null = null;
  let webBridge: WebBridge | null = null;
  let ownerMode = true;
  const taskHandles: TaskHandleMap = new Map();
  const embeddedTerminalManager = new EmbeddedTerminalManager({
    backend: createEmbeddedTerminalBackendFromConfig(resolveEmbeddedTerminalBackendConfig(invokerConfig)),
  });

  embeddedTerminalManager.on('output', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('invoker:terminal-output', payload);
    }
  });
  embeddedTerminalManager.on('exit', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('invoker:terminal-exit', payload);
    }
  });
  const guiMutationHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  let dbPollInterval: { stop(): void } | null = null;
  let uiPerfLogInterval: { stop(): void } | null = null;
  let rendererTaskFeed: ReturnType<typeof createRendererTaskFeed> | null = null;
  let guiMutationTaskActions: GuiMutationTaskActions | null = null;
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
  let workflowMetadataPublisher: CoalescedWorkflowMetadataPublisher | null = null;
  let startupWorkflowId: string | null = null;
  const startupWorkflowCache = createStartupWorkflowCache();
  let uiInteractive = false;
  let deferredStartupTriggered = false;
  const traceUiDeltaFlow = process.env.INVOKER_TRACE_UI_DELTA === '1';
  const traceDbPollPerTask = process.env.INVOKER_TRACE_DB_POLL === '1';
  const traceTaskOutput = process.env.INVOKER_TRACE_TASK_OUTPUT === '1';
  const executingStallTimeoutMs = Number.parseInt(
    process.env.INVOKER_EXECUTING_STALL_TIMEOUT_MS ?? '180000',
    10,
  ) || 180000;
  const uiPerfStats = {
    mainDeltaToUi: 0,
    dbPollCreated: 0,
    dbPollUpdatedAsCreated: 0,
    dbPollUpdatedAsUpdated: 0,
    ...createRendererUiPerfCounters(),
    workflowMetadataPublishRequests: 0,
    workflowMetadataPublishes: 0,
    workflowMetadataCoalescedRequests: 0,
    largeTaskDeltaBatches: 0,
    maxTaskDeltaBatchSize: 0,
    ...createTerminalUiPerfCounters(),
  };
  const terminalUiPerf = createTerminalUiPerfReporter();
  const terminalUiPerfSink = createTerminalUiPerfSink(
    (source, level, message) => {
      persistence.writeActivityLog(source, level, message);
    },
    uiPerfStats,
  );
  const startupMarks = new Map<string, number>();
  const startupPhaseDetails: Array<Record<string, unknown>> = [];
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
  const recordStartupDuration = (phase: string, startedAtMs: number, extra?: Record<string, unknown>): void => {
    const durationMs = Date.now() - startedAtMs;
    startupPhaseDetails.push({
      phase,
      durationMs,
      ...(extra ?? {}),
    });
    recordStartupMark(phase, {
      durationMs,
      ...(extra ?? {}),
    });
  };
  const recordStartupDetail = (phase: string, details: Record<string, unknown>): void => {
    startupPhaseDetails.push({
      phase,
      ...details,
    });
    recordStartupMark(phase, details);
  };
  const timeStartupPhase = <T>(phase: string, work: () => T, extra?: (result: T) => Record<string, unknown>): T => {
    const startedAtMs = Date.now();
    const result = work();
    recordStartupDuration(phase, startedAtMs, extra?.(result));
    return result;
  };

  const resetUiPerfStats = (): void => {
    uiPerfStats.mainDeltaToUi = 0;
    uiPerfStats.dbPollCreated = 0;
    uiPerfStats.dbPollUpdatedAsCreated = 0;
    uiPerfStats.dbPollUpdatedAsUpdated = 0;
    resetRendererUiPerfCounters(uiPerfStats);
    uiPerfStats.workflowMetadataPublishRequests = 0;
    uiPerfStats.workflowMetadataPublishes = 0;
    uiPerfStats.workflowMetadataCoalescedRequests = 0;
    uiPerfStats.largeTaskDeltaBatches = 0;
    uiPerfStats.maxTaskDeltaBatchSize = 0;
    resetTerminalUiPerfCounters(uiPerfStats);
    terminalUiPerf.reset();
  };

  const getUiPerfStats = (): Record<string, unknown> => ({
    ...uiPerfStats,
    startupMarks: Object.fromEntries(startupMarks.entries()),
    startupPhaseDetails: [...startupPhaseDetails],
    ts: new Date().toISOString(),
  });

  const requireRendererTaskFeed = (): ReturnType<typeof createRendererTaskFeed> => {
    if (!rendererTaskFeed) throw new Error('Renderer task feed is unavailable');
    return rendererTaskFeed;
  };

  const requireGuiMutationTaskActions = (): GuiMutationTaskActions => {
    if (!guiMutationTaskActions) throw new Error('GUI mutation task actions are unavailable');
    return guiMutationTaskActions;
  };

  const taskDeltaStream = createTaskDeltaStreamSequence();
  const getTaskDeltaStreamSequence = (): number => taskDeltaStream.current();


  const taskGraphEventPublisher = createTaskGraphEventPublisher({
    getMainWindow: () => mainWindow,
    isUiInteractive: () => uiInteractive,
    stampDelta: (delta) => taskDeltaStream.stamp(delta),
    getStreamSequence: getTaskDeltaStreamSequence,
    onLargeBatch: ({ batchSize, remaining }) => {
      uiPerfStats.largeTaskDeltaBatches += 1;
      uiPerfStats.maxTaskDeltaBatchSize = Math.max(uiPerfStats.maxTaskDeltaBatchSize, batchSize);
      logger.info(`large task-graph-event batch chunked size=${batchSize} remaining=${remaining}`, {
        module: 'ui-backpressure',
      });
    },
    onEvent: (event) => webBridge?.broadcast('invoker:task-graph-event', event),
  });

  const requestWorkflowMetadataPublish = (reason: string): void => {
    uiPerfStats.workflowMetadataPublishRequests += 1;
    workflowMetadataPublisher?.requestPublish(reason);
  };
  function assertFatalExecutionCapacity(label: string): void {
    if (!shouldFatalOnExecutionCapacityOvercommit()) return;
    try {
      assertExecutionCapacityInvariant({
        config: loadConfig(),
        activeExecutions: taskHandles.size,
        label,
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.stack ?? err.message : String(err), { module: 'exec' });
      setImmediate(() => {
        throw err;
      });
      throw err;
    }
  }

  registerMainWindowSecondInstanceHandler({
    app,
    getMainWindow: () => mainWindow,
  });

  function rebuildTaskRunner(): void {
    rebuildTaskRunnerWiring({
      orchestrator,
      persistence,
      executorRegistry,
      executionAgentRegistry: agentRegistry,
      repoRoot,
      invokerConfig,
      logger,
      messageBus,
      taskHandles,
      enqueueTaskOutput: (taskId, data) => requireRendererTaskFeed().enqueueTaskOutput(taskId, data),
      flushTaskOutput: (taskId) => requireRendererTaskFeed().flushTaskOutput(taskId),
      assertFatalExecutionCapacity,
      getTaskRunner: () => taskExecutor,
      setTaskRunner: (runner) => { taskExecutor = runner; },
      setLatestTaskExecutor: (runner) => { latestTaskExecutor = runner; },
    });
  }

  async function killRunningTask(taskId: string): Promise<void> {
    await killRunningTaskExecution({
      getTaskRunner: () => taskExecutor,
      logger,
      taskHandles,
    }, taskId);
  }

  function requireTaskExecutor(): TaskRunner {
    return requireWiredTaskRunner(() => taskExecutor);
  }

  function createWindow(): void {
    createMainWindow({
      appRootDir: __dirname,
      invokerConfig,
      logger,
      hideE2eWindow,
      enableTestCompositor,
      recordStartupMark,
      setUiInteractive: (value) => { uiInteractive = value; },
      startDeferredStartupWork,
      setMainWindow: (window) => { mainWindow = window; },
    });
  }

  function loadTaskByIdFromPersistence(taskId: string): TaskState | undefined {
    return persistence.loadTask(taskId);
  }

  workflowMetadataPublisher = new CoalescedWorkflowMetadataPublisher({
    listWorkflows: () => persistence.listWorkflows(),
    publish: (workflows, stats) => {
      requireRendererTaskFeed().setLastKnownWorkflowCount(workflows.length);
      uiPerfStats.workflowMetadataPublishes += 1;
      uiPerfStats.workflowMetadataCoalescedRequests += Math.max(0, stats.coalescedRequests - 1);
      if (stats.coalescedRequests > 1) {
        logger.info(
          `coalesced workflow metadata publish requests=${stats.coalescedRequests} workflows=${workflows.length}`,
          { module: 'ui-backpressure', reasonCounts: stats.reasonCounts },
        );
      }
      if (!mainWindow || mainWindow.isDestroyed() || !uiInteractive) {
        return;
      }
      mainWindow.webContents.send('invoker:workflows-changed', workflows);
    },
  });

  function listWorkflowsByStartupRecency() {
    const workflows = timeStartupPhase('listWorkflowsByStartupRecency', () => persistence.listWorkflows(), (result) => ({
      workflowCount: result.length,
    }));
    return [...workflows].sort((left, right) => {
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
    startupWorkflowCache.set(workflows);
    requireRendererTaskFeed().setLastKnownWorkflowCount(workflows.length);
    startupWorkflowId = workflows[0]?.id ?? null;
    if (!startupWorkflowId) {
      logger.info('[init] No workflows available for initial startup bootstrap', { module: 'init' });
      return;
    }
    try {
      timeStartupPhase('orchestrator.restore.full-snapshot', () => orchestrator.syncAllFromDb(), () => ({
        workflowCount: workflows.length,
        taskCount: orchestrator.getAllTasks().length,
      }));
      if (writerLock?.reclaimedDeadOwner && ownerMode) {
        const preservedTaskIds = preserveCrashedInFlightTasks(
          persistence,
          orchestrator.getAllTasks(),
          writerLock.reclaimedDeadOwner,
          new Date(),
        );
        if (preservedTaskIds.length > 0) {
          orchestrator.syncAllFromDb();
          logger.warn(
            `[init] preserved ${preservedTaskIds.length} in-flight task(s) after reclaiming dead owner pid=${writerLock.reclaimedDeadOwner.pid}: ${preservedTaskIds.join(', ')}`,
            { module: 'init' },
          );
        }
      }
      const snapshotStats = (persistence as unknown as {
        getLastWorkflowTaskSnapshotStats?: () => Record<string, unknown> | null;
      }).getLastWorkflowTaskSnapshotStats?.();
      if (snapshotStats) {
        recordStartupDetail('sqlite.workflow-metadata.query', {
          durationMs: snapshotStats.workflowMetadataQueryMs,
          workflowCount: snapshotStats.workflowCount,
        });
        recordStartupDetail('sqlite.tasks.query', {
          durationMs: snapshotStats.taskQueryMs,
          taskCount: snapshotStats.taskCount,
        });
        recordStartupDetail('sqlite.workflow-rollups.compute', {
          durationMs: snapshotStats.rollupComputationMs,
          workflowCount: snapshotStats.workflowCount,
          taskCount: snapshotStats.taskCount,
        });
        recordStartupDetail('sqlite.tasks.deserialize-reconcile', {
          durationMs: snapshotStats.taskDeserializeReconcileMs,
          taskCount: snapshotStats.taskCount,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`workflow invariant violation during full startup bootstrap: ${message}`, {
        module: 'init',
        error: message,
      });
      throw err;
    }
    logger.info(
      `[init] Bootstrapped full workflow graph with ${orchestrator.getAllTasks().length} tasks across ${workflows.length} workflows`,
      { module: 'init' },
    );
    recordStartupMark('startup.full-graph.ready', {
      workflowId: startupWorkflowId,
      taskCount: orchestrator.getAllTasks().length,
      workflowCount: workflows.length,
    });
  }

  function publishOrchestratorSnapshotToRenderer(): void {
    const workflows = persistence.listWorkflows();
    const tasks = orchestrator.getAllTasks();
    const feed = requireRendererTaskFeed();
    const previousTaskIds = new Set(feed.listKnownTaskIds());
    feed.clearTaskSnapshots();
    feed.replaceWorkflowRollups(tasks);
    for (const task of tasks) {
      previousTaskIds.delete(task.id);
      feed.rememberTaskState(task);
      if (mainWindow && !mainWindow.isDestroyed()) {
        feed.publishTaskDeltaToRenderer({ type: 'created', task });
      }
    }
    feed.setLastKnownWorkflowCount(workflows.length);
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const removedTaskId of previousTaskIds) {
        feed.publishTaskDeltaToRenderer({ type: 'removed', taskId: removedTaskId, previousTaskStateVersion: 0 });
      }
      requestWorkflowMetadataPublish('orchestrator-snapshot');
    }
  }

  function executeStartReady(request: StartReadyRequest = {}): StartReadyResult {
    const result = runStartReady(orchestrator, request);
    if (!result.dryRun) {
      publishOrchestratorSnapshotToRenderer();
    }
    logger.info(
      `start-ready: ready=${result.preview.readyTaskIds.length} recoverable=${result.preview.recoverableTaskIds.length} failedWorkflows=${result.preview.failedWorkflowIds.length} recreated=${result.recreatedWorkflowIds.length} started=${result.started.length} dryRun=${result.dryRun ? 'true' : 'false'}`,
      { module: 'ipc' },
    );
    if (!result.dryRun && result.started.length > 0 && launchDispatcher) {
      try {
        launchDispatcher.poll();
      } catch (err) {
        logger.warn(
          `start-ready: launch dispatcher poll failed: ${err instanceof Error ? err.message : String(err)}`,
          { module: 'ipc' },
        );
      }
    }
    return result;
  }

  function startDeferredStartupWork(): void {
    if (deferredStartupTriggered) return;
    deferredStartupTriggered = true;
    recordStartupMark('deferred-startup.begin');
    if (ownerMode && workerRuntimeController) {
      setTimeout(() => {
        workerRuntimeController?.startAutoStartedWorkers();
        recordStartupMark('workers.auto-started');
      }, 0);
    }
    const configuredStartupPollDelayMs = Number.parseInt(process.env.INVOKER_STARTUP_POLL_DELAY_MS ?? '10000', 10);
    const startupPollDelayMs = Number.isFinite(configuredStartupPollDelayMs)
      ? configuredStartupPollDelayMs
      : 10000;

    setTimeout(() => {
      if (!ownerMode) return;

      const webMutations = new WorkflowMutationFacade({
        logger,
        orchestrator,
        persistence,
        commandService,
        taskExecutor: requireTaskExecutor(),
        autoApproveAIFixes: resolveAutoApproveAIFixes(invokerConfig),
        killRunningTask,
      });
      apiServer = startApiServer({
        logger,
        orchestrator,
        persistence,
        executorRegistry,
        mutations: webMutations,
        queueWorkflowMutation: (workflowId, priority, channel, args, options) => {
          if (!workflowMutationCoordinator) {
            throw new Error('Workflow mutation coordinator is unavailable');
          }
          return workflowMutationCoordinator.submit(workflowId, priority, channel, args, options);
        },
        deleteWorkflow: (workflowId) => requireGuiMutationTaskActions().performDeleteWorkflow(workflowId),
        detachWorkflow: (workflowId, upstreamWorkflowId) =>
          requireGuiMutationTaskActions().performDetachWorkflow(workflowId, upstreamWorkflowId),
      });
      recordStartupMark('api-server.started');

      const webToken = resolveWebToken(invokerConfig);
      if (webToken) {
        const webDispatch = buildWebInvokerDispatch({
          orchestrator,
          persistence,
          mutations: webMutations,
          agentRegistry,
          loadConfig,
          getStreamSequence: getTaskDeltaStreamSequence,
          refreshTaskGraph: async () => {
            const snapshot = await resolveRefreshTaskGraphSnapshot({
              ownerMode,
              messageBus,
              resolveInvokerHomeRoot,
              orchestrator,
              persistence,
              logger,
            });
            taskGraphEventPublisher.publishSnapshot('refresh-task-graph', snapshot.tasks, snapshot.workflows);
          },
          deleteWorkflow: (workflowId) => requireGuiMutationTaskActions().performDeleteWorkflow(workflowId),
          detachWorkflow: (workflowId, upstreamWorkflowId) =>
            requireGuiMutationTaskActions().performDetachWorkflow(workflowId, upstreamWorkflowId),
          getBundledSkillsStatus,
          getWorkers: () => workerRuntimeController?.snapshot() ?? createLocalWorkerStatusSnapshot({
            registry: createRegisteredWorkerRegistry(),
            persistence,
            autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
          }),
          getSystemDiagnostics: () => collectSystemDiagnostics({
            appVersion: app.getVersion(),
            isPackaged: app.isPackaged,
            platform: process.platform,
            arch: process.arch,
            config: resolveConfigFileState(),
            presets: invokerConfig.slackHarnessPresets ?? DEFAULT_SLACK_HARNESS_PRESETS,
            defaultPreset: invokerConfig.defaultSlackHarnessPreset ?? 'cursor+claude',
          }),
          logger,
        });
        webBridge = startWebBridge({
          logger,
          dispatch: webDispatch,
          messageBus,
          persistence,
          uiDistDir: resolveWebUiDistDir(__dirname),
          token: webToken,
          host: resolveWebHost(invokerConfig),
          port: resolveWebPort(invokerConfig),
        });
      } else {
        logger.info('Web surface disabled — set INVOKER_WEB_TOKEN (or config.webToken) to enable it', { module: 'web-bridge' });
      }

      void recoverWorkflowMutationsOnStartup({
        ownerMode,
        persistence,
        workflowMutationCoordinator: workflowMutationCoordinator ?? undefined,
        logger,
        maybeDelayResume: maybeDelayWorkflowResumeForTest,
      });


      setTimeout(() => {
        if (ownerMode) {
          dbPollInterval = requireRendererTaskFeed().startDbPolling();
        }
      }, startupPollDelayMs).unref?.();
    }, 0);
  }

  const runGuiReadyBootstrap = async (): Promise<void> => {
    recordStartupMark('app.whenReady');
    const guiOwnerPreference = resolveGuiOwnerPreference();
    let daemonGuiOwner = false;
    if (guiOwnerPreference === 'daemon') {
      try {
        recordStartupMark('daemonOwner.ensure.start');
        await ensureStandaloneOwnerForGui();
        recordStartupMark('daemonOwner.ensure.end');
        daemonGuiOwner = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const fallbackMessage = formatGuiOwnerBootstrapFallbackMessage(message);
        logger.warn(fallbackMessage, { module: 'init' });
        process.stderr.write(`${YELLOW}Warning:${RESET} ${fallbackMessage}\n`);
        daemonGuiOwner = false;
      }
    } else if (guiOwnerPreference === 'auto') {
      recordStartupMark('daemonOwner.discover.start');
      try {
        daemonGuiOwner = await discoverStandaloneOwnerForGui(1_000);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`daemon owner auto-discovery failed; starting GUI owner locally: ${message}`, { module: 'init' });
        daemonGuiOwner = false;
      }
      recordStartupMark('daemonOwner.discover.end', { daemonOwner: daemonGuiOwner });
    }

    if (daemonGuiOwner) {
      ownerMode = false;
      guiUsingDaemonOwner = true;
      daemonOwnerLoss.clearConnectionLost();
      try {
        recordStartupMark('initServices.readOnly.start');
        await initServices({ detachedViewer: true, executionAgentRegistry: agentRegistry, startupSyncMode: 'none' });
        recordStartupMark('initServices.readOnly.end', { ownerMode: false, daemonOwner: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${RED}Error:${RESET} ${message}\n`);
        app.quit();
        return;
      }
    } else {
      ownerMode = true;
      guiUsingDaemonOwner = false;
      daemonOwnerLoss.clearConnectionLost();
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
        const owner = await discoverOwner(messageBus, 1500);
        if (!isStandaloneCapable(owner)) {
          process.stderr.write(`${RED}Error:${RESET} ${message}\n`);
          process.stderr.write(`${RED}Detached viewer fallback requires a reachable owner, but no owner answered IPC.\n${RESET}`);
          app.quit();
          return;
        }
        recordStartupMark('initServices.readOnly.start', { ownerId: owner.ownerId });
        await initServices({ detachedViewer: true, executionAgentRegistry: agentRegistry, startupSyncMode: 'none' });
        ownerMode = false;
        guiUsingDaemonOwner = false;
        daemonOwnerLoss.clearConnectionLost();
        recordStartupMark('initServices.readOnly.end', { ownerMode: false, ownerId: owner.ownerId });
      }
    }

    rendererTaskFeed = createRendererTaskFeed({
      logger,
      persistence,
      messageBus,
      getOrchestrator: () => orchestrator,
      taskHandles,
      taskGraphEventPublisher,
      getMainWindow: () => mainWindow,
      setStartupWorkflowId: (workflowId) => { startupWorkflowId = workflowId; },
      requestWorkflowMetadataPublish,
      scheduleAutoFix: (taskId) => requireGuiMutationTaskActions().scheduleAutoFix(taskId),
      logAutoFixDebug: (taskId, phase, details) =>
        requireGuiMutationTaskActions().logAutoFixDebug(taskId, phase, details),
      uiPerfStats,
      traceUiDeltaFlow,
      traceDbPollPerTask,
      traceTaskOutput,
      executingStallTimeoutMs,
      pollLaunchDispatcher: () => {
        if (launchDispatcher) launchDispatcher.poll();
      },
    });

    const mutationActions = createGuiMutationTaskActions({
      logger,
      persistence,
      messageBus,
      executorRegistry,
      agentRegistry,
      repoRoot,
      invokerConfig,
      effectiveMaxConcurrency,
      taskHandles,
      getOrchestrator: () => orchestrator,
      setOrchestrator: (nextOrchestrator) => { orchestrator = nextOrchestrator; },
      getCommandService: () => commandService,
      setCommandService: (nextCommandService) => { commandService = nextCommandService; },
      getWorkflowMutationCoordinator: () => workflowMutationCoordinator,
      workflowMutationDispatcher,
      getActiveMutationContext: () => activeMutationContext,
      getRendererTaskFeed: requireRendererTaskFeed,
      getStartupWorkflowId: () => startupWorkflowId,
      getLaunchDispatcher: () => launchDispatcher,
      requireTaskExecutor,
      getTaskExecutor: () => taskExecutor,
      rebuildTaskRunner,
      initServices,
      requestWorkflowMetadataPublish,
      cancelDeferredWorkflowLaunch,
      killRunningTask,
      buildCommandServiceInvalidationDeps,
    });
    guiMutationTaskActions = mutationActions;

    const guiMutationRegistrationContext: GuiMutationRegistrationContext = {
      ipcMain,
      getOwnerMode: () => ownerMode,
      getMessageBus: () => messageBus,
      refreshOwnerRoute: refreshGuiMutationOwnerRoute,
      onMutationOwnerUnavailable: markDaemonOwnerUnavailable,
      translateGuiMutationToHeadless: (payload) => mutationActions.translateGuiMutationToHeadless(payload),
      guiMutationHandlers,
    };

    const workflowScopedGuiMutationRegistrationContext: WorkflowScopedGuiMutationRegistrationContext = {
      ...guiMutationRegistrationContext,
      workflowMutationDispatcher,
      submitWorkflowMutation: mutationActions.submitWorkflowMutation,
    };

    const registrars = createGuiMutationRegistrars(
      guiMutationRegistrationContext,
      workflowScopedGuiMutationRegistrationContext,
    );

    if (ownerMode) {
      registerTerminalSessionPersistence({
        embeddedTerminalManager,
        persistence,
        uiPerfStats,
        terminalUiPerf,
        terminalUiPerfSink,
      });
    }

    if (ownerMode) {
      rebuildTaskRunner();
      workflowMutationCoordinator = new PersistedWorkflowMutationCoordinator(
        persistence,
        workflowMutationOwnerId,
        async (channel: string, args: unknown[], context) => {
          const handler = workflowMutationDispatcher.get(channel);
          if (!handler) {
            throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
          }
          activeMutationContext = context;
          try {
            return await handler(...args);
          } finally {
            activeMutationContext = undefined;
          }
        },
        {
          logger,
          onIntentFailed: (event) => {
            if (!mainWindow || mainWindow.isDestroyed() || !uiInteractive) return;
            mainWindow.webContents.send('invoker:workflow-mutation-failed', event);
          },
        },
      );
      launchDispatcher = new LaunchDispatcher({
        persistence,
        orchestrator,
        // taskExecutor is re-built by rebuildTaskRunner(); read via
        // a provider so the dispatcher always picks up the current
        // instance instead of capturing a stale reference.
        taskRunnerProvider: () => taskExecutor,
        ownerId: workflowMutationOwnerId,
        logger,
      });
    } else {
      logger.info('Launched in follower mode; mutation execution is delegated to the current owner', {
        module: 'init',
      });
    }

    // ── IPC Delegation Handlers — peer → owner ────────────────
    // Peer processes delegate write-heavy commands to the owner process via IpcBus.
    if (ownerMode) {
      workflowMutationDispatcher.set('headless.exec', async (payloadArg: unknown) => {
        return mutationActions.executeHeadlessExec(payloadArg as HeadlessExecMutationPayload);
      });
      workflowMutationDispatcher.set('invoker:start-ready', async (requestArg: unknown) =>
        executeStartReady(requestArg as StartReadyRequest | undefined),
      );
      workflowMutationDispatcher.set('api:approve-task', async (taskIdArg: unknown) => {
        await mutationActions.performSharedApproveTask(String(taskIdArg), 'api');
      });
      workflowMutationDispatcher.set('api:reject-task', async (taskIdArg: unknown, reasonArg?: unknown) => {
        const taskId = String(taskIdArg);
        const reason = reasonArg === undefined ? undefined : String(reasonArg);
        const envelope = makeEnvelope('reject', 'surface', 'task', { taskId, reason });
        const result = await commandService.reject(envelope);
        if (!result.ok) throw new Error(result.error.message);
      });
      workflowMutationDispatcher.set('surface:approve-task', async (taskIdArg: unknown) => {
        await mutationActions.performSharedApproveTask(String(taskIdArg), 'surface');
      });
      messageBus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: workflowMutationOwnerId,
        mode: 'gui',
      }));
      messageBus.onRequest('headless.query', async (req: unknown) =>
        answerOwnerHeadlessQuery(req, buildOwnerReadQueryHandlers({
          ownerModeLabel: 'gui',
          getUiPerfStats: () => getUiPerfStats(),
          resetUiPerfStats: () => resetUiPerfStats(),
          getWorkerStatus: () => workerRuntimeController?.snapshot() ?? createLocalWorkerStatusSnapshot({
            registry: createRegisteredWorkerRegistry(),
            persistence,
            autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
          }),
          getWorkers: () => workerRuntimeController?.snapshot() ?? createLocalWorkerStatusSnapshot({
            registry: createRegisteredWorkerRegistry(),
            persistence,
            autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
          }),
          getStreamSequence: () => getTaskDeltaStreamSequence(),
          resolveInvokerHomeRoot,
          orchestrator,
          persistence,
          getActionGraphSnapshot: () =>
            buildCurrentActionGraphSnapshot({ orchestrator, persistence, invokerConfig }) as unknown as Record<string, unknown>,
        }), {
          orchestrator,
          persistence,
          invokerConfig,
          executionAgentRegistry: agentRegistry,
          getUiPerfStats,
          resetUiPerfStats,
          getWorkerStatus: () => workerRuntimeController?.snapshot() ?? { generatedAt: new Date().toISOString(), workers: [] },
        }));
      messageBus.onRequest('headless.run', async (req: unknown) => {
        const { planPath, traceId } = req as { planPath: string; traceId?: string };
        logger.info(
          `headless.run received trace=${traceId ?? '<none>'} planPath="${planPath}" ownerId=${workflowMutationOwnerId} mode=gui`,
          { module: 'ipc-delegate' },
        );
        const result = await mutationActions.executeHeadlessRun({ planPath });
        logger.info(
          `headless.run accepted trace=${traceId ?? '<none>'} workflow="${result.workflowId}" tasks=${result.tasks.length} mode=gui`,
          { module: 'ipc-delegate' },
        );
        return result;
      });

      messageBus.onRequest('headless.resume', async (req: unknown) => {
        const { workflowId, traceId } = req as { workflowId: string; traceId?: string };
        logger.info(
          `headless.resume received trace=${traceId ?? '<none>'} workflowId="${workflowId}" ownerId=${workflowMutationOwnerId} mode=gui`,
          { module: 'ipc-delegate' },
        );
        const result = await mutationActions.executeHeadlessResume({ workflowId });
        logger.info(
          `headless.resume accepted trace=${traceId ?? '<none>'} workflow="${result.workflowId}" tasks=${result.tasks.length} mode=gui`,
          { module: 'ipc-delegate' },
        );
        return result;
      });

      messageBus.onRequest('headless.exec', async (req: unknown) => {
        const { args, waitForApproval: delegatedWait, noTrack: delegatedNoTrack, traceId } =
          req as { args: string[]; waitForApproval?: boolean; noTrack?: boolean; traceId?: string };
        if (!Array.isArray(args) || args.length === 0) {
          throw new Error('Missing delegated headless command arguments');
        }
        const payload: HeadlessExecMutationPayload = {
          args,
          waitForApproval: delegatedWait,
          noTrack: delegatedNoTrack,
          traceId,
        };
        logHeadlessExecReceived(payload, 'gui');
        const { workflowId, priority } = mutationActions.classifyHeadlessExecMutation(payload);
        const acknowledgement = acknowledgeNoTrackHeadlessExec(payload, workflowId, priority, 'gui');
        if (acknowledgement) return acknowledgement;
        return mutationActions.runWorkflowMutation(
          workflowId,
          priority,
          'headless.exec',
          [payload],
          async () => mutationActions.executeHeadlessExec(payload),
        );
      });
      messageBus.onRequest('headless.batch-exec', async (req: unknown) => {
        const request = req as HeadlessBatchExecRequest;
        const itemCount = Array.isArray(request.items) ? request.items.length : 0;
        logger.info(`headless.batch-exec received items=${itemCount} noTrack=${request.noTrack ? 'true' : 'false'} mode=gui`, {
          module: 'ipc-delegate',
        });
        if (!workflowMutationCoordinator) {
          throw new Error('Workflow mutation coordinator is unavailable');
        }
        const coordinator = workflowMutationCoordinator;
        const results = executeNoTrackHeadlessBatch(request, {
          classify: mutationActions.classifyHeadlessExecMutation,
          submit: (workflowId, priority, channel, args, options) =>
            coordinator.submit(workflowId, priority, channel, args, options),
        });
        const accepted = results.filter((result) => result.ok).length;
        logger.info(`headless.batch-exec accepted=${accepted} failed=${results.length - accepted} mode=gui`, {
          module: 'ipc-delegate',
        });
        return results;
      });
      messageBus.onRequest('headless.gui-mutation', async (req: unknown) => {
        const payload = req as GuiMutationPayload;
        const handler = guiMutationHandlers.get(payload.channel);
        if (!handler) {
          throw new Error(`No GUI mutation handler registered for channel: ${payload.channel}`);
        }
        const mutationArgs = Array.isArray(payload.args) ? payload.args : [];
        logger.info(`headless.gui-mutation received channel=${payload.channel} mode=gui`, { module: 'ipc-delegate' });
        return handler(...mutationArgs);
      });
      logger.info(`owner-ipc-ready ownerId=${workflowMutationOwnerId}`, { module: 'ipc-delegate' });
      recordStartupMark('owner-ipc-ready');
    }

    if (ownerMode) {
      bootstrapInitialWorkflowState();
      startLifecycleEventBridge({
        messageBus,
        getInitialTasks: () => orchestrator.getAllTasks(),
        getTask: (taskId) => orchestrator.getTask(taskId),
        logger,
      });
      startSurfaceEventRelay({
        messageBus,
        persistence,
        orchestrator,
        logWarn: (message) => logger.warn(message, { module: 'surface-relay' }),
      });
    }

    if (ownerMode) {
      workerRuntimeController = createWorkerRuntimeController({
        registry: createRegisteredWorkerRegistry(),
        deps: buildRegisteredOwnerWorkerDeps(
          persistence,
          async () => {
            await requireTaskExecutor().checkMergeGateStatuses();
          },
        ),
        autoStartKinds: invokerConfig.e2eAutoFixEnabled
          ? [...AUTO_STARTED_OWNER_WORKER_KINDS, E2E_AUTOFIX_WORKER_KIND]
          : AUTO_STARTED_OWNER_WORKER_KINDS,
        persistence,
        autoFixRetries: resolveAutoFixRetries(invokerConfig),
        canControl: () => ownerMode,
      });
    }

    // Fail orphaned in-flight tasks left by a previous crash, then start ready work.
    if (!ownerMode) {
      logger.info('follower mode startup: auto-run disabled', { module: 'init' });
    } else {
      setTimeout(() => {
        if (!ownerMode) return;
        try {
          const reconciledWorkerActions = reconcileTerminalWorkerActionsOnStartup(persistence);
          if (reconciledWorkerActions > 0) {
            logger.info(
              `reconciled ${reconciledWorkerActions} terminal worker action(s) on startup`,
              { module: 'init' },
            );
          }
          const orphaned = reconcileOrphanedInFlightTasksOnBoot({
            orchestrator,
            persistence,
          });
          if (orphaned.length > 0) {
            logger.info(
              `failed ${orphaned.length} orphaned in-flight task(s) left by a previous owner crash`,
              { module: 'init', taskIds: orphaned.map((task) => task.id) },
            );
          }
          if (invokerConfig.disableAutoRunOnStartup) {
            logger.info('auto-run on startup disabled by config', { module: 'init' });
          } else {
            orchestrator.startExecution();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`deferred owner startup maintenance failed: ${message}`, { module: 'init' });
        }
      }, 0);
    }

    const dbPath = path.join(resolveInvokerHomeRoot(), 'invoker.db');
    logger.info(`IPC socket: ${resolveInvokerIpcSocketPath()}`, { module: 'init' });
    logger.info(`Database: ${dbPath}`, { module: 'init' });
    logger.info(`Repo root: ${repoRoot}`, { module: 'init' });
    logger.info(`Config: disableAutoRunOnStartup=${invokerConfig.disableAutoRunOnStartup ?? false}`, { module: 'init' });
    logger.info('Effective configuration', { config: getSafeInvokerConfigForLogging(invokerConfig), module: 'startup' });
    recordStartupMark('startup.ready-for-window');

    if (!ownerMode) {
      requireRendererTaskFeed().beginDetachedViewerBuffering();
    }
    messageBus.subscribe(Channels.TASK_DELTA, (delta: unknown) => {
      requireRendererTaskFeed().receiveTaskDelta(delta as TaskDelta);
    });

    uiPerfLogInterval = requireRendererTaskFeed().startActivityPolling();

    messageBus.subscribe(Channels.TASK_OUTPUT, (data: unknown) => {
      if (mainWindow && !mainWindow.isDestroyed() && uiInteractive) {
        mainWindow.webContents.send('invoker:task-output', data);
      }
    });

    const computeRuntimeStatus = () => {
      if (process.env.NODE_ENV === 'test' && process.env.INVOKER_E2E_FORCE_CONNECTION_LOST_STATUS === '1') {
        return { ownerMode: false, readOnly: true, mode: 'connection-lost' as const };
      }
      if (process.env.NODE_ENV === 'test' && process.env.INVOKER_E2E_FORCE_READ_ONLY_STATUS === '1') {
        return { ownerMode: false, readOnly: true, mode: 'read-only' as const };
      }
      return computeGuiRuntimeStatus({ ownerMode, guiUsingDaemonOwner, connectionLost: guiDaemonOwnerConnectionLost });
    };
    daemonOwnerLoss.setNotify(() => { if (mainWindow && !mainWindow.isDestroyed() && uiInteractive) mainWindow.webContents.send('invoker:runtime-status', computeRuntimeStatus()); });

    registerBootstrapStateIpc({
      ipcMain,
      getTasks: () => (ownerMode ? orchestrator.getAllTasks() : requireRendererTaskFeed().getDetachedViewerTasks()),
      getWorkflows: () =>
        requireRendererTaskFeed().getDetachedViewerWorkflows()
          ?? startupWorkflowCache.takeOrLoad(listWorkflowsByStartupRecency),
      getInitialWorkflowId: () => startupWorkflowId,
      appStartedAtEpochMs: appProcessStartedAt,
      getTaskDeltaStreamSequence,
      recordStartupDuration,
    });
    await registerGuiMutationIpcHandlers({
      ipcMain,
      app,
      logger,
      persistence,
      messageBus,
      executorRegistry,
      agentRegistry,
      repoRoot,
      invokerConfig,
      effectiveMaxConcurrency,
      taskHandles,
      getOwnerMode: () => ownerMode,
      getWorkerRuntimeController: () => workerRuntimeController,
      requireTaskExecutor,
      getTaskExecutor: () => taskExecutor,
      rebuildTaskRunner,
      initServices,
      requestWorkflowMetadataPublish,
      cancelDeferredWorkflowLaunch,
      killRunningTask,
      buildCommandServiceInvalidationDeps,
      getOrchestrator: () => orchestrator,
      setOrchestrator: (nextOrchestrator) => { orchestrator = nextOrchestrator; },
      getCommandService: () => commandService,
      setCommandService: (nextCommandService) => { commandService = nextCommandService; },
      getWorkflowMutationCoordinator: () => workflowMutationCoordinator,
      workflowMutationDispatcher,
      getActiveMutationContext: () => activeMutationContext,
      getRendererTaskFeed: requireRendererTaskFeed,
      getStartupWorkflowId: () => startupWorkflowId,
      getLaunchDispatcher: () => launchDispatcher,
      getMainWindow: () => mainWindow,
      registrars,
      actions: mutationActions,
      planningChatSessions,
      planningCommandBuilder,
      emitPlanningChatStream: (event) => {
        if (mainWindow && !mainWindow.isDestroyed() && uiInteractive) {
          mainWindow.webContents.send('invoker:planning-chat-stream', event);
        }
      },
      taskGraphEventPublisher,
      loadTaskByIdFromPersistence,
      markDaemonOwnerUnavailable,
      recordStartupDuration,
      getTaskDeltaStreamSequence,
      computeRuntimeStatus,
      getUiPerfStats,
      uiPerfStats,
      createRegisteredWorkerRegistry,
      buildCliInstallerContext,
      resolveSetupCliPath,
      getBundledSkillsStatus,
      installPackagedSkills,
    });

    ipcMain.handle('invoker:get-workers', async () => {
      if (!ownerMode) {
        try {
          return await messageBus.request('headless.query', { kind: 'workers' });
        } catch (err) {
          if (isMutationOwnerUnavailableError(err)) markDaemonOwnerUnavailable(err instanceof Error ? err.message : String(err));
          logger.warn(
            `get-workers owner delegation failed; falling back to local read-only snapshot: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { module: 'ipc' },
          );
        }
        return createLocalWorkerStatusSnapshot({
          registry: createRegisteredWorkerRegistry(),
          persistence,
          autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
        });
      }
      return workerRuntimeController?.snapshot() ?? createLocalWorkerStatusSnapshot({
        registry: createRegisteredWorkerRegistry(),
        persistence,
        autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
      });
    });

    ipcMain.handle('invoker:get-activity-logs', (_event, sinceId?: number, limit?: number) => {
      return persistence.getActivityLogs(sinceId ?? 0, limit ?? 2000);
    });

    ipcMain.handle('invoker:open-terminal', async (_event, taskId: string) => {
      logger.info(`invoked for task="${taskId}"`, { module: 'open-terminal' });
      const liveHandle = taskHandles.get(taskId);
      const resolved = resolveTaskTerminalSpec({
        taskId,
        persistence,
        executorRegistry,
        executionAgentRegistry: agentRegistry,
        repoRoot,
        logger,
        // If a live executor handle exists we can safely attach instead of
        // refusing — embedded mode is designed for this case.
        allowRunning: Boolean(liveHandle),
        runningTaskReason:
          'Task is still running or being fixed with AI. View output in the terminal panel below.',
      });
      if (!resolved.ok) {
        return { opened: false, reason: resolved.reason };
      }
      try {
        const session = embeddedTerminalManager.openOrReuse({
          taskId,
          spec: resolved.spec,
          cwd: resolved.cwd,
          attach: liveHandle ? { handle: liveHandle.handle, executor: liveHandle.executor } : undefined,
        });
        return { opened: true, session };
      } catch (err) {
        // A backend spawn failure (e.g. node-pty's spawn-helper missing its
        // exec bit) must surface as a visible refusal, not a rejected IPC
        // promise the renderer drops silently.
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(`terminal session spawn failed for task="${taskId}": ${reason}`, { module: 'open-terminal' });
        return { opened: false, reason: `Failed to start terminal session: ${reason}` };
      }
    });

    registerPlanningTerminalSessionIpcHandlers({
      ipcMain,
      embeddedTerminalManager,
      logger,
      planningChatSessions,
      getPlanningSessionStore: () => (ownerMode ? persistence : undefined),
      repoRoot,
    });

    registerTerminalSessionIpcHandlers({
      ipcMain,
      embeddedTerminalManager,
      persistence,
      uiPerfStats,
      terminalUiPerf,
      terminalUiPerfSink,
    });

    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildAppMenuTemplate({
          isMac: process.platform === 'darwin',
          onUpdateInvokerCli: updateInvokerCliFromMenu,
        }),
      ),
    );

    if (ownerMode) {
      requireRendererTaskFeed().seedUiSnapshotCache();
    } else {
      await requireRendererTaskFeed().hydrateDetachedViewerFromOwner();
    }
    createWindow();
    recordStartupMark('createWindow.end');

    setTimeout(() => {
      try {
        maybeAutoInstallCli(buildCliInstallerContext(), (message) =>
          logger.info(message, { module: 'cli-installer' }),
        );
      } catch (err) {
        logger.warn(`invoker-cli auto-install failed: ${err}`, { module: 'cli-installer' });
      }
    }, 0);

    registerMainWindowActivateHandler({
      app,
      createWindow,
    });
  };

  runElectronReadyBootstrap({
    app,
    run: runGuiReadyBootstrap,
    onError: (err) => {
      process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
      app.quit();
    },
  });

  let isQuitting = false;
  registerGuiLifecycleHandlers(app, {
    onWindowAllClosed: () => {
      logger.info('window-all-closed', { module: 'window' });
      if (process.platform !== 'darwin') {
        app.quit();
      }
    },
    onBeforeQuit: async (event) => {
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
        embeddedTerminalManager.closeAll({ preserveForRestart: true });
        await workerRuntimeController?.stopAll();
        dbPollInterval?.stop();
        uiPerfLogInterval?.stop();
        if (hourlyBackupInterval) {
          clearInterval(hourlyBackupInterval);
          hourlyBackupInterval = null;
        }

        embeddedTerminalManager.closeAll();
        if (executorRegistry) {
          await Promise.all(executorRegistry.getAll().map(f => f.destroyAll()));
        }
        if (orchestrator) {
          for (const task of orchestrator.getAllTasks()) {
            if (task.status === 'running' || task.status === 'fixing_with_ai') {
              if (persistence) {
                persistShutdownDiagnostic(task, persistence, {
                  flushPendingOutput: (taskId) => rendererTaskFeed?.flushTaskOutput(taskId),
                  forcedStopReason: 'Application quit',
                });
              }
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
        if (persistence) {
          persistence.requeueRunningWorkflowMutationIntents();
          persistence.close();
        }
        guiInstanceLock?.release();
        guiInstanceLock = null;
        if (writerLock) writerLock.release();
        if (messageBus) messageBus.disconnect();
      } finally {
        clearTimeout(safetyTimer);
        logger.info('before-quit end -> app.exit(0)', { module: 'process' });
        app.exit(0);
      }
    },
  });

}
