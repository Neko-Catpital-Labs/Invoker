import { describe, it, expect } from 'vitest';

// We test the internal helpers indirectly via the exported functions.
// For discoverCodexSessionId and findCodexSessionPath, we need to
// override the sessions directory. We'll test parseCodexSessionJsonl
// directly since it's a pure function.

import { parseCodexSessionJsonl, toReadableText, extractCodexSessionId, extractCodexUsage } from '../codex-session.js';

// ── parseCodexSessionJsonl ───────────────────────────────────

describe('parseCodexSessionJsonl', () => {
  it('extracts user messages from event_msg entries', () => {
    const jsonl = [
      JSON.stringify({ timestamp: '2026-03-31T10:00:00Z', type: 'session_meta', payload: { id: 'abc', cwd: '/tmp' } }),
      JSON.stringify({ timestamp: '2026-03-31T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the bug' } }),
    ].join('\n');

    const msgs = parseCodexSessionJsonl(jsonl);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      role: 'user',
      content: 'Fix the bug',
      timestamp: '2026-03-31T10:00:01Z',
    });
  });

  it('extracts assistant messages from response_item entries', () => {
    const jsonl = [
      JSON.stringify({
        timestamp: '2026-03-31T10:00:02Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I found the issue.' }],
        },
      }),
    ].join('\n');

    const msgs = parseCodexSessionJsonl(jsonl);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      role: 'assistant',
      content: 'I found the issue.',
      timestamp: '2026-03-31T10:00:02Z',
    });
  });

  it('extracts user messages from response_item input_text entries', () => {
    const jsonl = [
      JSON.stringify({
        timestamp: '2026-03-31T10:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Please fix lint failures.' }],
        },
      }),
    ].join('\n');

    const msgs = parseCodexSessionJsonl(jsonl);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      role: 'user',
      content: 'Please fix lint failures.',
      timestamp: '2026-03-31T10:00:01Z',
    });
  });

  it('joins multiple output_text blocks with newline', () => {
    const jsonl = JSON.stringify({
      timestamp: '2026-03-31T10:00:02Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'First part.' },
          { type: 'output_text', text: 'Second part.' },
        ],
      },
    });

    const msgs = parseCodexSessionJsonl(jsonl);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('First part.\nSecond part.');
  });

  it('skips developer messages, function_call, reasoning, and token_count entries', () => {
    const lines = [
      JSON.stringify({ timestamp: 'ts1', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system prompt' }] } }),
      JSON.stringify({ timestamp: 'ts2', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } }),
      JSON.stringify({ timestamp: 'ts3', type: 'response_item', payload: { type: 'reasoning' } }),
      JSON.stringify({ timestamp: 'ts4', type: 'event_msg', payload: { type: 'token_count', count: 100 } }),
      JSON.stringify({ timestamp: 'ts5', type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ timestamp: 'ts6', type: 'event_msg', payload: { type: 'task_complete' } }),
      JSON.stringify({ timestamp: 'ts7', type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } }),
    ];

    const msgs = parseCodexSessionJsonl(lines.join('\n'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('Hello');
  });

  it('handles full realistic Codex session', () => {
    const lines = [
      JSON.stringify({ timestamp: 'ts0', type: 'session_meta', payload: { id: '019d', cwd: '/repo' } }),
      JSON.stringify({ timestamp: 'ts1', type: 'event_msg', payload: { type: 'task_started', turn_id: 'abc' } }),
      JSON.stringify({ timestamp: 'ts2', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'permissions' }] } }),
      JSON.stringify({ timestamp: 'ts3', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'env' }] } }),
      JSON.stringify({ timestamp: 'ts4', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the merge conflict' } }),
      JSON.stringify({ timestamp: 'ts5', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking at the conflicted files.' }] } }),
      JSON.stringify({ timestamp: 'ts6', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"cat file.ts"}' } }),
      JSON.stringify({ timestamp: 'ts7', type: 'event_msg', payload: { type: 'agent_message' } }),
      JSON.stringify({ timestamp: 'ts8', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the conflict.' }] } }),
      JSON.stringify({ timestamp: 'ts9', type: 'event_msg', payload: { type: 'task_complete' } }),
    ];

    const msgs = parseCodexSessionJsonl(lines.join('\n'));
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toEqual({ role: 'user', content: 'env', timestamp: 'ts3' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'Fix the merge conflict', timestamp: 'ts4' });
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'Looking at the conflicted files.', timestamp: 'ts5' });
    expect(msgs[3]).toEqual({ role: 'assistant', content: 'Fixed the conflict.', timestamp: 'ts8' });
  });

  it('extracts assistant messages from item.completed agent_message format', () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: '019d5193-197f-79a2-8e37-3551f55b67e7' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'agent_message',
          text: 'I will inspect the repository state first.',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: 'The merge itself succeeded; PR creation failed with 422.',
        },
      }),
    ];

    const msgs = parseCodexSessionJsonl(lines.join('\n'));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({
      role: 'assistant',
      content: 'I will inspect the repository state first.',
      timestamp: '',
    });
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: 'The merge itself succeeded; PR creation failed with 422.',
      timestamp: '',
    });
  });

  it('normalizes mixed newer and older formats in encounter order', () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: '019d5193-197f-79a2-8e37-3551f55b67e7' }),
      JSON.stringify({
        timestamp: 'ts1',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Fix test failures.' }],
        },
      }),
      JSON.stringify({
        timestamp: 'ts2',
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'agent_message',
          text: 'I am inspecting the failing test first.',
        },
      }),
      JSON.stringify({
        timestamp: 'ts3',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Updated assertions and reran tests.' }],
        },
      }),
    ];

    const msgs = parseCodexSessionJsonl(lines.join('\n'));
    expect(msgs).toEqual([
      { role: 'user', content: 'Fix test failures.', timestamp: 'ts1' },
      { role: 'assistant', content: 'I am inspecting the failing test first.', timestamp: 'ts2' },
      { role: 'assistant', content: 'Updated assertions and reran tests.', timestamp: 'ts3' },
    ]);
  });

  it('skips malformed lines gracefully', () => {
    const lines = [
      'not json',
      '',
      JSON.stringify({ timestamp: 'ts1', type: 'event_msg', payload: { type: 'user_message', message: 'Valid' } }),
      '{"incomplete',
    ];

    const msgs = parseCodexSessionJsonl(lines.join('\n'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('Valid');
  });

  it('returns empty array for empty input', () => {
    expect(parseCodexSessionJsonl('')).toEqual([]);
    expect(parseCodexSessionJsonl('\n\n')).toEqual([]);
  });
});

// ── extractCodexSessionId ───────────────────────────────────

describe('extractCodexSessionId', () => {
  it('returns thread_id from thread.started line (codex 0.117+ format)', () => {
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: '019d5086-675d-7823-b866-ac320c5d689f' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } }),
    ].join('\n');

    expect(extractCodexSessionId(jsonl)).toBe('019d5086-675d-7823-b866-ac320c5d689f');
  });

  it('returns undefined when no thread.started present', () => {
    const jsonl = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } }),
    ].join('\n');

    expect(extractCodexSessionId(jsonl)).toBeUndefined();
  });

  it('returns undefined for thread.started without thread_id', () => {
    const jsonl = JSON.stringify({ type: 'thread.started' });
    expect(extractCodexSessionId(jsonl)).toBeUndefined();
  });

  it('handles malformed lines gracefully', () => {
    const jsonl = [
      'not json',
      '',
      JSON.stringify({ type: 'thread.started', thread_id: 'real-thread-id' }),
    ].join('\n');

    expect(extractCodexSessionId(jsonl)).toBe('real-thread-id');
  });

  it('returns undefined for empty input', () => {
    expect(extractCodexSessionId('')).toBeUndefined();
    expect(extractCodexSessionId('\n\n')).toBeUndefined();
  });
});

describe('toReadableText', () => {
  it('converts JSONL with user and assistant messages to readable text', () => {
    const jsonl = [
      JSON.stringify({ timestamp: 'ts1', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the bug' } }),
      JSON.stringify({ timestamp: 'ts2', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I fixed the bug.' }] } }),
    ].join('\n');

    const text = toReadableText(jsonl);
    expect(text).toBe('[user] Fix the bug\n[assistant] I fixed the bug.');
  });

  it('handles malformed lines gracefully', () => {
    const jsonl = [
      'not json',
      JSON.stringify({ timestamp: 'ts1', type: 'event_msg', payload: { type: 'user_message', message: 'Valid' } }),
    ].join('\n');

    const text = toReadableText(jsonl);
    expect(text).toBe('[user] Valid');
  });

  it('returns empty string for empty input', () => {
    expect(toReadableText('')).toBe('');
  });
});

// ── extractCodexUsage ───────────────────────────────────────

describe('extractCodexUsage', () => {
  it('extracts usage from turn.completed events', () => {
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({ type: 'turn.completed', timestamp: '2026-01-01T00:00:00Z', model: 'o3-mini', usage: { input_tokens: 500, output_tokens: 200 } }),
    ].join('\n');

    const events = extractCodexUsage(jsonl);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      eventId: 'codex-turn-2',
      timestamp: '2026-01-01T00:00:00Z',
      model: 'o3-mini',
      inputTokens: 500,
      outputTokens: 200,
      cachedTokens: 0,
      totalTokens: 700,
      confidence: 'exact',
    });
  });

  it('extracts usage from thread.completed events', () => {
    const jsonl = JSON.stringify({
      type: 'thread.completed',
      timestamp: '2026-01-01T00:01:00Z',
      usage: { input_tokens: 1000, output_tokens: 400, cached_tokens: 100 },
    });

    const events = extractCodexUsage(jsonl);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      eventId: 'codex-thread-1',
      timestamp: '2026-01-01T00:01:00Z',
      model: '',
      inputTokens: 1000,
      outputTokens: 400,
      cachedTokens: 100,
      totalTokens: 1400,
      confidence: 'exact',
    });
  });

  it('extracts token_count events with estimated confidence', () => {
    const jsonl = JSON.stringify({
      timestamp: 'ts1',
      type: 'event_msg',
      payload: { type: 'token_count', count: 150 },
    });

    const events = extractCodexUsage(jsonl);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      eventId: 'codex-token-count-1',
      timestamp: 'ts1',
      model: '',
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 150,
      confidence: 'estimated',
    });
  });

  it('extracts multiple usage events from a mixed stream', () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({ timestamp: 'ts1', type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } }),
      JSON.stringify({ timestamp: 'ts2', type: 'event_msg', payload: { type: 'token_count', count: 50 } }),
      JSON.stringify({ timestamp: 'ts3', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi there.' }] } }),
      JSON.stringify({ timestamp: 'ts4', type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 80 } }),
    ];

    const events = extractCodexUsage(lines.join('\n'));
    expect(events).toHaveLength(2);
    expect(events[0].confidence).toBe('estimated');
    expect(events[0].totalTokens).toBe(50);
    expect(events[1].confidence).toBe('exact');
    expect(events[1].inputTokens).toBe(200);
    expect(events[1].outputTokens).toBe(80);
  });

  it('returns empty array when no usage events are present', () => {
    const jsonl = [
      JSON.stringify({ timestamp: 'ts1', type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } }),
      JSON.stringify({ timestamp: 'ts2', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] } }),
    ].join('\n');

    expect(extractCodexUsage(jsonl)).toEqual([]);
  });

  it('skips malformed lines gracefully', () => {
    const lines = [
      'not json',
      '',
      JSON.stringify({ type: 'turn.completed', timestamp: 'ts1', usage: { input_tokens: 10, output_tokens: 5 } }),
      '{"incomplete',
    ];

    const events = extractCodexUsage(lines.join('\n'));
    expect(events).toHaveLength(1);
    expect(events[0].inputTokens).toBe(10);
  });

  it('returns empty array for empty input', () => {
    expect(extractCodexUsage('')).toEqual([]);
    expect(extractCodexUsage('\n\n')).toEqual([]);
  });

  it('handles turn.completed without usage object', () => {
    const jsonl = JSON.stringify({ type: 'turn.completed', timestamp: 'ts1' });
    expect(extractCodexUsage(jsonl)).toEqual([]);
  });

  it('does not affect parseCodexSessionJsonl output (backward compat)', () => {
    // This test proves usage extraction is additive — the existing message
    // parsing remains identical with or without usage events in the stream.
    const lines = [
      JSON.stringify({ timestamp: 'ts1', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the bug' } }),
      JSON.stringify({ timestamp: 'ts2', type: 'event_msg', payload: { type: 'token_count', count: 100 } }),
      JSON.stringify({ timestamp: 'ts3', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] } }),
      JSON.stringify({ timestamp: 'ts4', type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 200 } }),
    ];
    const raw = lines.join('\n');

    // Messages remain the same — token_count and turn.completed are still skipped by parseCodexSessionJsonl
    const msgs = parseCodexSessionJsonl(raw);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'Fix the bug', timestamp: 'ts1' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'Fixed.', timestamp: 'ts3' });

    // Usage is extracted separately
    const usage = extractCodexUsage(raw);
    expect(usage).toHaveLength(2);
    expect(usage[0].confidence).toBe('estimated');
    expect(usage[1].confidence).toBe('exact');
  });
});
