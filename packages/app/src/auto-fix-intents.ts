import type { WorkflowMutationIntent } from '@invoker/data-store';
import type { ReviewGateCiFailureTrigger } from '@invoker/execution-engine';

/**
 * Shared parsing/encoding helpers for fix mutations.
 *
 * The auto-fix worker submits *normal* fix commands (headless `fix` or the
 * `invoker:fix-with-agent` IPC channel) instead of executing a fix directly.
 * That keeps fixes flowing through one accepted-command boundary, which owns
 * mutation coordination, duplicate suppression, and retry accounting.  These
 * helpers let an auto-fix request carry the extra context it needs — that it
 * *is* an auto-fix (so the boundary spends a retry) and, optionally, the
 * review-gate CI failure that triggered it — across both transports.
 */

type HeadlessExecPayload = {
  args?: unknown[];
};

/** Marker tagging an encoded review-gate CI context envelope. */
export const REVIEW_GATE_CI_CONTEXT_KIND = 'review-gate-ci' as const;

/**
 * Serializable review-gate CI context.  This is exactly the trigger the
 * review-gate worker produces; it is plain JSON data so it survives the round
 * trip through persisted intent args / headless argv.
 */
export type ReviewGateCiContext = ReviewGateCiFailureTrigger;

/** Flag used on the headless `fix` command line to mark an auto-fix request. */
export const HEADLESS_AUTO_FIX_FLAG = '--auto-fix' as const;
/** Flag carrying the encoded review-gate CI context on the headless command line. */
export const HEADLESS_REVIEW_GATE_CI_FLAG = '--review-gate-ci' as const;

export interface ParsedHeadlessFixArgs {
  /** True when the first arg is the `fix` command. */
  isFix: boolean;
  taskId?: string;
  /** Positional agent name (e.g. `claude` / `codex`), if present. */
  agent?: string;
  /** True when the request explicitly opted into auto-fix accounting. */
  autoFix: boolean;
  /** Review-gate CI context, if a valid one was attached. */
  reviewGateCi?: ReviewGateCiContext;
}

/**
 * Parse a headless `fix` argv: `fix <taskId> [agent] [--auto-fix] [--review-gate-ci <json>]`.
 *
 * Flags may appear in any order after the command; the first non-flag token
 * after `<taskId>` is treated as the agent.  Manual fixes carry no flags, so
 * `autoFix` is false and no review-gate context is returned — that is what keeps
 * manual fixes from spending the auto-fix retry budget.
 */
export function parseHeadlessFixArgs(args: readonly unknown[]): ParsedHeadlessFixArgs {
  const tokens = args.map((arg) => (typeof arg === 'string' ? arg : undefined));
  if (tokens[0] !== 'fix') {
    return { isFix: false, autoFix: false };
  }

  let taskId: string | undefined;
  let agent: string | undefined;
  let autoFix = false;
  let reviewGateCi: ReviewGateCiContext | undefined;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token === HEADLESS_AUTO_FIX_FLAG) {
      autoFix = true;
      continue;
    }
    if (token === HEADLESS_REVIEW_GATE_CI_FLAG) {
      reviewGateCi = decodeReviewGateCiContext(tokens[i + 1]);
      i += 1;
      continue;
    }
    if (taskId === undefined) {
      taskId = token;
    } else if (agent === undefined) {
      agent = token;
    }
  }

  return { isFix: true, taskId, agent, autoFix, reviewGateCi };
}

/**
 * Structured options carried as the trailing positional arg of the
 * `invoker:fix-with-agent` IPC channel: `[taskId, agentName?, options?]`.
 * Older callers omit the third element, so decoding tolerates its absence.
 */
export interface FixMutationOptions {
  autoFix: boolean;
  reviewGateCi?: ReviewGateCiContext;
}

/**
 * Encode structured fix options for the IPC args array.  Returns `undefined`
 * when there is nothing to carry, so the common manual path keeps its plain
 * `[taskId, agentName]` shape.
 */
export function encodeFixMutationOptions(
  options: Partial<FixMutationOptions> | undefined,
): FixMutationOptions | undefined {
  if (!options) return undefined;
  if (!options.autoFix && !options.reviewGateCi) return undefined;
  const encoded: FixMutationOptions = { autoFix: options.autoFix === true };
  if (options.reviewGateCi) encoded.reviewGateCi = options.reviewGateCi;
  return encoded;
}

/** Decode the trailing IPC options arg.  Unknown / malformed values decode to a no-op. */
export function decodeFixMutationOptions(value: unknown): FixMutationOptions {
  if (!value || typeof value !== 'object') {
    return { autoFix: false };
  }
  const record = value as Record<string, unknown>;
  const reviewGateCi = isReviewGateCiContext(record.reviewGateCi)
    ? (record.reviewGateCi as ReviewGateCiContext)
    : decodeReviewGateCiContext(record.reviewGateCi);
  return {
    autoFix: record.autoFix === true,
    ...(reviewGateCi ? { reviewGateCi } : {}),
  };
}

/**
 * Convert structured IPC fix options into a headless `fix` argv so the owner
 * can delegate the same request over the headless transport without losing the
 * auto-fix marker or the review-gate context.
 */
export function buildHeadlessFixArgs(
  taskId: string,
  agentName: string | undefined,
  options?: Partial<FixMutationOptions>,
): string[] {
  const args = ['fix', taskId];
  if (typeof agentName === 'string' && agentName.length > 0) {
    args.push(agentName);
  }
  if (options?.autoFix) {
    args.push(HEADLESS_AUTO_FIX_FLAG);
  }
  if (options?.reviewGateCi) {
    args.push(HEADLESS_REVIEW_GATE_CI_FLAG, encodeReviewGateCiContext(options.reviewGateCi));
  }
  return args;
}

/** Encode a review-gate CI context as a single JSON token for headless argv. */
export function encodeReviewGateCiContext(context: ReviewGateCiContext): string {
  return JSON.stringify({ kind: REVIEW_GATE_CI_CONTEXT_KIND, context });
}

/**
 * Decode a review-gate CI context token.  Accepts either the JSON-string
 * envelope (headless argv) or an already-parsed object (IPC args).  Returns
 * `undefined` for anything that is not a valid context.
 */
export function decodeReviewGateCiContext(value: unknown): ReviewGateCiContext | undefined {
  let envelope = value;
  if (typeof value === 'string') {
    try {
      envelope = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!envelope || typeof envelope !== 'object') return undefined;
  const record = envelope as Record<string, unknown>;
  if (record.kind !== REVIEW_GATE_CI_CONTEXT_KIND) return undefined;
  return isReviewGateCiContext(record.context) ? (record.context as ReviewGateCiContext) : undefined;
}

function isReviewGateCiContext(value: unknown): value is ReviewGateCiContext {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.taskId === 'string' &&
    typeof record.reviewId === 'string' &&
    typeof record.generation === 'number' &&
    Array.isArray(record.failedChecks)
  );
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

  const parsed = parseHeadlessFixArgs(getHeadlessExecArgs(intent));
  return parsed.isFix && parsed.taskId === taskId;
}

export function listOpenFixIntentsForTask(
  intents: WorkflowMutationIntent[],
  taskId: string,
): WorkflowMutationIntent[] {
  return intents.filter((intent) => isFixIntentForTask(intent, taskId));
}

/** True when a queued/running fix intent already exists for the task (IPC or headless shape). */
export function hasOpenFixIntentForTask(
  intents: WorkflowMutationIntent[],
  taskId: string,
): boolean {
  return intents.some((intent) => isFixIntentForTask(intent, taskId));
}
