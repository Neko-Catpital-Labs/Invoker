import type { WorkflowMutationIntent } from '@invoker/data-store';
import type { ReviewGateCiFailureTrigger } from '@invoker/execution-engine';

type HeadlessExecPayload = {
  args?: unknown[];
};

export const AUTO_FIX_FLAG = '--auto-fix';
export const REVIEW_GATE_CI_FLAG = '--review-gate-ci';

const FIX_USAGE = 'fix <taskId> [claude|codex] [--auto-fix] [--review-gate-ci <context>]';

/**
 * Structured options carried as the third arg of `invoker:fix-with-agent`
 * mutations. `autoFix` marks the request as auto-fix-initiated so the
 * accepted command boundary bumps `autoFixAttempts`; manual fixes omit it
 * and never consume retry budget. `reviewGateCi` carries the CI failure
 * trigger for review-gate auto-fixes.
 */
export type FixWithAgentMutationOptions = {
  autoFix?: boolean;
  reviewGateCi?: ReviewGateCiFailureTrigger;
};

function validateReviewGateCiContext(value: unknown): ReviewGateCiFailureTrigger {
  const trigger = value as Partial<ReviewGateCiFailureTrigger> | null | undefined;
  if (
    !trigger
    || typeof trigger !== 'object'
    || Array.isArray(trigger)
    || typeof trigger.taskId !== 'string' || trigger.taskId.length === 0
    || typeof trigger.workflowId !== 'string' || trigger.workflowId.length === 0
    || typeof trigger.reviewId !== 'string' || trigger.reviewId.length === 0
    || typeof trigger.reviewUrl !== 'string'
    || typeof trigger.generation !== 'number'
    || !Array.isArray(trigger.failedChecks)
    || typeof trigger.statusText !== 'string'
  ) {
    throw new Error('Invalid review-gate CI context for fix command');
  }
  return trigger as ReviewGateCiFailureTrigger;
}

export function parseFixWithAgentMutationOptions(value: unknown): FixWithAgentMutationOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const raw = value as { autoFix?: unknown; reviewGateCi?: unknown };
  const options: FixWithAgentMutationOptions = {};
  if (raw.autoFix === true) {
    options.autoFix = true;
  }
  if (raw.reviewGateCi !== undefined && raw.reviewGateCi !== null) {
    options.reviewGateCi = validateReviewGateCiContext(raw.reviewGateCi);
  }
  return options;
}

export function encodeReviewGateCiContext(trigger: ReviewGateCiFailureTrigger): string {
  return Buffer.from(JSON.stringify(trigger), 'utf8').toString('base64url');
}

export function decodeReviewGateCiContext(encoded: string): ReviewGateCiFailureTrigger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid review-gate CI context for fix command');
  }
  return validateReviewGateCiContext(parsed);
}

export type ParsedHeadlessFixArgs = {
  taskId?: string;
  agentName?: string;
  autoFix: boolean;
  reviewGateCi?: ReviewGateCiFailureTrigger;
};

/** Parse the args after the `fix` command word: `<taskId> [agent] [flags]`. */
export function parseHeadlessFixArgs(args: unknown[]): ParsedHeadlessFixArgs {
  const parsed: ParsedHeadlessFixArgs = { autoFix: false };
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = String(args[i] ?? '');
    if (arg === AUTO_FIX_FLAG) {
      parsed.autoFix = true;
      i += 1;
    } else if (arg === REVIEW_GATE_CI_FLAG) {
      const encoded = args[i + 1];
      if (typeof encoded !== 'string' || encoded.length === 0) {
        throw new Error(`Missing value for ${REVIEW_GATE_CI_FLAG}. Usage: ${FIX_USAGE}`);
      }
      parsed.reviewGateCi = decodeReviewGateCiContext(encoded);
      i += 2;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown fix flag "${arg}". Usage: ${FIX_USAGE}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (positional.length > 2) {
    throw new Error(`Too many arguments. Usage: ${FIX_USAGE}`);
  }
  parsed.taskId = positional[0];
  parsed.agentName = positional[1];
  return parsed;
}

export function buildHeadlessFixArgs(
  taskId: string,
  agentName?: string,
  options: FixWithAgentMutationOptions = {},
): string[] {
  const args = ['fix', taskId];
  if (agentName) {
    args.push(agentName);
  }
  if (options.autoFix) {
    args.push(AUTO_FIX_FLAG);
  }
  if (options.reviewGateCi) {
    args.push(REVIEW_GATE_CI_FLAG, encodeReviewGateCiContext(options.reviewGateCi));
  }
  return args;
}

function getHeadlessExecArgs(intent: WorkflowMutationIntent): unknown[] {
  if (intent.channel !== 'headless.exec') {
    return [];
  }
  const payload = intent.args[0] as HeadlessExecPayload | undefined;
  return Array.isArray(payload?.args) ? payload.args : [];
}

export function isFixIntentForTask(intent: WorkflowMutationIntent, taskId: string): boolean {
  if (intent.channel === 'invoker:fix-with-agent') {
    return typeof intent.args[0] === 'string' && intent.args[0] === taskId;
  }

  const args = getHeadlessExecArgs(intent);
  if (args[0] !== 'fix') return false;
  try {
    return parseHeadlessFixArgs(args.slice(1)).taskId === taskId;
  } catch {
    // Malformed flags still target the first positional arg; do not let a
    // bad encoded context defeat duplicate suppression.
    return typeof args[1] === 'string' && args[1] === taskId;
  }
}

export function listOpenFixIntentsForTask(
  intents: WorkflowMutationIntent[],
  taskId: string,
): WorkflowMutationIntent[] {
  return intents.filter((intent) => isFixIntentForTask(intent, taskId));
}
