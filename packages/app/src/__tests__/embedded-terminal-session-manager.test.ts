/**
 * Unit tests for the embedded terminal session manager.
 *
 * Cover the contract called out by the implementation plan:
 *   - GUI open-terminal for an existing task returns an opened embedded
 *     session descriptor.
 *   - Reopening the same task reuses the same session id (reused=true).
 *   - Workspace invariants from the shared resolver are preserved.
 *   - Running tasks attach to executor.onOutput / sendInput when a handle
 *     is available.
 *   - Headless / external launcher behaviour is unaffected (regression
 *     guard documented separately).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExecutorRegistry, WorktreeExecutor } from '@invoker/execution-engine';
import type {
  Executor,
  ExecutorHandle,
  PersistedTaskMeta,
  TerminalSpec,
  Unsubscribe,
} from '@invoker/execution-engine';
import { EmbeddedTerminalSessionManager } from '../embedded-terminal-session-manager.js';
import type {
  TerminalBackend,
  TerminalProcess,
  SpawnTerminalOptions,
} from '../terminal-pty-backend.js';
import type { OpenTerminalPersistence } from '../open-terminal-for-task.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
import { existsSync } from 'node:fs';

interface FakeProcessRecord {
  opts: SpawnTerminalOptions;
  process: FakeProcess;
}

class FakeProcess implements TerminalProcess {
  pid = 12345;
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed = false;
  private dataListeners = new Set<(d: string) => void>();
  private exitListeners = new Set<(c: number | null) => void>();

  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
    this.emitExit(0);
  }
  onData(cb: (d: string) => void): Unsubscribe {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }
  onExit(cb: (c: number | null) => void): Unsubscribe {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }
  emitData(d: string): void {
    for (const l of this.dataListeners) l(d);
  }
  emitExit(code: number | null): void {
    for (const l of this.exitListeners) l(code);
  }
}

function makeFakeBackend(records: FakeProcessRecord[]): TerminalBackend {
  return (opts) => {
    const proc = new FakeProcess();
    records.push({ opts, process: proc });
    return proc;
  };
}

function makePersistence(overrides: Partial<OpenTerminalPersistence> = {}): OpenTerminalPersistence {
  return {
    getTaskStatus: () => 'completed',
    getRunnerKind: () => 'worktree',
    getAgentSessionId: () => null,
    getContainerId: () => null,
    getWorkspacePath: () => '/tmp/wt/task-a',
    getBranch: () => 'experiment/task-a',
    ...overrides,
  };
}

describe('EmbeddedTerminalSessionManager.open', () => {
  let registry: ExecutorRegistry;

  beforeEach(() => {
    registry = new ExecutorRegistry();
    registry.register(
      'worktree',
      new WorktreeExecutor({ worktreeBaseDir: '/tmp/wt', cacheDir: '/tmp/cache' }),
    );
    vi.mocked(existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  it('returns an opened embedded session descriptor for a completed task', async () => {
    const records: FakeProcessRecord[] = [];
    const outputs: Array<{ sessionId: string; data: string }> = [];
    const manager = new EmbeddedTerminalSessionManager({
      backend: makeFakeBackend(records),
      emitOutput: (e) => outputs.push({ sessionId: e.sessionId, data: e.data }),
    });

    const result = await manager.open({
      taskId: 'task-a',
      persistence: makePersistence(),
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    expect(result.opened).toBe(true);
    if (!result.opened) return;
    expect(result.session.taskId).toBe('task-a');
    expect(result.session.sessionId).toMatch(/[0-9a-f-]{8,}/i);
    expect(result.session.mode).toBe('pty');
    expect(result.session.status).toBe('running');
    expect(result.session.reused).toBe(false);
    expect(result.session.cwd).toBe('/tmp/wt/task-a');

    // Backend received a real spawn request with the resolved cwd
    expect(records).toHaveLength(1);
    expect(records[0].opts.cwd).toBe('/tmp/wt/task-a');

    // Output piping: data from the PTY is broadcast under the session id
    records[0].process.emitData('hello\r\n');
    expect(outputs).toEqual([{ sessionId: result.session.sessionId, data: 'hello\r\n' }]);
  });

  it('reuses the same session id when the same task is reopened', async () => {
    const records: FakeProcessRecord[] = [];
    const manager = new EmbeddedTerminalSessionManager({ backend: makeFakeBackend(records) });
    const persistence = makePersistence();

    const first = await manager.open({
      taskId: 'task-a',
      persistence,
      executorRegistry: registry,
      repoRoot: '/repo',
    });
    expect(first.opened).toBe(true);

    const second = await manager.open({
      taskId: 'task-a',
      persistence,
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    expect(second.opened).toBe(true);
    if (!first.opened || !second.opened) return;
    expect(second.session.sessionId).toBe(first.session.sessionId);
    expect(second.session.reused).toBe(true);
    // The backend must NOT be invoked again when reusing the session
    expect(records).toHaveLength(1);
  });

  it('opens a fresh session after the previous one exits', async () => {
    const records: FakeProcessRecord[] = [];
    const manager = new EmbeddedTerminalSessionManager({ backend: makeFakeBackend(records) });
    const persistence = makePersistence();

    const first = await manager.open({
      taskId: 'task-a',
      persistence,
      executorRegistry: registry,
      repoRoot: '/repo',
    });
    expect(first.opened).toBe(true);
    if (!first.opened) return;

    records[0].process.emitExit(0);

    const second = await manager.open({
      taskId: 'task-a',
      persistence,
      executorRegistry: registry,
      repoRoot: '/repo',
    });
    expect(second.opened).toBe(true);
    if (!second.opened) return;
    expect(second.session.sessionId).not.toBe(first.session.sessionId);
    expect(second.session.reused).toBe(false);
    expect(records).toHaveLength(2);
  });

  it('preserves the managed-workspace invariant from the shared resolver', async () => {
    const manager = new EmbeddedTerminalSessionManager({
      backend: makeFakeBackend([]),
    });

    const result = await manager.open({
      taskId: 'task-missing',
      persistence: makePersistence({ getWorkspacePath: () => null }),
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    expect(result.opened).toBe(false);
    if (result.opened) return;
    expect(result.reason).toContain('workspace metadata is missing');
    expect(result.reason).toContain('worktree');
  });

  it('returns a not-found reason when the task does not exist', async () => {
    const manager = new EmbeddedTerminalSessionManager({ backend: makeFakeBackend([]) });

    const result = await manager.open({
      taskId: 'task-missing',
      persistence: makePersistence({ getTaskStatus: () => null }),
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    expect(result.opened).toBe(false);
    if (result.opened) return;
    expect(result.reason).toContain('not found');
  });

  it('attaches to executor.onOutput for a running task with an active handle', async () => {
    const records: FakeProcessRecord[] = [];
    const outputs: string[] = [];

    const onOutputSubs: Array<(d: string) => void> = [];
    const sentInput: string[] = [];
    const handle: ExecutorHandle = { executionId: 'exec-1', taskId: 'task-running' };
    const fakeExecutor: Executor = {
      type: 'worktree',
      start: vi.fn(),
      kill: vi.fn(),
      sendInput: vi.fn((_h, input: string) => {
        sentInput.push(input);
      }),
      onOutput: vi.fn((_h, cb: (d: string) => void) => {
        onOutputSubs.push(cb);
        return () => undefined;
      }),
      onComplete: vi.fn(() => () => undefined),
      onHeartbeat: vi.fn(() => () => undefined),
      getTerminalSpec: vi.fn(() => ({ cwd: '/tmp/wt/running' })),
      getRestoredTerminalSpec: vi.fn(
        (_meta: PersistedTaskMeta): TerminalSpec => ({ cwd: '/tmp/wt/running' }),
      ),
      destroyAll: vi.fn(),
    };
    registry.register('worktree', fakeExecutor);

    const manager = new EmbeddedTerminalSessionManager({
      backend: makeFakeBackend(records),
      getTaskHandle: (taskId) =>
        taskId === 'task-running' ? { handle, executor: fakeExecutor } : undefined,
      emitOutput: (e) => outputs.push(e.data),
    });

    const result = await manager.open({
      taskId: 'task-running',
      persistence: makePersistence({
        getTaskStatus: () => 'running',
        getWorkspacePath: () => '/tmp/wt/running',
      }),
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    expect(result.opened).toBe(true);
    if (!result.opened) return;
    expect(result.session.mode).toBe('executor-attached');

    // Should NOT have spawned a PTY for the running task
    expect(records).toHaveLength(0);
    expect(fakeExecutor.onOutput).toHaveBeenCalledTimes(1);

    // Output piped through executor.onOutput
    onOutputSubs[0]('streamed-output');
    expect(outputs).toEqual(['streamed-output']);

    // Input is routed via executor.sendInput
    manager.write(result.session.sessionId, 'hello\n');
    expect(sentInput).toEqual(['hello\n']);
  });
});

describe('EmbeddedTerminalSessionManager.write/resize/close', () => {
  let registry: ExecutorRegistry;
  beforeEach(() => {
    registry = new ExecutorRegistry();
    registry.register(
      'worktree',
      new WorktreeExecutor({ worktreeBaseDir: '/tmp/wt', cacheDir: '/tmp/cache' }),
    );
    vi.mocked(existsSync).mockReturnValue(true);
  });
  afterEach(() => vi.mocked(existsSync).mockReset());

  it('routes write/resize/close to the underlying PTY process', async () => {
    const records: FakeProcessRecord[] = [];
    const exits: number[] = [];
    const manager = new EmbeddedTerminalSessionManager({
      backend: makeFakeBackend(records),
      emitExit: (e) => {
        if (typeof e.exitCode === 'number') exits.push(e.exitCode);
      },
    });

    const opened = await manager.open({
      taskId: 'task-a',
      persistence: makePersistence(),
      executorRegistry: registry,
      repoRoot: '/repo',
    });
    expect(opened.opened).toBe(true);
    if (!opened.opened) return;
    const id = opened.session.sessionId;

    expect(manager.write(id, 'echo hi\n').ok).toBe(true);
    expect(records[0].process.written).toEqual(['echo hi\n']);

    expect(manager.resize(id, 132, 40).ok).toBe(true);
    expect(records[0].process.resized).toEqual([[132, 40]]);

    expect(manager.list()).toHaveLength(1);

    expect(manager.close(id).ok).toBe(true);
    expect(records[0].process.killed).toBe(true);
    expect(manager.list()).toHaveLength(0);

    // close() triggers exit emission via kill→emitExit
    expect(exits).toEqual([0]);

    // After close, subsequent operations on the same id fail cleanly.
    expect(manager.write(id, 'late').ok).toBe(false);
  });
});
