import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { createAttempt, createTaskState, type TaskState } from '@invoker/workflow-core';

import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

describe('cost attribution attempt read cost', () => {
  let adapter: SQLiteAdapter | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    adapter?.close();
    adapter = undefined;
  });

  it('attributes costs from projected attempt metadata without loading full attempt rows', async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'Workflow',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });

    const task = {
      ...createTaskState('wf-1/task-a', 'Task A', [], {
        workflowId: 'wf-1',
        runnerKind: 'worktree',
      }),
      status: 'completed',
      execution: {
        generation: 0,
        agentName: 'codex',
      },
    } satisfies TaskState;
    adapter.saveTask('wf-1', task);

    const largeError = 'x'.repeat(100_000);
    adapter.saveAttempt({
      ...createAttempt(task.id, {
        status: 'failed',
        agentSessionId: 'sess-old',
        error: largeError,
      }),
      id: 'attempt-old',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    adapter.saveAttempt({
      ...createAttempt(task.id, {
        status: 'completed',
        agentSessionId: 'sess-new',
        error: largeError,
      }),
      id: 'attempt-new',
      createdAt: new Date('2026-07-01T00:01:00.000Z'),
    });

    const queryAll = vi.spyOn(
      adapter as unknown as { queryAll: (sql: string, params?: unknown[]) => Record<string, unknown>[] },
      'queryAll',
    );
    const loadAttempts = vi.spyOn(adapter, 'loadAttempts').mockImplementation(() => {
      throw new Error('cost attribution must not load full attempts');
    });
    const driver = {
      processOutput: vi.fn(),
      loadSession: vi.fn((sessionId: string) => (sessionId === 'sess-new' ? '{"ok":true}' : null)),
      parseSession: vi.fn(() => []),
      inspectSession: vi.fn(() => ({ state: 'finished' as const })),
      extractUsage: vi.fn(() => [
        {
          eventId: 'turn-1',
          timestamp: '2026-07-01T00:02:00.000Z',
          model: 'gpt-5.2',
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          totalTokens: 15,
          confidence: 'exact' as const,
        },
      ]),
    };
    const deps: HeadlessQueryDeps = {
      persistence: adapter,
      orchestrator: {
        syncFromDb: vi.fn(),
        getAllTasks: vi.fn(() => [task]),
      } as unknown as HeadlessQueryDeps['orchestrator'],
      executionAgentRegistry: {
        getSessionDriver: vi.fn(() => driver),
      } as unknown as HeadlessQueryDeps['executionAgentRegistry'],
      invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
      getUiPerfStats: () => ({}),
      resetUiPerfStats: () => {},
    };

    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'cost-events', '--output', 'json'],
      deps,
    );

    const parsed = JSON.parse(output) as Array<{ attemptId: string }>;
    expect(parsed.map((event) => event.attemptId)).toEqual(['attempt-new']);
    expect(driver.loadSession).toHaveBeenCalledWith('sess-new');
    expect(loadAttempts).not.toHaveBeenCalled();

    const attemptSqlCalls = queryAll.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => /\bFROM attempts\b/.test(sql));
    expect(attemptSqlCalls).toEqual([
      expect.stringMatching(
        /SELECT id, node_id, agent_session_id, created_at\s+FROM attempts\s+WHERE node_id = \?\s+ORDER BY created_at ASC/,
      ),
    ]);
    expect(attemptSqlCalls[0]).not.toMatch(/SELECT\s+\*/i);
    expect(attemptSqlCalls[0]).not.toMatch(/\berror\b/i);
  });
});
