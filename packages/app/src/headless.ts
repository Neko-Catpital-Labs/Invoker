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

import type { BundledSkillsInstallMode } from '@invoker/contracts';
import { makeEnvelope } from '@invoker/contracts';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import {
  AUTO_FIX_WORKER_KIND,
  TaskRunner,
  acquireWorkerLock,
  createAutoFixAttemptLedger,
  createWorkerRegistry,
  registerBuiltinWorkers,
  resolveInvokerHomeRoot,
  GitHubMergeGateProvider,
  WorkerLockHeldError,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import {
  parseMetadataValue,
  setTaskMetadata,
  setWorkflowMetadata,
} from './metadata-setter.js';
import {
  deleteAllWorkflows as sharedDeleteAllWorkflows,
  setWorkflowMergeMode,
} from './workflow-actions.js';
import { normalizeMergeModeForPersistence } from './merge-mode.js';
import { resolvePrMaintenanceWorkerConfig } from './config.js';
import {
  isDispatchableLaunch,
} from './global-topup.js';
import { LaunchDispatcher } from './launch-dispatcher.js';
import { formatHeadlessSetSubcommands } from './headless-command-registry.js';
import { registerExternalWorkersFromConfig } from './external-worker-loader.js';

export {
  DEFAULT_DELEGATION_TIMEOUT_MS,
  WORKFLOW_DELEGATION_TIMEOUT_MS,
  delegationTimeoutMs,
  isDelegated,
  resolveDelegationTimeoutMs,
  tryDelegateExec,
  tryDelegateQuery,
  tryDelegateResume,
  tryDelegateRun,
} from './headless-delegation.js';
export type { DelegationOutcome } from './headless-delegation.js';

import {
  type HeadlessDeps,
  type QueryFlags,
  BOLD,
  RESET,
  YELLOW,
  createHeadlessExecutor,
  wireHeadlessApproveHook,
  parseQueryFlags,
  trackHeadlessWorkflow,
  restoreWorkflowForTask,
  restoreWorkflowForTaskUnlessDeleteAllWon,
  withRestoredTaskUnlessDeleteAllWon,
} from './headless-shared.js';

export { createHeadlessExecutor, wireHeadlessApproveHook, parseQueryFlags };
export type { HeadlessDeps, QueryFlags };
import { headlessQuery, headlessQuerySelect, renderWorkerStatus } from './headless-query-list.js';
export { resolveAgentSession } from './headless-query-list.js';
import {
  headlessRun,
  headlessStartReady,
  headlessResume,
  headlessWatch,
  headlessRetryWorkflow,
  headlessRetryTask,
  headlessRecreateWorkflow,
  headlessRecreateTask,
  headlessRecreateDownstream,
  headlessForkWorkflow,
  headlessRebaseRetry,
  headlessRebaseRecreate,
  headlessRepairReviewGateCi,
  headlessFix,
  headlessResolveConflict,
} from './headless-run-resume.js';
import {
  headlessApprove,
  headlessReject,
  headlessInput,
  headlessSelect,
  headlessCancel,
  headlessCancelWorkflow,
  headlessDeleteWorkflow,
  headlessDeleteTask,
  headlessDetachWorkflow,
  headlessOpenTerminal,
} from './headless-approve-delete.js';

async function dispatchHeadlessRunnableTasks(
  deps: HeadlessDeps,
  taskExecutor: TaskRunner,
  runnable: TaskState[],
  context: string,
): Promise<void> {
  if (runnable.length === 0) return;

  const dispatcher = new LaunchDispatcher({
    persistence: deps.persistence,
    orchestrator: {
      prepareTaskForNewAttempt: (taskId, reason) =>
        deps.orchestrator.prepareTaskForNewAttempt(taskId, reason),
      syncFromDb: (workflowId) => deps.orchestrator.syncFromDb(workflowId),
      getTask: (taskId) => deps.orchestrator.getTask(taskId),
      getTaskLaunchReadiness: (taskId) => deps.orchestrator.getTaskLaunchReadiness(taskId),
    },
    taskRunnerProvider: () => taskExecutor,
    ownerId: `headless-${process.pid}`,
    logger: deps.logger,
  });
  deps.logger?.debug?.(
    `[headless] ${context}: polling local launch dispatcher for ${runnable.length} runnable task(s)`,
    { module: 'headless' },
  );
  const poll = (): void => {
    try {
      dispatcher.poll();
    } catch (err) {
      deps.logger?.warn?.(
        `[headless] ${context}: local launch dispatcher poll failed: ${err instanceof Error ? err.message : String(err)}`,
        { module: 'headless' },
      );
    }
  };
  poll();
  const timer = setInterval(poll, 250);
  timer.unref?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
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

// ── Set Router ──────────────────────────────────────────────

async function headlessSet(args: string[], deps: HeadlessDeps): Promise<void> {
  const subCommand = args[0];
  if (!subCommand) {
    throw new Error(`Missing set sub-command. Usage: --headless set <${formatHeadlessSetSubcommands('|')}>`);
  }

  switch (subCommand) {
    case 'command':
      await headlessEdit(args[1], args.slice(2).join(' '), deps);
      break;
    case 'prompt':
      await headlessEditPrompt(args[1], args.slice(2).join(' '), deps);
      break;
    case 'pool':
    case 'executor':
      await headlessEditExecutor(args[1], args[2], args[3], deps);
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
    case 'workflow':
      await headlessSetWorkflowMetadata(args[1], args[2], args.slice(3).join(' '), deps);
      break;
    case 'task':
      await headlessSetTaskMetadata(args[1], args[2], args.slice(3).join(' '), deps);
      break;
    default:
      throw new Error(`Unknown set sub-command: "${subCommand}". Use: ${formatHeadlessSetSubcommands(', ')}`);
  }
}

async function headlessMigrateCompatibility(deps: HeadlessDeps): Promise<void> {
  const report = deps.persistence.runCompatibilityMigration();
  process.stdout.write(`${BOLD}Compatibility migration complete.${RESET}\n`);
  process.stdout.write(`  migratedFixingWithAiStatuses: ${report.migratedFixingWithAiStatuses}\n`);
  process.stdout.write(`  normalizedMergeModes: ${report.normalizedMergeModes}\n`);
  process.stdout.write(`  staleAutoFixExperimentTasks: ${report.staleAutoFixExperimentTasks}\n`);
  process.stdout.write(`  normalizedLegacyAcknowledgedLaunchDispatches: ${report.normalizedLegacyAcknowledgedLaunchDispatches}\n`);
}

async function headlessInstallSkills(
  mode: BundledSkillsInstallMode | undefined,
  deps: Pick<HeadlessDeps, 'installBundledSkills'>,
): Promise<void> {
  if (!deps.installBundledSkills) {
    throw new Error('Bundled AI helper installation is not available in this runtime.');
  }
  const status = deps.installBundledSkills(mode ?? 'install');
  process.stdout.write(`Installed ${status.bundledSkillNames.length} bundled AI helpers with prefix "${status.managedPrefix}".\n`);
  for (const target of status.targets) {
    process.stdout.write(`Skill target (${target.name}): ${target.path}\n`);
  }
  for (const target of status.commandTargets) {
    process.stdout.write(`Command target (${target.name}): ${target.path}\n`);
  }
  for (const target of status.mcpTargets) {
    process.stdout.write(`MCP target (${target.name}): ${target.path}\n`);
  }
  for (const skillName of status.bundledSkillNames) {
    process.stdout.write(`- ${status.managedPrefix}${skillName}\n`);
  }
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
    case 'install-skills':
      await headlessInstallSkills(
        args[1] === 'reinstall' || args[1] === 'update' ? args[1] : 'install',
        deps,
      );
      break;
    case 'watch':
      await headlessWatch(args[1], deps);
      break;

    // ── Execute (unchanged) ──
    case 'run':
      await headlessRun(args[1], deps, deps.waitForApproval, deps.noTrack);
      break;
    case 'start-ready':
      await headlessStartReady(args.slice(1), deps);
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
    case 'recreate-downstream':
      await headlessRecreateDownstream(args[1], deps);
      break;
    case 'replace-task':
      throw new Error(
        'Headless replace-task is disabled because it is not a safe supported CLI flow. ' +
        'Use the UI replace-task flow instead.',
      );
    case 'fork-workflow':
      await headlessForkWorkflow(args[1], deps);
      break;
    case 'detach-workflow':
      await headlessDetachWorkflow(args[1], args[2], deps);
      break;
    case 'rebase-retry':
      await headlessRebaseRetry(args[1], deps);
      break;
    case 'rebase-recreate':
      await headlessRebaseRecreate(args[1], deps);
      break;
    case 'repair-review-gate-ci':
      await headlessRepairReviewGateCi(args[1], deps);
      break;
    case 'fix':
      await headlessFix(args, deps);
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
    case 'delete-task':
      await headlessDeleteTask(args[1], deps);
      break;
    case 'delete':
    case 'delete-workflow':
      await headlessDeleteWorkflow(args[1], deps);
      break;
    case 'delete-all':
      assertDeleteAllEnabled();
      {
        const { snapshotPath } = await sharedDeleteAllWorkflows({
          logger: deps.logger,
          orchestrator: deps.orchestrator,
        });
        if (snapshotPath) {
          process.stderr.write(`[headless] delete-all snapshot: ${snapshotPath}\n`);
        } else {
          process.stderr.write('[headless] delete-all snapshot skipped: DB file does not exist yet\n');
        }
      }
      process.stdout.write('All workflows deleted.\n');
      break;
    case 'open-terminal':
      await headlessOpenTerminal(args[1], deps);
      break;
    case 'query-select':
      await headlessQuerySelect(args[1], deps);
      break;
    case 'worker':
      await headlessWorker(args.slice(1), deps);
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
      warnDeprecated(command, 'set pool');
      await headlessSet(['pool', ...args.slice(1)], deps);
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

async function headlessWorker(args: string[], deps: HeadlessDeps): Promise<void> {
  const subCommand = args[0] ?? 'list';
  const registry = registerExternalWorkersFromConfig(
    deps.invokerConfig?.externalWorkers,
    registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>()),
  );

  if (subCommand === 'list') {
    process.stdout.write(`${BOLD}Worker kinds${RESET}\n`);
    for (const worker of registry.list()) {
      process.stdout.write(`  ${worker.kind} — available (${worker.note})\n`);
    }
    return;
  }

  if (subCommand === 'status') {
    await renderWorkerStatus(args.slice(1), deps);
    return;
  }

  const definition = registry.get(subCommand);
  if (!definition) {
    const knownKinds = registry.list().map((worker) => worker.kind).join(', ');
    throw new Error(`Unknown worker kind: "${subCommand}". Use: ${knownKinds}, list, status`);
  }

  let lock;
  try {
    lock = acquireWorkerLock({ kind: definition.kind, homeRoot: resolveInvokerHomeRoot(), logger: deps.logger });
  } catch (err) {
    if (err instanceof WorkerLockHeldError) {
      // Surface via the app's throw-based error convention.
      throw new Error(err.message);
    }
    throw err;
  }
  const autoFixAttemptLedger = createAutoFixAttemptLedger();
  try {
    const worker = definition.factory({
      store: deps.persistence,
      submitter: {
        submit: (workflowId, priority, channel, mutationArgs) => (
          deps.persistence.enqueueWorkflowMutationIntent(workflowId, channel, mutationArgs, priority)
        ),
      },
      logger: deps.logger,
      autoFix: {
        defaultAutoFixRetries: deps.invokerConfig.autoFixRetries,
        attemptLedger: autoFixAttemptLedger,
        getAutoFixAgent: () => deps.invokerConfig.autoFixAgent,
      },
      prMaintenance: resolvePrMaintenanceWorkerConfig(deps.invokerConfig),
      mergeGateProvider: new GitHubMergeGateProvider(),
    });
    await worker.tick('manual');
    await worker.stop();
  } finally {
    // Release deterministically so a clean run never leaves a stale lock that
    // blocks the next legitimate start.
    lock.release();
  }
  const label = definition.kind === AUTO_FIX_WORKER_KIND ? 'Auto-fix' : definition.kind;
  process.stdout.write(`${label} worker scan completed.\n`);
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
  query workflow <workflowId> [--output F]           Show one workflow
  query tasks [--workflow <id>|<workflowId>] [--status S]
                                                      Show task states (latest workflow by default)
    [--no-merge] [--output F]
  query task <taskId> [--output F]                    Print single task status
  query queue [--output F]                            Show queue status
  query workers [--output F]                          Show worker fleet snapshot
  query review-gate <prNumber|prUrl> [--output F]    Resolve a PR back to its Invoker workflow
  query action-graph [--output F]                     Print action graph source-of-truth snapshot
  query audit <taskId> [--output F]                   Print event history
  query session <taskId>                              Print agent session messages
  query worker-actions [--workflow <id>] [--status S] [--decision act|skip]
                                                      List durable worker action rows (all workers)
  query worker-decisions [--workflow <id>] [--decision act|skip] [--reason <substr>]
                                                      Show what each worker decided: submitted vs skipped, and why
  query ui-perf [--output F] [--reset]               Print live UI perf stats
  query stats [--output F]                           Aggregate stats across all workflows

${BOLD}Execute:${RESET}
  watch [<workflowId>]                                Watch workflow status until settled or Ctrl-C
  run <plan.yaml>                                     Load and execute plan
  start-ready [--dry-run] [--recreate-failed] [--no-track]
                                                      Start pending work that is ready to execute
  resume <id>                                         Resume incomplete workflow
  retry <workflowId>                                  Retry workflow: rerun failed, keep completed
  retry-task <taskId>                                 Retry a single failed/stuck task
  recreate <workflowId>                                Recreate workflow: wipe all state, new generation
  recreate-task <taskId>                               Recreate task + downstream (task-scoped reset)
  recreate-downstream <taskId>                         Recreate downstream of task only (target preserved)
  fork-workflow <workflowId>                          Fork a live workflow into a new branched workflow (Step 14)
  detach-workflow <workflowId> <upstreamWorkflowId>  Detach one upstream workflow and void downstream to pending
  rebase-retry <workflowId|mergeTaskId|taskId>        Refresh pool base, then retry incomplete work
  rebase-recreate <workflowId|mergeTaskId|taskId>     Refresh pool base, then recreate workflow
  repair-review-gate-ci <prNumber|prUrl>              Queue CI repair for one mapped review-gate PR
  fix <taskId> [claude|codex]                         Fix a failed task (default: claude)

${BOLD}Respond:${RESET}
  approve <taskId>                                    Approve a task
  reject <taskId> [reason]                            Reject a task
  input <taskId> <text>                               Provide input to task
  select <taskId> <experimentId>                      Select winning experiment

${BOLD}Configure:${RESET}
  install-skills [install|update|reinstall]          Install bundled Invoker AI helpers
  set command <taskId> <cmd>                          Edit task command and re-run
  set prompt <taskId> <text>                          Edit task prompt and re-run
  set pool <taskId> <type> [poolMemberId]           Change execution pool (worktree|docker|ssh)
  set agent <taskId> <agent>                          Change execution agent (claude|codex|omp)
  set merge-mode <workflowId> <mode>                  manual | automatic | external_review
  set fix-prompt <taskId> <text>                      Update fix-session prompt and retry
  set fix-context <taskId> <text>                     Update fix-session context and retry
  set gate-policy <taskId> <wfId> [depTaskId] <policy>
                                                      policy: completed | review_ready
  set workflow <workflowId> <fieldPath> <value>      Safely update workflow metadata/config
  set task <taskId> <fieldPath> <value>              Safely update task metadata/config
  migrate-compat                                     Normalize persisted compatibility workflow/task state

${BOLD}Lifecycle:${RESET}
  cancel <taskId>                                     Cancel task + all downstream
  cancel-workflow <workflowId>                        Cancel all active tasks in a workflow
  delete-task <taskId>                                 Delete one task and retarget dependents
  delete <workflowId>                                  Delete a single workflow
  delete-all                                           Delete all workflows (requires INVOKER_ALLOW_DELETE_ALL=1)
  open-terminal <taskId>                              Open OS terminal for a task
  slack                                               Start Slack bot (long-running)
  worker [kind|list|status]                           Run/list registry worker kinds (autofix scans failed tasks)

${BOLD}Deprecated${RESET} (use new names above):
  list → query workflows       status → query tasks       task-status → query task
  queue → query queue           audit → query audit         session → query session
  edit → set command            edit-executor → set pool
  edit-agent → set agent        set-merge-mode → set merge-mode
  delete-workflow → delete

${BOLD}Options:${RESET}
  --wait-for-approval    Keep running until PR approval (use with 'run' or 'resume')
  --no-track             Submit and return immediately after printing Workflow ID
  --do-not-track         Alias for --no-track
`);
}

async function headlessEdit(taskId: string, newCommand: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !newCommand) throw new Error('Missing arguments. Usage: --headless edit <taskId> <newCommand>');
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, 'set command');
  if (!restored) return;
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);

  const envelope = makeEnvelope('edit-task-command', 'headless', 'task', { taskId, newCommand });
  const result = await deps.commandService.editTaskCommand(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter(isDispatchableLaunch);
  await dispatchHeadlessRunnableTasks(deps, taskExecutor, runnable, 'edit-task-command');
  process.stdout.write(`Edited task "${taskId}" command → "${newCommand}"\n`);

  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set command accepted; exiting without tracking.\n');
    return;
  }
  if (runnable.length === 0) {
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
}

async function headlessEditPrompt(taskId: string, newPrompt: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !newPrompt) throw new Error('Missing arguments. Usage: --headless set prompt <taskId> <newPrompt>');
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);

  const envelope = makeEnvelope('edit-task-prompt', 'headless', 'task', { taskId, newPrompt });
  const result = await deps.commandService.editTaskPrompt(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter(isDispatchableLaunch);
  await dispatchHeadlessRunnableTasks(deps, taskExecutor, runnable, 'edit-task-prompt');
  process.stdout.write(`Edited task "${taskId}" prompt → "${newPrompt}"\n`);

  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set prompt accepted; exiting without tracking.\n');
    return;
  }
  if (runnable.length === 0) {
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
}

async function headlessEditExecutor(
  taskId: string,
  runnerKind: string,
  poolMemberId: string | undefined,
  deps: HeadlessDeps,
): Promise<void> {
  if (!taskId || !runnerKind) {
    throw new Error(
      'Missing arguments. Usage: --headless set pool <taskId> <runnerKind> [poolMemberId]',
    );
  }
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, 'set pool');
  if (!restored) return;
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);

  const envelope = makeEnvelope('edit-task-type', 'headless', 'task', { taskId, runnerKind, poolMemberId });
  const result = await deps.commandService.editTaskType(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter(isDispatchableLaunch);
  await dispatchHeadlessRunnableTasks(deps, taskExecutor, runnable, 'edit-task-type');
  process.stdout.write(
    `Edited task "${taskId}" executor → "${runnerKind}"` +
    `${poolMemberId ? ` (poolMemberId=${poolMemberId})` : ''}\n`,
  );

  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set pool accepted; exiting without tracking.\n');
    return;
  }
  if (runnable.length === 0) {
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
}


async function headlessEditAgent(taskId: string, agentName: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !agentName) throw new Error('Missing arguments. Usage: --headless set agent <taskId> <claude|codex|omp>');
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, 'set agent');
  if (!restored) return;
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);

  const envelope = makeEnvelope('edit-task-agent', 'headless', 'task', { taskId, agentName });
  const result = await deps.commandService.editTaskAgent(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter(isDispatchableLaunch);
  await dispatchHeadlessRunnableTasks(deps, taskExecutor, runnable, 'edit-task-agent');
  process.stdout.write(`Edited task "${taskId}" agent → "${agentName}"\n`);

  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set agent accepted; exiting without tracking.\n');
    return;
  }
  if (runnable.length === 0) {
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
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
  const runnable = result.data.filter(isDispatchableLaunch);
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

  const envelope = makeEnvelope('edit-task-fix-context', 'headless', 'task', {
    taskId,
    ...patch,
  });
  const result = await deps.commandService.editTaskFixContext(envelope);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const runnable = result.data.filter(isDispatchableLaunch);
  if (runnable.length > 0) {
    await taskExecutor.executeTasks(runnable);
  }
  const value = 'fixPrompt' in patch ? patch.fixPrompt : patch.fixContext;
  process.stdout.write(`Updated ${which} for "${taskId}" → "${value ?? ''}"\n`);

  if (deps.noTrack) {
    process.stdout.write(`[headless] --no-track enabled: set ${which} accepted; exiting without tracking.\n`);
    return;
  }
  if (runnable.length === 0) {
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
}

async function headlessSetGatePolicy(args: string[], deps: HeadlessDeps): Promise<void> {
  const [taskIdRaw, workflowId, arg3, arg4] = args;
  if (!taskIdRaw || !workflowId || !arg3) {
    throw new Error(
      'Missing arguments. Usage: --headless set gate-policy <taskId> <workflowId> [depTaskId] <completed|review_ready>',
    );
  }
  await withRestoredTaskUnlessDeleteAllWon(taskIdRaw, deps, 'set gate-policy', async (restored) => {
    const taskId = restored.resolvedTaskId;
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
    const runnable = result.data.filter(isDispatchableLaunch);
    if (runnable.length > 0) {
      const taskExecutor = createHeadlessExecutor(deps);
      await taskExecutor.executeTasks(runnable);
    }
    process.stdout.write(
      `Updated gate policy for ${taskId}: ${workflowId}/${depTaskId} -> ${gatePolicy} (${runnable.length} task(s) started)\n`,
    );
  });
}

async function headlessSetWorkflowMetadata(
  workflowId: string,
  fieldPath: string,
  rawValue: string,
  deps: HeadlessDeps,
): Promise<void> {
  if (!workflowId || !fieldPath || rawValue === '') {
    throw new Error('Missing arguments. Usage: --headless set workflow <workflowId> <fieldPath> <value>');
  }
  const result = await setWorkflowMetadata(
    {
      commandService: deps.commandService,
      orchestrator: deps.orchestrator,
      persistence: deps.persistence,
    },
    workflowId,
    fieldPath,
    parseMetadataValue(rawValue),
  );
  process.stdout.write(`Updated workflow "${result.id}" ${result.fieldPath} → ${JSON.stringify(result.value)}\n`);
}

async function headlessSetTaskMetadata(
  taskId: string,
  fieldPath: string,
  rawValue: string,
  deps: HeadlessDeps,
): Promise<void> {
  if (!taskId || !fieldPath || rawValue === '') {
    throw new Error('Missing arguments. Usage: --headless set task <taskId> <fieldPath> <value>');
  }
  const result = await setTaskMetadata(
    {
      commandService: deps.commandService,
      orchestrator: deps.orchestrator,
      persistence: deps.persistence,
    },
    taskId,
    fieldPath,
    parseMetadataValue(rawValue),
  );
  process.stdout.write(`Updated task "${result.id}" ${result.fieldPath} → ${JSON.stringify(result.value)}\n`);
}
