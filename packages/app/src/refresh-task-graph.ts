import type { Logger, WorkflowMeta } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';

interface DelegatedRefreshTaskGraphSnapshot {
  tasks: TaskState[];
  workflows: WorkflowMeta[];
  invokerHomeRoot?: string;
}

export interface RefreshTaskGraphSnapshot {
  tasks: TaskState[];
  workflows: WorkflowMeta[];
}

export interface ResolveRefreshTaskGraphSnapshotDeps {
  ownerMode: boolean;
  messageBus: Pick<MessageBus, 'request'>;
  resolveInvokerHomeRoot: () => string;
  orchestrator: Pick<Orchestrator, 'syncAllFromDb' | 'getAllTasks'>;
  persistence: Pick<SQLiteAdapter, 'listWorkflows'>;
  logger: Logger;
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
    invokerHomeRoot?: string;
  };
  if (!Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.workflows)) {
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
    return {
      tasks: delegated.tasks,
      workflows: delegated.workflows,
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
