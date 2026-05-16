/* Command-family handlers extracted from headless.ts. */

import { assertPlanExecutionAgentsRegistered, registerBuiltinAgents } from '@invoker/execution-engine';
import { backupPlan } from './plan-backup.js';
import { startApiServer } from './api-server.js';
import { relaunchOrphansAndStartReady } from './orphan-relaunch.js';
import { trackWorkflow } from './headless-watch.js';
import type { HeadlessDeps } from './headless.js';
import {
  BOLD,
  RESET,
  buildHeadlessApiServerDeps,
  createHeadlessExecutor,
  wireHeadlessApproveHook,
  wireHeadlessAutoFix,
} from './headless.js';

export async function trackHeadlessWorkflow(
  workflowId: string,
  deps: Pick<HeadlessDeps, 'orchestrator' | 'messageBus'>,
  options: {
    waitForApproval?: boolean;
    hasBackgroundWork?: () => boolean;
    printSnapshot?: boolean;
    printSummary?: boolean;
    printTaskOutput?: boolean;
    allowSignals?: boolean;
    syncFromDb?: boolean;
    setExitCodeOnFailure?: boolean;
  } = {},
): Promise<Awaited<ReturnType<typeof trackWorkflow>>> {
  if (options.waitForApproval) {
    process.stdout.write('[headless] Waiting for PR approval (--wait-for-approval)...\n');
  }
  return await trackWorkflow({
    workflowId,
    messageBus: deps.messageBus,
    waitForApproval: options.waitForApproval,
    hasBackgroundWork: options.hasBackgroundWork,
    printSnapshot: options.printSnapshot,
    printSummary: options.printSummary,
    printTaskOutput: options.printTaskOutput,
    allowSignals: options.allowSignals,
    setExitCodeOnFailure: options.setExitCodeOnFailure,
    maxWaitMs: options.allowSignals ? undefined : (options.waitForApproval ? 86_400_000 : 1_800_000),
    loadTasks: () => {
      if (options.syncFromDb) {
        deps.orchestrator.syncFromDb(workflowId);
      }
      return deps.orchestrator.getAllTasks().filter((task) => task.config.workflowId === workflowId);
    },
  });
}

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
  process.stdout.write(`\n[watch] done — ${result.status.completed} completed, ${result.status.failed} failed\n`);
}

// ── Headless Commands ────────────────────────────────────────

export async function headlessRun(
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
  const autoFix = wireHeadlessAutoFix(deps, taskExecutor);

  const api = startApiServer({
    logger: deps.logger,
    orchestrator,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    ...buildHeadlessApiServerDeps(deps, taskExecutor),
  });

  orchestrator.syncFromDb(workflowId);
  const allStarted = relaunchOrphansAndStartReady(orchestrator, deps.logger, 'headless', workflowId);

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
