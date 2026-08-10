import type { Logger, WorkflowMeta } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';

interface DelegatedRefreshTaskGraphSnapshot {
  tasks: TaskState[];
  workflows: WorkflowMeta[];
  streamSequence: number;
  invokerHomeRoot?: string;
}

export interface RefreshTaskGraphSnapshot {
  tasks: TaskState[];
  workflows: WorkflowMeta[];
  streamSequence: number;
}

export interface ResolveRefreshTaskGraphSnapshotDeps {
  ownerMode: boolean;
  messageBus: Pick<MessageBus, 'request'>;
  resolveInvokerHomeRoot: () => string;
  orchestrator: Pick<Orchestrator, 'syncAllFromDb' | 'getAllTasks'>;
  persistence: Pick<SQLiteAdapter, 'listWorkflows'>;
  logger: Logger;
  getStreamSequence: () => number;
}
export interface RefreshTaskGraphSnapshotPublisher {
  publishSnapshot(
    reason: string,
    tasks: TaskState[],
    workflows: WorkflowMeta[],
    streamSequence: number,
    forced?: boolean,
  ): void;
}


function parseDelegatedRefreshTaskGraphSnapshot(
  value: unknown,
  localInvokerHomeRoot: string,
): DelegatedRefreshTaskGraphSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('refresh-task-graph owner delegation returned no snapshot');
  }

  const snapshot = value as {
    tasks?: unknown[];
    workflows?: unknown[];
    streamSequence?: unknown;
    invokerHomeRoot?: string;
  };
  if (
    !Array.isArray(snapshot.tasks) ||
    !Array.isArray(snapshot.workflows) ||
    typeof snapshot.streamSequence !== 'number'
  ) {
    throw new Error('refresh-task-graph owner delegation returned an invalid snapshot');
  }
  if (snapshot.invokerHomeRoot && snapshot.invokerHomeRoot !== localInvokerHomeRoot) {
    throw new Error(
      `refresh-task-graph owner home mismatch: owner=${snapshot.invokerHomeRoot} local=${localInvokerHomeRoot}`,
    );
  }

  return snapshot as DelegatedRefreshTaskGraphSnapshot;
}

export async function resolveRefreshTaskGraphSnapshot(
  deps: ResolveRefreshTaskGraphSnapshotDeps,
): Promise<RefreshTaskGraphSnapshot> {
  const readLocalSnapshot = (): RefreshTaskGraphSnapshot => {
    deps.orchestrator.syncAllFromDb();
    return {
      tasks: deps.orchestrator.getAllTasks(),
      workflows: deps.persistence.listWorkflows() as WorkflowMeta[],
      streamSequence: deps.getStreamSequence(),
    };
  };

  if (deps.ownerMode) {
    return readLocalSnapshot();
  }

  try {
    const delegated = parseDelegatedRefreshTaskGraphSnapshot(
      await deps.messageBus.request('headless.query', { kind: 'task-graph-refresh' }) as unknown,
      deps.resolveInvokerHomeRoot(),
    );
    // streamSequence is a per-caller delivery count (how many deltas THIS
    // process has locally stamped and forwarded to its own renderer), not a
    // value the remote owner can know. Trusting `delegated.streamSequence`
    // here handed the caller a number from a different process's counter
    // (or the standalone owner's unrelated stub) — never comparable to the
    // watermark the caller's own gap-detection tracks, so a resync could
    // never actually close the gap that triggered it.
    return {
      tasks: delegated.tasks,
      workflows: delegated.workflows,
      streamSequence: deps.getStreamSequence(),
    };
  } catch (err) {
    deps.logger.warn(
      `refresh-task-graph owner delegation failed; falling back to local read-only snapshot: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { module: 'ipc' },
    );
    return readLocalSnapshot();
  }
}
export function publishForcedRefreshTaskGraphSnapshot(
  publisher: RefreshTaskGraphSnapshotPublisher,
  reason: string,
  snapshot: RefreshTaskGraphSnapshot,
): void {
  publisher.publishSnapshot(reason, snapshot.tasks, snapshot.workflows, snapshot.streamSequence, true);
}
