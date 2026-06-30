/**
 * Lobby command parser — deterministic verb grammar for lobby/DM mentions and
 * the `/invoker` slash command. Mirrors `parseWorkflowControl` (workflow channels)
 * but for lobby-scoped verbs: workflow operations and plan submission.
 *
 * Pure function, no Slack SDK. Returns `null` for anything that isn't an
 * unambiguous command, so the caller falls through to conversation.
 */

import type { WorkflowGatePolicy, WorkflowGatePolicyUpdate, WorkflowOpName } from '../surface.js';

export type LobbyControl =
  | { kind: 'op'; operation: WorkflowOpName; target: { all: true } | { workflow: string } }
  | { kind: 'gate-policy'; target: { workflow: string }; updates: WorkflowGatePolicyUpdate[] }
  | { kind: 'submit' }
  | { kind: 'restart' };

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

function parseGatePolicy(rest: string): Extract<LobbyControl, { kind: 'gate-policy' }> | null {
  const withoutPolicy = rest.trim().replace(/[.!?]+$/, '').trim();
  let gatePolicy: WorkflowGatePolicy;
  let argsText: string;

  const reviewReady = /\s+review[-_\s]+ready$/i.exec(withoutPolicy);
  if (reviewReady) {
    gatePolicy = 'review_ready';
    argsText = withoutPolicy.slice(0, reviewReady.index).trim();
  } else {
    const completed = /\s+completed$/i.exec(withoutPolicy);
    if (!completed) return null;
    gatePolicy = 'completed';
    argsText = withoutPolicy.slice(0, completed.index).trim();
  }

  const args = argsText.split(/\s+/).filter(Boolean);
  if (args.length < 2 || args.length > 3) return null;
  if (!args.every((arg) => TARGET_TOKEN.test(arg))) return null;

  const [downstreamWorkflow, upstreamWorkflowToken, upstreamTaskToken] = args;
  const update = parseGatePolicyUpdate(upstreamWorkflowToken, upstreamTaskToken, gatePolicy);
  if (!update) return null;

  return { kind: 'gate-policy', target: { workflow: downstreamWorkflow }, updates: [update] };
}

function parseGatePolicyUpdate(
  upstreamWorkflowToken: string,
  upstreamTaskToken: string | undefined,
  gatePolicy: WorkflowGatePolicy,
): WorkflowGatePolicyUpdate | null {
  if (upstreamWorkflowToken.includes('/')) {
    if (upstreamTaskToken) return null;
    const [workflowId, taskId, ...extra] = upstreamWorkflowToken.split('/');
    if (!workflowId || !taskId || extra.length > 0) return null;
    return { workflowId, taskId, gatePolicy };
  }

  return upstreamTaskToken
    ? { workflowId: upstreamWorkflowToken, taskId: upstreamTaskToken, gatePolicy }
    : { workflowId: upstreamWorkflowToken, gatePolicy };
}

/**
 * Parse a lobby command. Recognizes:
 *   - `submit` / `submit to invoker`
 *   - `restart` / `restart invoker`
 *   - `<op> all` / `<op> <workflow-id-or-name>`  (op ∈ recreate|rebase|rebase-recreate|rebase-retry|retry|cancel|status)
 *   - `gate-policy <downstream-workflow> <upstream-workflow>[/<upstream-task>] <completed|review_ready>`
 *   - `status` with no target → all workflows
 * Returns null for missing/ambiguous targets and for prose, so the message is
 * treated as conversation (or routed to the classifier fallback).
 */
export function parseLobbyControl(text: string): LobbyControl | null {
  const trimmed = text.trim();

  if (/^submit(\s+to\s+invoker)?\s*[.!?]*$/i.test(trimmed)) return { kind: 'submit' };
  if (/^restart(\s+(invoker|the\s+invoker|app|the\s+app|gui|the\s+gui))?\s*[.!?]*$/i.test(trimmed)) return { kind: 'restart' };

  const gatePolicy = /^(?:set\s+)?gate[-\s]+policy\b([\s\S]*)$/i.exec(trimmed);
  if (gatePolicy) return parseGatePolicy(gatePolicy[1]);

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
