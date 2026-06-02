import type { WorkflowMutationIntent } from '@invoker/data-store';

/**
 * Token carried by a headless `fix` command (and the resulting
 * `headless.exec` mutation intent args) to mark the submission as an
 * automatic fix rather than a manual right-click "Fix with AI". Its presence
 * is the explicit, typed auto-fix context: it opts the request into
 * retry-budget gating, attempt accounting, and auto-fix labels/log events.
 * Manual submissions never carry it, so manual right-click semantics are
 * unchanged.
 */
export const AUTO_FIX_FLAG = '--auto-fix';

export interface ParsedFixCommand {
  /** Target task id (first non-flag positional token). */
  taskId?: string;
  /** Optional agent name (second non-flag positional token). */
  agentName?: string;
  /** Whether the explicit auto-fix context flag was present. */
  autoFix: boolean;
}

/**
 * Parse the tokens that follow the `fix` keyword (`[taskId, agentName?]` plus
 * an optional {@link AUTO_FIX_FLAG} in any position) into a typed shape. The
 * flag is order-independent so both `fix <taskId> --auto-fix` and
 * `fix <taskId> claude --auto-fix` are accepted.
 */
export function parseFixCommandTokens(tokens: readonly (string | undefined)[]): ParsedFixCommand {
  let taskId: string | undefined;
  let agentName: string | undefined;
  let autoFix = false;
  for (const token of tokens) {
    if (token === undefined) continue;
    if (token === AUTO_FIX_FLAG) {
      autoFix = true;
      continue;
    }
    if (taskId === undefined) {
      taskId = token;
    } else if (agentName === undefined) {
      agentName = token;
    }
  }
  return { taskId, agentName, autoFix };
}

type HeadlessExecPayload = {
  args?: unknown[];
};

function getHeadlessExecArgs(intent: WorkflowMutationIntent): unknown[] {
  if (intent.channel !== 'headless.exec') {
    return [];
  }
  const payload = intent.args[0] as HeadlessExecPayload | undefined;
  return Array.isArray(payload?.args) ? payload.args : [];
}

/**
 * Whether an open mutation intent carries the explicit auto-fix context. Only
 * `headless.exec fix` intents can carry it; manual `invoker:fix-with-agent`
 * intents are always manual and therefore never report `true`.
 */
export function intentCarriesAutoFixContext(intent: WorkflowMutationIntent): boolean {
  const args = getHeadlessExecArgs(intent);
  if (args[0] !== 'fix') return false;
  return args.slice(1).includes(AUTO_FIX_FLAG);
}

export function isFixIntentForTask(intent: WorkflowMutationIntent, taskId: string): boolean {
  if (intent.channel === 'invoker:fix-with-agent') {
    return typeof intent.args[0] === 'string' && intent.args[0] === taskId;
  }

  const args = getHeadlessExecArgs(intent);
  return args[0] === 'fix' && typeof args[1] === 'string' && args[1] === taskId;
}

export function listOpenFixIntentsForTask(
  intents: WorkflowMutationIntent[],
  taskId: string,
): WorkflowMutationIntent[] {
  return intents.filter((intent) => isFixIntentForTask(intent, taskId));
}

export type FixSubmissionDecision =
  | { accepted: true }
  | {
      accepted: false;
      reason: 'duplicate-open-intent' | 'should-not-auto-fix';
      openIntentIds: number[];
    };

/**
 * Centralized acceptance check for a new fix request. Duplicate suppression is
 * applied to both the `invoker:fix-with-agent` and `headless.exec fix` intent
 * shapes (via {@link listOpenFixIntentsForTask}): if any open fix intent for
 * the target task already exists, a new auto-fix submission is skipped so the
 * route stays idempotent. The intent that is currently executing this very
 * submission can be excluded via `excludeIntentId` so a request never
 * suppresses itself. When `autoFix` is set, the request is additionally gated
 * on `shouldAutoFix` (retry budget / eligibility).
 */
export function evaluateFixSubmission(input: {
  taskId: string;
  autoFix: boolean;
  openIntents: WorkflowMutationIntent[];
  excludeIntentId?: number;
  shouldAutoFix?: boolean;
}): FixSubmissionDecision {
  const openForTask = listOpenFixIntentsForTask(input.openIntents, input.taskId)
    .filter((intent) => intent.id !== input.excludeIntentId);
  if (openForTask.length > 0) {
    return {
      accepted: false,
      reason: 'duplicate-open-intent',
      openIntentIds: openForTask.map((intent) => intent.id),
    };
  }
  if (input.autoFix && input.shouldAutoFix === false) {
    return { accepted: false, reason: 'should-not-auto-fix', openIntentIds: [] };
  }
  return { accepted: true };
}

