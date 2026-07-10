import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  EmbeddedTerminalManager,
  createBashTerminalBackend,
  type BashSpawnFn,
} from '../embedded-terminal-manager.js';
import { registerTerminalSessionPersistence } from '../terminal-session-ipc.js';
import {
  createTerminalUiPerfCounters,
  createTerminalUiPerfReporter,
  createTerminalUiPerfSink,
} from '../terminal-ui-perf.js';

function createFakeChild() {
  const ee = new EventEmitter() as any;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.stdin = { write: vi.fn() };
  ee.killed = false;
  ee.kill = vi.fn();
  return ee;
}

describe('terminal session persistence upsert storm (proof)', () => {
  it('persists every running output chunk with a sync upsert (current behavior)', () => {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: (() => child) as unknown as BashSpawnFn }),
    });
    const upserts: Array<{ status: string; outputSnapshot: string }> = [];
    const persistence = {
      listTerminalSessions: () => [],
      loadTask: () => ({ id: 'task-1' }),
      deleteTerminalSession: vi.fn(),
      updateTerminalSession: vi.fn(),
      upsertTerminalSession: vi.fn((record: { status: string; outputSnapshot: string }) => {
        upserts.push({ status: record.status, outputSnapshot: record.outputSnapshot });
      }),
    };

    registerTerminalSessionPersistence({
      embeddedTerminalManager: mgr,
      persistence: persistence as any,
      uiPerfStats: createTerminalUiPerfCounters(),
      terminalUiPerf: createTerminalUiPerfReporter({ throttleMs: 0 }),
      terminalUiPerfSink: createTerminalUiPerfSink(() => {}, createTerminalUiPerfCounters()),
    });

    mgr.openOrReuse({ taskId: 'task-1', spec: {}, cwd: '/tmp' });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ status: 'running', outputSnapshot: '' });

    const CHUNKS = 100;
    for (let i = 0; i < CHUNKS; i++) {
      child.stdout.emit('data', Buffer.from('x'));
    }

    // Proof of the main-thread hitch: every PTY chunk forces a full-snapshot upsert.
    expect(upserts).toHaveLength(1 + CHUNKS);
    expect(upserts[upserts.length - 1]?.outputSnapshot).toBe('x'.repeat(CHUNKS));
  });
});
