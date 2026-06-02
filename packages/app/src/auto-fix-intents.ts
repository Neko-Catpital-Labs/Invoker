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

/**
 * True when an open (queued/running) fix intent already targets `taskId`,
 * ignoring `excludeIntentId` — the caller's own currently-executing intent, so a
 * fix request does not treat itself as a duplicate. Recognizes both the
 * `invoker:fix-with-agent` and `headless.exec fix` intent shapes, so a single
 * call centralizes idempotency for every fix entry point.
 */
export function hasOpenFixIntentForTask(
  intents: WorkflowMutationIntent[],
  taskId: string,
  excludeIntentId?: number,
): boolean {
  return listOpenFixIntentsForTask(intents, taskId).some(
    (intent) => intent.id !== excludeIntentId,
  );
}

/**
 * Explicit context carried alongside a fix submission. When `autoFix` is true
 * the submission consumes auto-fix retry budget, increments attempt accounting,
 * selects the configured auto-fix agent, and uses auto-fix labels/log events.
 * Manual "Fix with AI" submissions carry {@link MANUAL_FIX_CONTEXT} and never
 * touch the auto-fix budget, so manual right-click semantics are preserved.
 */
export interface FixSubmissionContext {
  readonly autoFix: boolean;
}

export const MANUAL_FIX_CONTEXT: FixSubmissionContext = { autoFix: false };
export const AUTO_FIX_CONTEXT: FixSubmissionContext = { autoFix: true };

/** Minimal orchestrator surface needed to read a task's auto-fix attempt count. */
export interface AutoFixAttemptOrchestrator {
  getTask(taskId: string): { execution: { autoFixAttempts?: number } } | undefined;
}

/** Minimal persistence surface needed to persist a task's auto-fix attempt count. */
export interface AutoFixAttemptPersistence {
  updateTask(taskId: string, patch: { execution: { autoFixAttempts: number } }): unknown;
}

/**
 * Increment `autoFixAttempts` exactly once for an accepted auto-fix submission.
 * Returns the before/after counts so callers can emit consistent log events.
 * Must be called at most once per accepted submission so auto-fix budget
 * accounting stays exact.
 */
export function recordAutoFixAttempt(
  taskId: string,
  orchestrator: AutoFixAttemptOrchestrator,
  persistence: AutoFixAttemptPersistence,
): { attemptsBefore: number; attemptsAfter: number } {
  const attemptsBefore = orchestrator.getTask(taskId)?.execution.autoFixAttempts ?? 0;
  const attemptsAfter = attemptsBefore + 1;
  persistence.updateTask(taskId, { execution: { autoFixAttempts: attemptsAfter } });
  return { attemptsBefore, attemptsAfter };
}

/**
 * Choose the agent for a fix submission. An explicitly-requested agent always
 * wins (manual "Fix with Claude/Codex"); otherwise an auto-fix submission falls
 * back to the configured `autoFixAgent`. Returns `undefined` to let downstream
 * defaults apply (the task's executionAgent, then the built-in default).
 */
export function selectFixAgent(
  context: FixSubmissionContext,
  requestedAgent: string | undefined,
  configuredAutoFixAgent: string | undefined,
): string | undefined {
  const requested = requestedAgent?.trim();
  if (requested) return requested;
  if (context.autoFix) {
    const configured = configuredAutoFixAgent?.trim();
    if (configured) return configured;
  }
  return undefined;
}

