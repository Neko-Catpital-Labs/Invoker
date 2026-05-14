import { describe, it, expect } from 'vitest';
import type {
  NormalizedCostEvent,
  CostEventIdentity,
  CostEventAttribution,
  CostEventUsage,
  CostEventPricing,
  CostRollup,
  CostConfidence,
} from '../cost-types.js';
import {
  emptyCostRollup,
  accumulateCostEvent,
  rollUpCostEvents,
} from '../cost-types.js';

// ── Fixture helpers ─────────────────────────────────────────

/** Simulated raw event from Anthropic's API (Claude). */
interface AnthropicRawEvent {
  id: string;
  session_id: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
  // Anthropic-specific fields that don't exist on other providers
  stop_reason: string;
  anthropic_metadata?: { billing_tier: string };
}

/** Simulated raw event from OpenAI's API (GPT). */
interface OpenAIRawEvent {
  id: string;
  object: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number } };
  // OpenAI-specific fields
  system_fingerprint: string;
  service_tier?: string;
}

/** Map an Anthropic raw event to the normalized shape. */
function fromAnthropic(
  raw: AnthropicRawEvent,
  attribution: CostEventAttribution,
): NormalizedCostEvent {
  const input = raw.usage.input_tokens;
  const output = raw.usage.output_tokens;
  const cached = raw.usage.cache_read_input_tokens;
  return {
    identity: {
      eventId: raw.id,
      agentSessionId: raw.session_id,
      agentName: 'claude',
      source: 'anthropic',
    },
    attribution,
    usage: { inputTokens: input, outputTokens: output, cachedTokens: cached, totalTokens: input + output },
    pricing: { model: raw.model, pricingVersion: '2025-01', estimatedCostUsd: (input * 3 + output * 15) / 1_000_000, confidence: 'estimated' },
    timestamp: new Date().toISOString(),
  };
}

/** Map an OpenAI raw event to the normalized shape. */
function fromOpenAI(
  raw: OpenAIRawEvent,
  attribution: CostEventAttribution,
): NormalizedCostEvent {
  const input = raw.usage.prompt_tokens;
  const output = raw.usage.completion_tokens;
  const cached = raw.usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    identity: {
      eventId: raw.id,
      agentSessionId: `oai-${raw.id}`,
      agentName: 'gpt-4o',
      source: 'openai',
    },
    attribution,
    usage: { inputTokens: input, outputTokens: output, cachedTokens: cached, totalTokens: input + output },
    pricing: { model: raw.model, pricingVersion: '2025-01', estimatedCostUsd: (input * 2.5 + output * 10) / 1_000_000, confidence: 'estimated' },
    timestamp: new Date().toISOString(),
  };
}

const SHARED_ATTRIBUTION: CostEventAttribution = {
  workflowId: 'wf-1',
  taskId: 'task-a',
  attemptId: 'att-1',
  runnerKind: 'worktree',
};

function makeEvent(overrides: Partial<NormalizedCostEvent> = {}): NormalizedCostEvent {
  return {
    identity: {
      eventId: 'evt-1',
      agentSessionId: 'session-1',
      agentName: 'claude',
      source: 'anthropic',
    },
    attribution: SHARED_ATTRIBUTION,
    usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 500, totalTokens: 1200 },
    pricing: { model: 'claude-sonnet-4-20250514', pricingVersion: '2025-01', estimatedCostUsd: 0.006, confidence: 'exact' },
    timestamp: '2025-06-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('NormalizedCostEvent type contract', () => {
  it('enforces all required identity fields', () => {
    const id: CostEventIdentity = {
      eventId: 'e1',
      agentSessionId: 's1',
      agentName: 'claude',
      source: 'anthropic',
    };
    expect(id.eventId).toBe('e1');
    expect(id.agentSessionId).toBe('s1');
    expect(id.agentName).toBe('claude');
    expect(id.source).toBe('anthropic');
  });

  it('enforces all required attribution fields', () => {
    const attr: CostEventAttribution = {
      workflowId: 'wf-1',
      taskId: 'task-a',
      attemptId: 'att-1',
      runnerKind: 'worktree',
    };
    expect(attr.workflowId).toBe('wf-1');
    expect(attr.taskId).toBe('task-a');
    expect(attr.attemptId).toBe('att-1');
    expect(attr.runnerKind).toBe('worktree');
  });

  it('enforces all required usage fields', () => {
    const usage: CostEventUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 20,
      totalTokens: 150,
    };
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cachedTokens).toBe(20);
    expect(usage.totalTokens).toBe(150);
  });

  it('enforces all required pricing fields', () => {
    const pricing: CostEventPricing = {
      model: 'claude-sonnet-4-20250514',
      pricingVersion: '2025-01',
      estimatedCostUsd: 0.003,
      confidence: 'exact',
    };
    expect(pricing.model).toBe('claude-sonnet-4-20250514');
    expect(pricing.pricingVersion).toBe('2025-01');
    expect(pricing.estimatedCostUsd).toBe(0.003);
    expect(pricing.confidence).toBe('exact');
  });

  it('confidence type is a union of exact | estimated | unknown', () => {
    const values: CostConfidence[] = ['exact', 'estimated', 'unknown'];
    expect(values).toHaveLength(3);
  });
});

describe('multi-provider fixture mapping', () => {
  it('Anthropic raw event maps to NormalizedCostEvent', () => {
    const raw: AnthropicRawEvent = {
      id: 'msg_01abc',
      session_id: 'sess-claude-1',
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
      stop_reason: 'end_turn',
    };

    const event = fromAnthropic(raw, SHARED_ATTRIBUTION);

    expect(event.identity.eventId).toBe('msg_01abc');
    expect(event.identity.source).toBe('anthropic');
    expect(event.usage.inputTokens).toBe(1000);
    expect(event.usage.outputTokens).toBe(200);
    expect(event.usage.cachedTokens).toBe(500);
    expect(event.usage.totalTokens).toBe(1200);
    expect(event.pricing.model).toBe('claude-sonnet-4-20250514');
  });

  it('OpenAI raw event maps to the same NormalizedCostEvent shape', () => {
    const raw: OpenAIRawEvent = {
      id: 'chatcmpl-xyz',
      object: 'chat.completion',
      model: 'gpt-4o-2025-05-13',
      usage: { prompt_tokens: 800, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } },
      system_fingerprint: 'fp_abc123',
    };

    const event = fromOpenAI(raw, SHARED_ATTRIBUTION);

    expect(event.identity.eventId).toBe('chatcmpl-xyz');
    expect(event.identity.source).toBe('openai');
    expect(event.usage.inputTokens).toBe(800);
    expect(event.usage.outputTokens).toBe(300);
    expect(event.usage.cachedTokens).toBe(200);
    expect(event.usage.totalTokens).toBe(1100);
    expect(event.pricing.model).toBe('gpt-4o-2025-05-13');
  });

  it('both providers produce structurally identical objects', () => {
    const anthropicRaw: AnthropicRawEvent = {
      id: 'msg_01abc',
      session_id: 'sess-1',
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0 },
      stop_reason: 'end_turn',
    };
    const openaiRaw: OpenAIRawEvent = {
      id: 'chatcmpl-xyz',
      object: 'chat.completion',
      model: 'gpt-4o',
      usage: { prompt_tokens: 500, completion_tokens: 100 },
      system_fingerprint: 'fp_abc',
    };

    const anthropicEvent = fromAnthropic(anthropicRaw, SHARED_ATTRIBUTION);
    const openaiEvent = fromOpenAI(openaiRaw, SHARED_ATTRIBUTION);

    // Both have the exact same top-level keys
    expect(Object.keys(anthropicEvent).sort()).toEqual(Object.keys(openaiEvent).sort());

    // Both have the exact same nested keys in each facet
    expect(Object.keys(anthropicEvent.identity).sort()).toEqual(Object.keys(openaiEvent.identity).sort());
    expect(Object.keys(anthropicEvent.attribution).sort()).toEqual(Object.keys(openaiEvent.attribution).sort());
    expect(Object.keys(anthropicEvent.usage).sort()).toEqual(Object.keys(openaiEvent.usage).sort());
    expect(Object.keys(anthropicEvent.pricing).sort()).toEqual(Object.keys(openaiEvent.pricing).sort());
  });

  it('mixed-provider events can be rolled up without branching', () => {
    const anthropicEvent = fromAnthropic(
      { id: 'a1', session_id: 's1', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0 }, stop_reason: 'end_turn' },
      SHARED_ATTRIBUTION,
    );
    const openaiEvent = fromOpenAI(
      { id: 'o1', object: 'chat.completion', model: 'gpt-4o', usage: { prompt_tokens: 800, completion_tokens: 300 }, system_fingerprint: 'fp_1' },
      { ...SHARED_ATTRIBUTION, taskId: 'task-b' },
    );

    // A single rollUpCostEvents call handles both providers uniformly
    const rollup = rollUpCostEvents([anthropicEvent, openaiEvent]);
    expect(rollup.eventCount).toBe(2);
    expect(rollup.inputTokens).toBe(1800);
    expect(rollup.outputTokens).toBe(500);
    expect(rollup.totalTokens).toBe(2300);
    expect(rollup.totalCostUsd).toBeGreaterThan(0);
  });
});

describe('competing-design proof: provider-specific schema causes branching', () => {
  it('provider-specific schemas require conditional access patterns', () => {
    // Simulate what consumers must do with provider-specific schemas
    type AnthropicCost = { type: 'anthropic'; input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
    type OpenAICost = { type: 'openai'; prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
    type ProviderSpecificCost = AnthropicCost | OpenAICost;

    function getInputTokensProviderSpecific(cost: ProviderSpecificCost): number {
      // Consumer must branch on provider type
      if (cost.type === 'anthropic') return cost.input_tokens;
      return cost.prompt_tokens;
    }

    function getOutputTokensProviderSpecific(cost: ProviderSpecificCost): number {
      // Consumer must branch on provider type
      if (cost.type === 'anthropic') return cost.output_tokens;
      return cost.completion_tokens;
    }

    // Every access site requires a type guard — O(providers * access sites) branches
    const a: AnthropicCost = { type: 'anthropic', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 };
    const o: OpenAICost = { type: 'openai', prompt_tokens: 100, completion_tokens: 50 };

    expect(getInputTokensProviderSpecific(a)).toBe(100);
    expect(getInputTokensProviderSpecific(o)).toBe(100);
    expect(getOutputTokensProviderSpecific(a)).toBe(50);
    expect(getOutputTokensProviderSpecific(o)).toBe(50);
  });

  it('normalized schema needs zero consumer branching', () => {
    // With the normalized schema, the parser does the mapping once.
    // Consumers access fields uniformly — no type guards needed.
    function getInputTokensNormalized(event: NormalizedCostEvent): number {
      return event.usage.inputTokens; // No branching, no type guards
    }

    function getOutputTokensNormalized(event: NormalizedCostEvent): number {
      return event.usage.outputTokens; // No branching, no type guards
    }

    const event = makeEvent();
    expect(getInputTokensNormalized(event)).toBe(1000);
    expect(getOutputTokensNormalized(event)).toBe(200);
  });

  it('formatter signature stays uniform regardless of provider', () => {
    // A formatter function accepts NormalizedCostEvent — no provider parameter needed
    function formatCost(event: NormalizedCostEvent): string {
      return `${event.identity.agentName}: ${event.usage.totalTokens} tokens, $${event.pricing.estimatedCostUsd.toFixed(4)}`;
    }

    const anthropicEvent = fromAnthropic(
      { id: 'a1', session_id: 's1', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, stop_reason: 'end_turn' },
      SHARED_ATTRIBUTION,
    );
    const openaiEvent = fromOpenAI(
      { id: 'o1', object: 'chat.completion', model: 'gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 50 }, system_fingerprint: 'fp_1' },
      SHARED_ATTRIBUTION,
    );

    // Same function, same signature, both providers — zero branching
    const a = formatCost(anthropicEvent);
    const o = formatCost(openaiEvent);
    expect(a).toContain('claude');
    expect(a).toContain('150 tokens');
    expect(o).toContain('gpt-4o');
    expect(o).toContain('150 tokens');
  });
});

describe('emptyCostRollup', () => {
  it('returns all zeros', () => {
    const rollup = emptyCostRollup();
    expect(rollup.inputTokens).toBe(0);
    expect(rollup.outputTokens).toBe(0);
    expect(rollup.cachedTokens).toBe(0);
    expect(rollup.totalTokens).toBe(0);
    expect(rollup.totalCostUsd).toBe(0);
    expect(rollup.unknownConfidenceCount).toBe(0);
    expect(rollup.missingUsageCount).toBe(0);
    expect(rollup.eventCount).toBe(0);
  });
});

describe('accumulateCostEvent', () => {
  it('accumulates token counts and cost', () => {
    const event = makeEvent();
    const rollup = accumulateCostEvent(emptyCostRollup(), event);

    expect(rollup.inputTokens).toBe(1000);
    expect(rollup.outputTokens).toBe(200);
    expect(rollup.cachedTokens).toBe(500);
    expect(rollup.totalTokens).toBe(1200);
    expect(rollup.totalCostUsd).toBe(0.006);
    expect(rollup.eventCount).toBe(1);
  });

  it('counts unknown confidence events', () => {
    const event = makeEvent({
      pricing: { model: 'unknown-model', pricingVersion: '2025-01', estimatedCostUsd: 0, confidence: 'unknown' },
    });
    const rollup = accumulateCostEvent(emptyCostRollup(), event);
    expect(rollup.unknownConfidenceCount).toBe(1);
  });

  it('counts missing usage events (totalTokens === 0)', () => {
    const event = makeEvent({
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 },
    });
    const rollup = accumulateCostEvent(emptyCostRollup(), event);
    expect(rollup.missingUsageCount).toBe(1);
  });

  it('does not mutate the input rollup', () => {
    const initial = emptyCostRollup();
    const event = makeEvent();
    const result = accumulateCostEvent(initial, event);

    expect(initial.eventCount).toBe(0);
    expect(result.eventCount).toBe(1);
  });
});

describe('rollUpCostEvents', () => {
  it('returns empty rollup for empty array', () => {
    const rollup = rollUpCostEvents([]);
    expect(rollup).toEqual(emptyCostRollup());
  });

  it('accumulates multiple events correctly', () => {
    const events = [
      makeEvent({ usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 10, totalTokens: 150 }, pricing: { model: 'm1', pricingVersion: 'v1', estimatedCostUsd: 0.001, confidence: 'exact' } }),
      makeEvent({ usage: { inputTokens: 200, outputTokens: 100, cachedTokens: 20, totalTokens: 300 }, pricing: { model: 'm2', pricingVersion: 'v1', estimatedCostUsd: 0.002, confidence: 'estimated' } }),
      makeEvent({ usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 }, pricing: { model: 'm3', pricingVersion: 'v1', estimatedCostUsd: 0, confidence: 'unknown' } }),
    ];

    const rollup = rollUpCostEvents(events);

    expect(rollup.eventCount).toBe(3);
    expect(rollup.inputTokens).toBe(300);
    expect(rollup.outputTokens).toBe(150);
    expect(rollup.cachedTokens).toBe(30);
    expect(rollup.totalTokens).toBe(450);
    expect(rollup.totalCostUsd).toBeCloseTo(0.003);
    expect(rollup.unknownConfidenceCount).toBe(1);
    expect(rollup.missingUsageCount).toBe(1);
  });
});

describe('export ergonomics', () => {
  it('all types are importable from the cost-types module', () => {
    // This test verifies the import works at the module level.
    // If any type were missing from the export, this file would fail to compile.
    const event: NormalizedCostEvent = makeEvent();
    const rollup: CostRollup = rollUpCostEvents([event]);
    expect(rollup.eventCount).toBe(1);
  });
});
