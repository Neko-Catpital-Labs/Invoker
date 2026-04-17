import type { Logger } from '@invoker/contracts';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';

export function relaunchOrphansAndStartReady(
  orchestrator: Orchestrator,
  logger: Logger,
  logPrefix: string,
  workflowId?: string,
): TaskState[] {
  const orphanRestarted: TaskState[] = [];
  const activeTaskIds = orchestrator.getPersistedActiveTaskIds?.() ?? new Set<string>();
  for (const task of orchestrator.getAllTasks()) {
    if (workflowId && task.config.workflowId !== workflowId) {
      continue;
    }
    const isPersistedOrphan =
      task.status === 'running'
      || task.status === 'fixing_with_ai'
      || (task.status === 'pending' && activeTaskIds.has(task.id));
    if (!isPersistedOrphan) continue;

    const lastHeartbeat = task.execution.lastHeartbeatAt instanceof Date
      ? task.execution.lastHeartbeatAt.toISOString()
      : task.execution.lastHeartbeatAt ?? 'none';
    const startedAt = task.execution.startedAt instanceof Date
      ? task.execution.startedAt.toISOString()
      : task.execution.startedAt ?? 'none';
    logger.info(
      `relaunching orphaned in-flight task "${task.id}" (${task.status}${task.status === 'pending' ? '/claimed' : ''}) ` +
        `startedAt=${startedAt} lastHeartbeatAt=${lastHeartbeat} generation=${task.execution.generation ?? 0}`,
      { module: logPrefix },
    );
    const started = orchestrator.restartTask(task.id);
    const runnable = started.filter((candidate) => candidate.status === 'running');
    if (runnable.length > 0) {
      orphanRestarted.push(...runnable);
      continue;
    }

    const refreshed = orchestrator.getTask?.(task.id);
    if (refreshed?.status === 'running') {
      orphanRestarted.push(refreshed);
      continue;
    }

    orphanRestarted.push({
      ...task,
      status: 'running',
    });
  }

  const readyStarted = orchestrator.startExecution();
  const allStarted = [...orphanRestarted, ...readyStarted];
  if (allStarted.length > 0) {
    logger.info(
      `started ${allStarted.length} tasks (${orphanRestarted.length} orphans relaunched, ${readyStarted.length} ready): [${allStarted.map((task) => task.id).join(', ')}]`,
      { module: logPrefix },
    );
  }
  return allStarted;
}
