import type { WorkflowMutationIntent } from '@invoker/data-store';

// ── Duplicate fix-intent detection ──────────────────────────
//
// A "fix intent" is any queued/running mutation that will run the shared fix
// behavior for a task, regardless of whether it arrived as a structured IPC
// mutation (`invoker:fix-with-agent`) or as a headless `fix` command wrapped in
// a `headless.exec` payload. Detecting duplicates across both shapes lets the
// auto-fix worker submit a normal fix command and rely on the accepted-command
// boundary to suppress redundant retries.

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

export function hasOpenFixIntentForTask(
  intents: WorkflowMutationIntent[],
  taskId: string,
): boolean {
  return intents.some((intent) => isFixIntentForTask(intent, taskId));
}

// ── Review-gate CI auto-fix context ─────────────────────────
//
// When a fix is triggered by a failed review-gate CI run, the worker carries an
// explicit snapshot of the lineage it observed. The accepted-command boundary
// re-checks that snapshot against the live task before fixing so a stale retry
// (the task moved on, was re-selected, or got a new review) is rejected instead
// of clobbering newer work.

export interface ReviewGateCiContext {
  /** Provider review identifier the CI failure was observed against. */
  reviewId: string;
  /** Task generation observed when the failure was captured. */
  generation: number;
  /** Selected attempt observed when the failure was captured. */
  selectedAttemptId?: string;
  /** Branch observed when the failure was captured. */
  branch?: string;
  /** Head commit observed when the failure was captured. */
  headSha?: string;
  /** Pre-formatted fix instructions handed to the executor, if any. */
  fixContext?: string;
}

/** Lineage fields read off a live task when validating review-gate context. */
export interface ReviewGateLineageFields {
  generation?: number;
  reviewId?: string;
  selectedAttemptId?: string;
  branch?: string;
}

export function encodeReviewGateCiContext(context: ReviewGateCiContext): string {
  return JSON.stringify(context);
}

export function decodeReviewGateCiContext(encoded: unknown): ReviewGateCiContext | undefined {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.reviewId !== 'string' || typeof candidate.generation !== 'number') {
    return undefined;
  }
  return {
    reviewId: candidate.reviewId,
    generation: candidate.generation,
    selectedAttemptId: typeof candidate.selectedAttemptId === 'string' ? candidate.selectedAttemptId : undefined,
    branch: typeof candidate.branch === 'string' ? candidate.branch : undefined,
    headSha: typeof candidate.headSha === 'string' ? candidate.headSha : undefined,
    fixContext: typeof candidate.fixContext === 'string' ? candidate.fixContext : undefined,
  };
}

/**
 * True when the captured review-gate context no longer matches the live task —
 * mirrors the lineage fields the review-gate worker guards on (selected attempt,
 * generation, review id, branch).
 */
export function isReviewGateCiContextStale(
  context: ReviewGateCiContext,
  current: ReviewGateLineageFields,
): boolean {
  return (
    current.selectedAttemptId !== context.selectedAttemptId ||
    (current.generation ?? 0) !== context.generation ||
    current.reviewId !== context.reviewId ||
    current.branch !== context.branch
  );
}

// ── Explicit auto-fix command context ───────────────────────
//
// The auto-fix worker submits the same `fix` command a human would, plus a
// machine-readable marker. Carrying the marker through the command lets the
// accepted-command boundary (not the worker) own attempt accounting and lets a
// review-gate failure ride along without a side channel.

const AUTO_FIX_FLAG = '--auto-fix';
const REVIEW_GATE_CI_FLAG = '--review-gate-ci';

export interface AutoFixCommandContext {
  /** Whether the fix request was explicitly issued by the auto-fix worker. */
  autoFix: boolean;
  /** Review-gate CI context, when the fix was triggered by a failed CI run. */
  reviewGateContext?: ReviewGateCiContext;
}

export interface ParsedHeadlessFixArgs extends AutoFixCommandContext {
  taskId?: string;
  agentName?: string;
}

/**
 * Parse a headless `fix` command: `fix <taskId> [agent] [--auto-fix]
 * [--review-gate-ci <encoded>]`. Positional order and the manual default agent
 * are unchanged when no auto-fix flags are present, so manual `fix` keeps its
 * existing behavior.
 */
export function parseHeadlessFixArgs(args: readonly string[]): ParsedHeadlessFixArgs {
  const rest = args[0] === 'fix' ? args.slice(1) : args.slice();
  let taskId: string | undefined;
  let agentName: string | undefined;
  let autoFix = false;
  let reviewGateContext: ReviewGateCiContext | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === AUTO_FIX_FLAG) {
      autoFix = true;
      continue;
    }
    if (token === REVIEW_GATE_CI_FLAG) {
      const decoded = decodeReviewGateCiContext(rest[i + 1]);
      if (decoded) {
        reviewGateContext = decoded;
        autoFix = true;
      }
      i += 1;
      continue;
    }
    if (taskId === undefined) {
      taskId = token;
      continue;
    }
    if (agentName === undefined) {
      agentName = token;
    }
  }

  return { taskId, agentName, autoFix, reviewGateContext };
}

/**
 * Build a headless `fix` command argument vector from structured fix options.
 * Used when converting a structured `invoker:fix-with-agent` mutation into the
 * headless command the shared owner actually runs.
 */
export function buildHeadlessFixArgs(
  taskId: string,
  agentName: string | undefined,
  context: AutoFixCommandContext = { autoFix: false },
): string[] {
  const args = ['fix', taskId];
  if (agentName !== undefined && agentName.length > 0) {
    args.push(agentName);
  }
  if (context.autoFix || context.reviewGateContext) {
    args.push(AUTO_FIX_FLAG);
  }
  if (context.reviewGateContext) {
    args.push(REVIEW_GATE_CI_FLAG, encodeReviewGateCiContext(context.reviewGateContext));
  }
  return args;
}

// ── Structured IPC mutation options ─────────────────────────
//
// `invoker:fix-with-agent` historically carried `[taskId, agentName]`. The
// auto-fix worker adds a third structured-options argument so explicit auto-fix
// context survives owner delegation without changing the manual two-argument
// call shape.

export interface FixWithAgentMutationOptions {
  autoFix?: boolean;
  reviewGateContext?: ReviewGateCiContext;
}

export interface ParsedFixWithAgentMutationArgs {
  taskId: string;
  agentName?: string;
  context: AutoFixCommandContext;
}

export function buildFixWithAgentMutationArgs(
  taskId: string,
  agentName?: string,
  options?: FixWithAgentMutationOptions,
): unknown[] {
  const args: unknown[] = [taskId, agentName];
  if (options && (options.autoFix || options.reviewGateContext)) {
    args.push({
      autoFix: Boolean(options.autoFix || options.reviewGateContext),
      ...(options.reviewGateContext ? { reviewGateContext: options.reviewGateContext } : {}),
    });
  }
  return args;
}

export function parseFixWithAgentMutationArgs(args: unknown[]): ParsedFixWithAgentMutationArgs {
  const taskId = String(args[0]);
  const agentName = args[1] === undefined || args[1] === null ? undefined : String(args[1]);
  const optionsArg = args[2];
  let autoFix = false;
  let reviewGateContext: ReviewGateCiContext | undefined;

  if (optionsArg && typeof optionsArg === 'object') {
    const candidate = optionsArg as Record<string, unknown>;
    autoFix = Boolean(candidate.autoFix);
    if (candidate.reviewGateContext) {
      const ctx = candidate.reviewGateContext;
      reviewGateContext = typeof ctx === 'string'
        ? decodeReviewGateCiContext(ctx)
        : decodeReviewGateCiContext(JSON.stringify(ctx));
      if (reviewGateContext) {
        autoFix = true;
      }
    }
  }

  return { taskId, agentName, context: { autoFix, reviewGateContext } };
}
