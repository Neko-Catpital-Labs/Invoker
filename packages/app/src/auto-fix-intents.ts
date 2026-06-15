import type { WorkflowMutationIntent } from '@invoker/data-store';
import type { ReviewGateCiFailureTrigger } from '@invoker/execution-engine';

/**
 * Structured context that lets a normal `fix` command stand in for a
 * review-gate CI auto-fix. It carries everything the fix boundary needs to
 * reject a stale request and reconstruct the review-gate saved error / fix
 * context, so the auto-fix worker can submit an ordinary fix command instead
 * of calling the review-gate auto-fix path directly.
 */
export type ReviewGateCiContext = ReviewGateCiFailureTrigger;

/**
 * Options that ride along with an accepted fix command, beyond the taskId and
 * agent name. These are what distinguish an explicit auto-fix request (which
 * must own retry-budget accounting) from a manual fix.
 */
export type FixMutationOptions = {
  /** True when the request is an auto-fix retry that should consume the retry budget. */
  autoFix?: boolean;
  /** Present when the fix stands in for a review-gate CI failure auto-fix. */
  reviewGateCiContext?: ReviewGateCiContext;
};

const AUTO_FIX_FLAG = '--auto-fix';
const REVIEW_GATE_CI_FLAG_PREFIX = '--review-gate-ci=';

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

// ── Review-gate CI context encode / decode ───────────────────────────────────

/**
 * Encode a review-gate CI context into a CLI-safe token so it can ride on the
 * headless `fix` argv as `--review-gate-ci=<token>`.
 */
export function encodeReviewGateCiContext(context: ReviewGateCiContext): string {
  return Buffer.from(JSON.stringify(context), 'utf8').toString('base64');
}

/**
 * Decode a review-gate CI context token. Returns `undefined` for any malformed
 * or non-object payload so a bad flag degrades to a plain fix rather than
 * throwing inside command parsing.
 */
export function decodeReviewGateCiContext(encoded: string): ReviewGateCiContext | undefined {
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return asReviewGateCiContext(parsed);
  } catch {
    return undefined;
  }
}

function asReviewGateCiContext(raw: unknown): ReviewGateCiContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ReviewGateCiContext>;
  if (typeof candidate.taskId !== 'string' || candidate.taskId.length === 0) return undefined;
  if (typeof candidate.reviewId !== 'string') return undefined;
  return candidate as ReviewGateCiContext;
}

// ── Headless fix argv parsing / building ─────────────────────────────────────

export type ParsedHeadlessFixArgs = {
  taskId: string | undefined;
  agentName: string | undefined;
  options: FixMutationOptions;
};

/**
 * Parse the arguments that follow the headless `fix` command. Manual
 * `fix <taskId> [agent]` keeps its defaults (no auto-fix accounting); the
 * auto-fix worker adds `--auto-fix` and, for review-gate CI failures, a
 * `--review-gate-ci=<token>` context flag.
 */
export function parseHeadlessFixArgs(args: string[]): ParsedHeadlessFixArgs {
  const positionals: string[] = [];
  const options: FixMutationOptions = {};
  for (const arg of args) {
    if (arg === AUTO_FIX_FLAG) {
      options.autoFix = true;
    } else if (arg.startsWith(REVIEW_GATE_CI_FLAG_PREFIX)) {
      const decoded = decodeReviewGateCiContext(arg.slice(REVIEW_GATE_CI_FLAG_PREFIX.length));
      if (decoded) {
        options.reviewGateCiContext = decoded;
        options.autoFix = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return {
    taskId: positionals[0],
    agentName: positionals[1],
    options,
  };
}

/**
 * Build the headless `fix` argv from structured fix options. Used when an
 * `invoker:fix-with-agent` mutation is converted into a headless exec request,
 * so auto-fix context survives the owner-delegation hop.
 */
export function buildHeadlessFixArgs(
  taskId: string,
  agentName?: string,
  options: FixMutationOptions = {},
): string[] {
  const args = ['fix', taskId];
  if (typeof agentName === 'string' && agentName.length > 0) {
    args.push(agentName);
  }
  if (options.reviewGateCiContext) {
    args.push(`${REVIEW_GATE_CI_FLAG_PREFIX}${encodeReviewGateCiContext(options.reviewGateCiContext)}`);
  }
  if (options.autoFix) {
    args.push(AUTO_FIX_FLAG);
  }
  return args;
}

// ── Structured `invoker:fix-with-agent` mutation args ────────────────────────

export type ParsedFixWithAgentMutationArgs = {
  taskId: string;
  agentName: string | undefined;
  options: FixMutationOptions;
};

/**
 * Build the positional args for an `invoker:fix-with-agent` mutation. Manual
 * fixes stay byte-compatible with the legacy `[taskId, agentName]` shape; a
 * third options positional appears only when auto-fix context is present.
 */
export function buildFixWithAgentMutationArgs(
  taskId: string,
  agentName?: string,
  options: FixMutationOptions = {},
): unknown[] {
  const normalized = normalizeFixMutationOptions(options);
  if (!normalized.autoFix && !normalized.reviewGateCiContext) {
    return [taskId, agentName];
  }
  return [taskId, agentName, normalized];
}

/**
 * Parse the positional args of an `invoker:fix-with-agent` mutation back into
 * a taskId, agent, and structured options. Tolerates the legacy two-arg shape.
 */
export function parseFixWithAgentMutationArgs(args: unknown[]): ParsedFixWithAgentMutationArgs {
  const taskId = String(args[0]);
  const agentName = typeof args[1] === 'string' && args[1].length > 0 ? args[1] : undefined;
  return { taskId, agentName, options: normalizeFixMutationOptions(args[2]) };
}

function normalizeFixMutationOptions(raw: unknown): FixMutationOptions {
  if (!raw || typeof raw !== 'object') return {};
  const candidate = raw as { autoFix?: unknown; reviewGateCiContext?: unknown };
  const options: FixMutationOptions = {};
  const context = asReviewGateCiContext(candidate.reviewGateCiContext);
  if (context) {
    options.reviewGateCiContext = context;
  }
  // A review-gate CI fix is always an auto-fix: it consumes the retry budget.
  if (candidate.autoFix === true || context) {
    options.autoFix = true;
  }
  return options;
}
