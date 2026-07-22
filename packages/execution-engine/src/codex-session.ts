/**
 * Codex session JSONL parsing.
 *
 * Pure parsing module — no filesystem access.
 * Storage and retrieval are handled by CodexSessionDriver.
 */

import type { SessionUsageEvent } from './session-driver.js';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/**
 * Parse a Codex session JSONL string into conversation messages.
 *
 * Codex JSONL format (observed):
 *   - type=event_msg, payload.type=user_message → user content
 *   - type=response_item, payload.type=message, payload.role=assistant → assistant content
 *   - Skips: function_call, function_call_output, reasoning, token_count,
 *            task_started, task_complete, developer role messages
 */
export function parseCodexSessionJsonl(raw: string): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const ts: string = entry.timestamp ?? '';
      const payload = entry.payload;
      const push = (role: 'user' | 'assistant', content: string): void => {
        if (!content) return;
        messages.push({ role, content, timestamp: ts });
      };

      // Newer Codex format (e.g. 0.117+): item.completed / agent_message
      // Example:
      // {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
      if (entry.type === 'item.completed' && entry.item) {
        const item = entry.item;
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          push('assistant', item.text);
          continue;
        }
        if (item.type === 'user_message') {
          const userText = typeof item.text === 'string'
            ? item.text
            : typeof item.message === 'string'
              ? item.message
              : '';
          push('user', userText);
          continue;
        }
      }

      if (!payload) continue;

      // User messages
      if (entry.type === 'event_msg' && payload.type === 'user_message') {
        const content = typeof payload.message === 'string'
          ? payload.message
          : JSON.stringify(payload.message);
        push('user', content);
        continue;
      }

      // User messages (response_item user blocks)
      if (
        entry.type === 'response_item'
        && payload.type === 'message'
        && payload.role === 'user'
      ) {
        const blocks = Array.isArray(payload.content) ? payload.content : [];
        const text = blocks
          .filter((b: any) => typeof b === 'string' || b?.type === 'input_text')
          .map((b: any) => typeof b === 'string' ? b : b.text ?? '')
          .join('\n');
        push('user', text);
        continue;
      }

      // Assistant messages
      if (
        entry.type === 'response_item'
        && payload.type === 'message'
        && payload.role === 'assistant'
      ) {
        const blocks = Array.isArray(payload.content) ? payload.content : [];
        const text = blocks
          .filter((b: any) => typeof b === 'string' || b?.type === 'output_text')
          .map((b: any) => typeof b === 'string' ? b : b.text ?? '')
          .join('\n');
        push('assistant', text);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return messages;
}

/**
 * Extract the real Codex thread ID from raw JSONL output.
 *
 * Codex CLI (v0.117+) emits `{"type":"thread.started","thread_id":"<uuid>"}` as the
 * first JSONL line. This thread ID is required for `codex exec resume`.
 */
export function extractCodexSessionId(raw: string): string | undefined {
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Current format (codex-cli 0.117+): {"type":"thread.started","thread_id":"..."}
      if (entry.type === 'thread.started' && entry.thread_id) {
        return entry.thread_id;
      }
    } catch { /* skip */ }
  }
  return undefined;
}

export function toReadableText(raw: string): string {
  const messages = parseCodexSessionJsonl(raw);
  return messages.map(m => `[${m.role}] ${m.content}`).join('\n');
}

export interface CodexPlannerStdout {
  message: string;
  reasoning: string[];
}

const CODEX_JSONL_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
  'event_msg',
  'response_item',
  'session_meta',
]);

export function looksLikeCodexJsonl(raw: string): boolean {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (
        entry
        && typeof entry === 'object'
        && typeof entry.type === 'string'
        && CODEX_JSONL_EVENT_TYPES.has(entry.type)
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

export function formatCodexPlannerStdout(raw: string): CodexPlannerStdout {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { message: '', reasoning: [] };
  }
  if (!looksLikeCodexJsonl(trimmed)) {
    return { message: trimmed, reasoning: [] };
  }

  const reasoning: string[] = [];
  const messages: string[] = [];

  for (const line of trimmed.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'item.completed' && entry.item) {
        const item = entry.item;
        if (item.type === 'reasoning' && typeof item.text === 'string' && item.text.trim()) {
          reasoning.push(item.text.trim());
          continue;
        }
        if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
          messages.push(item.text.trim());
          continue;
        }
      }

      const payload = entry.payload;
      if (
        entry.type === 'response_item'
        && payload?.type === 'message'
        && payload.role === 'assistant'
      ) {
        const blocks: Array<string | { type?: string; text?: string }> =
          Array.isArray(payload.content) ? payload.content : [];
        const text = blocks
          .filter((b) => typeof b === 'string' || b?.type === 'output_text')
          .map((b) => typeof b === 'string' ? b : b.text ?? '')
          .join('\n')
          .trim();
        if (text) messages.push(text);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    message: messages.at(-1) ?? '',
    reasoning,
  };
}

/**
 * Extract usage events from Codex session JSONL.
 *
 * Codex emits usage data in several forms:
 *   - turn.completed with usage: { input_tokens, output_tokens, ... }
 *   - event_msg with payload.type === 'token_count'
 *
 * When explicit usage is absent, returns an empty array (callers may
 * emit an unknown-confidence placeholder upstream if needed).
 */
export function extractCodexUsage(raw: string): SessionUsageEvent[] {
  const events: SessionUsageEvent[] = [];
  let lineIndex = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    lineIndex++;
    try {
      const entry = JSON.parse(line);
      const ts: string = entry.timestamp ?? '';

      // turn.completed carries aggregate usage for the turn
      if (entry.type === 'turn.completed' && entry.usage) {
        const u = entry.usage;
        const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
        const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
        const cached = typeof u.cached_tokens === 'number' ? u.cached_tokens : 0;
        events.push({
          eventId: `codex-turn-${lineIndex}`,
          timestamp: ts,
          model: typeof entry.model === 'string' ? entry.model : '',
          inputTokens: input,
          outputTokens: output,
          cachedTokens: cached,
          totalTokens: input + output,
          confidence: 'exact',
        });
        continue;
      }

      // thread.completed may also carry usage
      if (entry.type === 'thread.completed' && entry.usage) {
        const u = entry.usage;
        const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
        const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
        const cached = typeof u.cached_tokens === 'number' ? u.cached_tokens : 0;
        events.push({
          eventId: `codex-thread-${lineIndex}`,
          timestamp: ts,
          model: typeof entry.model === 'string' ? entry.model : '',
          inputTokens: input,
          outputTokens: output,
          cachedTokens: cached,
          totalTokens: input + output,
          confidence: 'exact',
        });
        continue;
      }

      // event_msg token_count — partial/incremental count
      const payload = entry.payload;
      if (
        entry.type === 'event_msg'
        && payload?.type === 'token_count'
        && typeof payload.count === 'number'
      ) {
        events.push({
          eventId: `codex-token-count-${lineIndex}`,
          timestamp: ts,
          model: '',
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: payload.count,
          confidence: 'estimated',
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}
