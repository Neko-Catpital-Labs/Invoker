import type { WorkRequest, WorkResponse } from '@invoker/protocol';

export type Unsubscribe = () => void;

export interface ExecutorHandle {
  executionId: string;
  taskId: string;
}

export interface Executor {
  readonly type: string;
  start(request: WorkRequest): Promise<ExecutorHandle>;
  kill(handle: ExecutorHandle): Promise<void>;
  sendInput(handle: ExecutorHandle, input: string): void;
  onOutput(handle: ExecutorHandle, cb: (data: string) => void): Unsubscribe;
  onComplete(handle: ExecutorHandle, cb: (response: WorkResponse) => void): Unsubscribe;
  destroyAll(): Promise<void>;
}
