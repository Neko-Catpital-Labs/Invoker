/**
 * Single source for the `{ tasks, workflows, streamSequence }` task-graph
 * snapshot shape returned by `invoker:get-tasks`. Both the Electron read
 * handler (ipc-read-handlers.ts) and the web bridge dispatch
 * (web-invoker-dispatch.ts) build the snapshot through this function so the
 * two transports never diverge.
 */

import type { WorkflowMeta } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';

export interface TaskGraphSnapshot {
  tasks: TaskState[];
  workflows: WorkflowMeta[];
  streamSequence: number;
}

export interface BuildTaskGraphSnapshotDeps {
  orchestrator: Pick<Orchestrator, 'syncAllFromDb' | 'getAllTasks'>;
  persistence: Pick<SQLiteAdapter, 'listWorkflows'> & {
    loadWorkflowTaskSnapshot?: SQLiteAdapter['loadWorkflowTaskSnapshot'];
  };
  getStreamSequence: () => number;
}

export function buildTaskGraphSnapshot(deps: BuildTaskGraphSnapshotDeps): TaskGraphSnapshot {
  deps.orchestrator.syncAllFromDb();
  const snapshot = deps.persistence.loadWorkflowTaskSnapshot?.();
  return {
    tasks: (snapshot?.tasks ?? deps.orchestrator.getAllTasks()) as TaskState[],
    workflows: (snapshot?.workflows ?? deps.persistence.listWorkflows()) as WorkflowMeta[],
    streamSequence: deps.getStreamSequence(),
  };
}
