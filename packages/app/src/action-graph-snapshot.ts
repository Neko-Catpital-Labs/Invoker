import type { ActionGraphResponse } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { Orchestrator } from '@invoker/workflow-core';
import type { InvokerConfig } from './config.js';
import {
  buildActionGraphDiagnostics,
  resolveActionDiagnosticsStallThresholdMs,
} from './action-graph-diagnostics.js';

function needsActionGraphDetail(status: string): boolean {
  switch (status) {
    case 'running':
    case 'queued':
    case 'failed':
    case 'fixing_with_ai':
    case 'blocked':
    case 'needs_input':
    case 'awaiting_approval':
    case 'review_ready':
    case 'stale':
      return true;
    default:
      return false;
  }
}

export function buildCurrentActionGraphSnapshot(args: {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  invokerConfig: InvokerConfig;
}): ActionGraphResponse {
  args.orchestrator.syncAllFromDb();
  const tasks = args.orchestrator.getAllTasks();
  const workflows = args.persistence.listWorkflows();

  const attemptsByTaskId = new Map<string, ReturnType<SQLiteAdapter['loadActionGraphAttempts']>>();
  const eventsByTaskId = new Map<string, ReturnType<SQLiteAdapter['getEvents']>>();
  for (const task of tasks) {
    if (!needsActionGraphDetail(task.status) && !task.execution.selectedAttemptId) continue;
    attemptsByTaskId.set(
      task.id,
      args.persistence.loadActionGraphAttempts(task.id, task.execution.selectedAttemptId),
    );
    eventsByTaskId.set(task.id, args.persistence.getEvents(task.id, 'desc', 20));
  }

  return buildActionGraphDiagnostics({
    workflows,
    tasks,
    attemptsByTaskId,
    queueStatus: args.orchestrator.getQueueStatus({ refresh: false }),
    mutationIntents: args.persistence.listWorkflowMutationIntents(undefined, ['queued', 'running', 'failed']),
    mutationLeases: args.persistence.listWorkflowMutationLeases(),
    eventsByTaskId,
    activityLogs: args.persistence.getActivityLogs(0, 200),
    stallThresholdMs: resolveActionDiagnosticsStallThresholdMs(args.invokerConfig),
    launchDispatches: args.persistence.listLaunchDispatchesByState(['enqueued', 'leased']),
  });
}
