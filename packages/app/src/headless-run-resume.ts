/**
 * Headless "execute" command family: run / resume / watch and the
 * retry · recreate · rebase · fork · fix · resolve-conflict handlers.
 *
 * These commands load or re-drive workflow execution. They depend only on
 * `headless-shared.ts` for cross-cutting infrastructure (TaskRunner wiring,
 * workflow tracking, restore/preemption helpers) — never on the other
 * command-family modules — keeping the import graph acyclic.
 */

import { makeEnvelope, type StartReadyRequest } from '@invoker/contracts';

import type { TaskState } from '@invoker/workflow-core';
import {
  remoteFetchForPool,
  registerBuiltinAgents,
  assertPlanExecutionAgentsRegistered,
} from '@invoker/execution-engine';
import { backupPlan } from './plan-backup.js';
import { startApiServer } from './api-server.js';
import { startWebSurfaceForHeadless } from './web/start-web-surface.js';
import {
  fixWithAgentAction,
  rebaseRetry,
  rebaseRecreate,
  resolveConflictAction,
  forkWorkflow as sharedForkWorkflow,
} from './workflow-actions.js';
import { parseHeadlessFixArgs } from './auto-fix-intents.js';
import { resolveDefaultExecutionAgent, resolveConflictResolutionSettings } from './config.js';
import {
  dispatchStartedTasksWithGlobalTopup,
  executeGlobalTopup,
  finalizeMutationWithGlobalTopup,
  isDispatchableLaunch,
} from './global-topup.js';
import { resolveHeadlessTargetWorkflowId } from './headless-command-classification.js';
import { preemptWorkflowBeforeMutation } from './workflow-preemption.js';
import {
  type HeadlessDeps,
  BOLD,
  RESET,
  createHeadlessExecutor,
  wireHeadlessApproveHook,
  buildHeadlessApiServerDeps,
  trackHeadlessWorkflow,
  restoreWorkflowForTaskUnlessDeleteAllWon,
  withRestoredTaskUnlessDeleteAllWon,
  preemptTaskSubgraph,
  preemptWorkflowExecution,
} from './headless-shared.js';
import { runStartReady } from './start-ready.js';
type StartReadyRequestExt = StartReadyRequest & {
  recreateFailedAndPending?: boolean;
};

type StartReadyPreviewExt = {
  readyTaskIds: string[];
  recoverableTaskIds: string[];
  failedWorkflowIds: string[];
  pendingWorkflowIds: string[];
  skipped: {
    awaitingApproval: number;
    reviewReady: number;
    blocked: number;
    failedTasks: number;
    pendingTasks: number;
  };
};

export async function headlessWatch(workflowId: string | undefined, deps: HeadlessDeps): Promise<void> {
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

export async function headlessRun(
  planPath: string,
  deps: HeadlessDeps,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<void> {
  const { orchestrator, repoRoot, invokerConfig } = deps;
  if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');

  const { readFile } = await import('node:fs/promises');
  const { applyConfiguredPlanDefaults, parsePlanFile } = await import('./plan-parser.js');

  const yamlSource = await readFile(planPath, 'utf-8');
  const plan = applyConfiguredPlanDefaults(await parsePlanFile(planPath));
  const execRegistry = deps.executionAgentRegistry ?? registerBuiltinAgents();
  assertPlanExecutionAgentsRegistered(plan, execRegistry);
  backupPlan(plan, yamlSource, deps.logger);
  process.stdout.write(`${BOLD}Loading plan: ${plan.name}${RESET}\n`);
  process.stdout.write(`Tasks: ${plan.tasks.length}\n\n`);

  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);

  const apiServerDeps = buildHeadlessApiServerDeps(deps, taskExecutor);
  const api = startApiServer({
    logger: deps.logger,
    orchestrator,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    ...apiServerDeps,
  });
  const webSurface = startWebSurfaceForHeadless(deps, apiServerDeps);

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
    await webSurface?.close().catch(() => {});
    return;
  }

  if (started.length > 0) {
    await taskExecutor.executeTasks(started);
  }

  if (currentWorkflowId) {
    await trackHeadlessWorkflow(currentWorkflowId, deps, {
      waitForApproval,
      printSnapshot: true,
      printSummary: true,
      printTaskOutput: true,
      setExitCodeOnFailure: true,
    });
  }

  await api.close().catch(() => {});
  await webSurface?.close().catch(() => {});
}

export async function headlessResume(
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

  const apiServerDeps = buildHeadlessApiServerDeps(deps, taskExecutor);
  const api = startApiServer({
    logger: deps.logger,
    orchestrator,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    ...apiServerDeps,
  });
  const webSurface = startWebSurfaceForHeadless(deps, apiServerDeps);

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
    await webSurface?.close().catch(() => {});
    return;
  }

  if (allStarted.length === 0) {
    await api.close().catch(() => {});
    await webSurface?.close().catch(() => {});
    return;
  }

  await taskExecutor.executeTasks(allStarted);

  await trackHeadlessWorkflow(workflowId, deps, {
    waitForApproval,
    printSnapshot: true,
    printSummary: true,
    printTaskOutput: true,
    setExitCodeOnFailure: true,
  });

  await api.close().catch(() => {});
  await webSurface?.close().catch(() => {});
}

function parseStartReadyArgs(args: string[], inheritedNoTrack: boolean | undefined): {
  request: StartReadyRequestExt;
  noTrack: boolean;
} {
  const request: StartReadyRequestExt = {};
  let noTrack = inheritedNoTrack ?? false;
  for (const arg of args) {
    switch (arg) {
      case '--dry-run':
        request.dryRun = true;
        break;
      case '--recreate-failed':
        request.recreateFailed = true;
        break;
      case '--recreate-failed-and-pending':
        request.recreateFailedAndPending = true;
        break;
      case '--no-track':
        noTrack = true;
        break;
      default:
        throw new Error(`Unknown start-ready option "${arg}". Usage: --headless start-ready [--dry-run] [--recreate-failed] [--recreate-failed-and-pending] [--no-track]`);
    }
  }
  return { request, noTrack };
}

export async function headlessStartReady(args: string[], deps: HeadlessDeps): Promise<void> {
  const { request, noTrack } = parseStartReadyArgs(args, deps.noTrack);
  const result = runStartReady(deps.orchestrator, request) as typeof runStartReady extends (...args: any[]) => infer T
    ? T & { preview: StartReadyPreviewExt }
    : never;
  const runnable = result.started.filter(isDispatchableLaunch);
  const preview = result.preview;

  const modeLabel = request.recreateFailedAndPending
    ? 'Start and recreate failed and pending'
    : request.recreateFailed
      ? 'Start and recreate failed'
      : 'Start ready work';
  process.stdout.write(`${modeLabel}: ${result.dryRun ? 'preview' : 'submitted'}\n`);
  process.stdout.write(`  ready: ${preview.readyTaskIds.length}\n`);
  process.stdout.write(`  recoverable: ${preview.recoverableTaskIds.length}\n`);
  process.stdout.write(`  failed workflows: ${preview.failedWorkflowIds.length}\n`);
  if (request.recreateFailedAndPending) {
    process.stdout.write(`  pending workflows: ${preview.pendingWorkflowIds.length}\n`);
  }
  process.stdout.write(`  recreated workflows: ${result.recreatedWorkflowIds.length}\n`);
  process.stdout.write(`  started: ${runnable.length}\n`);

  if (result.dryRun || runnable.length === 0) {
    return;
  }

  if (noTrack) {
    if (deps.deferRunnableTasks) {
      deps.deferRunnableTasks(runnable);
    } else {
      const taskExecutor = createHeadlessExecutor(deps);
      void Promise.resolve()
        .then(() => taskExecutor.executeTasks(runnable))
        .catch((err) => {
          deps.logger.error(
            `background no-track start-ready failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
            { module: 'headless' },
          );
        });
    }
    process.stdout.write('[headless] --no-track enabled: start-ready accepted; exiting without tracking.\n');
    return;
  }

  const taskExecutor = createHeadlessExecutor(deps);
  wireHeadlessApproveHook(deps, taskExecutor);
  await taskExecutor.executeTasks(runnable);
}

export async function headlessRetryTask(taskId: string, deps: HeadlessDeps): Promise<void> {
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
          void Promise.resolve()
            .then(() => taskExecutor.executeTasks(dispatchable))
            .catch((err) => {
              deps.logger.error(
                `background no-track task retry failed for ${taskId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
                { module: 'headless' },
              );
            });
        }
      }
      process.stdout.write('[headless] --no-track enabled: retry-task accepted; exiting without tracking.\n');
      return;
    }

    const taskExecutor = createHeadlessExecutor(deps);
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
      return;
    }
    await trackHeadlessWorkflow(restored.workflowId, deps, {
      printSummary: false,
      printTaskOutput: true,
      setExitCodeOnFailure: false,
    });
  });
}

export async function headlessRepairReviewGateCi(prArg: string | undefined, deps: HeadlessDeps): Promise<void> {
  if (!prArg) throw new Error('Missing PR argument. Usage: --headless repair-review-gate-ci <prNumber|prUrl>');
  if (!deps.repairReviewGateCi) {
    throw new Error('Review-gate CI repair is unavailable in this process.');
  }
  const result = await deps.repairReviewGateCi(prArg);
  process.stdout.write(`${result.message}\n`);
}

export async function headlessFix(rawArgs: string[], deps: HeadlessDeps): Promise<void> {
  const parsed = parseHeadlessFixArgs(rawArgs);
  let taskId = parsed.taskId;
  if (!taskId) throw new Error('Missing taskId. Usage: --headless fix <taskId> [claude|codex] [--auto-fix]');
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, 'fix');
  if (!restored) return;
  taskId = restored.resolvedTaskId;


  const te = createHeadlessExecutor(deps);
  const agent = (parsed.agentName ?? resolveDefaultExecutionAgent(deps.invokerConfig)).toLowerCase();
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
  }
}

export async function headlessResolveConflict(taskId: string, deps: HeadlessDeps, agentArg?: string): Promise<void> {
  if (!taskId) throw new Error('Missing taskId. Usage: --headless resolve-conflict <taskId> [claude|codex]');
  const restored = restoreWorkflowForTaskUnlessDeleteAllWon(taskId, deps, 'resolve-conflict');
  if (!restored) return;
  taskId = restored.resolvedTaskId;

  const te = createHeadlessExecutor(deps);
  const settings = resolveConflictResolutionSettings(deps.invokerConfig, {
    explicitAgent: agentArg?.toLowerCase(),
    pathDefaultAgent: resolveDefaultExecutionAgent(deps.invokerConfig),
  });
  const agent = settings.agent ?? resolveDefaultExecutionAgent(deps.invokerConfig);
  try {
    const result = await resolveConflictAction(taskId, {
      ...deps,
      taskExecutor: te,
      autoApproveAIFixes: deps.invokerConfig.autoApproveAIFixes,
    }, agentArg?.toLowerCase(), deps.signal, {
      pathDefaultAgent: resolveDefaultExecutionAgent(deps.invokerConfig),
    });
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
  }
}

export async function headlessRebaseRetry(target: string, deps: HeadlessDeps): Promise<void> {
  if (!target) throw new Error('Missing arguments. Usage: --headless rebase-retry <workflowId|mergeTaskId|taskId>');
  const workflowId = resolveHeadlessTargetWorkflowId(target, deps.persistence);
  await preemptWorkflowBeforeMutation(workflowId, {
    preemptWorkflowExecution: (id) => preemptWorkflowExecution(id, deps),
    logger: deps.logger,
    context: 'headless.rebase-retry',
    mutationTiming: deps.mutationTiming,
  });
  const te = createHeadlessExecutor(deps);
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
    return;
  }
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: rebase-retry accepted; exiting without tracking.\n');
    return;
  }
  await trackHeadlessWorkflow(workflowId, deps, {
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });

  const tasksStarted = runnable.length;
  process.stdout.write(`Rebase-retry: retried workflow from fresh base (${tasksStarted} task(s))\n`);
}

export async function headlessRebaseRecreate(workflowTarget: string, deps: HeadlessDeps): Promise<void> {
  if (!workflowTarget) throw new Error('Missing arguments. Usage: --headless rebase-recreate <workflowId|mergeTaskId|taskId>');
  const workflowId = resolveHeadlessTargetWorkflowId(workflowTarget, deps.persistence);
  await preemptWorkflowBeforeMutation(workflowId, {
    preemptWorkflowExecution: (id) => preemptWorkflowExecution(id, deps),
    logger: deps.logger,
    context: 'headless.rebase-recreate',
    mutationTiming: deps.mutationTiming,
  });
  const te = createHeadlessExecutor(deps);
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
    return;
  }
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: rebase-recreate accepted; exiting without tracking.\n');
    return;
  }
  await trackHeadlessWorkflow(workflowId, deps, {
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });

  const tasksStarted = runnable.length;
  process.stdout.write(`Rebase-recreate: recreated workflow from fresh base (${tasksStarted} task(s))\n`);
}

export async function headlessRecreateWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
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
      return;
    }
    if (deps.noTrack) {
      process.stdout.write('[headless] --no-track enabled: recreate accepted; exiting without tracking.\n');
      return;
    }
    await trackHeadlessWorkflow(workflowId, deps, {
      printSummary: false,
      printTaskOutput: true,
      setExitCodeOnFailure: false,
    });
  }
  const tasksStarted = runnable.length;
  process.stdout.write(`Recreate workflow "${workflowId}" — ${tasksStarted} task(s) to execute (pool fetch skipped)\n`);
}

export async function headlessRecreateTask(taskId: string, deps: HeadlessDeps): Promise<void> {
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
    return;
  }
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: recreate-task accepted; exiting without tracking.\n');
    return;
  }
  if (workflowId) {
    await trackHeadlessWorkflow(workflowId, deps, {
      printSummary: false,
      printTaskOutput: true,
      setExitCodeOnFailure: false,
    });
  }
}

export async function headlessRecreateDownstream(taskId: string, deps: HeadlessDeps): Promise<void> {
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
    return;
  }
  if (deps.noTrack) {
    process.stdout.write('[headless] --no-track enabled: recreate-downstream accepted; exiting without tracking.\n');
    return;
  }
  if (workflowId) {
    await trackHeadlessWorkflow(workflowId, deps, {
      printSummary: false,
      printTaskOutput: true,
      setExitCodeOnFailure: false,
    });
  }
}

export async function headlessForkWorkflow(
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

export async function headlessRetryWorkflow(workflowId: string, deps: HeadlessDeps): Promise<void> {
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
      void Promise.resolve()
        .then(() => te.executeTasks(dispatchable))
        .catch((err) => {
          deps.logger.error(
            `background no-track workflow retry failed for ${workflowId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
            { module: 'headless' },
          );
        });
    }
    process.stdout.write('[headless] --no-track enabled: retry accepted; exiting without tracking.\n');
    return;
  }

  const te = createHeadlessExecutor(deps);
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
    return;
  }
  await trackHeadlessWorkflow(workflowId, deps, {
    printSummary: false,
    printTaskOutput: true,
    setExitCodeOnFailure: false,
  });
}
