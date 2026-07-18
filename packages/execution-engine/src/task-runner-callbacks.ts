import type { WorkResponse } from '@invoker/contracts';
import type { TaskHeartbeatSource } from '@invoker/workflow-core';
import type { Executor, ExecutorHandle } from './executor.js';

export interface TaskHeartbeatEvent {
  at: Date;
  source: TaskHeartbeatSource;
}

export interface TaskRunnerCallbacks {
  onOutput?: (taskId: string, data: string) => void;
  onLaunchAccepted?: (taskId: string) => void;
  onLaunchStart?: (taskId: string, executor: Executor) => void;
  onLaunchFailed?: (taskId: string, error: Error, executor: Executor) => void;
  onSpawned?: (taskId: string, handle: ExecutorHandle, executor: Executor) => void;
  onComplete?: (taskId: string, response: WorkResponse) => void;
  onHeartbeat?: (taskId: string, event: TaskHeartbeatEvent) => void;
  onLaunchSettled?: (taskId: string) => void;
}
