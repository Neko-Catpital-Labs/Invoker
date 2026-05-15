import type { Logger } from '@invoker/contracts';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import { isDispatchableLaunch } from './global-topup.js';

export function relaunchOrphansAndStartReady(
  orchestrator: Orchestrator,
  logger: Logger,
  logPrefix: string,
  workflowId?: string,
): TaskState[] {
  let preparedOrphanCount = 0;
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
    const prepareTaskForNewAttempt = (
      orchestrator as Partial<Pick<Orchestrator, 'prepareTaskForNewAttempt'>>
    ).prepareTaskForNewAttempt;
    if (typeof prepareTaskForNewAttempt === 'function') {
      prepareTaskForNewAttempt.call(orchestrator, task.id, `${logPrefix}_orphan_relaunch`);
    } else {
      const started = orchestrator.retryTask(task.id);
      const runnable = started.filter(isDispatchableLaunch);
      if (runnable.length > 0) {
        orphanRestarted.push(...runnable);
      } else {
        const refreshed = orchestrator.getTask?.(task.id);
        orphanRestarted.push(refreshed?.status === 'running' ? refreshed : { ...task, status: 'running' });
      }
    }
    preparedOrphanCount += 1;
  }

  const readyStarted = orchestrator.startExecution();
  const allStarted = [
    ...orphanRestarted,
    ...readyStarted.filter(isDispatchableLaunch),
  ];
  if (allStarted.length > 0) {
    logger.info(
      `started ${allStarted.length} tasks (${preparedOrphanCount} orphans prepared, ${readyStarted.length} ready): [${allStarted.map((task) => task.id).join(', ')}]`,
      { module: logPrefix },
    );
  }
  return allStarted;
}
