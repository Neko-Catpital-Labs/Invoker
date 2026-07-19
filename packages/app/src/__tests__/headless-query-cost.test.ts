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

function makeSessionRaw(turns: Array<{ input: number; output: number; cached?: number }>) {
  return turns.map((t) => JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: t.input,
      output_tokens: t.output,
      cache_read_input_tokens: t.cached ?? 0,
      total_tokens: t.input + t.output,
    },
  })).join('\n');
}

describe('headless query cost', () => {
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
          timestamp: '2025-01-01T00:00:00Z',
          model: 'gpt-4o',
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
        loadCostAttributionAttempts: vi.fn((taskId: string) => attemptsByTaskId.get(taskId) ?? []),
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
    await expect(runHeadless(['query', 'cost'], mockDeps)).resolves.toBeUndefined();
  });

  it('outputs required JSON shape: { scope, groupBy, totals, groups, metadata }', async () => {
    await runHeadless(['query', 'cost', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed).toHaveProperty('scope');
    expect(parsed).toHaveProperty('groupBy');
    expect(parsed).toHaveProperty('totals');
    expect(parsed).toHaveProperty('groups');
    expect(parsed).toHaveProperty('metadata');
    expect(parsed.scope).toBe('all');
    expect(parsed.groupBy).toEqual(['workflow', 'task', 'agent', 'model', 'day']);
    expect(parsed.totals.eventCount).toBe(3);
    expect(parsed.totals.inputTokens).toBe(600);
    expect(parsed.totals.outputTokens).toBe(250);
    expect(parsed.metadata.eventCount).toBe(3);
  });

  it('scopes JSON output to workflow filter', async () => {
    await runHeadless(['query', 'cost', '--workflow', 'wf-1', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.scope).toBe('wf-1');
    expect(parsed.totals.eventCount).toBe(3);
  });

  it('supports --group-by flag with subset of dimensions', async () => {
    await runHeadless(['query', 'cost', '--group-by', 'task,agent', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.groupBy).toEqual(['task', 'agent']);
    expect(parsed.groups.length).toBeGreaterThan(0);
    // Each group should have dimensions for task and agent only
    for (const group of parsed.groups) {
      expect(group.dimensions).toHaveProperty('task');
      expect(group.dimensions).toHaveProperty('agent');
    }
  });

  it('rejects invalid --group-by dimension', async () => {
    await expect(
      runHeadless(['query', 'cost', '--group-by', 'invalid'], mockDeps),
    ).rejects.toThrow('Invalid --group-by dimension: "invalid"');
  });

  it('outputs groups in JSONL format (one group per line)', async () => {
    await runHeadless(['query', 'cost', '--output', 'jsonl'], mockDeps);
    const lines = stdoutSpy.mock.calls.map(c => (c[0] as string).trim()).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('groupKey');
      expect(parsed).toHaveProperty('dimensions');
    }
  });

  it('outputs compact label format', async () => {
    await runHeadless(['query', 'cost', '--output', 'label'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/\d+ tokens \$[\d.]+/);
  });

  it('outputs "No cost data" when no sessions exist', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask('wf-1', 'task-c', { execution: {} }),
    ] as any);

    await runHeadless(['query', 'cost'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain('No cost data');
  });

  it('produces deterministic JSON output across repeated runs', async () => {
    await runHeadless(['query', 'cost', '--output', 'json'], mockDeps);
    const output1 = stdoutSpy.mock.calls[0][0] as string;

    stdoutSpy.mockClear();
    await runHeadless(['query', 'cost', '--output', 'json'], mockDeps);
    const output2 = stdoutSpy.mock.calls[0][0] as string;

    expect(output1).toBe(output2);
  });

  it('loads the exact persisted attempt session before selectedAttemptId for query cost', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask('wf-1', 'task-a', {
        execution: {
          agentSessionId: 'sess-wf-1-task-a',
          selectedAttemptId: 'wf-1/task-a-selected',
        } as any,
      }),
    ] as any);
    (mockDeps.persistence.loadCostAttributionAttempts as any) = vi.fn(() => [
      { id: 'wf-1/task-a-selected', agentSessionId: 'sess-stale' },
      { id: 'wf-1/task-a-exact', agentSessionId: 'sess-wf-1-task-a' },
    ]);

    await runHeadless(['query', 'cost', '--output', 'json'], mockDeps);

    expect(mockDriver.loadSession).toHaveBeenCalledWith('sess-wf-1-task-a');
    expect(mockDriver.loadSession).not.toHaveBeenCalledWith('sess-stale');

    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.totals.eventCount).toBe(2);
  });

  it('falls back to the latest persisted attempt session for query cost when no selected attempt exists', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask('wf-1', 'task-b', {
        execution: {
          agentSessionId: undefined,
          selectedAttemptId: undefined,
        } as any,
      }),
    ] as any);
    (mockDeps.persistence.loadCostAttributionAttempts as any) = vi.fn(() => [
      { id: 'wf-1/task-b-older', agentSessionId: 'sess-old-b' },
      { id: 'wf-1/task-b-latest', agentSessionId: 'sess-wf-1-task-b' },
    ]);

    await runHeadless(['query', 'cost', '--output', 'json'], mockDeps);

    expect(mockDriver.loadSession).toHaveBeenCalledWith('sess-wf-1-task-b');
    expect(mockDriver.loadSession).not.toHaveBeenCalledWith('sess-old-b');

    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.totals.eventCount).toBe(1);
  });
});

describe('headless query cost-events', () => {
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
          timestamp: '2025-01-01T00:00:00Z',
          model: 'gpt-4o',
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
        loadCostAttributionAttempts: vi.fn((taskId: string) => attemptsByTaskId.get(taskId) ?? []),
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
    await expect(runHeadless(['query', 'cost-events'], mockDeps)).resolves.toBeUndefined();
  });

  it('outputs all events in JSON format as array', async () => {
    await runHeadless(['query', 'cost-events', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    for (const event of parsed) {
      expect(event).toHaveProperty('eventId');
      expect(event).toHaveProperty('inputTokens');
      expect(event).toHaveProperty('outputTokens');
      expect(event).toHaveProperty('workflowId');
      expect(event).toHaveProperty('taskId');
      expect(event).toHaveProperty('attemptId');
      expect(event).toHaveProperty('model');
      expect(event).toHaveProperty('confidence');
    }
    expect(parsed.map((event: any) => event.attemptId)).toEqual([
      'wf-1/task-a-attempt-1',
      'wf-1/task-a-attempt-1',
      'wf-1/task-b-attempt-1',
    ]);
  });

  it('outputs events in JSONL format (one per line)', async () => {
    await runHeadless(['query', 'cost-events', '--output', 'jsonl'], mockDeps);
    // formatAsJsonl joins all into a single write
    const allOutput = stdoutSpy.mock.calls.map(c => (c[0] as string).trim()).join('\n');
    const lines = allOutput.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('eventId');
      expect(parsed).toHaveProperty('inputTokens');
      expect(parsed).toHaveProperty('workflowId');
    }
  });

  it('outputs label format (taskId:eventId per line)', async () => {
    await runHeadless(['query', 'cost-events', '--output', 'label'], mockDeps);
    const lines = stdoutSpy.mock.calls.map(c => (c[0] as string).trim()).filter(Boolean);
    expect(lines).toHaveLength(3);

    for (const line of lines) {
      expect(line).toMatch(/^wf-1\/task-[ab]:codex-turn-\d+$/);
    }
  });

  it('outputs text format with formatted event lines', async () => {
    await runHeadless(['query', 'cost-events'], mockDeps);
    const calls = stdoutSpy.mock.calls;
    // 3 events = 3 write calls
    expect(calls).toHaveLength(3);
  });

  it('filters by workflow', async () => {
    await runHeadless(['query', 'cost-events', '--workflow', 'wf-1', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(3);
    for (const event of parsed) {
      expect(event.workflowId).toBe('wf-1');
    }
  });

  it('outputs "No cost events found" when no sessions exist', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask('wf-1', 'task-c', { execution: {} }),
    ] as any);

    await runHeadless(['query', 'cost-events'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    expect(output).toContain('No cost events found');
  });

  it('produces deterministic JSON output across repeated runs', async () => {
    await runHeadless(['query', 'cost-events', '--output', 'json'], mockDeps);
    const output1 = stdoutSpy.mock.calls[0][0] as string;

    stdoutSpy.mockClear();
    await runHeadless(['query', 'cost-events', '--output', 'json'], mockDeps);
    const output2 = stdoutSpy.mock.calls[0][0] as string;

    expect(output1).toBe(output2);
  });

  it('uses selectedAttemptId when no exact persisted session match exists', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask('wf-1', 'task-a', {
        execution: {
          agentName: 'codex',
          selectedAttemptId: 'wf-1/task-a-selected',
        } as any,
      }),
    ] as any);
    (mockDeps.persistence.loadCostAttributionAttempts as any) = vi.fn(() => [
      { id: 'wf-1/task-a-older', agentSessionId: 'sess-older' },
      { id: 'wf-1/task-a-selected', agentSessionId: 'sess-wf-1-task-a' },
    ]);

    await runHeadless(['query', 'cost-events', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed[0].attemptId).toBe('wf-1/task-a-selected');
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
    (mockDeps.persistence.loadCostAttributionAttempts as any) = vi.fn(() => [
      { id: 'wf-1/task-a-selected', agentSessionId: 'sess-stale' },
      { id: 'wf-1/task-a-exact', agentSessionId: 'sess-wf-1-task-a' },
    ]);

    await runHeadless(['query', 'cost-events', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.map((event: any) => event.attemptId)).toEqual([
      'wf-1/task-a-exact',
      'wf-1/task-a-exact',
    ]);
  });

  it('falls back to the latest persisted attempt when no selected attempt is available', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask('wf-1', 'task-b', {
        execution: {
          agentSessionId: undefined,
          selectedAttemptId: undefined,
        } as any,
      }),
    ] as any);
    (mockDeps.persistence.loadCostAttributionAttempts as any) = vi.fn(() => [
      { id: 'wf-1/task-b-older', agentSessionId: 'sess-old-b' },
      { id: 'wf-1/task-b-latest', agentSessionId: 'sess-wf-1-task-b' },
    ]);

    await runHeadless(['query', 'cost-events', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.map((event: any) => event.attemptId)).toEqual([
      'wf-1/task-b-latest',
    ]);
  });

  it('serializes resolved persisted attempt IDs deterministically', async () => {
    mockDeps.orchestrator.getAllTasks = vi.fn(() => [
      makeTask('wf-1', 'task-a', {
        execution: {
          agentName: 'codex',
          selectedAttemptId: 'wf-1/task-a-selected',
        } as any,
      }),
    ] as any);
    (mockDeps.persistence.loadCostAttributionAttempts as any) = vi.fn(() => [
      { id: 'wf-1/task-a-older', agentSessionId: 'sess-older' },
      { id: 'wf-1/task-a-selected', agentSessionId: 'sess-wf-1-task-a' },
    ]);

    await runHeadless(['query', 'cost-events', '--output', 'json'], mockDeps);
    const output = stdoutSpy.mock.calls[0][0] as string;

    expect(output).toBe(JSON.stringify([
      {
        eventId: 'codex-turn-0',
        agentSessionId: 'sess-wf-1-task-a',
        agentName: 'codex',
        source: 'openai',
        workflowId: 'wf-1',
        taskId: 'wf-1/task-a',
        attemptId: 'wf-1/task-a-selected',
        runnerKind: 'worktree',
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 0,
        totalTokens: 150,
        model: 'gpt-4o',
        pricingVersion: '0',
        estimatedCostUsd: 0,
        confidence: 'exact',
        timestamp: '2025-01-01T00:00:00Z',
      },
      {
        eventId: 'codex-turn-1',
        agentSessionId: 'sess-wf-1-task-a',
        agentName: 'codex',
        source: 'openai',
        workflowId: 'wf-1',
        taskId: 'wf-1/task-a',
        attemptId: 'wf-1/task-a-selected',
        runnerKind: 'worktree',
        inputTokens: 200,
        outputTokens: 80,
        cachedTokens: 0,
        totalTokens: 280,
        model: 'gpt-4o',
        pricingVersion: '0',
        estimatedCostUsd: 0,
        confidence: 'exact',
        timestamp: '2025-01-01T00:00:00Z',
      },
    ]) + '\n');
  });

  it('supports JSONL piping without special handling', async () => {
    // Demonstrates that cost-events JSONL output is standard NDJSON
    // that can be piped through standard tools like jq
    await runHeadless(['query', 'cost-events', '--output', 'jsonl'], mockDeps);
    const allOutput = stdoutSpy.mock.calls.map(c => (c[0] as string).trim()).join('\n');
    const lines = allOutput.split('\n').filter(Boolean);

    // Each line must be independently parseable JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('rejects invalid --output format', async () => {
    await expect(
      runHeadless(['query', 'cost-events', '--output', 'csv'], mockDeps),
    ).rejects.toThrow('Invalid --output format');
  });

  it('rejects unknown flags', async () => {
    await expect(
      runHeadless(['query', 'cost-events', '--foo'], mockDeps),
    ).rejects.toThrow('Unknown query flag');
  });
});
