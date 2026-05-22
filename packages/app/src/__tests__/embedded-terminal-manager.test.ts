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
  EMBEDDED_TERMINAL_OUTPUT_SNAPSHOT_MAX,
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

  it('captures output emitted synchronously during spawn into the returned descriptor', () => {
    const backend: EmbeddedTerminalBackend = {
      name: 'bash',
      spawn: (opts) => {
        // Synchronously emit output before returning, simulating fast PTY startup.
        opts.emitOutput('boot-line-1\n');
        opts.emitOutput('boot-line-2\n');
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    };
    const mgr = new EmbeddedTerminalManager({ backend });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    expect(session.outputSnapshot).toBe('boot-line-1\nboot-line-2\n');
  });

  it('list() returns the bounded replay snapshot for live sessions', () => {
    const child = createFakeChild();
    const bashSpawnFn = vi.fn(() => child) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });
    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    child.stdout.emit('data', Buffer.from('hello world'));

    const listed = mgr.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]?.sessionId).toBe(session.sessionId);
    expect(listed[0]?.outputSnapshot).toBe('hello world');
  });

  it('handles synchronous backend exit during spawn without throwing', () => {
    const exits: Array<{ sessionId: string; exitCode?: number }> = [];
    const backend: EmbeddedTerminalBackend = {
      name: 'bash',
      spawn: (opts) => {
        opts.emitOutput('startup banner\n');
        opts.emitExit(0);
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    };
    const mgr = new EmbeddedTerminalManager({ backend });
    mgr.on('exit', (e) => exits.push({ sessionId: e.sessionId, exitCode: e.exitCode }));

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    expect(session.outputSnapshot).toBe('startup banner\n');
    expect(exits).toEqual([{ sessionId: session.sessionId, exitCode: 0 }]);
    // The session is finalized after returning, so it has been removed from the live list.
    expect(mgr.list()).toHaveLength(0);
  });

  it('bounds the replay buffer to the configured maximum', () => {
    const cap = EMBEDDED_TERMINAL_OUTPUT_SNAPSHOT_MAX;
    let savedEmit: ((data: string) => void) | null = null;
    const backend: EmbeddedTerminalBackend = {
      name: 'bash',
      spawn: (opts) => {
        savedEmit = opts.emitOutput;
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    };
    const mgr = new EmbeddedTerminalManager({ backend });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    if (!savedEmit) throw new Error('emitOutput not captured');
    const emit = savedEmit as (data: string) => void;

    // Write twice the cap, in two chunks. The newest data must win.
    const chunkA = 'A'.repeat(cap);
    const chunkB = 'B'.repeat(cap);
    emit(chunkA);
    emit(chunkB);

    const snapshot = mgr.get(session.sessionId)?.outputSnapshot ?? '';
    expect(snapshot.length).toBe(cap);
    expect(snapshot[snapshot.length - 1]).toBe('B');
    expect(snapshot[0]).toBe('B');
  });

  it('clears the replay buffer when a session exits', () => {
    const child = createFakeChild();
    const bashSpawnFn = vi.fn(() => child) as unknown as BashSpawnFn;
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: bashSpawnFn }),
    });
    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    child.stdout.emit('data', Buffer.from('alive'));
    expect(mgr.get(session.sessionId)?.outputSnapshot).toBe('alive');

    child.emit('exit', 0);

    expect(mgr.get(session.sessionId)).toBeUndefined();
  });
});

// ── PTY open-terminal race regression: early output must survive the gap ──
//
// Reproduces the bug where a renderer terminal pane only subscribes after
// `openTerminal` returns (so a React effect can mount the pane). Backend
// output emitted synchronously during spawn was lost in that gap before
// the replay buffer was added. The marker `FIRST_FRAME_FROM_PTY\n` is the
// canonical first-frame string the repro script (scripts/repro-gui-open-terminal-pty-race.sh)
// greps for to discriminate fixed vs. broken behavior.

describe('PTY open-terminal race regression (FIRST_FRAME_FROM_PTY)', () => {
  const FIRST_FRAME = 'FIRST_FRAME_FROM_PTY\n';

  it('replays the first PTY frame to a late-subscribing consumer via the descriptor snapshot', () => {
    // Fake backend that mimics a fast-starting PTY: it synchronously emits
    // the first frame from inside `spawn()`, before `openOrReuse()` returns.
    const backend: EmbeddedTerminalBackend = {
      name: 'pty',
      spawn: (opts) => {
        opts.emitOutput(FIRST_FRAME);
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    };
    const mgr = new EmbeddedTerminalManager({ backend });

    // Renderer-style subscriber that attaches AFTER openOrReuse returns —
    // exactly the race the replay buffer is designed to close.
    const liveEvents: string[] = [];

    const session = mgr.openOrReuse({ taskId: 'task-race', spec: {}, cwd: '/tmp' });

    // The late subscriber attaches here, after the synchronous spawn output.
    mgr.on('output', (e) => liveEvents.push(e.data));

    // 1) The descriptor must carry the first frame in its replay snapshot so the
    //    renderer can seed its xterm instance without waiting for new output.
    expect(session.outputSnapshot).toBe(FIRST_FRAME);

    // 2) A late consumer can fully reconstruct the terminal state by feeding
    //    the snapshot first and then appending subsequent live output.
    const seededByLateConsumer: string[] = [];
    if (session.outputSnapshot) seededByLateConsumer.push(session.outputSnapshot);
    seededByLateConsumer.push(...liveEvents);
    expect(seededByLateConsumer.join('')).toBe(FIRST_FRAME);

    // 3) terminalList()-style reloads also see the same snapshot for live sessions.
    const listed = mgr.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.sessionId).toBe(session.sessionId);
    expect(listed[0]?.outputSnapshot).toBe(FIRST_FRAME);
  });

  it('synchronous backend exit during spawn does not throw and still replays the first frame', () => {
    // The backend emits the first frame and exits synchronously, all from
    // inside `spawn()`. Before the fix, the exit callback ran before the
    // session state was registered and threw (or dropped the snapshot).
    const exits: Array<{ sessionId: string; exitCode?: number }> = [];
    const backend: EmbeddedTerminalBackend = {
      name: 'pty',
      spawn: (opts) => {
        opts.emitOutput(FIRST_FRAME);
        opts.emitExit(0);
        return { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    };
    const mgr = new EmbeddedTerminalManager({ backend });
    mgr.on('exit', (e) => exits.push({ sessionId: e.sessionId, exitCode: e.exitCode }));

    let session: ReturnType<EmbeddedTerminalManager['openOrReuse']> | undefined;
    expect(() => {
      session = mgr.openOrReuse({ taskId: 'task-sync-exit', spec: {}, cwd: '/tmp' });
    }).not.toThrow();

    expect(session?.outputSnapshot).toBe(FIRST_FRAME);
    expect(exits.map((e) => e.exitCode)).toEqual([0]);
    expect(exits[0]?.sessionId).toBe(session?.sessionId);
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
