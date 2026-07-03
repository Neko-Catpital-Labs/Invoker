/**
 * Surface-event relay — publishes workflow-progress cards on the IPC bus so an
 * out-of-process surface (the Slack manager) can render live progress without
 * opening the database or living inside the Electron app.
 *
 * This mirrors the in-process progress path the embedded Slack bot formerly ran
 * (`emitWorkflowProgress` + the debounced `task.delta` subscription), but instead
 * of calling `slack.handleEvent` directly it publishes a `Channels.SURFACE_EVENT`
 * message. Publishing with no subscriber is a harmless no-op (IpcBus only
 * delivers to connected peers), so this can run in every owner process whether
 * or not any surface is listening.
 *
 * Unlike the in-process path, the relay does NOT gate on a workflow→channel map
 * (that mapping now lives in the manager's own store). It emits for every
 * workflow that produces task deltas; the surface filters to mapped channels.
 */

import { Channels, type MessageBus } from '@invoker/transport';
import type { Orchestrator, TaskDelta, TaskState } from '@invoker/workflow-core';
import type { PersistenceAdapter } from '@invoker/data-store';
import { buildReviewGateQueryResponse } from './review-gate-query.js';

export interface SurfaceEventRelayDeps {
  messageBus: MessageBus;
  persistence: Pick<PersistenceAdapter, 'loadTasks' | 'loadWorkflow'>;
  orchestrator: Pick<Orchestrator, 'getWorkflowStatus'>;
  /** Logs a warning when a progress emit fails. */
  logWarn: (message: string) => void;
}

const PROGRESS_DEBOUNCE_MS = 2500;
const TERMINAL_DERIVED_STATUSES = new Set(['completed', 'failed', 'closed']);

/** Derive the owning workflow id from a task id (`wf-…/task` or `__merge__wf-…`). */
function workflowIdFromTaskId(taskId: string): string | undefined {
  if (taskId.startsWith('__merge__')) return taskId.slice('__merge__'.length);
  const slash = taskId.indexOf('/');
  return slash <= 0 ? undefined : taskId.slice(0, slash);
}

/**
 * Start relaying workflow-progress surface events on the IPC bus.
 * Returns a stop function that unsubscribes and clears pending timers.
 */
export function startSurfaceEventRelay(deps: SurfaceEventRelayDeps): () => void {
  const { messageBus, persistence, orchestrator } = deps;
  const progressTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const emitWorkflowProgress = (workflowId: string): void => {
    const tasks = persistence.loadTasks(workflowId);
    const workflow = persistence.loadWorkflow(workflowId);
    const counts = orchestrator.getWorkflowStatus(workflowId);
    const percentComplete = counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0;
    const gate = buildReviewGateQueryResponse({ workflowId, workflow, tasks });
    const prUrl = gate.artifacts.find((artifact) => artifact.url)?.url;
    const reviewState = gate.mergeTaskId
      ? (gate.ready ? 'review ready' : (gate.status ?? undefined))
      : undefined;
    const event = {
      type: 'workflow_progress' as const,
      progress: {
        workflowId,
        name: (workflow as { name?: string } | undefined)?.name ?? workflowId,
        counts,
        percentComplete,
        tasks: tasks.map((task: TaskState) => ({
          id: task.id,
          name: task.description,
          status: task.status,
          phase: task.execution.phase,
          reviewUrl: task.execution.reviewUrl,
        })),
        prUrl,
        reviewState,
      },
    };
    messageBus.publish(Channels.SURFACE_EVENT, event);
  };

  const scheduleWorkflowProgress = (workflowId: string, flushNow: boolean): void => {
    clearTimeout(progressTimers.get(workflowId));
    const fire = (): void => {
      progressTimers.delete(workflowId);
      try {
        emitWorkflowProgress(workflowId);
      } catch (err) {
        deps.logWarn(`surface-event relay emit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (flushNow) {
      fire();
      return;
    }
    const timer = setTimeout(fire, PROGRESS_DEBOUNCE_MS);
    timer.unref?.();
    progressTimers.set(workflowId, timer);
  };

  const unsubscribe = messageBus.subscribe(Channels.TASK_DELTA, (delta: unknown) => {
    const d = delta as TaskDelta;
    const taskId = d.type === 'created' ? d.task.id : d.taskId;
    const workflowId = workflowIdFromTaskId(taskId);
    if (!workflowId) return;
    const status = d.type === 'updated'
      ? (d.changes.status as string | undefined)
      : d.type === 'created' ? d.task.status : undefined;
    // Flush immediately when this delta drives the workflow to a terminal state.
    let flushNow = false;
    if (status && TERMINAL_DERIVED_STATUSES.has(status)) {
      const counts = orchestrator.getWorkflowStatus(workflowId);
      flushNow = counts.running === 0 && counts.pending === 0;
    }
    scheduleWorkflowProgress(workflowId, flushNow);
  });

  return () => {
    unsubscribe();
    for (const timer of progressTimers.values()) clearTimeout(timer);
    progressTimers.clear();
  };
}
