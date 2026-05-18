/**
 * Embedded terminal manager unit + integration tests.
 *
 * Covers:
 *   - openOrReuse returns the same sessionId for the same taskId
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
  type PtySpawnFn,
} from '../embedded-terminal-manager.js';
import { resolveTaskTerminalSpec } from '../open-terminal-for-task.js';
import {
  ExecutorRegistry,
  WorktreeExecutor,
  AgentRegistry,
  type Executor,
  type ExecutorHandle,
  type ExecutionAgent,
  type TerminalSpec,
} from '@invoker/execution-engine';

function createFakePty() {
  const ee = new EventEmitter() as EventEmitter & {
    onData: (cb: (data: string) => void) => { dispose: () => void };
    onExit: (cb: (event: { exitCode: number }) => void) => { dispose: () => void };
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    kill: () => void;
    killed: boolean;
    pid: number;
    cols: number;
    rows: number;
    process: string;
    handleFlowControl: boolean;
    clear: () => void;
    pause: () => void;
    resume: () => void;
  };
  const written: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  ee.onData = (cb) => {
    ee.on('data', cb);
    return { dispose: () => ee.off('data', cb) };
  };
  ee.onExit = (cb) => {
    ee.on('exit', cb);
    return { dispose: () => ee.off('exit', cb) };
  };
  ee.write = (data: string) => {
    written.push(data);
  };
  ee.resize = (cols: number, rows: number) => {
    resizes.push({ cols, rows });
  };
  ee.killed = false;
  ee.kill = () => {
    ee.killed = true;
  };
  ee.pid = 123;
  ee.cols = 80;
  ee.rows = 24;
  ee.process = 'zsh';
  ee.handleFlowControl = false;
  ee.clear = () => {};
  ee.pause = () => {};
  ee.resume = () => {};
  (ee as unknown as { __written: string[] }).__written = written;
  (ee as unknown as { __resizes: Array<{ cols: number; rows: number }> }).__resizes = resizes;
  return ee;
}

function makeAgent(name: string): ExecutionAgent {
  return {
    name,
    stdinMode: 'pipe',
    buildCommand: (prompt: string) => ({ cmd: name, args: ['run', prompt] }),
    buildResumeArgs: (sessionId: string) => ({ cmd: `${name}-bin`, args: ['resume', sessionId] }),
  };
}

describe('EmbeddedTerminalManager', () => {
  it('opens a PTY-backed session and returns a descriptor', () => {
    const pty = createFakePty();
    const ptySpawnFn = vi.fn(() => pty as never) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({ ptySpawnFn });

    const spec: TerminalSpec = { cwd: '/tmp/wt-1' };
    const session = mgr.openOrReuse({ taskId: 'task-1', spec, cwd: '/tmp/wt-1' });

    expect(session.taskId).toBe('task-1');
    expect(session.status).toBe('running');
    expect(session.mode).toBe('pty');
    expect(session.backend).toBe('pty');
    expect(session.attached).toBe(false);
    expect(session.cwd).toBe('/tmp/wt-1');
    expect(typeof session.sessionId).toBe('string');
    expect(ptySpawnFn).toHaveBeenCalledTimes(1);
  });

  it('reopening the same task returns the same session id', () => {
    const pty = createFakePty();
    const ptySpawnFn = vi.fn(() => pty as never) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({ ptySpawnFn });

    const first = mgr.openOrReuse({ taskId: 'task-1', spec: {}, cwd: '/tmp' });
    const second = mgr.openOrReuse({ taskId: 'task-1', spec: {}, cwd: '/tmp' });

    expect(second.sessionId).toBe(first.sessionId);
    expect(ptySpawnFn).toHaveBeenCalledTimes(1);
    expect(mgr.list()).toHaveLength(1);
  });

  it('opens a distinct tab when the same task targets a different terminal identity', () => {
    const pty1 = createFakePty();
    const pty2 = createFakePty();
    const ptySpawnFn = vi
      .fn()
      .mockReturnValueOnce(pty1)
      .mockReturnValueOnce(pty2) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({ ptySpawnFn });

    const first = mgr.openOrReuse({
      taskId: 'task-1',
      spec: { cwd: '/tmp/wt-1', command: 'codex', args: ['resume', 'sess-1'] },
      cwd: '/tmp/wt-1',
      terminalKey: 'branch-a/session-1',
    });
    const sameTarget = mgr.openOrReuse({
      taskId: 'task-1',
      spec: { cwd: '/tmp/wt-1', command: 'codex', args: ['resume', 'sess-1'] },
      cwd: '/tmp/wt-1',
      terminalKey: 'branch-a/session-1',
    });
    const nextAttempt = mgr.openOrReuse({
      taskId: 'task-1',
      spec: { cwd: '/tmp/wt-2', command: 'codex', args: ['resume', 'sess-2'] },
      cwd: '/tmp/wt-2',
      terminalKey: 'branch-b/session-2',
    });

    expect(sameTarget.sessionId).toBe(first.sessionId);
    expect(nextAttempt.sessionId).not.toBe(first.sessionId);
    expect(ptySpawnFn).toHaveBeenCalledTimes(2);
    expect(mgr.list()).toHaveLength(2);
  });

  it('fans PTY data through the output event', () => {
    const pty = createFakePty();
    const ptySpawnFn = vi.fn(() => pty as never) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({ ptySpawnFn });
    const events: Array<{ sessionId: string; data: string }> = [];
    mgr.on('output', (e) => events.push({ sessionId: e.sessionId, data: e.data }));

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    pty.emit('data', 'hello');
    pty.emit('data', 'err');

    expect(events.map((e) => e.data)).toEqual(['hello', 'err']);
    expect(events.every((e) => e.sessionId === session.sessionId)).toBe(true);
  });

  it('write() forwards data to the PTY', () => {
    const pty = createFakePty();
    const ptySpawnFn = vi.fn(() => pty as never) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({ ptySpawnFn });
    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    const res = mgr.write(session.sessionId, 'ls\n');

    expect(res.ok).toBe(true);
    expect((pty as unknown as { __written: string[] }).__written).toEqual(['ls\n']);
  });

  it('routes resize to the PTY backend', () => {
    const pty = createFakePty();
    const ptySpawnFn = vi.fn(() => pty as never) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({ ptySpawnFn });

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    const res = mgr.resize(session.sessionId, 120, 30);

    expect(res.ok).toBe(true);
    expect((pty as unknown as { __resizes: Array<{ cols: number; rows: number }> }).__resizes).toEqual([
      { cols: 120, rows: 30 },
    ]);
  });

  it('emits exit and leaves the session visible when the PTY exits', () => {
    const pty = createFakePty();
    const ptySpawnFn = vi.fn(() => pty as never) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({ ptySpawnFn });
    const exits: Array<{ sessionId: string; exitCode?: number }> = [];
    mgr.on('exit', (e) => exits.push({ sessionId: e.sessionId, exitCode: e.exitCode }));

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    pty.emit('exit', { exitCode: 0 });

    expect(exits).toEqual([{ sessionId: session.sessionId, exitCode: 0 }]);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.get(session.sessionId)?.status).toBe('exited');
  });

  it('after exit, openOrReuse spawns a fresh session', () => {
    const pty1 = createFakePty();
    const pty2 = createFakePty();
    const ptySpawnFn = vi
      .fn()
      .mockReturnValueOnce(pty1)
      .mockReturnValueOnce(pty2) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({ ptySpawnFn });

    const a = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    pty1.emit('exit', { exitCode: 0 });
    const b = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });

    expect(b.sessionId).not.toBe(a.sessionId);
  });

  it('close() kills the PTY and clears the session', () => {
    const pty = createFakePty();
    const ptySpawnFn = vi.fn(() => pty as never) as unknown as PtySpawnFn;
    const mgr = new EmbeddedTerminalManager({ ptySpawnFn });
    const exits: Array<{ sessionId: string }> = [];
    mgr.on('exit', (e) => exits.push({ sessionId: e.sessionId }));

    const session = mgr.openOrReuse({ taskId: 't', spec: {}, cwd: '/tmp' });
    const res = mgr.close(session.sessionId);

    expect(res.ok).toBe(true);
    expect(pty.killed).toBe(true);
    expect(exits).toEqual([{ sessionId: session.sessionId }]);
    expect(mgr.list()).toHaveLength(0);
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
      // ptySpawnFn is irrelevant for attached mode; supply a guard.
      ptySpawnFn: () => {
        throw new Error('PTY should not be spawned in attached mode');
      },
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
    expect(session.backend).toBe('attached');
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
    const mgr = new EmbeddedTerminalManager({ ptySpawnFn: () => createFakePty() as never });
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

      const pty = createFakePty();
      const mgr = new EmbeddedTerminalManager({
        ptySpawnFn: () => pty as never,
      });

      const session = mgr.openOrReuse({
        taskId: 'task-X',
        spec: resolved.spec,
        cwd: resolved.cwd,
      });

      expect(session.taskId).toBe('task-X');
      expect(session.status).toBe('running');
      expect(session.mode).toBe('pty');
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

  it.each([
    ['claude', 'claude-bin'],
    ['codex', 'codex-bin'],
    ['future-agent', 'future-agent-bin'],
  ])('resolves %s sessions through ExecutionAgent.buildResumeArgs', (agentName, expectedCommand) => {
    const wtBase = join(tmpdir(), `embedded-agent-wt-${randomUUID()}`);
    const workspacePath = join(wtBase, 'task-workspace');
    mkdirSync(workspacePath, { recursive: true });
    try {
      const agentRegistry = new AgentRegistry();
      agentRegistry.registerExecution(makeAgent(agentName));
      const registry = new ExecutorRegistry();
      registry.register('worktree', new WorktreeExecutor({
        cacheDir: join(tmpdir(), `cache-${randomUUID()}`),
        worktreeBaseDir: wtBase,
        agentRegistry,
      }));
      const persistence = {
        getTaskStatus: vi.fn(() => 'completed'),
        getRunnerKind: vi.fn(() => 'worktree'),
        getAgentSessionId: vi.fn(() => 'sess-123'),
        getExecutionAgent: vi.fn(() => agentName),
        getContainerId: vi.fn(() => null),
        getWorkspacePath: vi.fn(() => workspacePath),
        getBranch: vi.fn(() => null),
      };

      const resolved = resolveTaskTerminalSpec({
        taskId: 'task-agent',
        persistence: persistence as never,
        executorRegistry: registry,
        executionAgentRegistry: agentRegistry,
        repoRoot: '/repo',
      });

      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.meta.executionAgent).toBe(agentName);
      expect(resolved.spec.command).toBe(expectedCommand);
      expect(resolved.spec.args).toEqual(['resume', 'sess-123']);
    } finally {
      try { rmSync(wtBase, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('opens a shell in the workspace for command tasks without an agent session', () => {
    const wtBase = join(tmpdir(), `embedded-command-wt-${randomUUID()}`);
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
        getExecutionAgent: vi.fn(() => null),
        getContainerId: vi.fn(() => null),
        getWorkspacePath: vi.fn(() => workspacePath),
        getBranch: vi.fn(() => 'task/branch'),
      };

      const resolved = resolveTaskTerminalSpec({
        taskId: 'task-command',
        persistence: persistence as never,
        executorRegistry: registry,
        repoRoot: '/repo',
      });

      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.spec).toEqual({ cwd: workspacePath });
    } finally {
      try { rmSync(wtBase, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
