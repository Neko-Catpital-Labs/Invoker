import type { WorkflowMutationIntent } from '@invoker/data-store';

export interface FixWithAgentMutationOptions {
  autoFix?: boolean;
  reviewGate?: AutoFixReviewGateContext;
}

type HeadlessExecPayload = {
  args?: unknown[];
};

export interface AutoFixReviewGateFailedCheck {
  name: string;
  conclusion?: string;
  detailsUrl?: string;
  summary?: string;
}

export interface AutoFixReviewGateContext {
  taskId: string;
  workflowId: string;
  reviewId: string;
  reviewUrl: string;
  headSha?: string;
  headRef?: string;
  branch?: string;
  selectedAttemptId?: string;
  generation: number;
  failedChecks: AutoFixReviewGateFailedCheck[];
  statusText: string;
}

const REVIEW_GATE_AUTO_FIX_PREFIX = '--auto-fix-review-gate=';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFixWithAgentAutoFixContext(value: unknown): boolean {
  return isObject(value) && value.autoFix === true;
}

export function parseFixWithAgentMutationOptions(value: unknown): FixWithAgentMutationOptions {
  const reviewGate = parseAutoFixReviewGateContext(isObject(value) ? value.reviewGate : undefined);
  return {
    autoFix: isFixWithAgentAutoFixContext(value),
    ...(reviewGate ? { reviewGate } : {}),
  };
}

export function fixWithAgentMutationArgs(
  taskId: string,
  agentName?: string,
  options: FixWithAgentMutationOptions = {},
): unknown[] {
  const args: unknown[] = [taskId, agentName];
  if (options.reviewGate) {
    args.push({ autoFix: true, reviewGate: options.reviewGate });
  } else if (options.autoFix) {
    args.push({ autoFix: true });
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

export function parseHeadlessFixArgs(args: unknown[]): {
  taskId?: string;
  agentName?: string;
  autoFix: boolean;
  reviewGate?: AutoFixReviewGateContext;
} {
  const [, taskIdArg, ...rest] = args;
  const taskId = typeof taskIdArg === 'string' ? taskIdArg : undefined;
  const reviewGate = rest
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith(REVIEW_GATE_AUTO_FIX_PREFIX))
    .map(decodeAutoFixReviewGateArg)
    .find((context): context is AutoFixReviewGateContext => context !== undefined);
  const structuredContext = rest
    .map((arg) => parseFixWithAgentMutationOptions(arg).reviewGate)
    .find((context): context is AutoFixReviewGateContext => context !== undefined);
  const autoFix = rest.includes('--auto-fix') || reviewGate !== undefined || structuredContext !== undefined;
  const agentArg = rest.find((arg) => (
    typeof arg === 'string'
    && arg !== '--auto-fix'
    && !arg.startsWith(REVIEW_GATE_AUTO_FIX_PREFIX)
  ));
  return {
    taskId,
    agentName: typeof agentArg === 'string' ? agentArg : undefined,
    autoFix,
    ...(reviewGate ?? structuredContext ? { reviewGate: reviewGate ?? structuredContext } : {}),
  };
}

export function encodeAutoFixReviewGateArg(context: AutoFixReviewGateContext): string {
  return `${REVIEW_GATE_AUTO_FIX_PREFIX}${encodeURIComponent(JSON.stringify(context))}`;
}

function decodeAutoFixReviewGateArg(arg: string): AutoFixReviewGateContext | undefined {
  if (!arg.startsWith(REVIEW_GATE_AUTO_FIX_PREFIX)) return undefined;
  const encoded = arg.slice(REVIEW_GATE_AUTO_FIX_PREFIX.length);
  try {
    return parseAutoFixReviewGateContext(JSON.parse(decodeURIComponent(encoded)));
  } catch {
    return undefined;
  }
}

function parseAutoFixReviewGateContext(value: unknown): AutoFixReviewGateContext | undefined {
  if (!isObject(value)) return undefined;
  if (
    typeof value.taskId !== 'string'
    || typeof value.workflowId !== 'string'
    || typeof value.reviewId !== 'string'
    || typeof value.reviewUrl !== 'string'
    || typeof value.statusText !== 'string'
    || typeof value.generation !== 'number'
    || !Array.isArray(value.failedChecks)
  ) {
    return undefined;
  }
  const failedChecks = value.failedChecks
    .map((check) => {
      if (!isObject(check) || typeof check.name !== 'string') return undefined;
      return {
        name: check.name,
        ...(typeof check.conclusion === 'string' ? { conclusion: check.conclusion } : {}),
        ...(typeof check.detailsUrl === 'string' ? { detailsUrl: check.detailsUrl } : {}),
        ...(typeof check.summary === 'string' ? { summary: check.summary } : {}),
      };
    })
    .filter((check): check is AutoFixReviewGateFailedCheck => check !== undefined);
  if (failedChecks.length === 0) return undefined;
  return {
    taskId: value.taskId,
    workflowId: value.workflowId,
    reviewId: value.reviewId,
    reviewUrl: value.reviewUrl,
    ...(typeof value.headSha === 'string' ? { headSha: value.headSha } : {}),
    ...(typeof value.headRef === 'string' ? { headRef: value.headRef } : {}),
    ...(typeof value.branch === 'string' ? { branch: value.branch } : {}),
    ...(typeof value.selectedAttemptId === 'string' ? { selectedAttemptId: value.selectedAttemptId } : {}),
    generation: value.generation,
    failedChecks,
    statusText: value.statusText,
  };
}

export function isFixIntentForTask(intent: WorkflowMutationIntent, taskId: string): boolean {
  if (intent.channel === 'invoker:fix-with-agent') {
    return typeof intent.args[0] === 'string' && intent.args[0] === taskId;
  }

  const args = getHeadlessExecArgs(intent);
  return args[0] === 'fix' && parseHeadlessFixArgs(args).taskId === taskId;
}

export function listOpenFixIntentsForTask(
  intents: WorkflowMutationIntent[],
  taskId: string,
): WorkflowMutationIntent[] {
  return intents.filter((intent) => isFixIntentForTask(intent, taskId));
}
