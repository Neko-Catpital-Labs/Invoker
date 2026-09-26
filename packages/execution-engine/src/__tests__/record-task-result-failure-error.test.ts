import { describe, expect, it } from 'vitest';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import { BaseExecutor, type BaseEntry } from '../base-executor.js';
import type { ExecutorHandle, TerminalSpec } from '../executor.js';

function makeRequest(): WorkRequest {
  return {
    requestId: 'req-record',
    actionId: 'record-fails',
    actionType: 'command',
    inputs: {
      command: 'true',
      description: 'command that succeeds',
      workspacePath: '/tmp/invoker-record-task-result-failure',
    },
    callbackUrl: '',
    timestamps: { createdAt: new Date().toISOString() },
  };
}

class RecordFailsExecutor extends BaseExecutor<BaseEntry> {
  readonly type = 'record-fails-test';

  async start(_request: WorkRequest): Promise<ExecutorHandle> {
    throw new Error('Not implemented');
  }

  async kill(_handle: ExecutorHandle): Promise<void> {}
  sendInput(_handle: ExecutorHandle, _input: string): void {}
  getTerminalSpec(_handle: ExecutorHandle): TerminalSpec | null { return null; }
  getRestoredTerminalSpec(): TerminalSpec { throw new Error('Not implemented'); }
  async destroyAll(): Promise<void> { this.entries.clear(); }

  protected override async recordTaskResult(): Promise<string | null> {
    throw new Error('fatal: not a git repository: (null)');
  }

  async completeSuccessfulCommand(): Promise<WorkResponse> {
    const request = makeRequest();
    const handle = this.createHandle(request);
    this.registerEntry(handle, {
      request,
      outputListeners: new Set(),
      outputBuffer: ['created INV-1\n'],
      outputBufferBytes: 14,
      evictedChunkCount: 0,
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
    });
    const completed = new Promise<WorkResponse>((resolve) => {
      this.onComplete(handle, resolve);
    });
    await this.handleProcessExit(handle.executionId, request, process.cwd(), 0);
    return completed;
  }
}

describe('recordTaskResult failure after a clean exit', () => {
  it('fails the task and stores the record error instead of an empty error', async () => {
    const response = await new RecordFailsExecutor().completeSuccessfulCommand();
    expect(response.status).toBe('failed');
    expect(String(response.outputs.error)).toContain('recordTaskResult');
    expect(String(response.outputs.error)).toContain('fatal: not a git repository');
  });
});
