import { extractLegibleAgentFailure, resolveHeadlessExecTaskId } from '@invoker/execution-engine';

const BANNER_MESSAGE_MAX_LEN = 160;

export function resolveHeadlessExecCommand(args: unknown[]): string | undefined {
  const payload = args[0] as { args?: unknown[] } | undefined;
  const rawArgs = Array.isArray(payload?.args) ? payload.args : [];
  const command = typeof rawArgs[0] === 'string' ? rawArgs[0] : undefined;
  return command || undefined;
}

export function resolveMutationFailureTaskId(channel: string, args: unknown[]): string | undefined {
  if (channel === 'headless.exec') {
    return resolveHeadlessExecTaskId(args);
  }
  const firstArg = args[0];
  return typeof firstArg === 'string' ? firstArg : undefined;
}

export function summarizeMutationFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return summarizeMutationFailureText(raw);
}

export function summarizeMutationFailureText(raw: string): string {
  let message = raw.replace(/^Error:\s*/, '').trim();
  const stackIdx = message.indexOf('\n    at ');
  if (stackIdx >= 0) {
    message = message.slice(0, stackIdx).trim();
  }

  const legible = extractLegibleAgentFailure(message);
  if (legible) return truncateBannerMessage(legible);

  const firstLine = message.split('\n').find((line) => line.trim().length > 0)?.trim() ?? message;
  return truncateBannerMessage(firstLine);
}

function truncateBannerMessage(message: string): string {
  if (message.length <= BANNER_MESSAGE_MAX_LEN) return message;
  return `${message.slice(0, BANNER_MESSAGE_MAX_LEN - 1).trimEnd()}…`;
}
