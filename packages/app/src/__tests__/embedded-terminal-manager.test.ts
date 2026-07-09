import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { EmbeddedTerminalManager } from '../embedded-terminal-manager.js';

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: string[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      callback();
    },
  });
  readonly kill = vi.fn(() => {
    this.emit('exit', null, 'SIGTERM');
    return true;
  });
}

function createFakeSpawn() {
  const children: FakeChildProcess[] = [];
  const spawn = vi.fn((..._args: unknown[]) => {
    const child = new FakeChildProcess();
    children.push(child);
    return child;
  });
  return { spawn, children };
}

describe('EmbeddedTerminalManager planning terminals', () => {
  it('opens a manual planning shell in the repo cwd', () => {
    const { spawn } = createFakeSpawn();
    const manager = new EmbeddedTerminalManager({
      repoRoot: '/repo',
      spawn: spawn as never,
      shell: '/bin/bash',
      env: { TERM: 'xterm-256color' },
    });

    const result = manager.openPlanningTerminal({
      planningSessionId: 'plan-1',
      cols: 100,
      rows: 40,
    });

    expect(result.reused).toBe(false);
    expect(result.session).toMatchObject({
      id: 'planning:plan-1',
      kind: 'planning',
      planningSessionId: 'plan-1',
      mode: 'manual',
      backend: 'process',
      cwd: '/repo',
      cols: 100,
      rows: 40,
      status: 'running',
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('/bin/bash', ['-i'], expect.objectContaining({
      cwd: '/repo',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: expect.objectContaining({
        INVOKER_TERMINAL_KIND: 'planning',
        INVOKER_TERMINAL_MODE: 'manual',
        INVOKER_PLANNING_SESSION_ID: 'plan-1',
      }),
    }));
  });

  it('reuses an existing planning session and returns buffered output', () => {
    const { spawn, children } = createFakeSpawn();
    const manager = new EmbeddedTerminalManager({
      repoRoot: '/repo',
      spawn: spawn as never,
      shell: '/bin/bash',
    });
    const outputs: unknown[] = [];
    manager.on('output', (event) => outputs.push(event));

    manager.openPlanningTerminal({ planningSessionId: 'plan-1' });
    children[0].stdout.write('hello\n');

    const reused = manager.openPlanningTerminal({
      planningSessionId: 'plan-1',
      cols: 80,
      rows: 24,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(reused.reused).toBe(true);
    expect(reused.output).toBe('hello\n');
    expect(reused.session.cols).toBe(80);
    expect(reused.session.rows).toBe(24);
    expect(outputs).toEqual([
      expect.objectContaining({
        sessionId: 'planning:plan-1',
        planningSessionId: 'plan-1',
        data: 'hello\n',
      }),
    ]);
  });

  it('keeps different planning identities as distinct sessions', () => {
    const { spawn } = createFakeSpawn();
    const manager = new EmbeddedTerminalManager({
      repoRoot: '/repo',
      spawn: spawn as never,
      shell: '/bin/bash',
    });

    manager.openPlanningTerminal({ planningSessionId: 'plan-a' });
    manager.openPlanningTerminal({ planningSessionId: 'plan-b' });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(manager.listPlanningTerminals().map((session) => session.id)).toEqual([
      'planning:plan-a',
      'planning:plan-b',
    ]);
  });

  it('writes input and updates terminal size', () => {
    const fake = createFakeSpawn();
    const manager = new EmbeddedTerminalManager({
      repoRoot: '/repo',
      spawn: fake.spawn as never,
      shell: '/bin/bash',
    });

    manager.openPlanningTerminal({ planningSessionId: 'plan-1' });
    expect(manager.writePlanningTerminal({
      planningSessionId: 'plan-1',
      data: 'pwd\n',
    })).toEqual({ accepted: true });
    const resized = manager.resizePlanningTerminal({
      planningSessionId: 'plan-1',
      cols: 132,
      rows: 50,
    });

    expect(fake.children[0].writes).toEqual(['pwd\n']);
    expect(resized).toMatchObject({ cols: 132, rows: 50 });
  });

  it('closes sessions and emits a planning close event', () => {
    const { children, spawn } = createFakeSpawn();
    const manager = new EmbeddedTerminalManager({
      repoRoot: '/repo',
      spawn: spawn as never,
      shell: '/bin/bash',
    });
    const closedEvents: unknown[] = [];
    manager.on('closed', (event) => closedEvents.push(event));

    manager.openPlanningTerminal({ planningSessionId: 'plan-1' });
    const result = manager.closePlanningTerminal({ planningSessionId: 'plan-1' });

    expect(result).toEqual({ closed: true });
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(manager.listPlanningTerminals()).toEqual([]);
    expect(closedEvents).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({
          id: 'planning:plan-1',
          status: 'exited',
        }),
      }),
    ]);
  });

  it('rejects empty planning identities', () => {
    const manager = new EmbeddedTerminalManager({
      repoRoot: '/repo',
      spawn: createFakeSpawn().spawn as never,
      shell: '/bin/bash',
    });

    expect(() => manager.openPlanningTerminal({ planningSessionId: '  ' })).toThrow(
      'planningSessionId is required.',
    );
  });
});
