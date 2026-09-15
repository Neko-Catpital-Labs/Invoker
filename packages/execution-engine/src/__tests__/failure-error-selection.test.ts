import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import {
  BaseExecutor,
  selectFailedTaskStoredError,
  type BaseEntry,
} from '../base-executor.js';
import { SshExecutor } from '../ssh-executor.js';
import type { ExecutorHandle, TerminalSpec } from '../executor.js';

let spawnedProcesses: Array<ChildProcess & EventEmitter> = [];

function createMockProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();

  (proc as any).stdout = stdoutEmitter;
  (proc as any).stderr = stderrEmitter;
  (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
  (proc as any).pid = 12345;
  (proc as any).killed = false;
  (proc as any).exitCode = null;
  proc.kill = vi.fn().mockReturnValue(true);

  return proc;
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const proc = createMockProcess();
      spawnedProcesses.push(proc);
      return proc;
    }),
  };
});

function makeRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  return {
    requestId: 'req-1',
    actionId: 'failed-task',
    actionType: 'command',
    inputs: {
      command: 'pnpm test',
      description: 'run tests',
      workspacePath: '/tmp/invoker-failure-error-selection',
    },
    callbackUrl: '',
    timestamps: { createdAt: new Date().toISOString() },
    ...overrides,
  };
}

function currentTailSelection(output: string): string | undefined {
  const lines = output.split('\n');
  const tail = lines.slice(-50).join('\n').trim();
  if (!tail) return undefined;
  return tail.length > 3000 ? tail.slice(-3000) : tail;
}

function tracebackThenInstallChatter(): string {
  return [
    'Traceback (most recent call last):',
    '  File "/home/invoker/project/scripts/bootstrap.py", line 7, in <module>',
    '    import missing_dependency',
    "ModuleNotFoundError: No module named 'missing_dependency'",
    ...Array.from({ length: 200 }, (_, index) => `+ package${index.toString().padStart(3, '0')}==1.2.3`),
  ].join('\n');
}

class LocalFailureExecutor extends BaseExecutor<BaseEntry> {
  readonly type = 'local-test';

  async start(_request: WorkRequest): Promise<ExecutorHandle> {
    throw new Error('Not implemented');
  }

  async kill(_handle: ExecutorHandle): Promise<void> {}
  sendInput(_handle: ExecutorHandle, _input: string): void {}
  getTerminalSpec(_handle: ExecutorHandle): TerminalSpec | null { return null; }
  getRestoredTerminalSpec(): TerminalSpec { throw new Error('Not implemented'); }
  async destroyAll(): Promise<void> { this.entries.clear(); }

  protected override async recordTaskResult(): Promise<string | null> {
    return null;
  }

  async completeFailedRun(output: string): Promise<WorkResponse> {
    const request = makeRequest();
    const handle = this.createHandle(request);
    const entry: BaseEntry = {
      request,
      outputListeners: new Set(),
      outputBuffer: [output],
      outputBufferBytes: output.length,
      evictedChunkCount: 0,
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
    };
    this.registerEntry(handle, entry);
    const completed = new Promise<WorkResponse>((resolve) => {
      this.onComplete(handle, resolve);
    });
    await this.handleProcessExit(handle.executionId, request, process.cwd(), 1);
    return completed;
  }
}

async function completeSshFailedRun(output: string): Promise<WorkResponse> {
  const ssh = new SshExecutor({
    host: 'localhost',
    user: 'testuser',
    sshKeyPath: '/dev/null',
  });
  const request = makeRequest();
  const handle = await ssh.start(request);
  const completed = new Promise<WorkResponse>((resolve) => {
    ssh.onComplete(handle, resolve);
  });
  const child = spawnedProcesses[spawnedProcesses.length - 1];
  if (!child) throw new Error('expected SSH process to be spawned');

  child.stdout?.emit('data', Buffer.from(output));
  child.emit('close', 1, null);
  return completed;
}

describe('failed task stored error selection', () => {
  beforeEach(() => {
    spawnedProcesses = [];
  });

  it('keeps a Python traceback that appears before install chatter', () => {
    const output = tracebackThenInstallChatter();

    const stored = selectFailedTaskStoredError(output);

    expect(stored).toContain('Traceback (most recent call last):');
    expect(stored).toContain("ModuleNotFoundError: No module named 'missing_dependency'");
    expect(stored).not.toBe(currentTailSelection(output));
  });

  it('keeps the existing tail selection byte for byte when no error-shaped content exists', () => {
    const output = Array.from(
      { length: 90 },
      (_, index) => `+ package${index.toString().padStart(3, '0')}==1.2.3`,
    ).join('\n');

    expect(selectFailedTaskStoredError(output)).toBe(currentTailSelection(output));
  });

  it('uses the same stored error selection for local and SSH executors', async () => {
    const output = tracebackThenInstallChatter();
    const local = new LocalFailureExecutor();

    const localResponse = await local.completeFailedRun(output);
    const sshResponse = await completeSshFailedRun(output);

    expect(localResponse.outputs.error).toBe(sshResponse.outputs.error);
    expect(localResponse.outputs.error).toBe(selectFailedTaskStoredError(output));
  });
});
