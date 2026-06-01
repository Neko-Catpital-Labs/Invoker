import type { WorkflowMutationIntent } from '@invoker/data-store';

type HeadlessExecPayload = {
  args?: unknown[];
};

/**
 * Explicit marker that a fix submission must run with auto-fix semantics
 * (retry-budget check, attempt counting, auto-fix agent/labels) rather than
 * manual "Fix with AI" semantics.
 *
 * It is a plain JSON object so it survives persistence on the
 * `invoker:fix-with-agent` workflow-mutation intent args and replays with
 * the correct source after a restart — unlike an in-memory closure, which
 * the persisted coordinator drops on dispatch. Manual right-click fixes do
 * NOT carry it, so they keep their existing positional args `[taskId,
 * agentName?]` and manual semantics untouched.
 */
export interface AutoFixContext {
  readonly autoFix: true;
}

/** The canonical {@link AutoFixContext} value carried on auto-fix intents. */
export const AUTO_FIX_CONTEXT: AutoFixContext = { autoFix: true };

/** CLI flag that tags a headless `fix` command as an auto-fix submission. */
export const AUTO_FIX_FLAG = '--auto-fix' as const;

/** Type guard for an {@link AutoFixContext} carried in intent args. */
export function isAutoFixContext(value: unknown): value is AutoFixContext {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { autoFix?: unknown }).autoFix === true
  );
}

/**
 * Split a headless `fix` argument vector (everything after the `fix` verb)
 * into the auto-fix flag and the remaining positional args (e.g. the agent
 * name). The flag may appear anywhere; it is stripped from `rest` so the
 * positional agent argument is preserved regardless of ordering.
 */
export function parseAutoFixArgs(args: string[]): { autoFix: boolean; rest: string[] } {
  const autoFix = args.includes(AUTO_FIX_FLAG);
  const rest = args.filter((arg) => arg !== AUTO_FIX_FLAG);
  return { autoFix, rest };
}

/**
 * Extract the target taskId of an INCOMING fix request, covering both the
 * `invoker:fix-with-agent` intent shape (`[taskId, agentName?, context?]`)
 * and the `headless.exec` `fix` payload shape
 * (`[{ args: ['fix', taskId, ...] }]`). Returns null when the request is
 * not a fix. Centralizes the shape-matching used to suppress duplicate fix
 * submissions before they are accepted onto the mutation queue.
 */
export function fixRequestTaskId(channel: string, args: unknown[]): string | null {
  if (channel === 'invoker:fix-with-agent') {
    return typeof args[0] === 'string' ? args[0] : null;
  }
  if (channel === 'headless.exec') {
    const payload = args[0] as HeadlessExecPayload | undefined;
    const inner = Array.isArray(payload?.args) ? payload.args : [];
    if (inner[0] === 'fix' && typeof inner[1] === 'string') {
      return inner[1];
    }
  }
  return null;
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
  return args[0] === 'fix' && typeof args[1] === 'string' && args[1] === taskId;
}

export function listOpenFixIntentsForTask(
  intents: WorkflowMutationIntent[],
  taskId: string,
): WorkflowMutationIntent[] {
  return intents.filter((intent) => isFixIntentForTask(intent, taskId));
}

