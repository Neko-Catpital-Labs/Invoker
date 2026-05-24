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

  it('captures output emitted synchronously during backend spawn into the descriptor snapshot', () => {
    const backend: EmbeddedTerminalBackend = {
      name: 'bash',
      spawn: ({ emitOutput }) => {
        emitOutput('boot-line-1\n');
        emitOutput('boot-line-2\n');
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    };
    const mgr = new EmbeddedTerminalManager({ backend });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    expect(session.outputSnapshot).toBe('boot-line-1\nboot-line-2\n');
  });

  it('list() descriptors include the same replay snapshot as openOrReuse for a live session', () => {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: () => child }),
    });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    child.stdout.emit('data', Buffer.from('post-mount-output'));

    const listed = mgr.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].sessionId).toBe(session.sessionId);
    expect(listed[0].outputSnapshot).toBe('post-mount-output');
    expect(mgr.get(session.sessionId)?.outputSnapshot).toBe('post-mount-output');
  });

  it('does not throw when the backend exits synchronously during spawn', () => {
    const backend: EmbeddedTerminalBackend = {
      name: 'bash',
      spawn: ({ emitOutput, emitExit }) => {
        emitOutput('startup banner\n');
        emitExit(42);
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    };
    const mgr = new EmbeddedTerminalManager({ backend });
    const exits: Array<{ sessionId: string; exitCode?: number }> = [];
    mgr.on('exit', (e) => exits.push({ sessionId: e.sessionId, exitCode: e.exitCode }));

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    expect(session.outputSnapshot).toBe('startup banner\n');
    expect(exits).toEqual([{ sessionId: session.sessionId, exitCode: 42 }]);
    expect(mgr.list()).toHaveLength(0);
  });

  it('bounds the replay snapshot so memory does not grow without limit', () => {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: () => child }),
    });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    // Pump well over the 64 KiB cap and verify the snapshot stays bounded
    // and contains the most-recent bytes (the tail of the stream).
    const chunk = 'x'.repeat(8 * 1024);
    for (let i = 0; i < 32; i += 1) {
      child.stdout.emit('data', Buffer.from(chunk));
    }
    child.stdout.emit('data', Buffer.from('TAIL_MARKER'));

    const snapshot = mgr.get(session.sessionId)?.outputSnapshot ?? '';
    expect(snapshot.length).toBeLessThanOrEqual(64 * 1024);
    expect(snapshot.endsWith('TAIL_MARKER')).toBe(true);
  });
});

// ── PTY race regression: output emitted before the renderer subscribes ──────
//
// Repros the production bug: a PTY-style backend emits a first frame
// synchronously during spawn, before openOrReuse() returns. The renderer
// terminal pane only subscribes to `invoker:terminal-output` after it has the
// session descriptor and React has mounted the pane. Without the replay buffer
// on the descriptor, that first frame is lost to every late subscriber.
//
// These tests pin the deterministic regression contract:
//   1. The descriptor returned by openOrReuse() includes the sync first frame
//      in `outputSnapshot`.
//   2. A late consumer (simulating a renderer that subscribes after
//      openOrReuse() returns) can seed its terminal from the snapshot and
//      receive subsequent live output via the `output` event without dropping
//      the first frame.
//   3. The same snapshot is observable via `list()` for a session that emits
//      its first frame before any subscriber attaches.
//   4. The manager does not throw when the backend synchronously exits during
//      spawn — `process` is undefined at the moment `emitExit` fires.

describe('EmbeddedTerminalManager — PTY race regression', () => {
  const FIRST_FRAME = 'FIRST_FRAME_FROM_PTY\n';

  it('descriptor.outputSnapshot replays a first frame emitted synchronously during spawn (PTY backend)', () => {
    const ptySpawnFn = vi.fn((_command, _args, _options) => {
      const ee = new EventEmitter() as EventEmitter & PtyLike;
      ee.write = () => {};
      ee.resize = () => {};
      ee.kill = () => {};
      ee.onData = (listener) => {
        ee.on('data', listener);
        return { dispose: () => ee.off('data', listener) };
      };
      ee.onExit = (listener) => {
        ee.on('exit', listener);
        return { dispose: () => ee.off('exit', listener) };
      };
      // Emit the first frame synchronously, before spawn() returns — the
      // PtyTerminalBackend wires onData inside spawn(), so this exercises the
      // exact pre-subscribe window the renderer race produced in prod.
      queueMicrotask(() => {
        // queueMicrotask runs after spawn() returns but before any awaited
        // continuation — still synchronous from the manager's perspective in
        // the spawn() call's caller frame. We use a direct synchronous emit
        // via the listener path the backend installs below to model the race
        // precisely.
      });
      // Synchronously: PtyTerminalBackend calls onData(emitOutput) during
      // spawn(). To force the first frame to fire *during* that wiring, we
      // override onData so the listener is invoked immediately with FIRST_FRAME.
      ee.onData = (listener) => {
        listener(FIRST_FRAME);
        return { dispose: () => {} };
      };
      return ee;
    }) as unknown as PtySpawnFn;

    const mgr = new EmbeddedTerminalManager({
      backend: createPtyTerminalBackend({ spawnFn: ptySpawnFn }),
    });

    const session = mgr.openOrReuse({
      taskId: 'pty-race-task',
      spec: { command: 'claude', args: ['chat'], cwd: '/tmp/wt' },
      cwd: '/tmp/wt',
    });

    expect(session.outputSnapshot).toBe(FIRST_FRAME);
    expect(ptySpawnFn).toHaveBeenCalledTimes(1);
  });

  it('a late consumer seeds from descriptor.outputSnapshot and then receives only post-subscribe output via the output event', () => {
    const ptySpawn: PtySpawnFn = (_command, _args, _options) => {
      const ee = new EventEmitter() as EventEmitter & PtyLike & {
        emitDataExternal: (data: string) => void;
      };
      ee.write = () => {};
      ee.resize = () => {};
      ee.kill = () => {};
      ee.onExit = (listener) => {
        ee.on('exit', listener);
        return { dispose: () => ee.off('exit', listener) };
      };
      ee.onData = (listener) => {
        // First frame is delivered synchronously while the manager is still
        // inside openOrReuse() — before any "renderer" can subscribe.
        listener(FIRST_FRAME);
        ee.on('data', listener);
        ee.emitDataExternal = (data: string) => ee.emit('data', data);
        return { dispose: () => ee.off('data', listener) };
      };
      return ee;
    };
    // Capture the live pty to drive post-mount output below.
    let livePty: (EventEmitter & PtyLike & { emitDataExternal: (data: string) => void }) | null = null;
    const wrappedPtySpawn: PtySpawnFn = (cmd, args, opts) => {
      const result = ptySpawn(cmd, args, opts) as EventEmitter & PtyLike & {
        emitDataExternal: (data: string) => void;
      };
      livePty = result;
      return result;
    };

    const mgr = new EmbeddedTerminalManager({
      backend: createPtyTerminalBackend({ spawnFn: wrappedPtySpawn }),
    });

    const session = mgr.openOrReuse({
      taskId: 'pty-late-consumer-task',
      spec: { command: 'claude', args: ['chat'], cwd: '/tmp/wt' },
      cwd: '/tmp/wt',
    });

    // Simulate a renderer pane that mounts after openOrReuse() returns:
    //   1. Seed its local terminal buffer from descriptor.outputSnapshot.
    //   2. Subscribe to the manager's output event for subsequent live data.
    const rendererBuffer: string[] = [];
    if (session.outputSnapshot) rendererBuffer.push(session.outputSnapshot);
    const postSubscribe: string[] = [];
    mgr.on('output', (event) => {
      if (event.sessionId !== session.sessionId) return;
      postSubscribe.push(event.data);
      rendererBuffer.push(event.data);
    });

    // Now the PTY emits a second, post-mount frame.
    expect(livePty).not.toBeNull();
    livePty!.emitDataExternal('SECOND_FRAME_AFTER_MOUNT\n');

    // The first frame reached the renderer via the seed; subsequent frames via the event.
    expect(rendererBuffer.join('')).toBe(`${FIRST_FRAME}SECOND_FRAME_AFTER_MOUNT\n`);
    expect(postSubscribe).toEqual(['SECOND_FRAME_AFTER_MOUNT\n']);
  });

  it('list() returns the same first-frame snapshot for a live PTY session whose first frame fired before any subscriber attached', () => {
    const ptySpawnFn: PtySpawnFn = (_command, _args, _options) => {
      const ee = new EventEmitter() as EventEmitter & PtyLike;
      ee.write = () => {};
      ee.resize = () => {};
      ee.kill = () => {};
      ee.onExit = (listener) => {
        ee.on('exit', listener);
        return { dispose: () => ee.off('exit', listener) };
      };
      ee.onData = (listener) => {
        listener(FIRST_FRAME);
        return { dispose: () => {} };
      };
      return ee;
    };

    const mgr = new EmbeddedTerminalManager({
      backend: createPtyTerminalBackend({ spawnFn: ptySpawnFn }),
    });
    const session = mgr.openOrReuse({
      taskId: 'pty-list-task',
      spec: { command: 'claude', args: ['chat'], cwd: '/tmp/wt' },
      cwd: '/tmp/wt',
    });

    const listed = mgr.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].sessionId).toBe(session.sessionId);
    expect(listed[0].outputSnapshot).toBe(FIRST_FRAME);
  });

  it('does not throw when a PTY-style backend exits synchronously during spawn (process handle is still undefined)', () => {
    const backend: EmbeddedTerminalBackend = {
      name: 'pty',
      spawn: ({ emitOutput, emitExit }) => {
        // Synchronous first frame followed by a synchronous exit — both occur
        // before backend.spawn() returns, so the manager has not yet captured
        // the SpawnedTerminalProcess handle.
        emitOutput(FIRST_FRAME);
        emitExit(7);
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    };
    const mgr = new EmbeddedTerminalManager({ backend });
    const exits: Array<{ sessionId: string; exitCode?: number }> = [];
    mgr.on('exit', (e) => exits.push({ sessionId: e.sessionId, exitCode: e.exitCode }));

    const session = mgr.openOrReuse({ taskId: 'pty-sync-exit-task', spec: {}, cwd: '/tmp' });

    expect(session.outputSnapshot).toBe(FIRST_FRAME);
    expect(exits).toEqual([{ sessionId: session.sessionId, exitCode: 7 }]);
    expect(mgr.list()).toHaveLength(0);
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
