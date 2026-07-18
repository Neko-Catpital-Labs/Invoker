import type { WorkflowMutationIntent } from '@invoker/data-store';


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

export interface ReviewGateCiContext {
  reviewId: string;
  generation: number;
  selectedAttemptId?: string;
  branch?: string;
  headSha?: string;
  fixContext?: string;
}

export interface ReviewGateLineageFields {
  generation?: number;
  reviewId?: string;
  selectedAttemptId?: string;
  branch?: string;
  headSha?: string;
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

export function isReviewGateCiContextStale(
  context: ReviewGateCiContext,
  current: ReviewGateLineageFields,
): boolean {
  return (
    current.selectedAttemptId !== context.selectedAttemptId ||
    (current.generation ?? 0) !== context.generation ||
    current.reviewId !== context.reviewId ||
    current.branch !== context.branch ||
    current.headSha !== context.headSha
  );
}

const AUTO_FIX_FLAG = '--auto-fix';
const REVIEW_GATE_CI_FLAG = '--review-gate-ci';

export interface AutoFixCommandContext {
  autoFix: boolean;
  reviewGateContext?: ReviewGateCiContext;
  executionModel?: string;
}

export interface ParsedHeadlessFixArgs extends AutoFixCommandContext {
  taskId?: string;
  agentName?: string;
}

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


export interface FixWithAgentMutationOptions {
  autoFix?: boolean;
  reviewGateContext?: ReviewGateCiContext;
  executionModel?: string;
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
  if (options && (options.autoFix || options.reviewGateContext || options.executionModel)) {
    args.push({
      autoFix: Boolean(options.autoFix || options.reviewGateContext),
      ...(options.reviewGateContext ? { reviewGateContext: options.reviewGateContext } : {}),
      ...(options.executionModel ? { executionModel: options.executionModel } : {}),
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
  let executionModel: string | undefined;

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
    if (typeof candidate.executionModel === 'string' && candidate.executionModel.length > 0) {
      executionModel = candidate.executionModel;
    }
  }

  return { taskId, agentName, context: { autoFix, reviewGateContext, executionModel } };
}
