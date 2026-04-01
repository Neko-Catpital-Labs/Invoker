import { describe, it, expect } from 'vitest';

// We test the internal helpers indirectly via the exported functions.
// For discoverCodexSessionId and findCodexSessionPath, we need to
// override the sessions directory. We'll test parseCodexSessionJsonl
// directly since it's a pure function.

import { parseCodexSessionJsonl, toReadableText } from '../codex-session.js';

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
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: 'user', content: 'Fix the merge conflict', timestamp: 'ts4' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'Looking at the conflicted files.', timestamp: 'ts5' });
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'Fixed the conflict.', timestamp: 'ts8' });
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
