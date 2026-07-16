import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBus, type MessageBus } from '@invoker/transport';
import { SQLiteAdapter, type Workflow } from '@invoker/data-store';
import {
  createAttempt,
  createTaskState,
  type CommandService,
  type Orchestrator,
  type TaskState,
} from '@invoker/workflow-core';
import type { AgentRegistry } from '@invoker/execution-engine';

import { runHeadless, type HeadlessDeps } from '../headless.js';

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function () { return noopLogger; }),
};

type QueryAllHandle = {
  queryAll: (sql: string, params?: unknown[]) => Record<string, unknown>[];
};

function makeWorkflow(id: string): Omit<Workflow, 'status' | 'rollup'> {
  return {
    id,
    name: `Workflow ${id}`,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
}

function makeTask(id: string, workflowId: string): TaskState {
  return {
    ...createTaskState(id, 'Cost attribution task', [], {
      workflowId,
      runnerKind: 'worktree',
    }),
    status: 'completed',
    execution: {
      generation: 0,
      agentName: 'codex',
    },
  };
}

describe('cost attribution attempt read cost', () => {
  let adapter: SQLiteAdapter | undefined;
  let stdoutSpy: any;

  afterEach(async () => {
    stdoutSpy?.mockRestore();
    stdoutSpy = undefined;
    await adapter?.close();
    adapter = undefined;
  });

  it('uses an indexed projected attempt read without hydrating error blobs', async () => {
    adapter = await SQLiteAdapter.create(':memory:', { ownerCapability: true });
    const workflowId = 'wf-cost';
    const taskId = 'wf-cost/task-a';
    const task = makeTask(taskId, workflowId);
    adapter.saveWorkflow(makeWorkflow(workflowId));
    adapter.saveTask(workflowId, task);

    const bigError = 'x'.repeat(100_000);
    for (let i = 0; i < 80; i += 1) {
      adapter.saveAttempt({
        ...createAttempt(taskId, { status: 'failed', error: bigError }),
        id: `attempt-fat-${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }
    adapter.saveAttempt({
      ...createAttempt(taskId, {
        status: 'completed',
        agentSessionId: 'sess-latest',
        error: bigError,
      }),
      id: 'attempt-latest',
      createdAt: new Date('2026-01-01T01:30:00.000Z'),
    });

    const queryAllHandle = adapter as unknown as QueryAllHandle;
    const planRows = queryAllHandle.queryAll(
      `EXPLAIN QUERY PLAN
      SELECT id, node_id, agent_session_id, created_at
      FROM attempts
      WHERE node_id = ?
      ORDER BY created_at ASC`,
      [taskId],
    );
    expect(JSON.stringify(planRows)).toContain('idx_attempts_node_created');

    const queryAllSpy = vi.spyOn(queryAllHandle, 'queryAll');
    const mockDriver = {
      processOutput: vi.fn(),
      loadSession: vi.fn((sessionId: string) => sessionId === 'sess-latest'
        ? JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            total_tokens: 15,
          },
        })
        : null),
      parseSession: vi.fn(() => []),
      inspectSession: vi.fn(() => ({ state: 'finished' as const })),
      extractUsage: vi.fn(() => [{
        eventId: 'turn-1',
        timestamp: '2026-07-16T00:00:00.000Z',
        model: 'gpt-5',
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        totalTokens: 15,
        confidence: 'exact' as const,
      }]),
    };
    const deps: HeadlessDeps = {
      logger: noopLogger as any,
      orchestrator: {
        syncFromDb: vi.fn(),
        getAllTasks: vi.fn(() => [task]),
      } as unknown as Orchestrator,
      persistence: adapter,
      commandService: {} as CommandService,
      executorRegistry: {} as any,
      executionAgentRegistry: {
        getSessionDriver: vi.fn(() => mockDriver),
      } as unknown as AgentRegistry,
      messageBus: new LocalBus() as MessageBus,
      repoRoot: '/fake/repo',
      invokerConfig: {} as any,
      initServices: vi.fn(async () => {}),
    };

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless(['query', 'cost-events', '--output', 'json'], deps);

    const output = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(output)[0].attemptId).toBe('attempt-latest');

    const attemptReads = queryAllSpy.mock.calls
      .map(([sql]) => typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : '')
      .filter((sql) => sql.includes('FROM attempts WHERE node_id = ? ORDER BY created_at ASC'));
    expect(attemptReads).toEqual([
      'SELECT id, node_id, agent_session_id, created_at FROM attempts WHERE node_id = ? ORDER BY created_at ASC',
    ]);
    expect(attemptReads[0]).not.toMatch(/^SELECT \*/i);
    expect(attemptReads[0]).not.toMatch(/\berror\b/i);
  });
});
