/**
 * Codex session JSONL parsing.
 *
 * Pure parsing module — no filesystem access.
 * Storage and retrieval are handled by CodexSessionDriver.
 */

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
