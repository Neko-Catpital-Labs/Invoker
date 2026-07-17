import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import { createAttempt, createTaskState, type TaskState } from '@invoker/workflow-core';
import { LocalBus } from '@invoker/transport';

import { runHeadless, type HeadlessDeps } from '../headless.js';

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function () { return noopLogger; }),
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('cost attribution attempt read cost', () => {
  let tmpDir: string | undefined;
  let adapter: SQLiteAdapter | undefined;
  let stdoutSpy: any;

  afterEach(async () => {
    stdoutSpy?.mockRestore();
    stdoutSpy = undefined;
    await adapter?.close();
    adapter = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('attributes costs through a projected indexed attempt read without hydrating error blobs', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'invoker-cost-attribution-attempts-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    adapter.saveWorkflow({
      id: 'wf-cost',
      name: 'Cost attribution',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });

    const baseTask = createTaskState('wf-cost/t1', 'Costed task', [], {
      workflowId: 'wf-cost',
      runnerKind: 'worktree',
    });
    const task = {
      ...baseTask,
      status: 'completed',
      execution: {
        ...baseTask.execution,
        agentName: 'codex',
        agentSessionId: undefined,
        selectedAttemptId: undefined,
      },
    } as TaskState;
    adapter.saveTask('wf-cost', task);

    const largeError = 'x'.repeat(100_000);
    for (let index = 0; index < 120; index += 1) {
      adapter.saveAttempt({
        ...createAttempt(task.id, { status: 'failed' }),
        id: `attempt-noise-${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        agentSessionId: `sess-noise-${index}`,
        error: largeError,
      });
    }
    adapter.saveAttempt({
      ...createAttempt(task.id, { status: 'failed' }),
      id: 'attempt-older',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      agentSessionId: 'sess-older',
      error: largeError,
    });
    adapter.saveAttempt({
      ...createAttempt(task.id, { status: 'completed' }),
      id: 'attempt-latest',
      createdAt: new Date('2026-07-01T00:01:00.000Z'),
      agentSessionId: 'sess-latest',
      error: largeError,
    });

    const queryAll = vi.spyOn(
      adapter as unknown as { queryAll: (sql: string, params?: unknown[]) => Record<string, unknown>[] },
      'queryAll',
    );
    const loadAttempts = vi.spyOn(adapter, 'loadAttempts');
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const mockDriver = {
      processOutput: vi.fn(),
      loadSession: vi.fn((sessionId: string) => sessionId === 'sess-latest' ? 'raw-session' : null),
      parseSession: vi.fn(() => []),
      inspectSession: vi.fn(() => ({ state: 'finished' as const })),
      extractUsage: vi.fn(() => [{
        eventId: 'turn-1',
        timestamp: '2026-07-01T00:02:00.000Z',
        model: 'gpt-5',
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        totalTokens: 15,
        confidence: 'exact' as const,
      }]),
    };

    const deps = {
      logger: noopLogger,
      orchestrator: {
        syncFromDb: vi.fn(),
        getAllTasks: vi.fn(() => [task]),
      },
      persistence: adapter,
      commandService: {},
      executorRegistry: {},
      executionAgentRegistry: {
        getSessionDriver: vi.fn(() => mockDriver),
      },
      messageBus: new LocalBus(),
      repoRoot: '/repo',
      invokerConfig: {},
      initServices: vi.fn(async () => {}),
    } as unknown as HeadlessDeps;

    await runHeadless(['query', 'cost-events', '--output', 'json'], deps);

    const output = stdoutSpy.mock.calls[0]?.[0] as string;
    const [event] = JSON.parse(output) as Array<{ attemptId: string; agentSessionId: string }>;
    expect(event).toMatchObject({
      attemptId: 'attempt-latest',
      agentSessionId: 'sess-latest',
    });
    expect(loadAttempts).not.toHaveBeenCalled();

    const attemptQueries = queryAll.mock.calls
      .map(([sql]) => normalizeSql(sql))
      .filter((sql) => /\bFROM attempts\b/i.test(sql));
    expect(attemptQueries).toEqual([
      'SELECT id, node_id, agent_session_id, created_at FROM attempts WHERE node_id = ? ORDER BY created_at ASC',
    ]);
    expect(attemptQueries[0]).not.toMatch(/SELECT \*/i);
    expect(attemptQueries[0]).not.toMatch(/\berror\b/i);

    const planRows = (adapter as any).db
      .prepare(`EXPLAIN QUERY PLAN
        SELECT id, node_id, agent_session_id, created_at
        FROM attempts
        WHERE node_id = ?
        ORDER BY created_at ASC`)
      .all(task.id) as Array<{ detail: string }>;
    const planDetail = planRows.map((row) => row.detail).join('\n');
    expect(planDetail).toContain('SEARCH attempts');
    expect(planDetail).toContain('idx_attempts_node_created');
    expect(planDetail).not.toContain('SCAN attempts');
    expect(planDetail).not.toContain('USE TEMP B-TREE');
  });
});
