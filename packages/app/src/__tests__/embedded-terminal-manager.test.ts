/**
 * Embedded terminal manager unit + integration tests.
 *
 * Covers:
 *   - openOrReuse returns the same sessionId for the same resolved terminal target
 *   - spawn mode wires stdout/stderr → output events and exit
 *   - attached mode forwards executor.onOutput → output events and
 *     executor.sendInput → write()
 *   - GUI route through resolveTaskTerminalSpec + manager returns a session
 *     descriptor (the deterministic outcome required by the task spec)
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';

import {
  EmbeddedTerminalManager,
  createBashTerminalBackend,
  createPtyTerminalBackend,
  type EmbeddedTerminalBackend,
  type BashSpawnFn,
  type PtyLike,
  type PtySpawnFn,
} from '../embedded-terminal-manager.js';
import { resolveTaskTerminalSpec } from '../open-terminal-for-task.js';
import {
  ExecutorRegistry,
  WorktreeExecutor,
  type Executor,
  type ExecutorHandle,
  type TerminalSpec,
} from '@invoker/execution-engine';

function createFakeChild() {
  const ee = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: (data: string) => boolean };
    kill: () => void;
    killed: boolean;
    __written: string[];
  };
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.__written = [];
  ee.stdin = {
    write: (data: string) => {
      ee.__written.push(data);
      return true;
    },
  };
  ee.killed = false;
  ee.kill = () => {
    ee.killed = true;
  };
  return ee;
}

function createFakePty() {
  const ee = new EventEmitter() as EventEmitter & PtyLike & {
    __written: string[];
    __resized: Array<{ cols: number; rows: number }>;
    killed: boolean;
  };
  ee.__written = [];
  ee.__resized = [];
  ee.killed = false;
  ee.onData = (listener) => {
    ee.on('data', listener);
    return { dispose: () => ee.off('data', listener) };
  };
  ee.onExit = (listener) => {
    ee.on('exit', listener);
    return { dispose: () => ee.off('exit', listener) };
  };
  ee.write = (data: string) => {
    ee.__written.push(data);
  };
  ee.resize = (cols: number, rows: number) => {
    ee.__resized.push({ cols, rows });
  };
  ee.kill = () => {
    ee.killed = true;
  };
  return ee;
}

describe('EmbeddedTerminalManager', () => {
  it('opens a spawn-mode session through the default bash backend and returns a descriptor', () => {
    const child = createFakeChild();
    const bashSpawnFn = vi.fn(() => child) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });

    const spec: TerminalSpec = { cwd: '/tmp/wt-1' };
    const session = mgr.openOrReuse({ taskId: 'task-1', spec, cwd: '/tmp/wt-1' });

    expect(session.taskId).toBe('task-1');
    expect(session.status).toBe('running');
    expect(session.mode).toBe('spawn');
    expect(session.attached).toBe(false);
    expect(session.cwd).toBe('/tmp/wt-1');
    expect(typeof session.sessionId).toBe('string');
    expect(bashSpawnFn).toHaveBeenCalledTimes(1);
  });

  it('reopening the same task and terminal target returns the same session id', () => {
    const child = createFakeChild();
    const bashSpawnFn = vi.fn(() => child) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });

    const first = mgr.openOrReuse({ taskId: 'task-1', spec: {}, cwd: '/tmp' });
    const second = mgr.openOrReuse({ taskId: 'task-1', spec: {}, cwd: '/tmp' });

    expect(second.sessionId).toBe(first.sessionId);
    expect(bashSpawnFn).toHaveBeenCalledTimes(1);
    expect(mgr.list()).toHaveLength(1);
  });

  it('opens and reuses sessions through an injected backend object', () => {
    const spawned = {
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
    };
    const backend: EmbeddedTerminalBackend = {
      name: 'bash',
      spawn: vi.fn(() => spawned),
    };
    const mgr = new EmbeddedTerminalManager({ backend });

    const first = mgr.openOrReuse({
      taskId: 'task-injected',
      spec: { command: 'codex', args: ['resume', 'session-1'] },
      cwd: '/tmp/wt',
    });
    const second = mgr.openOrReuse({
      taskId: 'task-injected',
      spec: { command: 'codex', args: ['resume', 'session-1'] },
      cwd: '/tmp/wt',
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(backend.spawn).toHaveBeenCalledTimes(1);
    expect(backend.spawn).toHaveBeenCalledWith(expect.objectContaining({
      spec: { command: 'codex', args: ['resume', 'session-1'] },
      cwd: '/tmp/wt',
      defaultShell: expect.any(String),
    }));
  });

  it('opens a distinct session when the same task resolves to a different terminal target', () => {
    const child1 = createFakeChild();
    const child2 = createFakeChild();
    const child3 = createFakeChild();
    const bashSpawnFn = vi
      .fn()
      .mockReturnValueOnce(child1)
      .mockReturnValueOnce(child2)
      .mockReturnValueOnce(child3) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });

    const first = mgr.openOrReuse({
      taskId: 'task-1',
      spec: { command: 'claude', args: ['--resume', 'session-a'], cwd: '/tmp/wt-a' },
      cwd: '/tmp/wt-a',
    });
    const changedSession = mgr.openOrReuse({
      taskId: 'task-1',
      spec: { command: 'claude', args: ['--resume', 'session-b'], cwd: '/tmp/wt-a' },
      cwd: '/tmp/wt-a',
    });
    const changedWorkspace = mgr.openOrReuse({
      taskId: 'task-1',
      spec: { command: 'claude', args: ['--resume', 'session-b'], cwd: '/tmp/wt-b' },
      cwd: '/tmp/wt-b',
    });

    expect(changedSession.sessionId).not.toBe(first.sessionId);
    expect(changedWorkspace.sessionId).not.toBe(changedSession.sessionId);
    expect(bashSpawnFn).toHaveBeenCalledTimes(3);
    expect(mgr.list()).toHaveLength(3);
  });

  it('preserves the resolved command, args, and cwd when spawning the bash backend', () => {
    const child = createFakeChild();
    const bashSpawnFn = vi.fn(() => child) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });

    const session = mgr.openOrReuse({
      taskId: 'task-1',
      spec: { command: 'codex', args: ['resume', 'codex-session-1'], cwd: '/tmp/wt' },
      cwd: '/tmp/wt',
    });

    expect(session.command).toBe('codex');
    expect(session.args).toEqual(['resume', 'codex-session-1']);
    expect(session.cwd).toBe('/tmp/wt');
    expect(bashSpawnFn).toHaveBeenCalledWith(
      'codex',
      ['resume', 'codex-session-1'],
      expect.objectContaining({ cwd: '/tmp/wt', stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('fans bash stdout and stderr through the output event', () => {
    const child = createFakeChild();
    const bashSpawnFn = vi.fn(() => child) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });
    const events: Array<{ sessionId: string; data: string }> = [];
    mgr.on('output', (e) => events.push({ sessionId: e.sessionId, data: e.data }));

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    child.stdout.emit('data', Buffer.from('hello'));
    child.stderr.emit('data', Buffer.from('err'));

    expect(events.map((e) => e.data)).toEqual(['hello', 'err']);
    expect(events.every((e) => e.sessionId === session.sessionId)).toBe(true);
  });

  it('write() forwards data to bash stdin in spawn mode', () => {
    const child = createFakeChild();
    const bashSpawnFn = vi.fn(() => child) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });
    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    const res = mgr.write(session.sessionId, 'ls\n');

    expect(res.ok).toBe(true);
    expect(child.__written).toEqual(['ls\n']);
  });

  it('resize() is accepted by the bash backend as a no-op', () => {
    const child = createFakeChild();
    const bashSpawnFn = vi.fn(() => child) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });
    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    const res = mgr.resize(session.sessionId, 120, 40);

    expect(res.ok).toBe(true);
  });

  it('opt-in PTY backend preserves command metadata and forwards resize', () => {
    const pty = createFakePty();
    const ptySpawnFn = vi.fn(() => pty) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createPtyTerminalBackend({ spawnFn: ptySpawnFn }),
    });
    const session = mgr.openOrReuse({
      taskId: 't',
      spec: { command: 'claude', args: ['--resume', 'session-1'], cwd: '/tmp' },
      cwd: '/tmp',
    });

    const res = mgr.resize(session.sessionId, 120, 40);

    expect(ptySpawnFn).toHaveBeenCalledWith(
      'claude',
      ['--resume', 'session-1'],
      expect.objectContaining({ cwd: '/tmp', cols: 80, rows: 24, name: 'xterm-256color' }),
    );
    expect(res.ok).toBe(true);
    expect(pty.__resized).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('emits exit and removes session when the bash child exits', () => {
    const child = createFakeChild();
    const bashSpawnFn = vi.fn(() => child) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });
    const exits: Array<{ sessionId: string; exitCode?: number }> = [];
    mgr.on('exit', (e) => exits.push({ sessionId: e.sessionId, exitCode: e.exitCode }));

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    child.emit('exit', 0);

    expect(exits).toEqual([{ sessionId: session.sessionId, exitCode: 0 }]);
    expect(mgr.list()).toHaveLength(0);
  });

  it('after exit, openOrReuse spawns a fresh session', () => {
    const child1 = createFakeChild();
    const child2 = createFakeChild();
    const bashSpawnFn = vi
      .fn()
      .mockReturnValueOnce(child1)
      .mockReturnValueOnce(child2) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });

    const a = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    child1.emit('exit', 0);
    const b = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    expect(b.sessionId).not.toBe(a.sessionId);
  });

  it('close() kills the bash child and clears the session', () => {
    const child = createFakeChild();
    const bashSpawnFn = vi.fn(() => child) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });
    const exits: Array<{ sessionId: string }> = [];
    mgr.on('exit', (e) => exits.push({ sessionId: e.sessionId }));

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    const res = mgr.close(session.sessionId);

    expect(res.ok).toBe(true);
    expect(child.killed).toBe(true);
    expect(exits).toEqual([{ sessionId: session.sessionId }]);
  });

  it('attached mode forwards executor output and routes sendInput', () => {
    const outputCallbacks: Array<(data: string) => void> = [];
    const inputs: string[] = [];
    let unsubscribed = 0;
    const executor: Pick<Executor, 'onOutput' | 'sendInput'> & { type: string } = {
      type: 'fake',
      onOutput(_handle: ExecutorHandle, cb: (data: string) => void) {
        outputCallbacks.push(cb);
        return () => {
          unsubscribed += 1;
        };
      },
      sendInput(_handle: ExecutorHandle, input: string) {
        inputs.push(input);
      },
    };
    const handle: ExecutorHandle = { executionId: 'exec-1', taskId: 'task-live' };
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({
        spawnFn: () => {
          throw new Error('bash should not be spawned in attached mode');
        },
      }),
    });
    const events: string[] = [];
    mgr.on('output', (e) => events.push(e.data));

    const session = mgr.openOrReuse({
      taskId: 'task-live',
      spec: { cwd: '/tmp/wt' },
      cwd: '/tmp/wt',
      attach: { handle, executor: executor as Executor },
    });

    expect(session.mode).toBe('attached');
    expect(session.attached).toBe(true);

    // Output fan-in
    outputCallbacks[0]?.('live-output');
    expect(events).toEqual(['live-output']);

    // Input routes through executor
    const writeRes = mgr.write(session.sessionId, 'cmd\n');
    expect(writeRes.ok).toBe(true);
    expect(inputs).toEqual(['cmd\n']);

    // Close unsubscribes from the executor
    mgr.close(session.sessionId);
    expect(unsubscribed).toBe(1);
  });

  it('write() rejects unknown sessions', () => {
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: () => createFakeChild() }),
    });
    const res = mgr.write('not-a-session', 'x');
    expect(res).toEqual({ ok: false, reason: expect.stringContaining('Unknown session') });
  });

  // ── Replay buffer (snapshot) ────────────────────────────────

  it('captures output emitted synchronously during spawn into the returned descriptor snapshot', () => {
    const backend: EmbeddedTerminalBackend = {
      name: 'bash',
      spawn: vi.fn((opts: Parameters<EmbeddedTerminalBackend['spawn']>[0]) => {
        opts.emitOutput('boot-banner\r\n');
        opts.emitOutput('prompt> ');
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      }),
    };
    const mgr = new EmbeddedTerminalManager({ backend });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    expect(session.outputSnapshot).toBe('boot-banner\r\nprompt> ');
  });

  it('terminal list descriptors include the same replay snapshot for live sessions', () => {
    let emit!: (data: string) => void;
    const backend: EmbeddedTerminalBackend = {
      name: 'bash',
      spawn: vi.fn((opts: Parameters<EmbeddedTerminalBackend['spawn']>[0]) => {
        emit = opts.emitOutput;
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      }),
    };
    const mgr = new EmbeddedTerminalManager({ backend });
    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    emit('hello\r\n');
    emit('world\r\n');

    const sessions = mgr.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(session.sessionId);
    expect(sessions[0].outputSnapshot).toBe('hello\r\nworld\r\n');

    const fetched = mgr.get(session.sessionId);
    expect(fetched?.outputSnapshot).toBe('hello\r\nworld\r\n');
  });

  it('does not throw when the backend exits synchronously during spawn and preserves the snapshot', () => {
    const backend: EmbeddedTerminalBackend = {
      name: 'bash',
      spawn: vi.fn((opts: Parameters<EmbeddedTerminalBackend['spawn']>[0]) => {
        opts.emitOutput('startup\r\n');
        opts.emitExit(0);
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      }),
    };
    const mgr = new EmbeddedTerminalManager({ backend });
    const exits: Array<{ sessionId: string; exitCode?: number }> = [];
    mgr.on('exit', (e) => exits.push({ sessionId: e.sessionId, exitCode: e.exitCode }));

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(0);
    expect(session.outputSnapshot).toBe('startup\r\n');
    expect(exits).toEqual([{ sessionId: session.sessionId, exitCode: 0 }]);
    // Synchronously finalized sessions are no longer tracked.
    expect(mgr.list()).toHaveLength(0);
  });

  it('bounds the replay buffer to OUTPUT_BUFFER_LIMIT and retains the most recent bytes', () => {
    let emit!: (data: string) => void;
    const backend: EmbeddedTerminalBackend = {
      name: 'bash',
      spawn: vi.fn((opts: Parameters<EmbeddedTerminalBackend['spawn']>[0]) => {
        emit = opts.emitOutput;
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      }),
    };
    const mgr = new EmbeddedTerminalManager({ backend });
    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    const limit = EmbeddedTerminalManager.OUTPUT_BUFFER_LIMIT;
    emit('A'.repeat(limit));
    emit('B'.repeat(2000));

    const snapshot = mgr.get(session.sessionId)?.outputSnapshot ?? '';
    expect(snapshot.length).toBe(limit);
    expect(snapshot.endsWith('B'.repeat(2000))).toBe(true);
    // The earliest 2000 'A' characters were trimmed off the front.
    expect(snapshot.startsWith('A')).toBe(true);
    expect(snapshot.slice(0, 100)).not.toContain('B');
  });

  it('clears the replay buffer when the session is finalized', () => {
    const child = createFakeChild();
    const bashSpawnFn = vi.fn(() => child) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    child.stdout.emit('data', Buffer.from('some-output'));
    expect(mgr.get(session.sessionId)?.outputSnapshot).toBe('some-output');

    child.emit('exit', 0);

    expect(mgr.get(session.sessionId)).toBeUndefined();
    expect(mgr.list()).toHaveLength(0);
  });

  // ── PTY race regression (FIRST_FRAME_FROM_PTY) ──────────────
  //
  // Models the production race: a real node-pty already has output buffered
  // before the renderer (or any consumer) can subscribe to terminal-output
  // IPC events. The PTY backend subscribes via `pty.onData(emitOutput)`, so a
  // fake PtyLike that invokes its data listener synchronously inside
  // `onData()` reproduces the "output emitted before any consumer attached"
  // condition deterministically — no sleeps required.

  it('replays FIRST_FRAME_FROM_PTY emitted synchronously during spawn to a late consumer', () => {
    const fakePty: PtyLike = {
      onData(listener) {
        listener('FIRST_FRAME_FROM_PTY\n');
        return { dispose: () => {} };
      },
      onExit() {
        return { dispose: () => {} };
      },
      write() {},
      resize() {},
      kill() {},
    };
    const ptySpawnFn = vi.fn(() => fakePty) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createPtyTerminalBackend({ spawnFn: ptySpawnFn }),
    });

    // The descriptor returned by openOrReuse() must carry the synchronous
    // first frame; on the broken baseline (no replay buffer) it was lost.
    const session = mgr.openOrReuse({ taskId: 't-pty-race', spec: {}, cwd: '/tmp' });
    expect(session.outputSnapshot).toBe('FIRST_FRAME_FROM_PTY\n');

    // A late consumer — modeling a renderer terminal pane that mounts after
    // openTerminal returns — looks the session up and seeds its terminal
    // buffer from the descriptor snapshot. The same bytes must be visible.
    const lateConsumerView = mgr.get(session.sessionId);
    expect(lateConsumerView?.outputSnapshot).toBe('FIRST_FRAME_FROM_PTY\n');
    expect(mgr.list()[0]?.outputSnapshot).toBe('FIRST_FRAME_FROM_PTY\n');
  });

  it('does not throw when the PTY backend exits synchronously during spawn', () => {
    const fakePty: PtyLike = {
      onData(listener) {
        listener('boot\n');
        return { dispose: () => {} };
      },
      onExit(listener) {
        listener({ exitCode: 7 });
        return { dispose: () => {} };
      },
      write() {},
      resize() {},
      kill() {},
    };
    const ptySpawnFn = vi.fn(() => fakePty) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createPtyTerminalBackend({ spawnFn: ptySpawnFn }),
    });
    const exits: Array<{ sessionId: string; exitCode?: number }> = [];
    mgr.on('exit', (e) => exits.push({ sessionId: e.sessionId, exitCode: e.exitCode }));

    let session!: ReturnType<typeof mgr.openOrReuse>;
    expect(() => {
      session = mgr.openOrReuse({ taskId: 't-pty-sync-exit', spec: {}, cwd: '/tmp' });
    }).not.toThrow();

    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(7);
    expect(session.outputSnapshot).toBe('boot\n');
    expect(exits).toEqual([{ sessionId: session.sessionId, exitCode: 7 }]);
  });
});

// ── Deterministic GUI route: resolveTaskTerminalSpec + EmbeddedTerminalManager ──

describe('GUI open-terminal embedded route', () => {
  it('returns an opened embedded session descriptor for an existing task', () => {
    const wtBase = join(tmpdir(), `embedded-wt-${randomUUID()}`);
    const workspacePath = join(wtBase, 'task-workspace');
    mkdirSync(workspacePath, { recursive: true });

    try {
      const registry = new ExecutorRegistry();
      registry.register('worktree', new WorktreeExecutor({
        cacheDir: join(tmpdir(), `cache-${randomUUID()}`),
        worktreeBaseDir: wtBase,
      }));

      const persistence = {
        getTaskStatus: vi.fn(() => 'completed'),
        getRunnerKind: vi.fn(() => 'worktree'),
        getAgentSessionId: vi.fn(() => null),
        getContainerId: vi.fn(() => null),
        getWorkspacePath: vi.fn(() => workspacePath),
        getBranch: vi.fn(() => null),
      };

      const resolved = resolveTaskTerminalSpec({
        taskId: 'task-X',
        persistence: persistence as never,
        executorRegistry: registry,
        repoRoot: '/repo',
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      const child = createFakeChild();
      const mgr = new EmbeddedTerminalManager({
        backend: createBashTerminalBackend({ spawnFn: () => child }),
      });

      const session = mgr.openOrReuse({
        taskId: 'task-X',
        spec: resolved.spec,
        cwd: resolved.cwd,
      });

      expect(session.taskId).toBe('task-X');
      expect(session.status).toBe('running');
      expect(session.mode).toBe('spawn');
      expect(session.cwd).toBe(workspacePath);

      // Reopening the same task reuses the same session id (deterministic outcome).
      const again = mgr.openOrReuse({
        taskId: 'task-X',
        spec: resolved.spec,
        cwd: resolved.cwd,
      });
      expect(again.sessionId).toBe(session.sessionId);
    } finally {
      try { rmSync(wtBase, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('propagates the resolved reason when workspace metadata is missing', () => {
    const registry = new ExecutorRegistry();
    registry.register('worktree', new WorktreeExecutor({
      cacheDir: join(tmpdir(), `cache-${randomUUID()}`),
      worktreeBaseDir: join(tmpdir(), `wt-${randomUUID()}`),
    }));
    const persistence = {
      getTaskStatus: vi.fn(() => 'completed'),
      getRunnerKind: vi.fn(() => 'worktree'),
      getAgentSessionId: vi.fn(() => null),
      getContainerId: vi.fn(() => null),
      getWorkspacePath: vi.fn(() => null),
      getBranch: vi.fn(() => null),
    };

    const resolved = resolveTaskTerminalSpec({
      taskId: 'task-no-workspace',
      persistence: persistence as never,
      executorRegistry: registry,
      repoRoot: '/repo',
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain('workspace metadata is missing');
  });

  it('allows running tasks when allowRunning=true (attach path)', () => {
    const wtBase = join(tmpdir(), `embedded-wt-${randomUUID()}`);
    const workspacePath = join(wtBase, 'task-workspace');
    mkdirSync(workspacePath, { recursive: true });
    try {
      const registry = new ExecutorRegistry();
      registry.register('worktree', new WorktreeExecutor({
        cacheDir: join(tmpdir(), `cache-${randomUUID()}`),
        worktreeBaseDir: wtBase,
      }));
      const persistence = {
        getTaskStatus: vi.fn(() => 'running'),
        getRunnerKind: vi.fn(() => 'worktree'),
        getAgentSessionId: vi.fn(() => null),
        getContainerId: vi.fn(() => null),
        getWorkspacePath: vi.fn(() => workspacePath),
        getBranch: vi.fn(() => null),
      };

      const refused = resolveTaskTerminalSpec({
        taskId: 'task-running',
        persistence: persistence as never,
        executorRegistry: registry,
        repoRoot: '/repo',
      });
      expect(refused.ok).toBe(false);

      const allowed = resolveTaskTerminalSpec({
        taskId: 'task-running',
        persistence: persistence as never,
        executorRegistry: registry,
        repoRoot: '/repo',
        allowRunning: true,
      });
      expect(allowed.ok).toBe(true);
    } finally {
      try { rmSync(wtBase, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
