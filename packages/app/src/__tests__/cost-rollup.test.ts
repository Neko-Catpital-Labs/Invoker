import { describe, it, expect } from 'vitest';
import type { SessionUsageEvent } from '@invoker/execution-engine';
import type { NormalizedCostEvent } from '@invoker/contracts';
import {
  attributeSessionUsage,
  groupCostEvents,
  buildAttributionContext,
  resolveSessionId,
  resolveAgentName,
  deriveSource,
  serializeGroupedRollup,
  type AttributionContext,
  type CostTaskInfo,
} from '../cost-rollup.js';

// ── Fixture Helpers ────────────────────────────────────────

function makeUsageEvent(overrides: Partial<SessionUsageEvent> = {}): SessionUsageEvent {
  return {
    eventId: 'evt-1',
    timestamp: '2025-01-15T10:00:00Z',
    model: 'gpt-4o',
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 10,
    totalTokens: 150,
    confidence: 'exact',
    ...overrides,
  };
}

function makeContext(overrides: Partial<AttributionContext> = {}): AttributionContext {
  return {
    workflowId: 'wf-1',
    taskId: 'wf-1/task-a',
    attemptId: 'attempt-1',
    runnerKind: 'worktree',
    agentSessionId: 'sess-abc',
    agentName: 'codex',
    source: 'openai',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<{
  eventId: string;
  workflowId: string;
  taskId: string;
  agentName: string;
  model: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  confidence: 'exact' | 'estimated' | 'unknown';
  estimatedCostUsd: number;
}> = {}): NormalizedCostEvent {
  const {
    eventId = 'evt-1',
    workflowId = 'wf-1',
    taskId = 'wf-1/task-a',
    agentName = 'codex',
    model = 'gpt-4o',
    timestamp = '2025-01-15T10:00:00Z',
    inputTokens = 100,
    outputTokens = 50,
    cachedTokens = 10,
    totalTokens = 150,
    confidence = 'exact',
    estimatedCostUsd = 0.005,
  } = overrides;

  return {
    identity: {
      eventId,
      agentSessionId: 'sess-abc',
      agentName,
      source: agentName === 'claude' ? 'anthropic' : 'openai',
    },
    attribution: {
      workflowId,
      taskId,
      attemptId: 'attempt-1',
      runnerKind: 'worktree',
    },
    usage: { inputTokens, outputTokens, cachedTokens, totalTokens },
    pricing: { model, pricingVersion: '0', estimatedCostUsd, confidence },
    timestamp,
  };
}

// ── attributeSessionUsage ──────────────────────────────────

describe('attributeSessionUsage', () => {
  it('maps session events to normalized events with attribution', () => {
    const events = [
      makeUsageEvent({ eventId: 'evt-1', inputTokens: 100, outputTokens: 50 }),
      makeUsageEvent({ eventId: 'evt-2', inputTokens: 200, outputTokens: 80 }),
    ];
    const ctx = makeContext();
    const result = attributeSessionUsage(events, ctx);

    expect(result).toHaveLength(2);
    expect(result[0].identity.eventId).toBe('evt-1');
    expect(result[0].identity.agentSessionId).toBe('sess-abc');
    expect(result[0].identity.agentName).toBe('codex');
    expect(result[0].attribution.workflowId).toBe('wf-1');
    expect(result[0].attribution.taskId).toBe('wf-1/task-a');
    expect(result[0].usage.inputTokens).toBe(100);
    expect(result[1].usage.inputTokens).toBe(200);
  });

  it('returns empty array for empty input', () => {
    expect(attributeSessionUsage([], makeContext())).toEqual([]);
  });

  it('uses "unknown" for missing model', () => {
    const events = [makeUsageEvent({ model: '' })];
    const result = attributeSessionUsage(events, makeContext());
    expect(result[0].pricing.model).toBe('unknown');
  });
});

// ── groupCostEvents ────────────────────────────────────────

describe('groupCostEvents', () => {
  it('groups by single dimension', () => {
    const events = [
      makeEvent({ agentName: 'claude', eventId: 'e1' }),
      makeEvent({ agentName: 'codex', eventId: 'e2' }),
      makeEvent({ agentName: 'claude', eventId: 'e3' }),
    ];
    const groups = groupCostEvents(events, ['agent']);

    expect(groups).toHaveLength(2);
    expect(groups[0].dimensions.agent).toBe('claude');
    expect(groups[0].rollup.eventCount).toBe(2);
    expect(groups[1].dimensions.agent).toBe('codex');
    expect(groups[1].rollup.eventCount).toBe(1);
  });

  it('groups by multiple dimensions', () => {
    const events = [
      makeEvent({ agentName: 'claude', model: 'opus-4', eventId: 'e1' }),
      makeEvent({ agentName: 'claude', model: 'sonnet-4', eventId: 'e2' }),
      makeEvent({ agentName: 'codex', model: 'gpt-4o', eventId: 'e3' }),
    ];
    const groups = groupCostEvents(events, ['agent', 'model']);

    expect(groups).toHaveLength(3);
    // Sorted lexicographically by composite key
    expect(groups[0].groupKey).toBe('claude|opus-4');
    expect(groups[1].groupKey).toBe('claude|sonnet-4');
    expect(groups[2].groupKey).toBe('codex|gpt-4o');
  });

  it('produces deterministic output across repeated calls', () => {
    const events = [
      makeEvent({ workflowId: 'wf-2', taskId: 'wf-2/b', agentName: 'codex', eventId: 'e1' }),
      makeEvent({ workflowId: 'wf-1', taskId: 'wf-1/a', agentName: 'claude', eventId: 'e2' }),
      makeEvent({ workflowId: 'wf-2', taskId: 'wf-2/a', agentName: 'claude', eventId: 'e3' }),
      makeEvent({ workflowId: 'wf-1', taskId: 'wf-1/b', agentName: 'codex', eventId: 'e4' }),
    ];

    const run1 = groupCostEvents(events, ['workflow', 'task', 'agent']);
    const run2 = groupCostEvents(events, ['workflow', 'task', 'agent']);
    const run3 = groupCostEvents([...events].reverse(), ['workflow', 'task', 'agent']);

    // Same input → identical output
    expect(run1.map(g => g.groupKey)).toEqual(run2.map(g => g.groupKey));
    // Reversed input → same sorted output
    expect(run1.map(g => g.groupKey)).toEqual(run3.map(g => g.groupKey));
    // Rollups match
    expect(run1.map(g => g.rollup)).toEqual(run3.map(g => g.rollup));
  });

  it('groups by day dimension using ISO date prefix', () => {
    const events = [
      makeEvent({ timestamp: '2025-01-15T10:00:00Z', eventId: 'e1' }),
      makeEvent({ timestamp: '2025-01-15T18:00:00Z', eventId: 'e2' }),
      makeEvent({ timestamp: '2025-01-16T09:00:00Z', eventId: 'e3' }),
    ];
    const groups = groupCostEvents(events, ['day']);

    expect(groups).toHaveLength(2);
    expect(groups[0].dimensions.day).toBe('2025-01-15');
    expect(groups[0].rollup.eventCount).toBe(2);
    expect(groups[1].dimensions.day).toBe('2025-01-16');
    expect(groups[1].rollup.eventCount).toBe(1);
  });

  it('handles missing timestamp gracefully', () => {
    const events = [makeEvent({ timestamp: '', eventId: 'e1' })];
    const groups = groupCostEvents(events, ['day']);
    expect(groups[0].dimensions.day).toBe('unknown');
  });

  it('returns empty array for empty input', () => {
    expect(groupCostEvents([])).toEqual([]);
  });

  it('tracks unknown confidence and missing usage in rollups', () => {
    const events = [
      makeEvent({ confidence: 'unknown', totalTokens: 0, eventId: 'e1' }),
      makeEvent({ confidence: 'exact', totalTokens: 100, eventId: 'e2' }),
    ];
    const groups = groupCostEvents(events, ['workflow']);

    expect(groups).toHaveLength(1);
    expect(groups[0].rollup.unknownConfidenceCount).toBe(1);
    expect(groups[0].rollup.missingUsageCount).toBe(1);
    expect(groups[0].rollup.eventCount).toBe(2);
  });

  it('defaults to all dimensions when none specified', () => {
    const events = [makeEvent({ eventId: 'e1' })];
    const groups = groupCostEvents(events);

    expect(groups).toHaveLength(1);
    // Key should contain all 5 dimension values
    const parts = groups[0].groupKey.split('|');
    expect(parts).toHaveLength(5);
    expect(groups[0].dimensions).toHaveProperty('workflow');
    expect(groups[0].dimensions).toHaveProperty('task');
    expect(groups[0].dimensions).toHaveProperty('agent');
    expect(groups[0].dimensions).toHaveProperty('model');
    expect(groups[0].dimensions).toHaveProperty('day');
  });

  it('aggregates token counts correctly within groups', () => {
    const events = [
      makeEvent({ inputTokens: 100, outputTokens: 50, cachedTokens: 10, totalTokens: 150, estimatedCostUsd: 0.005, eventId: 'e1' }),
      makeEvent({ inputTokens: 200, outputTokens: 80, cachedTokens: 20, totalTokens: 280, estimatedCostUsd: 0.010, eventId: 'e2' }),
    ];
    const groups = groupCostEvents(events, ['workflow']);

    expect(groups[0].rollup.inputTokens).toBe(300);
    expect(groups[0].rollup.outputTokens).toBe(130);
    expect(groups[0].rollup.cachedTokens).toBe(30);
    expect(groups[0].rollup.totalTokens).toBe(430);
    expect(groups[0].rollup.totalCostUsd).toBeCloseTo(0.015, 6);
  });
});

// ── Competing Design Proof ─────────────────────────────────

describe('competing design proof: deterministic grouped outputs without provider branching', () => {
  it('multi-provider events roll up identically regardless of input order', () => {
    const anthropicEvent = makeEvent({
      eventId: 'a1', agentName: 'claude', model: 'opus-4',
      inputTokens: 500, outputTokens: 200, totalTokens: 700,
      estimatedCostUsd: 0.025,
    });
    const openaiEvent = makeEvent({
      eventId: 'o1', agentName: 'codex', model: 'gpt-4o',
      inputTokens: 300, outputTokens: 100, totalTokens: 400,
      estimatedCostUsd: 0.010,
    });

    const forwardGroups = groupCostEvents([anthropicEvent, openaiEvent], ['agent']);
    const reverseGroups = groupCostEvents([openaiEvent, anthropicEvent], ['agent']);

    // Output is sorted by key, not input order
    expect(forwardGroups.map(g => g.groupKey)).toEqual(reverseGroups.map(g => g.groupKey));
    expect(forwardGroups.map(g => g.rollup)).toEqual(reverseGroups.map(g => g.rollup));

    // No provider-specific branching: both groups have same shape
    expect(forwardGroups[0].rollup).toHaveProperty('inputTokens');
    expect(forwardGroups[0].rollup).toHaveProperty('totalCostUsd');
    expect(forwardGroups[1].rollup).toHaveProperty('inputTokens');
    expect(forwardGroups[1].rollup).toHaveProperty('totalCostUsd');
  });

  it('JSON serialization is deterministic', () => {
    const events = [
      makeEvent({ eventId: 'e1', agentName: 'claude', workflowId: 'wf-1', taskId: 'wf-1/a' }),
      makeEvent({ eventId: 'e2', agentName: 'codex', workflowId: 'wf-1', taskId: 'wf-1/b' }),
      makeEvent({ eventId: 'e3', agentName: 'claude', workflowId: 'wf-2', taskId: 'wf-2/a' }),
    ];

    const groups1 = groupCostEvents(events, ['workflow', 'agent']);
    const groups2 = groupCostEvents([...events].reverse(), ['workflow', 'agent']);

    const json1 = JSON.stringify(groups1.map(serializeGroupedRollup));
    const json2 = JSON.stringify(groups2.map(serializeGroupedRollup));
    expect(json1).toBe(json2);
  });
});

// ── Session ID Resolution ──────────────────────────────────

describe('resolveSessionId', () => {
  it('prefers agentSessionId', () => {
    expect(resolveSessionId({
      id: 't1', workflowId: 'wf-1', runnerKind: 'worktree',
      agentSessionId: 'current', lastAgentSessionId: 'previous',
    })).toBe('current');
  });

  it('falls back to lastAgentSessionId', () => {
    expect(resolveSessionId({
      id: 't1', workflowId: 'wf-1', runnerKind: 'worktree',
      lastAgentSessionId: 'previous',
    })).toBe('previous');
  });

  it('returns undefined when neither is available', () => {
    expect(resolveSessionId({
      id: 't1', workflowId: 'wf-1', runnerKind: 'worktree',
    })).toBeUndefined();
  });
});

// ── Agent Name Resolution ──────────────────────────────────

describe('resolveAgentName', () => {
  it('prefers agentName', () => {
    expect(resolveAgentName({
      id: 't1', workflowId: 'wf-1', runnerKind: 'worktree',
      agentName: 'codex', lastAgentName: 'claude',
    })).toBe('codex');
  });

  it('falls back to lastAgentName', () => {
    expect(resolveAgentName({
      id: 't1', workflowId: 'wf-1', runnerKind: 'worktree',
      lastAgentName: 'codex',
    })).toBe('codex');
  });

  it('defaults to codex', () => {
    expect(resolveAgentName({
      id: 't1', workflowId: 'wf-1', runnerKind: 'worktree',
    })).toBe('codex');
  });
});

// ── Source Derivation ──────────────────────────────────────

describe('deriveSource', () => {
  it('maps claude to anthropic', () => {
    expect(deriveSource('claude')).toBe('anthropic');
  });

  it('maps codex to openai', () => {
    expect(deriveSource('codex')).toBe('openai');
  });

  it('returns unknown for unrecognized agents', () => {
    expect(deriveSource('custom-agent')).toBe('unknown');
  });
});

// ── buildAttributionContext ────────────────────────────────

describe('buildAttributionContext', () => {
  it('builds context from task info with agentSessionId', () => {
    const task: CostTaskInfo = {
      id: 'wf-1/task-a',
      workflowId: 'wf-1',
      runnerKind: 'worktree',
      agentSessionId: 'sess-123',
      agentName: 'codex',
    };
    const ctx = buildAttributionContext(task, 'attempt-123');
    expect(ctx).toEqual({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      attemptId: 'attempt-123',
      runnerKind: 'worktree',
      agentSessionId: 'sess-123',
      agentName: 'codex',
      source: 'openai',
    });
  });

  it('uses the caller-provided persisted session identity when supplied', () => {
    const task: CostTaskInfo = {
      id: 'wf-1/task-a',
      workflowId: 'wf-1',
      runnerKind: 'worktree',
      agentSessionId: 'sess-current',
      lastAgentSessionId: 'sess-old',
      agentName: 'codex',
    };
    const ctx = buildAttributionContext(task, 'attempt-persisted', 'sess-persisted');
    expect(ctx).toEqual({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      attemptId: 'attempt-persisted',
      runnerKind: 'worktree',
      agentSessionId: 'sess-persisted',
      agentName: 'codex',
      source: 'openai',
    });
  });

  it('returns undefined when no session ID is available', () => {
    const task: CostTaskInfo = {
      id: 'wf-1/task-a',
      workflowId: 'wf-1',
      runnerKind: 'worktree',
    };
    expect(buildAttributionContext(task, 'attempt-123')).toBeUndefined();
  });

  it('falls back to lastAgentSessionId and lastAgentName', () => {
    const task: CostTaskInfo = {
      id: 'wf-1/task-a',
      workflowId: 'wf-1',
      runnerKind: 'ssh',
      lastAgentSessionId: 'sess-old',
      lastAgentName: 'claude',
    };
    const ctx = buildAttributionContext(task, 'attempt-older');
    expect(ctx?.agentSessionId).toBe('sess-old');
    expect(ctx?.agentName).toBe('claude');
    expect(ctx?.source).toBe('anthropic');
  });

  it('defaults runnerKind to worktree when empty', () => {
    const task: CostTaskInfo = {
      id: 'wf-1/task-a',
      workflowId: 'wf-1',
      runnerKind: '',
      agentSessionId: 'sess-123',
    };
    const ctx = buildAttributionContext(task, 'attempt-123');
    expect(ctx?.runnerKind).toBe('worktree');
  });

  it('returns undefined when attempt ID is empty', () => {
    const task: CostTaskInfo = {
      id: 'wf-1/task-a',
      workflowId: 'wf-1',
      runnerKind: 'worktree',
      agentSessionId: 'sess-123',
    };
    expect(buildAttributionContext(task, '')).toBeUndefined();
  });
});

// ── serializeGroupedRollup ─────────────────────────────────

describe('serializeGroupedRollup', () => {
  it('flattens group into JSON-safe object', () => {
    const events = [makeEvent({ eventId: 'e1', estimatedCostUsd: 0.005 })];
    const groups = groupCostEvents(events, ['workflow']);
    const serialized = serializeGroupedRollup(groups[0]);

    expect(serialized.groupKey).toBe('wf-1');
    expect(serialized.dimensions).toEqual({ workflow: 'wf-1' });
    expect(serialized.eventCount).toBe(1);
    expect(serialized.totalCostUsd).toBeCloseTo(0.005, 6);

    // Valid JSON
    const json = JSON.stringify(serialized);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
