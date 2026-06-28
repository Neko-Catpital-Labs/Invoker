/**
 * Lobby command parser — deterministic verb grammar for lobby/DM mentions and
 * the `/invoker` slash command. Mirrors `parseWorkflowControl` (workflow channels)
 * but for lobby-scoped verbs: workflow operations and plan submission.
 *
 * Pure function, no Slack SDK. Returns `null` for anything that isn't an
 * unambiguous command, so the caller falls through to conversation.
 */

import type { WorkflowOpName } from '../surface.js';

export type LobbyControl =
  | { kind: 'op'; operation: WorkflowOpName; target: { all: true } | { workflow: string } }
  | { kind: 'submit' };

// Verb spellings → canonical operation. Bare `rebase` means recreate-after-rebase.
const OP_ALIASES: Record<string, WorkflowOpName> = {
  status: 'status',
  recreate: 'recreate',
  rebase: 'rebase-recreate',
  'rebase-recreate': 'rebase-recreate',
  'rebase-retry': 'rebase-retry',
  retry: 'retry',
  cancel: 'cancel',
};

const VERB_PATTERN = /^(rebase-recreate|rebase-retry|recreate|rebase|retry|cancel|status)\b([\s\S]*)$/i;
const TARGET_TOKEN = /^[\w./-]+$/;

/**
 * Parse a lobby command. Recognizes:
 *   - `submit` / `submit to invoker`
 *   - `<op> all` / `<op> <workflow-id-or-name>`  (op ∈ recreate|rebase|rebase-recreate|rebase-retry|retry|cancel|status)
 *   - `status` with no target → all workflows
 * Returns null for missing/ambiguous targets and for prose, so the message is
 * treated as conversation (or routed to the classifier fallback).
 */
export function parseLobbyControl(text: string): LobbyControl | null {
  const trimmed = text.trim();

  if (/^submit(\s+to\s+invoker)?\s*[.!?]*$/i.test(trimmed)) return { kind: 'submit' };

  const match = VERB_PATTERN.exec(trimmed);
  if (!match) return null;

  const operation = OP_ALIASES[match[1].toLowerCase()];
  const rest = match[2].trim().replace(/[.!?]+$/, '').trim();

  if (/^all(\s+workflows?)?$/i.test(rest)) return { kind: 'op', operation, target: { all: true } };

  if (rest === '') {
    // Status defaults to all; a bare mutation verb is ambiguous → not a command.
    return operation === 'status' ? { kind: 'op', operation, target: { all: true } } : null;
  }

  // A single id/name token is a concrete target; prose is not a command.
  if (TARGET_TOKEN.test(rest)) return { kind: 'op', operation, target: { workflow: rest } };

  return null;
}
