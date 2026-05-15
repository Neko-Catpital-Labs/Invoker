/**
 * Embedded terminal session manager — main-process backend tests.
 *
 * These tests inject a deterministic in-memory PTY backend so we can verify
 * session reuse, attached-mode wiring, write/resize/close behavior, and
 * preservation of the workspace-metadata safety contract — without
 * spawning real processes or depending on node-pty.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExecutorRegistry, WorktreeExecutor, type ExecutorHandle, type Executor, type Unsubscribe } from '@invoker/execution-engine';
import {
  EmbeddedTerminalManager,
  type PtyBackend,
  type PtyHandle,
  type PtySpawnOptions,
} from '../embedded-terminal-manager.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
import { existsSync } from 'node:fs';

// ── Fake PTY backend ────────────────────────────────────────

interface FakePty extends PtyHandle {
  spawnOpts: PtySpawnOptions;
  emitData(chunk: string): void;
  emitExit(exitCode: number, signal?: string): void;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: boolean;
}

function createFakePtyBackend(): { backend: PtyBackend; spawned: FakePty[] } {
  const spawned: FakePty[] = [];
  const backend: PtyBackend = {
    spawn(opts) {
      const dataListeners = new Set<(chunk: string) => void>();
      const exitListeners = new Set<(info: { exitCode: number; signal?: string }) => void>();
      const fake: FakePty = {
        spawnOpts: opts,
        writes: [],
        resizes: [],
        killed: false,
        onData(cb) { dataListeners.add(cb); return () => dataListeners.delete(cb); },
        onExit(cb) { exitListeners.add(cb); return () => exitListeners.delete(cb); },
        write(data) { fake.writes.push(data); },
        resize(cols, rows) { fake.resizes.push({ cols, rows }); },
        kill() { fake.killed = true; },
        emitData(chunk) { for (const cb of dataListeners) cb(chunk); },
        emitExit(exitCode, signal) {
          for (const cb of exitListeners) cb({ exitCode, signal });
        },
      };
      spawned.push(fake);
      return fake;
    },
  };
  return { backend, spawned };
}

// ── Persistence stub ────────────────────────────────────────

function createMockPersistence(overrides?: Partial<{
  taskStatus: string | null;
  runnerKind: string;
  workspacePath: string | null;
  agentSessionId: string | null;
  executionAgent: string | null;
}>) {
  // Use `in` checks so explicit null overrides survive (?? would replace null
  // with the default and break tests for "missing status / missing workspace").
  const data = {
    taskStatus: overrides && 'taskStatus' in overrides ? overrides.taskStatus! : 'completed',
    runnerKind: overrides?.runnerKind ?? 'worktree',
    workspacePath: overrides && 'workspacePath' in overrides ? overrides.workspacePath! : '/tmp/wt',
    agentSessionId: overrides?.agentSessionId ?? null,
    executionAgent: overrides?.executionAgent ?? null,
  };
  return {
    getTaskStatus: () => data.taskStatus,
    getRunnerKind: () => data.runnerKind,
    getAgentSessionId: () => data.agentSessionId,
    getContainerId: () => null,
    getWorkspacePath: () => data.workspacePath,
    getBranch: () => null,
    getExecutionAgent: () => data.executionAgent,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('EmbeddedTerminalManager.openOrSelectSession', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
  });
  afterEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  it('returns an opened embedded session descriptor for an existing completed task', () => {
    const { backend, spawned } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));

    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence(),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => undefined,
      ptyBackend: backend,
    });

    const result = manager.openOrSelectSession('task-1');
    expect(result.opened).toBe(true);
    expect(result.session).toBeDefined();
    expect(result.session!.taskId).toBe('task-1');
    expect(result.session!.mode).toBe('pty');
    expect(result.session!.cwd).toBe('/tmp/wt');
    expect(result.session!.exited).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].spawnOpts.cwd).toBe('/tmp/wt');
  });

  it('reopening the same task returns the same sessionId', () => {
    const { backend, spawned } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));

    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence(),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => undefined,
      ptyBackend: backend,
    });

    const first = manager.openOrSelectSession('task-reuse');
    const second = manager.openOrSelectSession('task-reuse');
    expect(first.opened).toBe(true);
    expect(second.opened).toBe(true);
    expect(second.session!.sessionId).toBe(first.session!.sessionId);
    // No second PTY spawned — the existing one was reused.
    expect(spawned).toHaveLength(1);
  });

  it('attaches to a live executor handle when the task is running', () => {
    const { backend } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));

    const outputListeners = new Set<(chunk: string) => void>();
    const sendInput = vi.fn();
    const executor = {
      type: 'worktree',
      sendInput,
      onOutput: (_h: ExecutorHandle, cb: (chunk: string) => void): Unsubscribe => {
        outputListeners.add(cb);
        return () => outputListeners.delete(cb);
      },
      onComplete: (_h: ExecutorHandle, _cb: unknown): Unsubscribe => () => {},
    } as unknown as Executor;
    const handle: ExecutorHandle = {
      executionId: 'exec-1',
      taskId: 'live-task',
      workspacePath: '/tmp/live',
    };

    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence({ taskStatus: 'running' }),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => ({ handle, executor }),
      ptyBackend: backend,
    });

    const outputs: Array<{ sessionId: string; data: string }> = [];
    manager.on('output', (evt) => outputs.push({ sessionId: evt.sessionId, data: evt.data }));

    const result = manager.openOrSelectSession('live-task');
    expect(result.opened).toBe(true);
    expect(result.session!.mode).toBe('attached');
    expect(result.session!.cwd).toBe('/tmp/live');

    for (const cb of outputListeners) cb('hello\n');
    expect(outputs).toHaveLength(1);
    expect(outputs[0].data).toBe('hello\n');
    expect(outputs[0].sessionId).toBe(result.session!.sessionId);

    const writeResult = manager.writeInput(result.session!.sessionId, 'echo hi\n');
    expect(writeResult.ok).toBe(true);
    expect(sendInput).toHaveBeenCalledWith(handle, 'echo hi\n');
  });

  it('refuses when task status is missing', () => {
    const { backend } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));
    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence({ taskStatus: null }),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => undefined,
      ptyBackend: backend,
    });
    const result = manager.openOrSelectSession('missing-task');
    expect(result.opened).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('preserves managed-workspace invariant: refuses worktree task with no workspacePath', () => {
    const { backend } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));
    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence({ workspacePath: null }),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => undefined,
      ptyBackend: backend,
    });
    const result = manager.openOrSelectSession('bad-task');
    expect(result.opened).toBe(false);
    expect(result.reason).toContain('workspace metadata is missing');
  });

  it('forwards PTY output and exit events to event listeners', () => {
    const { backend, spawned } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));
    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence(),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => undefined,
      ptyBackend: backend,
    });

    const outputs: string[] = [];
    let exited = false;
    manager.on('output', (evt) => outputs.push(evt.data));
    manager.on('exit', () => { exited = true; });

    const r = manager.openOrSelectSession('events-task');
    expect(r.opened).toBe(true);

    spawned[0].emitData('first ');
    spawned[0].emitData('second');
    expect(outputs.join('')).toBe('first second');

    spawned[0].emitExit(0);
    expect(exited).toBe(true);
    expect(manager.listSessions()[0].exited).toBe(true);
    expect(manager.listSessions()[0].exitCode).toBe(0);
  });

  it('writeInput forwards bytes to the PTY', () => {
    const { backend, spawned } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));
    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence(),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => undefined,
      ptyBackend: backend,
    });
    const r = manager.openOrSelectSession('write-task');
    const res = manager.writeInput(r.session!.sessionId, 'ls\n');
    expect(res.ok).toBe(true);
    expect(spawned[0].writes).toEqual(['ls\n']);
  });

  it('resize forwards dimensions to the PTY', () => {
    const { backend, spawned } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));
    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence(),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => undefined,
      ptyBackend: backend,
    });
    const r = manager.openOrSelectSession('resize-task');
    const res = manager.resize(r.session!.sessionId, 120, 40);
    expect(res.ok).toBe(true);
    expect(spawned[0].resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('closeSession tears down the PTY and removes the task→session mapping', () => {
    const { backend, spawned } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));
    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence(),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => undefined,
      ptyBackend: backend,
    });
    const r = manager.openOrSelectSession('close-task');
    const closed = manager.closeSession(r.session!.sessionId);
    expect(closed.closed).toBe(true);
    expect(manager.listSessions()).toHaveLength(0);
    expect(spawned[0].killed).toBe(true);

    // Reopening returns a NEW session (different id), not the closed one.
    const r2 = manager.openOrSelectSession('close-task');
    expect(r2.opened).toBe(true);
    expect(r2.session!.sessionId).not.toBe(r.session!.sessionId);
  });

  it('writeInput returns ok=false for unknown sessionId', () => {
    const { backend } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));
    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence(),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => undefined,
      ptyBackend: backend,
    });
    const res = manager.writeInput('does-not-exist', 'hi');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('Unknown session');
  });

  it('selectSession returns null for unknown id', () => {
    const { backend } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));
    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence(),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => undefined,
      ptyBackend: backend,
    });
    expect(manager.selectSession('nope')).toBeNull();
  });

  it('dispose tears down every session', async () => {
    const { backend, spawned } = createFakePtyBackend();
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({ cacheDir: '/tmp/c', worktreeBaseDir: '/tmp/w' }));
    const manager = new EmbeddedTerminalManager({
      persistence: createMockPersistence(),
      executorRegistry: registry,
      repoRoot: '/repo',
      getActiveHandle: () => undefined,
      ptyBackend: backend,
    });
    manager.openOrSelectSession('task-a');
    manager.openOrSelectSession('task-b');
    expect(manager.listSessions()).toHaveLength(2);
    await manager.dispose();
    expect(manager.listSessions()).toHaveLength(0);
    expect(spawned.every((p) => p.killed)).toBe(true);
  });
});
