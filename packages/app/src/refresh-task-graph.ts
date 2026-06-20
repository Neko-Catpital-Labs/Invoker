import type { Logger, WorkflowMeta } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';

interface DelegatedRefreshTaskGraphSnapshot {
  tasks: TaskState[];
  workflows: WorkflowMeta[];
  invokerHomeRoot?: string;
}

export interface ResolveRefreshTaskGraphSnapshotDeps {
  ownerMode: boolean;
  messageBus: Pick<MessageBus, 'request'>;
  localInvokerHomeRoot: string;
  logger: Logger;
  orchestrator: Pick<Orchestrator, 'syncAllFromDb' | 'getAllTasks'>;
  persistence: Pick<SQLiteAdapter, 'listWorkflows'>;
}

function asDelegatedRefreshTaskGraphSnapshot(value: unknown): DelegatedRefreshTaskGraphSnapshot | null {
  if (!value || typeof value !== 'object') return null;

  const snapshot = value as Partial<DelegatedRefreshTaskGraphSnapshot>;
  if (!Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.workflows)) {
    return null;
  }
  return snapshot as DelegatedRefreshTaskGraphSnapshot;
}

export async function resolveRefreshTaskGraphSnapshot(
  deps: ResolveRefreshTaskGraphSnapshotDeps,
): Promise<{ tasks: TaskState[]; workflows: WorkflowMeta[]; delegated: boolean }> {
  const readLocalSnapshot = () => {
    deps.orchestrator.syncAllFromDb();
    return {
      tasks: deps.orchestrator.getAllTasks(),
      workflows: deps.persistence.listWorkflows() as WorkflowMeta[],
      delegated: false,
    };
  };

  if (deps.ownerMode) {
    return readLocalSnapshot();
  }

  try {
    const delegated = asDelegatedRefreshTaskGraphSnapshot(
      await deps.messageBus.request('headless.query', { kind: 'task-graph-refresh' }) as unknown,
    );
    if (!delegated) {
      throw new Error('owner delegation returned no snapshot');
    }
    if (delegated.invokerHomeRoot && delegated.invokerHomeRoot !== deps.localInvokerHomeRoot) {
      throw new Error(
        `owner home mismatch: owner=${delegated.invokerHomeRoot} local=${deps.localInvokerHomeRoot}`,
      );
    }
    return {
      tasks: delegated.tasks,
      workflows: delegated.workflows,
      delegated: true,
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
