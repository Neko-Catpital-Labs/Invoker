import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless.js';
import type { Orchestrator, CommandService, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import { LocalBus } from '@invoker/transport';
import type { AgentRegistry } from '@invoker/execution-engine';

const noopLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(function () { return noopLogger; }),
};

const attemptsByTaskId = new Map<string, Array<{ id: string; agentSessionId?: string }>>([
  ['wf-1/task-a', [{ id: 'wf-1/task-a-attempt-1', agentSessionId: 'sess-wf-1-task-a' }]],
  ['wf-1/task-b', [{ id: 'wf-1/task-b-attempt-1', agentSessionId: 'sess-wf-1-task-b' }]],
]);

function makeWorkflow(id: string, status: 'completed' | 'failed' | 'running') {
  return { id, name: `Workflow ${id}`, status, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z' };
}

function makeTask(wfId: string, taskSuffix: string, overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: `${wfId}/${taskSuffix}`,
    description: `Task ${taskSuffix}`,
    status: 'completed',
    dependencies: [],
    createdAt: new Date(),
    config: {
      workflowId: wfId,
      isMergeNode: false,
      runnerKind: 'worktree',
      ...((overrides.config ?? {}) as any),
    },
    execution: {
      agentSessionId: `sess-${wfId}-${taskSuffix}`,
      agentName: 'codex',
      ...((overrides.execution ?? {}) as any),
    },
    ...overrides,
  } as unknown as TaskState;
}

/** Fake JSONL content that extractCodexUsage can parse. */
function makeSessionRaw(turns: Array<{ input: number; output: number; cached?: number }>) {
  return turns.map((t, i) => JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: t.input,
      output_tokens: t.output,
      cache_read_input_tokens: t.cached ?? 0,
      total_tokens: t.input + t.output,
    },
  })).join('\n');
}

describe('headless query costs', () => {
  let mockDeps: HeadlessDeps;
  let stdoutSpy: any;

  const tasksForWf1 = [
    makeTask('wf-1', 'task-a'),
    makeTask('wf-1', 'task-b'),
  ];

  const sessionData = new Map<string, string>([
    ['sess-wf-1-task-a', makeSessionRaw([{ input: 100, output: 50 }, { input: 200, output: 80 }])],
    ['sess-wf-1-task-b', makeSessionRaw([{ input: 300, output: 120 }])],
  ]);

  const mockDriver = {
    processOutput: vi.fn(),
    loadSession: vi.fn((sessionId: string) => sessionData.get(sessionId) ?? null),
    parseSession: vi.fn(() => []),
    inspectSession: vi.fn(() => ({ state: 'finished' as const })),
    extractUsage: vi.fn((raw: string) => {
      const lines = raw.split('\n').filter(Boolean);
      return lines.map((line, i) => {
        const entry = JSON.parse(line);
        const u = entry.usage;
        return {
          eventId: `codex-turn-${i}`,
          timestamp: '',
          model: '',
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cachedTokens: u.cache_read_input_tokens ?? 0,
          totalTokens: u.total_tokens ?? 0,
          confidence: 'exact' as const,
        };
      });
    }),
  };

  beforeEach(() => {
    mockDeps = {
      logger: noopLogger as any,
      orchestrator: {} as Orchestrator,
      persistence: {
        readOnly: false,
        listWorkflows: vi.fn(() => [makeWorkflow('wf-1', 'completed')]),
        loadTasks: vi.fn(() => []),
        loadAttempts: vi.fn((taskId: string) => attemptsByTaskId.get(taskId) ?? []),
      } as unknown as SQLiteAdapter,
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
    mockDeps.orchestrator.syncFromDb = vi.fn();
    mockDeps.orchestrator.getAllTasks = vi.fn(() => tasksForWf1 as any);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('resolves without error', async () => {
    await expect(runHeadless(['query', 'costs'], mockDeps)).resolves.toBeUndefined();
  });

  it('outputs grouped rollups in JSON format', async () => {
    await runHeadless(['query', 'costs', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.groups).toBeDefined();
    expect(parsed.total).toBeDefined();
    expect(parsed.events).toBeDefined();
    expect(parsed.total.eventCount).toBe(3); // 2 turns from task-a + 1 from task-b
    expect(parsed.total.inputTokens).toBe(600); // 100 + 200 + 300
    expect(parsed.total.outputTokens).toBe(250); // 50 + 80 + 120
    expect(parsed.events.map((event: any) => event.attemptId)).toEqual([
      'wf-1/task-a-attempt-1',
      'wf-1/task-a-attempt-1',
      'wf-1/task-b-attempt-1',
    ]);
  });

  it('outputs events in JSONL format', async () => {
    await runHeadless(['query', 'costs', '--output', 'jsonl'], mockDeps);
    const lines = stdoutSpy.mock.calls.map(c => (c[0] as string).trim()).filter(Boolean);
    expect(lines).toHaveLength(3);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('eventId');
      expect(parsed).toHaveProperty('inputTokens');
      expect(parsed).toHaveProperty('workflowId');
    }
  });

  it('outputs compact label format', async () => {
    await runHeadless(['query', 'costs', '--output', 'label'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/\d+ tokens \$[\d.]+/);
  });

  it('filters by workflow', async () => {
    await runHeadless(['query', 'costs', '--workflow', 'wf-1', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.total.eventCount).toBe(3);
  });

  it('outputs "No cost data" when no sessions exist', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask('wf-1', 'task-c', { execution: {} }),
    ] as any);

    await runHeadless(['query', 'costs'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain('No cost data');
  });

  it('produces deterministic JSON output across repeated runs', async () => {
    await runHeadless(['query', 'costs', '--output', 'json'], mockDeps);
    const output1 = stdoutSpy.mock.calls[0][0] as string;

    stdoutSpy.mockClear();
    await runHeadless(['query', 'costs', '--output', 'json'], mockDeps);
    const output2 = stdoutSpy.mock.calls[0][0] as string;

    expect(output1).toBe(output2);
  });

  it('prefers an exact persisted agentSessionId match before selectedAttemptId', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask('wf-1', 'task-a', {
        execution: {
          agentSessionId: 'sess-wf-1-task-a',
          selectedAttemptId: 'wf-1/task-a-selected',
        } as any,
      }),
    ] as any);
    (mockDeps.persistence.loadAttempts as any) = vi.fn(() => [
      { id: 'wf-1/task-a-selected', agentSessionId: 'sess-stale' },
      { id: 'wf-1/task-a-exact', agentSessionId: 'sess-wf-1-task-a' },
    ]);

    await runHeadless(['query', 'costs', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.events[0].attemptId).toBe('wf-1/task-a-exact');
  });

  it('falls back to selectedAttemptId, then to the latest persisted attempt', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask('wf-1', 'task-a', {
        execution: {
          selectedAttemptId: 'wf-1/task-a-selected',
        } as any,
      }),
      makeTask('wf-1', 'task-b', {
        execution: {
          agentSessionId: 'sess-wf-1-task-b',
        } as any,
      }),
    ] as any);
    (mockDeps.persistence.loadAttempts as any) = vi.fn((taskId: string) => {
      if (taskId === 'wf-1/task-a') {
        return [
          { id: 'wf-1/task-a-older', agentSessionId: 'sess-old' },
          { id: 'wf-1/task-a-selected', agentSessionId: 'sess-wf-1-task-a' },
        ];
      }
      if (taskId === 'wf-1/task-b') {
        return [
          { id: 'wf-1/task-b-older', agentSessionId: 'sess-old-b' },
          { id: 'wf-1/task-b-latest', agentSessionId: 'sess-wf-1-task-b' },
        ];
      }
      return [];
    });

    await runHeadless(['query', 'costs', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.events.map((event: any) => event.attemptId)).toEqual([
      'wf-1/task-a-selected',
      'wf-1/task-a-selected',
      'wf-1/task-b-latest',
    ]);
  });

  it('skips tasks without session drivers', async () => {
    (mockDeps.executionAgentRegistry as any).getSessionDriver = vi.fn(() => undefined);

    await runHeadless(['query', 'costs'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain('No cost data');
  });

  it('skips tasks whose driver lacks extractUsage', async () => {
    (mockDeps.executionAgentRegistry as any).getSessionDriver = vi.fn(() => ({
      ...mockDriver,
      extractUsage: undefined,
    }));

    await runHeadless(['query', 'costs'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain('No cost data');
  });
});
