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
      if (!payload) continue;

      // User messages
      if (entry.type === 'event_msg' && payload.type === 'user_message') {
        const content = typeof payload.message === 'string'
          ? payload.message
          : JSON.stringify(payload.message);
        if (content) {
          messages.push({ role: 'user', content, timestamp: ts });
        }
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
        if (text) {
          messages.push({ role: 'assistant', content: text, timestamp: ts });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  return messages;
}

/**
 * Convert raw Codex JSONL to human-readable text.
 *
 * Extracts user_message and assistant output_text entries,
 * formats as `[user] ...` and `[assistant] ...` lines.
 */
export function toReadableText(raw: string): string {
  const messages = parseCodexSessionJsonl(raw);
  return messages.map(m => `[${m.role}] ${m.content}`).join('\n');
}
