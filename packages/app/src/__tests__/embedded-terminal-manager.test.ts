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
  TERMINAL_REPLAY_BUFFER_MAX_BYTES,
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

  // ── Replay buffer (bounded output snapshot for late renderer subscribers) ──

  it('captures output emitted synchronously during spawn into the returned descriptor', () => {
    const backend: EmbeddedTerminalBackend = {
      name: 'pty',
      spawn: ({ emitOutput }) => {
        // Backend that emits before openOrReuse() returns — mirrors a PTY
        // that pushes startup bytes inside its spawn() call.
        emitOutput('boot-1\r\n');
        emitOutput('boot-2\r\n');
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    };
    const mgr = new EmbeddedTerminalManager({ backend });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    expect(session.outputSnapshot).toBe('boot-1\r\nboot-2\r\n');
  });

  it('terminal list() exposes the same replay snapshot for live sessions', () => {
    const backend: EmbeddedTerminalBackend = {
      name: 'pty',
      spawn: ({ emitOutput }) => {
        emitOutput('hello-from-spawn');
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    };
    const mgr = new EmbeddedTerminalManager({ backend });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    const listed = mgr.list();

    expect(listed).toHaveLength(1);
    expect(listed[0].sessionId).toBe(session.sessionId);
    expect(listed[0].outputSnapshot).toBe('hello-from-spawn');
    expect(mgr.get(session.sessionId)?.outputSnapshot).toBe('hello-from-spawn');
  });

  it('appends post-spawn async output to the snapshot returned by list()', () => {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: vi.fn(() => child) as unknown as BashSpawnFn }),
    });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    expect(session.outputSnapshot).toBeUndefined();

    child.stdout.emit('data', Buffer.from('line-1\n'));
    child.stderr.emit('data', Buffer.from('line-2\n'));

    const listed = mgr.list();
    expect(listed[0].outputSnapshot).toBe('line-1\nline-2\n');
  });

  it('bounds the replay snapshot to TERMINAL_REPLAY_BUFFER_MAX_BYTES, keeping the most recent bytes', () => {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: vi.fn(() => child) as unknown as BashSpawnFn }),
    });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    // Overflow the buffer with deterministic content. Each chunk has a known
    // suffix so we can assert that the tail (most-recent bytes) is preserved.
    const chunkSize = 8 * 1024;
    const overflowChunks = 10; // 80 KiB total, > 64 KiB cap
    for (let i = 0; i < overflowChunks; i += 1) {
      child.stdout.emit('data', Buffer.from('X'.repeat(chunkSize - 1) + String.fromCharCode(65 + i)));
    }

    const snapshot = mgr.get(session.sessionId)?.outputSnapshot ?? '';
    expect(snapshot.length).toBe(TERMINAL_REPLAY_BUFFER_MAX_BYTES);
    // Last emitted byte ('A' + 9 = 'J') must still be present at the tail.
    expect(snapshot.endsWith('J')).toBe(true);
  });

  it('omits outputSnapshot when no output has been emitted', () => {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: vi.fn(() => child) as unknown as BashSpawnFn }),
    });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    expect(session.outputSnapshot).toBeUndefined();
    expect(mgr.list()[0].outputSnapshot).toBeUndefined();
  });

  it('synchronous backend exit during spawn finalizes safely and does not throw', () => {
    const exits: Array<{ sessionId: string; exitCode?: number }> = [];
    const backend: EmbeddedTerminalBackend = {
      name: 'pty',
      spawn: ({ emitOutput, emitExit }) => {
        // Emit some output then exit, all before backend.spawn() returns.
        emitOutput('startup\r\n');
        emitExit(7);
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    };
    const mgr = new EmbeddedTerminalManager({ backend });
    mgr.on('exit', (e) => exits.push({ sessionId: e.sessionId, exitCode: e.exitCode }));

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    // Synchronous output captured into the returned descriptor.
    expect(session.outputSnapshot).toBe('startup\r\n');
    // Synchronous exit was applied — descriptor reflects the exited status.
    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(7);
    // Exit event fired once for this session.
    expect(exits).toEqual([{ sessionId: session.sessionId, exitCode: 7 }]);
    // Session and buffer were cleaned up by finalize.
    expect(mgr.list()).toHaveLength(0);
    expect(mgr.get(session.sessionId)).toBeUndefined();
  });

  it('finalizing a session releases its replay buffer', () => {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: vi.fn(() => child) as unknown as BashSpawnFn }),
    });
    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    child.stdout.emit('data', Buffer.from('some-output'));
    expect(mgr.get(session.sessionId)?.outputSnapshot).toBe('some-output');

    mgr.close(session.sessionId);

    expect(mgr.get(session.sessionId)).toBeUndefined();
    expect(mgr.list()).toHaveLength(0);

    // Late output from the dead child must not throw, even though the buffer
    // for this session was cleared as part of finalize.
    expect(() => child.stdout.emit('data', Buffer.from('post-mortem'))).not.toThrow();
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
