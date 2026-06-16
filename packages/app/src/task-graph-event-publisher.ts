import type { BrowserWindow } from 'electron';
import type { TaskGraphEvent, WorkflowMeta } from '@invoker/contracts';
import type { TaskDelta, TaskState } from '@invoker/workflow-core';

const UI_TASK_GRAPH_FLUSH_DELAY_MS = 25;
const UI_TASK_GRAPH_BATCH_LIMIT = 250;
const UI_TASK_GRAPH_LARGE_BATCH_THRESHOLD = 200;

type SnapshotTaskStates = Extract<TaskGraphEvent, { type: 'snapshot' }>['tasks'];

export interface TaskGraphEventPublisher {
  publishDelta(delta: TaskDelta): void;
  publishSnapshot(reason: string, tasks: TaskState[], workflows: WorkflowMeta[]): void;
}

export interface CreateTaskGraphEventPublisherOptions {
  getMainWindow: () => BrowserWindow | null;
  isUiInteractive: () => boolean;
  stampDelta: (delta: TaskDelta) => TaskDelta;
  getStreamSequence: () => number;
  onLargeBatch?: (stats: { batchSize: number; remaining: number }) => void;
}

export function createTaskGraphEventPublisher(
  options: CreateTaskGraphEventPublisherOptions,
): TaskGraphEventPublisher {
  const pendingEvents: TaskGraphEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const mainWindow = options.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || !options.isUiInteractive() || pendingEvents.length === 0) {
      pendingEvents.length = 0;
      return;
    }

    const batch = pendingEvents.splice(0, Math.min(pendingEvents.length, UI_TASK_GRAPH_BATCH_LIMIT));
    if (pendingEvents.length > 0) {
      flushTimer = setTimeout(flush, 0);
      flushTimer.unref?.();
    }
    if (batch.length >= UI_TASK_GRAPH_LARGE_BATCH_THRESHOLD) {
      options.onLargeBatch?.({ batchSize: batch.length, remaining: pendingEvents.length });
    }
    if (batch.length === 1) {
      mainWindow.webContents.send('invoker:task-graph-event', batch[0]);
      return;
    }
    mainWindow.webContents.send('invoker:task-graph-event-batch', batch);
  };

  const publishEvent = (event: TaskGraphEvent): void => {
    const mainWindow = options.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || !options.isUiInteractive()) {
      return;
    }
    pendingEvents.push(event);
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(flush, UI_TASK_GRAPH_FLUSH_DELAY_MS);
    flushTimer.unref?.();
  };

  return {
    publishDelta(delta: TaskDelta): void {
      publishEvent({
        type: 'delta',
        delta: options.stampDelta(delta),
      });
    },
    publishSnapshot(reason: string, tasks: TaskState[], workflows: WorkflowMeta[]): void {
      publishEvent({
        type: 'snapshot',
        tasks: tasks as SnapshotTaskStates,
        workflows,
        reason,
        streamSequence: options.getStreamSequence(),
      });
    },
  };
}
