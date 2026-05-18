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
  type EmbeddedTerminalBackend,
  type BashSpawnFn,
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
