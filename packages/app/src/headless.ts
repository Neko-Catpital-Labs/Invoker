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

import type { BundledSkillsInstallMode, BundledSkillsStatus, Logger } from '@invoker/contracts';
import { makeEnvelope } from '@invoker/contracts';
import type { AgentSessionData } from '@invoker/contracts';
import { OrchestratorErrorCode } from '@invoker/workflow-core';
import type { Attempt, Orchestrator, CommandService, TaskDelta, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
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
  type TaskHeartbeatEvent,
} from '@invoker/execution-engine';
import { loadConfig, resolveSecretsFilePath, type InvokerConfig } from './config.js';
import { backupPlan } from './plan-backup.js';
import { startApiServer } from './api-server.js';
import { WorkflowMutationFacade } from './workflow-mutation-facade.js';
import {
  parseMetadataValue,
  setTaskMetadata,
  setWorkflowMetadata,
} from './metadata-setter.js';
import {
  approveTask,
  autoFixOnReviewGateFailure,
  deleteAllWorkflows as sharedDeleteAllWorkflows,
  fixWithAgentAction,
  rebaseRetry,
  rebaseRecreate,
  resolveConflictAction,
  forkWorkflow as sharedForkWorkflow,
  setWorkflowMergeMode,
} from './workflow-actions.js';
import { normalizeMergeModeForPersistence } from './merge-mode.js';
import { parseHeadlessFixArgs } from './auto-fix-intents.js';
import type { CostGroupDimension } from './cost-rollup.js';
import { openExternalTerminalForTask } from './open-terminal-for-task.js';
import {
  dispatchStartedTasksWithGlobalTopup,
  executeGlobalTopup,
  finalizeMutationWithGlobalTopup,
  isDispatchableLaunch,
} from './global-topup.js';
import { LaunchDispatcher } from './launch-dispatcher.js';
import { createAutoFixRecoveryTick, RECOVERY_WORKER_KIND } from './workers/auto-fix-recovery.js';
import { resolveHeadlessTargetWorkflowId } from './headless-command-classification.js';
import { formatHeadlessSetSubcommands } from './headless-command-registry.js';
import { trackWorkflow } from './headless-watch.js';
import { preemptWorkflowBeforeMutation, type WorkflowCancelResult } from './workflow-preemption.js';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';
import type { RuntimeServices } from '@invoker/runtime-service';

import {
  type HeadlessDeps,
  type QueryFlags,
  type HeadlessAutoFixController,
  RESET,
  BOLD,
  YELLOW,
  buildHeadlessApiServerDeps,
  createHeadlessExecutor,
  wireHeadlessAutoFix,
  wireHeadlessApproveHook,
  parseQueryFlags,
  trackHeadlessWorkflow,
  restoreWorkflowForTask,
  tryRestoreWorkflowForTask,
  restoreWorkflowForTaskUnlessDeleteAllWon,
  withRestoredTaskUnlessDeleteAllWon,
  waitForCompletion,
  preemptTaskSubgraph,
  preemptWorkflowExecution,
} from './headless-shared.js';
import {
  headlessQuery,
  headlessQuerySelect,
} from './headless-query-list.js';
import {
  headlessApprove,
  headlessReject,
  headlessInput,
  headlessSelect,
  headlessCancel,
  headlessCancelWorkflow,
  headlessDeleteWorkflow,
  headlessDetachWorkflow,
  headlessOpenTerminal,
} from './headless-approve-delete.js';
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
export { resolveAgentSession } from './headless-query-list.js';
export { createHeadlessExecutor, wireHeadlessAutoFix, wireHeadlessApproveHook, parseQueryFlags };
export type { HeadlessDeps, QueryFlags, HeadlessAutoFixController };

// ── HeadlessDeps interface ───────────────────────────────────

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
    case 'slack':
      await headlessSlack(deps);
      break;
    case 'query-select':
      await headlessQuerySelect(args[1], deps);
      break;
    case 'worker':
      await headlessWorker(args[1], deps);
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

/**
 * Worker kinds exposed to the CLI.
 */
const HEADLESS_WORKER_KINDS: ReadonlyArray<{ kind: string; available: boolean; note: string }> = [
  {
    kind: 'autofix',
    available: true,
    note: 'scans persisted failed tasks and submits normal auto-fix command intents',
  },
];

async function headlessWorker(subCommand: string | undefined, deps: HeadlessDeps): Promise<void> {
  if (subCommand === 'autofix') {
    const tick = createAutoFixRecoveryTick({
      store: deps.persistence,
      submitter: {
        submit: (workflowId, priority, channel, args) => (
          deps.persistence.enqueueWorkflowMutationIntent(workflowId, channel, args, priority)
        ),
      },
      logger: deps.logger,
      defaultAutoFixRetries: deps.invokerConfig.autoFixRetries,
      getAutoFixAgent: () => deps.invokerConfig.autoFixAgent,
    });
    await tick({
      identity: { kind: RECOVERY_WORKER_KIND, instanceId: 'headless-worker-autofix' },
      reason: 'manual',
      tickNumber: 1,
    });
    process.stdout.write('Auto-fix worker scan completed.\n');
    return;
  }

  if (subCommand && subCommand !== 'list' && subCommand !== 'status') {
    throw new Error(`Unknown worker sub-command: "${subCommand}". Use: autofix, list, status`);
  }
  process.stdout.write(`${BOLD}Worker kinds${RESET}\n`);
  for (const worker of HEADLESS_WORKER_KINDS) {
    const status = worker.available ? 'available' : 'unavailable';
    process.stdout.write(`  ${worker.kind} — ${status} (${worker.note})\n`);
  }
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
  query audit <taskId> [--output F]                   Print event history
  query session <taskId>                              Print agent session messages
  query ui-perf [--output F] [--reset]               Print live UI perf stats
  query stats [--output F]                           Aggregate stats across all workflows

${BOLD}Execute:${RESET}
  watch [<workflowId>]                                Watch workflow status until settled or Ctrl-C
  run <plan.yaml>                                     Load and execute plan
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
  fix <taskId> [claude|codex]                         Fix a failed task (default: claude)
  resolve-conflict <taskId> [claude|codex]            Resolve merge conflict + restart

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
  delete <workflowId>                                 Delete a single workflow
  delete-all                                          Delete all workflows (requires INVOKER_ALLOW_DELETE_ALL=1)
  open-terminal <taskId>                              Open OS terminal for a task
  slack                                               Start Slack bot (long-running)
  worker [autofix|list|status]                        Run/list worker kinds (autofix scans failed tasks)

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

async function headlessWatch(workflowId: string | undefined, deps: HeadlessDeps): Promise<void> {
  const workflows = deps.persistence.listWorkflows();
  if (workflows.length === 0) {
    process.stdout.write('No workflows found. Run a plan first.\n');
    return;
  }
  const targetWorkflowId = workflowId ?? workflows[0]?.id;
  const workflow = workflows.find((item) => item.id === targetWorkflowId);
  if (!workflow || !targetWorkflowId) {
    throw new Error(`Workflow "${workflowId}" not found.`);
  }

  process.stdout.write(`${BOLD}Watching workflow: ${workflow.id}${RESET}\n\n`);
  const result = await trackHeadlessWorkflow(workflow.id, deps, {
    printSnapshot: true,
    printSummary: true,
    printTaskOutput: false,
    allowSignals: true,
    syncFromDb: true,
    setExitCodeOnFailure: true,
  });
  process.stdout.write(`\n[watch] done — ${result.status.completed} completed, ${result.status.failed} failed, ${result.status.closed} closed\n`);
}

// ── Headless Commands ────────────────────────────────────────

async function headlessRun(
  planPath: string,
  deps: HeadlessDeps,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<void> {
  const { orchestrator, repoRoot, invokerConfig } = deps;
  if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');

  const { readFile } = await import('node:fs/promises');
  const { parsePlanFile } = await import('./plan-parser.js');

  const yamlSource = await readFile(planPath, 'utf-8');
  const plan = await parsePlanFile(planPath);
  const execRegistry = deps.executionAgentRegistry ?? registerBuiltinAgents();
  assertPlanExecutionAgentsRegistered(plan, execRegistry);
  backupPlan(plan, yamlSource, deps.logger);
  process.stdout.write(`${BOLD}Loading plan: ${plan.name}${RESET}\n`);
  process.stdout.write(`Tasks: ${plan.tasks.length}\n\n`);

  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const api = startApiServer({
    logger: deps.logger,
    orchestrator,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    ...buildHeadlessApiServerDeps(deps, taskExecutor),
  });

  const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
  orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
  const currentWorkflowId = orchestrator.getWorkflowIds().find((id) => !wfIdsBefore.has(id));
  if (currentWorkflowId) process.stdout.write(`Workflow ID: ${currentWorkflowId}\n`);

  const started = orchestrator.startExecution();

  if (noTrack) {
    if (started.length > 0) {
      void Promise.resolve()
        .then(() => taskExecutor.executeTasks(started))
        .catch((err) => {
          deps.logger.error(
            `background no-track run failed for ${currentWorkflowId ?? 'unknown'}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
            { module: 'headless' },
          );
        });
    }
    process.stdout.write('[headless] --no-track enabled: submission accepted; exiting without tracking.\n');
    await api.close().catch(() => {});
    return;
  }

  if (started.length > 0) {
    await taskExecutor.executeTasks(started);
  }

  if (currentWorkflowId) {
    await trackHeadlessWorkflow(currentWorkflowId, deps, {
      waitForApproval,
      hasBackgroundWork: autoFix.isBusy,
      printSnapshot: true,
      printSummary: true,
      printTaskOutput: true,
      setExitCodeOnFailure: true,
    });
  }

  await api.close().catch(() => {});
  autoFix.unsubscribe();
}

async function headlessResume(
  workflowId: string,
  deps: HeadlessDeps,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<void> {
  const { orchestrator } = deps;
  if (!workflowId) throw new Error('Missing workflowId. Usage: --headless resume <id>');

  process.stdout.write(`${BOLD}Resuming workflow: ${workflowId}${RESET}\n\n`);

  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const api = startApiServer({
    logger: deps.logger,
    orchestrator,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    ...buildHeadlessApiServerDeps(deps, taskExecutor),
  });

  orchestrator.syncFromDb(workflowId);
  const allStarted = orchestrator.startExecution();

  if (noTrack) {
    if (allStarted.length > 0) {
      void Promise.resolve()
        .then(() => taskExecutor.executeTasks(allStarted))
        .catch((err) => {
          deps.logger.error(
            `background no-track resume failed for ${workflowId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
            { module: 'headless' },
          );
        });
    }
    process.stdout.write('[headless] --no-track enabled: resume accepted; exiting without tracking.\n');
    await api.close().catch(() => {});
    autoFix.unsubscribe();
    return;
  }

  if (allStarted.length === 0) {
    await api.close().catch(() => {});
    autoFix.unsubscribe();
    return;
  }

  await taskExecutor.executeTasks(allStarted);

  await trackHeadlessWorkflow(workflowId, deps, {
    waitForApproval,
    hasBackgroundWork: autoFix.isBusy,
    printSnapshot: true,
    printSummary: true,
    printTaskOutput: true,
    setExitCodeOnFailure: true,
  });

  await api.close().catch(() => {});
  autoFix.unsubscribe();
}

async function headlessRetryTask(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) throw new Error('Missing arguments. Usage: --headless retry-task <taskId>');
  await withRestoredTaskUnlessDeleteAllWon(taskId, deps, 'retry-task', async (restored) => {
    taskId = restored.resolvedTaskId;
    if (deps.mutationTiming) {
      await deps.mutationTiming.span(
        'headless.retry-task.preemptTaskSubgraph',
        { taskId },
        () => preemptTaskSubgraph(taskId, deps),
      );
    } else {
      await preemptTaskSubgraph(taskId, deps);
    }

    const envelope = makeEnvelope('restart-task', 'headless', 'task', { taskId });
    const result = deps.mutationTiming
      ? await deps.mutationTiming.span(
        'headless.retry-task.commandService.retryTask',
        { taskId },
        () => deps.commandService.retryTask(envelope),
      )
      : await deps.commandService.retryTask(envelope);
    if (!result.ok) throw new Error(result.error.message);
    const runnable = result.data.filter(isDispatchableLaunch);
    process.stdout.write(`Restarted task "${taskId}" — ${runnable.length} task(s) to execute\n`);

    if (deps.noTrack) {
      const runningKey = (task: TaskState): string => {
        const attemptId = task.execution.selectedAttemptId?.trim();
        return attemptId ? `attempt:${attemptId}` : `task:${task.id}`;
      };
      const scopedKeys = new Set(runnable.map((task) => runningKey(task)));
      const globalTopup = deps.orchestrator
        .startExecution()
        .filter(isDispatchableLaunch)
        .filter((task) => !scopedKeys.has(runningKey(task)));
      const dispatchable = [...runnable, ...globalTopup];
      if (dispatchable.length > 0) {
        if (deps.deferRunnableTasks) {
          deps.deferRunnableTasks(dispatchable, restored.workflowId);
        } else {
          const taskExecutor = createHeadlessExecutor(deps);
          const launch = setTimeout(() => {
            void taskExecutor.executeTasks(dispatchable).catch((err) => {
              deps.logger.error(
                `background no-track task retry failed for ${taskId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
                { module: 'headless' },
              );
            });
          }, 25);
          launch.unref?.();
        }
      }
      process.stdout.write('[headless] --no-track enabled: retry-task accepted; exiting without tracking.\n');
      return;
    }

    const taskExecutor = createHeadlessExecutor(deps);
    const autoFix = wireHeadlessAutoFix(deps, taskExecutor);
    const { topup } = await dispatchStartedTasksWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor,
      logger: deps.logger,
      context: 'headless.restart-task',
      started: result.data,
      scopedTaskIds: [taskId],
      mutationTiming: deps.mutationTiming,
    });
    if (runnable.length + topup.length === 0) {
      autoFix.unsubscribe();
      return;
    }
    await trackHeadlessWorkflow(restored.workflowId, deps, {
      hasBackgroundWork: autoFix.isBusy,
      printSummary: false,
      printTaskOutput: true,
      setExitCodeOnFailure: false,
    });
    autoFix.unsubscribe();
  });
}

async function headlessFix(rawArgs: string[], deps: HeadlessDeps): Promise<void> {
  const parsed = parseHeadlessFixArgs(rawArgs);
  let taskId = parsed.taskId;
  if (!taskId) throw new Error('Missing taskId. Usage: --headless fix <taskId> [claude|codex] [--auto-fix]');
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, 'fix');
  if (!restored) return;
  taskId = restored.resolvedTaskId;

  if (parsed.autoFix) {
    const task = deps.orchestrator.getTask(taskId);
    const attemptsBefore = task?.execution.autoFixAttempts ?? 0;
    deps.persistence.updateTask(taskId, { execution: { autoFixAttempts: attemptsBefore + 1 } });
  }

  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  const agent = (parsed.agentName ?? 'claude').toLowerCase();
  try {
    const result = await fixWithAgentAction(taskId, {
      logger: deps.logger,
      orchestrator: deps.orchestrator,
      persistence: deps.persistence,
      commandService: deps.commandService,
      taskExecutor: te,
      mutationTiming: deps.mutationTiming,
      autoApproveAIFixes: deps.invokerConfig.autoApproveAIFixes,
    }, {
      agentName: agent,
      recreateOutputLabel: 'Fix with AI',
      failureOutputLabel: 'Fix with AI',
      reviewGateContext: parsed.reviewGateContext,
      signal: deps.signal,
    });
    await finalizeMutationWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.fix-with-agent',
      started: result.started,
      mutationTiming: deps.mutationTiming,
      ...(result.kind === 'recreateWorkflowFromFreshBase'
        ? { scopedWorkflowId: result.workflowId }
        : { scopedTaskIds: [taskId] }),
    });
    if (result.kind === 'recreateWorkflowFromFreshBase') {
      process.stdout.write(
        `Startup merge conflict detected; recreated workflow ${result.workflowId} from a fresh base.\n`,
      );
      return;
    }
    process.stdout.write(
      result.autoApproved
        ? `Fix applied and auto-approved for task: ${taskId} (${agent}).\n`
        : `Fix applied for task: ${taskId} (${agent}). Use 'approve ${taskId}' or 'reject ${taskId}' to finalize.\n`,
    );
  } catch (err) {
    await finalizeMutationWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.fix-with-agent.failure',
      mutationTiming: deps.mutationTiming,
    });
    throw err;
  } finally {
    autoFix.unsubscribe();
  }
}

async function headlessResolveConflict(taskId: string, deps: HeadlessDeps, agentArg?: string): Promise<void> {
  if (!taskId) throw new Error('Missing taskId. Usage: --headless resolve-conflict <taskId> [claude|codex]');
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, 'resolve-conflict');
  if (!restored) return;
  taskId = restored.resolvedTaskId;

  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  const agent = (agentArg ?? 'claude').toLowerCase();
  try {
    const result = await resolveConflictAction(taskId, {
      ...deps,
      taskExecutor: te,
      autoApproveAIFixes: deps.invokerConfig.autoApproveAIFixes,
    }, agent, deps.signal);
    await finalizeMutationWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.resolve-conflict',
      started: result.started,
      mutationTiming: deps.mutationTiming,
      scopedTaskIds: [taskId],
    });
    process.stdout.write(
      deps.invokerConfig.autoApproveAIFixes
        ? `Conflict resolved and auto-approved for task: ${taskId} (${agent}).\n`
        : `Conflict resolved for task: ${taskId} (${agent}). Use 'approve ${taskId}' or 'reject ${taskId}' to finalize.\n`,
    );
  } catch (err) {
    await finalizeMutationWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.resolve-conflict.failure',
      mutationTiming: deps.mutationTiming,
    });
    throw err;
  } finally {
    autoFix.unsubscribe();
  }
}

async function headlessRebaseRetry(target: string, deps: HeadlessDeps): Promise<void> {
  if (!target) throw new Error('Missing arguments. Usage: --headless rebase-retry <workflowId|mergeTaskId|taskId>');
  const workflowId = resolveHeadlessTargetWorkflowId(target, deps.persistence);
  await preemptWorkflowBeforeMutation(workflowId, {
    preemptWorkflowExecution: (id) => preemptWorkflowExecution(id, deps),
    logger: deps.logger,
    context: 'headless.rebase-retry',
    mutationTiming: deps.mutationTiming,
  });
  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  const started = await rebaseRetry(target, {
    ...deps,
    logger: deps.logger,
    commandService: deps.commandService,
    taskExecutor: te,
    mutationTiming: deps.mutationTiming,
  });
  const runnable = started.filter(isDispatchableLaunch);
  const { topup } = await dispatchStartedTasksWithGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor: te,
    logger: deps.logger,
    context: 'headless.rebase-retry',
    started,
    scopedWorkflowId: workflowId,
    mutationTiming: deps.mutationTiming,
  });
  if (runnable.length + topup.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: rebase-retry accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();

  const tasksStarted = runnable.length;
  process.stdout.write(`Rebase-retry: retried workflow from fresh base (${tasksStarted} task(s))\n`);
}

async function headlessRebaseRecreate(workflowTarget: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowTarget) throw new Error('Missing arguments. Usage: --headless rebase-recreate <workflowId|mergeTaskId|taskId>');
  const workflowId = resolveHeadlessTargetWorkflowId(workflowTarget, deps.persistence);
  await preemptWorkflowBeforeMutation(workflowId, {
    preemptWorkflowExecution: (id) => preemptWorkflowExecution(id, deps),
    logger: deps.logger,
    context: 'headless.rebase-recreate',
    mutationTiming: deps.mutationTiming,
  });
  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  const started = await rebaseRecreate(workflowTarget, {
    ...deps,
    logger: deps.logger,
    commandService: deps.commandService,
    taskExecutor: te,
    mutationTiming: deps.mutationTiming,
  });
  const runnable = started.filter(isDispatchableLaunch);
  const { topup } = await dispatchStartedTasksWithGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor: te,
    logger: deps.logger,
    context: 'headless.rebase-recreate',
    started,
    scopedWorkflowId: workflowId,
    mutationTiming: deps.mutationTiming,
  });
  if (runnable.length + topup.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: rebase-recreate accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();

  const tasksStarted = runnable.length;
  process.stdout.write(`Rebase-recreate: recreated workflow from fresh base (${tasksStarted} task(s))\n`);
}

async function headlessRecreateWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowId) {
    throw new Error('Missing arguments. Usage: --headless recreate <workflowId>');
  }
  await preemptWorkflowBeforeMutation(workflowId, {
    preemptWorkflowExecution: (id) => preemptWorkflowExecution(id, deps),
    logger: deps.logger,
    context: 'headless.recreate-workflow',
    mutationTiming: deps.mutationTiming,
  });
  const recreateWfEnvelope = makeEnvelope('recreate-workflow', 'headless', 'workflow', { workflowId });
  const recreateWfResult = deps.mutationTiming
    ? await deps.mutationTiming.span(
      'headless.recreate-workflow.commandService.recreateWorkflow',
      undefined,
      () => deps.commandService.recreateWorkflow(recreateWfEnvelope),
    )
    : await deps.commandService.recreateWorkflow(recreateWfEnvelope);
  if (!recreateWfResult.ok) throw new Error(recreateWfResult.error.message);
  const started = recreateWfResult.data;
  const runnable = started.filter(isDispatchableLaunch);
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
        mutationTiming: deps.mutationTiming,
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
    await trackHeadlessWorkflow(workflowId, deps, {
      hasBackgroundWork: autoFix.isBusy,
      printSummary: false,
      printTaskOutput: true,
      setExitCodeOnFailure: false,
    });
    autoFix.unsubscribe();
  }
  const tasksStarted = runnable.length;
  process.stdout.write(`Recreate workflow "${workflowId}" — ${tasksStarted} task(s) to execute (pool fetch skipped)\n`);
}

async function headlessRecreateTask(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) {
    throw new Error('Missing arguments. Usage: --headless recreate-task <taskId>');
  }
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, 'recreate-task');
  if (!restored) return;
  taskId = restored.resolvedTaskId;
  if (deps.mutationTiming) {
    await deps.mutationTiming.span(
      'headless.recreate-task.preemptTaskSubgraph',
      { taskId },
      () => preemptTaskSubgraph(taskId, deps),
    );
  } else {
    await preemptTaskSubgraph(taskId, deps);
  }

  const recreateTaskEnvelope = makeEnvelope('recreate-task', 'headless', 'task', { taskId });
  const recreateTaskResult = deps.mutationTiming
    ? await deps.mutationTiming.span(
      'headless.recreate-task.commandService.recreateTask',
      { taskId },
      () => deps.commandService.recreateTask(recreateTaskEnvelope),
    )
    : await deps.commandService.recreateTask(recreateTaskEnvelope);
  if (!recreateTaskResult.ok) throw new Error(recreateTaskResult.error.message);
  const started = recreateTaskResult.data;
  const runnable = started.filter(isDispatchableLaunch);
  const workflowId = deps.orchestrator.getTask(taskId)?.config.workflowId;
  process.stdout.write(`Recreate task "${taskId}" (+ downstream) — ${runnable.length} task(s) to execute (pool fetch skipped)\n`);
  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  remoteFetchForPool.enabled = false;
  let topup: TaskState[] = [];
  try {
    ({ topup } = await dispatchStartedTasksWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.recreate-task',
      started,
      mutationTiming: deps.mutationTiming,
    }));
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
  if (workflowId) {
    await trackHeadlessWorkflow(workflowId, deps, {
      hasBackgroundWork: autoFix.isBusy,
      printSummary: false,
      printTaskOutput: true,
      setExitCodeOnFailure: false,
    });
  }
  autoFix.unsubscribe();
}

async function headlessRecreateDownstream(taskId: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId) {
    throw new Error('Missing arguments. Usage: --headless recreate-downstream <taskId>');
  }
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, 'recreate-downstream');
  if (!restored) return;
  taskId = restored.resolvedTaskId;
  if (deps.mutationTiming) {
    await deps.mutationTiming.span(
      'headless.recreate-downstream.preemptTaskSubgraph',
      { taskId },
      () => preemptTaskSubgraph(taskId, deps),
    );
  } else {
    await preemptTaskSubgraph(taskId, deps);
  }

  const envelope = makeEnvelope('recreate-downstream', 'headless', 'task', { taskId });
  const result = deps.mutationTiming
    ? await deps.mutationTiming.span(
      'headless.recreate-downstream.commandService.recreateDownstream',
      { taskId },
      () => deps.commandService.recreateDownstream(envelope),
    )
    : await deps.commandService.recreateDownstream(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const started = result.data;
  const runnable = started.filter(isDispatchableLaunch);
  const workflowId = deps.orchestrator.getTask(taskId)?.config.workflowId;
  process.stdout.write(`Recreate downstream of "${taskId}" — ${runnable.length} task(s) to execute (pool fetch skipped)\n`);
  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  remoteFetchForPool.enabled = false;
  let topup: TaskState[] = [];
  try {
    ({ topup } = await dispatchStartedTasksWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.recreate-downstream',
      started,
      mutationTiming: deps.mutationTiming,
    }));
  } finally {
    remoteFetchForPool.enabled = true;
  }
  if (runnable.length + topup.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: recreate-downstream accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  if (workflowId) {
    await trackHeadlessWorkflow(workflowId, deps, {
      hasBackgroundWork: autoFix.isBusy,
      printSummary: false,
      printTaskOutput: true,
      setExitCodeOnFailure: false,
    });
  }
  autoFix.unsubscribe();
}

async function headlessForkWorkflow(
  workflowId: string,
  deps: HeadlessDeps,
): Promise<void> {
  if (!workflowId) {
    throw new Error('Missing arguments. Usage: --headless fork-workflow <workflowId>');
  }
  const result = sharedForkWorkflow(workflowId, {
    orchestrator: deps.orchestrator,
    logger: deps.logger,
  });
  const taskExecutor = createHeadlessExecutor(deps);
  const { runnable } = await dispatchStartedTasksWithGlobalTopup({
    orchestrator: deps.orchestrator,
    taskExecutor,
    logger: deps.logger,
    context: 'headless.fork-workflow',
    started: result.started,
    scopedWorkflowId: result.forkedWorkflowId,
  });
  process.stdout.write(
    `Forked workflow ${result.sourceWorkflowId} → ${result.forkedWorkflowId}; ` +
      `launched ${runnable.length} task(s)\n`,
  );
}

async function headlessRetryWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowId) {
    throw new Error('Missing arguments. Usage: --headless retry <workflowId>');
  }
  deps.logger.info(`headlessRetryWorkflow begin workflow="${workflowId}" noTrack=${deps.noTrack ? 'true' : 'false'}`, {
    module: 'headless',
  });
  await preemptWorkflowBeforeMutation(workflowId, {
    preemptWorkflowExecution: (id) => preemptWorkflowExecution(id, deps),
    logger: deps.logger,
    context: 'headless.retry-workflow',
    mutationTiming: deps.mutationTiming,
  });
  const envelope = makeEnvelope('retry-workflow', 'headless', 'workflow', { workflowId });
  const result = deps.mutationTiming
    ? await deps.mutationTiming.span(
      'headless.retry-workflow.commandService.retryWorkflow',
      undefined,
      () => deps.commandService.retryWorkflow(envelope),
    )
    : await deps.commandService.retryWorkflow(envelope);
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
    .filter(isDispatchableLaunch)
    .map((task) => `${task.id}(${task.config.workflowId ?? 'unknown'})`);
  if (retryRunningSummary.length > 0) {
    deps.logger.info(
      `headlessRetryWorkflow trace workflow="${workflowId}" retryResult running=[${retryRunningSummary.join(', ')}]`,
      { module: 'headless' },
    );
  }
  const runnable = result.data.filter(isDispatchableLaunch);
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
    .filter(isDispatchableLaunch)
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
    process.stdout.write('[headless] --no-track enabled: retry accepted; exiting without tracking.\n');
    return;
  }

  const te = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, te);
  remoteFetchForPool.enabled = false;
  let topup: TaskState[] = [];
  try {
    ({ topup } = await dispatchStartedTasksWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: te,
      logger: deps.logger,
      context: 'headless.retry-workflow',
      started: dispatchable,
      scopedWorkflowId: workflowId,
      mutationTiming: deps.mutationTiming,
    }));
  } finally {
    remoteFetchForPool.enabled = true;
  }
  if (runnable.length + topup.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}

/** Orchestrator error codes that preemption treats as benign (cancel is best-effort). */
async function headlessEdit(taskId: string, newCommand: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !newCommand) throw new Error('Missing arguments. Usage: --headless edit <taskId> <newCommand>');
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, 'set command');
  if (!restored) return;
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const envelope = makeEnvelope('edit-task-command', 'headless', 'task', { taskId, newCommand });
  const result = await deps.commandService.editTaskCommand(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter(isDispatchableLaunch);
  await dispatchHeadlessRunnableTasks(deps, taskExecutor, runnable, 'edit-task-command');
  process.stdout.write(`Edited task "${taskId}" command → "${newCommand}"\n`);

  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set command accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  if (runnable.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}

async function headlessEditPrompt(taskId: string, newPrompt: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !newPrompt) throw new Error('Missing arguments. Usage: --headless set prompt <taskId> <newPrompt>');
  const restored = restoreWorkflowForTask(taskId, deps);
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const envelope = makeEnvelope('edit-task-prompt', 'headless', 'task', { taskId, newPrompt });
  const result = await deps.commandService.editTaskPrompt(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter(isDispatchableLaunch);
  await dispatchHeadlessRunnableTasks(deps, taskExecutor, runnable, 'edit-task-prompt');
  process.stdout.write(`Edited task "${taskId}" prompt → "${newPrompt}"\n`);

  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set prompt accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  if (runnable.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
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
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

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
    autoFix.unsubscribe();
    return;
  }
  if (runnable.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
}


async function headlessEditAgent(taskId: string, agentName: string, deps: HeadlessDeps): Promise<void> {
  if (!taskId || !agentName) throw new Error('Missing arguments. Usage: --headless set agent <taskId> <claude|codex|omp>');
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, 'set agent');
  if (!restored) return;
  taskId = restored.resolvedTaskId;
  const taskExecutor = createHeadlessExecutor(deps);
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const envelope = makeEnvelope('edit-task-agent', 'headless', 'task', { taskId, agentName });
  const result = await deps.commandService.editTaskAgent(envelope);
  if (!result.ok) throw new Error(result.error.message);
  const runnable = result.data.filter(isDispatchableLaunch);
  await dispatchHeadlessRunnableTasks(deps, taskExecutor, runnable, 'edit-task-agent');
  process.stdout.write(`Edited task "${taskId}" agent → "${agentName}"\n`);

  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: set agent accepted; exiting without tracking.\n');
    autoFix.unsubscribe();
    return;
  }
  if (runnable.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
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
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const envelope = makeEnvelope('edit-task-fix-context', 'headless', 'task', {
    taskId,
    ...patch,
  });
  const result = await deps.commandService.editTaskFixContext(envelope);
  if (!result.ok) {
    autoFix.unsubscribe();
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
    autoFix.unsubscribe();
    return;
  }
  if (runnable.length === 0) {
    autoFix.unsubscribe();
    return;
  }
  await trackHeadlessWorkflow(restored.workflowId, deps, {
    hasBackgroundWork: autoFix.isBusy,
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
  autoFix.unsubscribe();
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
    ...buildHeadlessApiServerDeps(deps, taskExecutor),
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
