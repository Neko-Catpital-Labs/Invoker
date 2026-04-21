import type { SQLiteAdapter, WorkflowMutationIntent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import { listOpenFixIntentsForTask } from './auto-fix-intents.js';

type AutoFixOrchestrator = {
  shouldAutoFix(taskId: string): boolean;
  getTask(taskId: string): TaskState | undefined;
};

type AutoFixPersistence = Pick<SQLiteAdapter, 'listWorkflowMutationIntents'>;

export type AutoFixEnqueueDecision =
  | { shouldEnqueue: true }
  | {
    shouldEnqueue: false;
    reason: 'shouldAutoFix-false' | 'already-live-intent';
    status?: string;
    existingIntentIds?: number[];
  };

export type AutoFixDispatchDecision =
  | { shouldDispatch: true; task: TaskState }
  | {
    shouldDispatch: false;
    reason: 'shouldAutoFix-false';
    status: string;
    autoFixAttempts: number | null;
  };

export function getOpenAutoFixIntentsForTask(
  persistence: AutoFixPersistence,
  workflowId: string,
  taskId: string,
): WorkflowMutationIntent[] {
  const openIntents = persistence.listWorkflowMutationIntents(workflowId, ['queued', 'running']);
  return listOpenFixIntentsForTask(openIntents, taskId);
}

export function getAutoFixEnqueueDecision(
  orchestrator: AutoFixOrchestrator,
  persistence: AutoFixPersistence,
  workflowId: string,
  taskId: string,
): AutoFixEnqueueDecision {
  const shouldAutoFixNow = orchestrator.shouldAutoFix(taskId);
  if (!shouldAutoFixNow) {
    return {
      shouldEnqueue: false,
      reason: 'shouldAutoFix-false',
      status: orchestrator.getTask(taskId)?.status,
    };
  }

  const openTaskFixIntents = getOpenAutoFixIntentsForTask(persistence, workflowId, taskId);
  if (openTaskFixIntents.length > 0) {
    return {
      shouldEnqueue: false,
      reason: 'already-live-intent',
      status: orchestrator.getTask(taskId)?.status,
      existingIntentIds: openTaskFixIntents.map((intent) => intent.id),
    };
  }

  return { shouldEnqueue: true };
}

export function getAutoFixDispatchDecision(
  orchestrator: AutoFixOrchestrator,
  taskId: string,
): AutoFixDispatchDecision {
  const task = orchestrator.getTask(taskId);
  if (task && orchestrator.shouldAutoFix(taskId)) {
    return { shouldDispatch: true, task };
  }
  return {
    shouldDispatch: false,
    reason: 'shouldAutoFix-false',
    status: task?.status ?? 'missing',
    autoFixAttempts: task?.execution.autoFixAttempts ?? null,
  };
}
