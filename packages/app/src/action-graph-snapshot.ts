import type { ActionGraphResponse } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { Orchestrator } from '@invoker/workflow-core';
import type { InvokerConfig } from './config.js';
import {
  buildActionGraphDiagnostics,
  resolveActionDiagnosticsStallThresholdMs,
} from './action-graph-diagnostics.js';

export function buildCurrentActionGraphSnapshot(args: {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  invokerConfig: InvokerConfig;
}): ActionGraphResponse {
  args.orchestrator.syncAllFromDb();
  const tasks = args.orchestrator.getAllTasks();
  const workflows = args.persistence.listWorkflows();

  return buildActionGraphDiagnostics({
    workflows,
    tasks,
    attemptsByTaskId: new Map(tasks.map((task) => [
      task.id,
      args.persistence.loadActionGraphAttempts(task.id, task.execution.selectedAttemptId),
    ])),
    queueStatus: args.orchestrator.getQueueStatus(),
    mutationIntents: args.persistence.listWorkflowMutationIntents(undefined, ['queued', 'running', 'failed']),
    mutationLeases: args.persistence.listWorkflowMutationLeases(),
    eventsByTaskId: new Map(tasks.map((task) => [task.id, args.persistence.getEvents(task.id, 'desc', 20)])),
    activityLogs: args.persistence.getActivityLogs(0, 200),
    stallThresholdMs: resolveActionDiagnosticsStallThresholdMs(args.invokerConfig),
    launchDispatches: args.persistence.listLaunchDispatchesByState(['enqueued', 'leased']),
  });
}
