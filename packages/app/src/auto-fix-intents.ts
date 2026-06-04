import type { WorkflowMutationIntent } from '@invoker/data-store';

export interface FixWithAgentMutationOptions {
  autoFix?: boolean;
}

type HeadlessExecPayload = {
  args?: unknown[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFixWithAgentAutoFixContext(value: unknown): boolean {
  return isObject(value) && value.autoFix === true;
}

export function parseFixWithAgentMutationOptions(value: unknown): FixWithAgentMutationOptions {
  return {
    autoFix: isFixWithAgentAutoFixContext(value),
  };
}

export function fixWithAgentMutationArgs(
  taskId: string,
  agentName?: string,
  options: FixWithAgentMutationOptions = {},
): unknown[] {
  const args: unknown[] = [taskId, agentName];
  if (options.autoFix) {
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
} {
  const [, taskIdArg, ...rest] = args;
  const taskId = typeof taskIdArg === 'string' ? taskIdArg : undefined;
  const autoFix = rest.includes('--auto-fix');
  const agentArg = rest.find((arg) => typeof arg === 'string' && arg !== '--auto-fix');
  return {
    taskId,
    agentName: typeof agentArg === 'string' ? agentArg : undefined,
    autoFix,
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
