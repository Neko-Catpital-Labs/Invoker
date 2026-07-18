import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRegistry } from '@invoker/execution-engine';
import { LocalBus } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { CommandService, Orchestrator, TaskState } from '@invoker/workflow-core';
import { runHeadless, type HeadlessDeps } from '../headless.js';

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function () {
    return noopLogger;
  }),
};

function makeTask(): TaskState {
  return {
    id: 'task-1',
    description: 'Task 1',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {
      workflowId: 'wf-1',
      isMergeNode: false,
      runnerKind: 'worktree',
    },
    execution: {
      agentSessionId: 'stale-task-session',
      agentName: 'codex',
    },
  } as unknown as TaskState;
}

function makeDeps() {
  const loadAttempts = vi.fn(() => {
    throw new Error('cost attribution must not call loadAttempts');
  });
  const loadCostAttributionAttempts = vi.fn(() => [
    {
      id: 'attempt-1',
      nodeId: 'task-1',
      agentSessionId: 'projected-session',
      createdAt: new Date('2026-01-01T00:01:00.000Z'),
    },
  ]);
  const rawSession = JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      total_tokens: 16,
    },
  });
  const driver = {
    processOutput: vi.fn(),
    loadSession: vi.fn((sessionId: string) => sessionId === 'projected-session' ? rawSession : null),
    parseSession: vi.fn(() => []),
    inspectSession: vi.fn(() => ({ state: 'finished' as const })),
    extractUsage: vi.fn(() => [
      {
        eventId: 'turn-1',
        timestamp: '2026-01-01T00:02:00.000Z',
        model: 'gpt-5',
        inputTokens: 12,
        outputTokens: 4,
        cachedTokens: 0,
        totalTokens: 16,
        confidence: 'exact' as const,
      },
    ]),
  };
  const orchestrator = {
    syncFromDb: vi.fn(),
    getAllTasks: vi.fn(() => [makeTask()]),
  } as unknown as Orchestrator;
  const deps: HeadlessDeps = {
    logger: noopLogger as any,
    orchestrator,
    persistence: {
      readOnly: false,
      listWorkflows: vi.fn(() => [
        {
          id: 'wf-1',
          name: 'Workflow 1',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:03:00.000Z',
        },
      ]),
      loadTasks: vi.fn(() => []),
      loadAttempts,
      loadCostAttributionAttempts,
    } as unknown as SQLiteAdapter,
    commandService: {} as CommandService,
    executorRegistry: {} as any,
    executionAgentRegistry: {
      getSessionDriver: vi.fn(() => driver),
    } as unknown as AgentRegistry,
    messageBus: new LocalBus() as MessageBus,
    repoRoot: '/fake/repo',
    invokerConfig: {} as any,
    initServices: vi.fn(async () => {}),
  };
  return { deps, driver, loadAttempts, loadCostAttributionAttempts };
}

describe('cost attribution attempt reads', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    stdoutSpy?.mockRestore();
    stdoutSpy = undefined;
  });

  it('uses the projected attempt read for query cost attribution', async () => {
    const { deps, driver, loadAttempts, loadCostAttributionAttempts } = makeDeps();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['query', 'cost', '--output', 'json'], deps);

    expect(loadCostAttributionAttempts).toHaveBeenCalledTimes(1);
    expect(loadCostAttributionAttempts).toHaveBeenCalledWith('task-1');
    expect(loadAttempts).not.toHaveBeenCalled();
    expect(driver.loadSession).toHaveBeenCalledWith('projected-session');
    expect(driver.loadSession).not.toHaveBeenCalledWith('stale-task-session');

    const output = stdoutSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.totals.eventCount).toBe(1);
    expect(parsed.metadata.eventCount).toBe(1);
  });
});
