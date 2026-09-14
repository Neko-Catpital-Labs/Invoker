import { vi } from 'vitest';
import type { WorkResponse } from '@invoker/contracts';

/**
 * Creates a mock executor that auto-completes on start().
 * For merge nodes (no command/prompt), this simulates the executor's
 * handleProcessExit(0) path which immediately completes.
 */
export function createAutoCompleteExecutor() {
  let completeCallback: ((response: WorkResponse) => void) | undefined;
  return {
    type: 'worktree',
    start: vi.fn().mockImplementation(async (request: any) => {
      const handle = {
        executionId: `exec-${request.actionId}`,
        taskId: request.actionId,
        workspacePath: '/tmp/mock-worktree',
        branch: `experiment/${request.actionId}-mock`,
      };
      // Auto-complete after start (simulates no-command path)
      setTimeout(() => {
        if (completeCallback) {
          completeCallback({
            requestId: request.requestId,
            actionId: request.actionId,
            executionGeneration: request.executionGeneration,
            status: 'completed',
            outputs: { exitCode: 0 },
          });
        }
      }, 0);
      return handle;
    }),
    onComplete: vi.fn().mockImplementation((_handle: any, cb: any) => {
      completeCallback = cb;
    }),
    onOutput: vi.fn(),
    onHeartbeat: vi.fn(),
    kill: vi.fn(),
    destroyAll: vi.fn(),
  };
}
