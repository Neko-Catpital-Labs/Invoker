import { describe, it, expect } from 'vitest';
import { formatCodexPlannerStdout, looksLikeCodexJsonl } from '../codex-session.js';

describe('formatCodexPlannerStdout', () => {
  it('extracts agent_message and drops lifecycle events', () => {
    const raw = [
      JSON.stringify({ type: 'thread.started', thread_id: '019f4d62-a2bc-7893-80a1-69b2c94e0fa5' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'agent_message',
          text: 'Hello. Tell me what you want Invoker to plan, and I’ll scope it against the repo before drafting YAML.',
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 18085,
          cached_input_tokens: 13696,
          output_tokens: 164,
          reasoning_output_tokens: 134,
        },
      }),
    ].join('\n');

    const formatted = formatCodexPlannerStdout(raw);
    expect(formatted.reasoning).toEqual([]);
    expect(formatted.message).toBe(
      'Hello. Tell me what you want Invoker to plan, and I’ll scope it against the repo before drafting YAML.',
    );
    expect(formatted.message).not.toContain('thread.started');
  });

  it('extracts reasoning summaries and agent_message', () => {
    const raw = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'reasoning', text: '**Scanning the repo for planning context**' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'reasoning', text: 'User said hello — greet and ask what to plan.' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_2', type: 'agent_message', text: 'Hello. What should we plan?' },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }),
    ].join('\n');

    const formatted = formatCodexPlannerStdout(raw);
    expect(formatted.reasoning).toEqual([
      '**Scanning the repo for planning context**',
      'User said hello — greet and ask what to plan.',
    ]);
    expect(formatted.message).toBe('Hello. What should we plan?');
  });

  it('passes through plain-text planner output unchanged', () => {
    const prose = 'I can help draft that.\n\nWhat should we build?';
    expect(looksLikeCodexJsonl(prose)).toBe(false);
    expect(formatCodexPlannerStdout(prose)).toEqual({
      message: prose,
      reasoning: [],
    });
  });

  it('returns only the final agent_message', () => {
    const raw = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'First part.' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Second part.' },
      }),
    ].join('\n');

    expect(formatCodexPlannerStdout(raw).message).toBe('Second part.');
  });

  it('finds Codex JSONL after a non-JSON preamble', () => {
    const raw = [
      'Codex CLI v1.0',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'reasoning', text: 'Inspecting the repository.' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'The final answer.' },
      }),
    ].join('\n');

    expect(looksLikeCodexJsonl(raw)).toBe(true);
    expect(formatCodexPlannerStdout(raw)).toEqual({
      message: 'The final answer.',
      reasoning: ['Inspecting the repository.'],
    });
  });
});
