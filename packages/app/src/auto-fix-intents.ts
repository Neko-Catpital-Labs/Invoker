import type { WorkflowMutationIntent } from '@invoker/data-store';

type HeadlessExecPayload = {
  args?: unknown[];
};

export type AutoFixContext = {
  source: 'auto-fix';
  attemptAccepted?: boolean;
};

export type FixWithAgentOptionsArg = {
  autoFixContext?: AutoFixContext;
};

export type HeadlessFixArgs = {
  taskId?: string;
  agentName?: string;
  autoFixContext?: AutoFixContext;
};

export function makeAutoFixContext(attemptAccepted = false): AutoFixContext {
  return {
    source: 'auto-fix',
    ...(attemptAccepted ? { attemptAccepted: true } : {}),
  };
}

export function normalizeAutoFixContext(value: unknown): AutoFixContext | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  if (raw.source === 'auto-fix') {
    return makeAutoFixContext(raw.attemptAccepted === true);
  }

  if (raw.autoFix === true) {
    return makeAutoFixContext(raw.attemptAccepted === true);
  }

  return undefined;
}

export function normalizeFixWithAgentOptions(value: unknown): FixWithAgentOptionsArg {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const autoFixContext = normalizeAutoFixContext(raw.autoFixContext) ?? normalizeAutoFixContext(raw);
  return autoFixContext ? { autoFixContext } : {};
}

export function parseHeadlessFixArgs(args: string[]): HeadlessFixArgs {
  const taskId = args[1];
  let agentName: string | undefined;
  let autoFixContext: AutoFixContext | undefined;

  for (const arg of args.slice(2)) {
    if (arg === '--auto-fix') {
      autoFixContext = makeAutoFixContext(false);
      continue;
    }
    if (!agentName) {
      agentName = arg;
      continue;
    }
    throw new Error(`Unexpected fix argument: ${arg}`);
  }

  return { taskId, agentName, autoFixContext };
}

export function appendAutoFixFlag(args: string[], autoFixContext?: AutoFixContext): string[] {
  if (!autoFixContext) return args;
  return args.includes('--auto-fix') ? args : [...args, '--auto-fix'];
}

export function isAutoFixHeadlessFixArgs(args: unknown[]): boolean {
  return args[0] === 'fix' && args.includes('--auto-fix');
}

function getHeadlessExecArgs(intent: WorkflowMutationIntent): unknown[] {
  if (intent.channel !== 'headless.exec') {
    return [];
  }
  const payload = intent.args[0] as HeadlessExecPayload | undefined;
  return Array.isArray(payload?.args) ? payload.args : [];
}

function taskIdsMatch(left: unknown, right: string): boolean {
  if (typeof left !== 'string') {
    return false;
  }
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

export function isFixIntentForTask(intent: WorkflowMutationIntent, taskId: string): boolean {
  if (intent.channel === 'invoker:fix-with-agent') {
    return taskIdsMatch(intent.args[0], taskId);
  }

  const args = getHeadlessExecArgs(intent);
  return args[0] === 'fix' && taskIdsMatch(args[1], taskId);
}

export function listOpenFixIntentsForTask(
  intents: WorkflowMutationIntent[],
  taskId: string,
  options: { excludeIntentId?: number } = {},
): WorkflowMutationIntent[] {
  return intents.filter((intent) => (
    intent.id !== options.excludeIntentId && isFixIntentForTask(intent, taskId)
  ));
}

export function hasOpenFixIntentForTask(
  intents: WorkflowMutationIntent[],
  taskId: string,
  options: { excludeIntentId?: number } = {},
): boolean {
  return listOpenFixIntentsForTask(intents, taskId, options).length > 0;
}
