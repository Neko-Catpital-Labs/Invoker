/**
 * Slack Command Parser — Converts slash command text into ConversationCommand objects.
 *
 * Pure function. No Slack SDK dependency. Easy to test.
 *
 * Supported commands:
 *   /invoker conversations list
 *   /invoker conversations clear <thread_ts>
 *   /invoker conversations cleanup <days>
 *   /invoker conversations status <thread_ts>
 *   /invoker conversations metrics
 *   /invoker conversations inspect <thread_ts>
 */

// ── Conversation Admin Commands (surface-internal, not dispatched to orchestrator) ──

export type ConversationCommand =
  | { type: 'conversations_list' }
  | { type: 'conversations_clear'; threadTs: string }
  | { type: 'conversations_cleanup'; olderThanDays: number }
  | { type: 'conversations_status'; threadTs: string }
  | { type: 'conversations_metrics' }
  | { type: 'conversations_inspect'; threadTs: string };

export type ParseResult =
  | { ok: true; command: ConversationCommand }
  | { ok: false; error: string };

/**
 * Parse a slash command text string into a ConversationCommand.
 * The text is everything after `/invoker ` — e.g. "conversations list".
 */
export function parseSlackCommand(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: 'Usage: /invoker conversations <list|clear|cleanup|status|metrics|inspect> [args]' };
  }

  const parts = trimmed.split(/\s+/);
  const subcommand = parts[0].toLowerCase();

  switch (subcommand) {
    case 'conversations':
      return parseConversationsSubcommand(parts.slice(1));

    default:
      return { ok: false, error: `Unknown command: "${subcommand}". Only conversation admin commands are supported.\n\nFor natural language requests, @mention the bot instead of using /invoker.` };
  }
}

// ── Conversations Subcommand Parser ───────────────────────

function parseConversationsSubcommand(parts: string[]): ParseResult {
  const sub = parts[0]?.toLowerCase();
  if (!sub) {
    return {
      ok: false,
      error: 'Usage: /invoker conversations <list|clear|cleanup|status|metrics|inspect> [args]',
    };
  }

  switch (sub) {
    case 'list':
      return { ok: true, command: { type: 'conversations_list' } };

    case 'clear': {
      const threadTs = parts[1];
      if (!threadTs) {
        return { ok: false, error: 'Usage: /invoker conversations clear <thread_ts>' };
      }
      return { ok: true, command: { type: 'conversations_clear', threadTs } };
    }

    case 'cleanup': {
      const daysStr = parts[1];
      if (!daysStr) {
        return { ok: false, error: 'Usage: /invoker conversations cleanup <days>' };
      }
      const days = parseInt(daysStr, 10);
      if (isNaN(days) || days <= 0) {
        return { ok: false, error: `Invalid days value: "${daysStr}". Must be a positive integer.` };
      }
      return { ok: true, command: { type: 'conversations_cleanup', olderThanDays: days } };
    }

    case 'status': {
      const threadTs = parts[1];
      if (!threadTs) {
        return { ok: false, error: 'Usage: /invoker conversations status <thread_ts>' };
      }
      return { ok: true, command: { type: 'conversations_status', threadTs } };
    }

    case 'metrics':
      return { ok: true, command: { type: 'conversations_metrics' } };

    case 'inspect': {
      const threadTs = parts[1];
      if (!threadTs) {
        return { ok: false, error: 'Usage: /invoker conversations inspect <thread_ts>' };
      }
      return { ok: true, command: { type: 'conversations_inspect', threadTs } };
    }

    default:
      return {
        ok: false,
        error: `Unknown conversations subcommand: "${sub}". Available: list, clear, cleanup, status, metrics, inspect.`,
      };
  }
}
