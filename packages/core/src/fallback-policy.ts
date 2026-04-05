/**
 * Fallback policy system for task execution decisions.
 *
 * Provides both Result-based (neverthrow) and throw-based APIs.
 */

import { ResultAsync } from 'neverthrow';
import type { TaskState } from '@invoker/graph';

// ── Fallback Decision Types ──────────────────────────────────

export type FallbackDecision =
  | { readonly type: 'retry'; readonly reason: string }
  | { readonly type: 'skip'; readonly reason: string }
  | { readonly type: 'fail'; readonly reason: string }
  | { readonly type: 'proceed'; readonly reason: string };

export interface FallbackPolicyContext {
  readonly task: TaskState;
  readonly error?: string;
  readonly exitCode?: number;
  readonly attemptCount?: number;
}

// ── Policy Error ──────────────────────────────────────────────

export class FallbackPolicyError extends Error {
  constructor(
    message: string,
    public readonly context: FallbackPolicyContext,
  ) {
    super(message);
    this.name = 'FallbackPolicyError';
  }
}

// ── Result-based API (neverthrow-first) ───────────────────────

/**
 * Evaluate fallback decision and return a Result.
 *
 * This is the neverthrow-first API. Use this in new code that wants
 * to handle errors explicitly without exceptions.
 */
export function evaluateFallbackDecision(
  context: FallbackPolicyContext,
): ResultAsync<FallbackDecision, FallbackPolicyError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Simple policy: if task has autoFix enabled and failed, retry
      if (context.task.config.autoFix && context.exitCode !== 0) {
        return { type: 'retry' as const, reason: 'Auto-fix enabled' };
      }

      // If task is blocked, skip it
      if (context.task.status === 'blocked') {
        return { type: 'skip' as const, reason: 'Task is blocked' };
      }

      // If task completed successfully, proceed
      if (context.task.status === 'completed') {
        return { type: 'proceed' as const, reason: 'Task completed successfully' };
      }

      // Default: fail if we have an error
      if (context.error || (context.exitCode && context.exitCode !== 0)) {
        return { type: 'fail' as const, reason: context.error || `Exit code ${context.exitCode}` };
      }

      // Otherwise proceed
      return { type: 'proceed' as const, reason: 'No error condition detected' };
    })(),
    (error) => new FallbackPolicyError(
      error instanceof Error ? error.message : String(error),
      context,
    ),
  );
}

// ── Throw-based API (backwards compatibility) ─────────────────

/**
 * Apply a fallback decision, throwing on error.
 *
 * This preserves the original throw-based semantics for existing code.
 * Internally delegates to evaluateFallbackDecision().
 */
export async function applyFallbackDecision(
  context: FallbackPolicyContext,
): Promise<FallbackDecision> {
  const result = await evaluateFallbackDecision(context);

  if (result.isErr()) {
    throw result.error;
  }

  return result.value;
}

// ── TaskState extension pattern ───────────────────────────────

/**
 * Extension helper for TaskState that provides .applyFallback() method.
 *
 * Usage:
 *   const decision = await taskUpdate(task).applyFallback(context);
 */
export function taskUpdate(task: TaskState) {
  return {
    applyFallback: async (overrides?: Partial<FallbackPolicyContext>) => {
      const context: FallbackPolicyContext = {
        task,
        error: task.execution.error,
        exitCode: task.execution.exitCode,
        attemptCount: 1, // Could be tracked in task execution
        ...overrides,
      };
      return applyFallbackDecision(context);
    },
  };
}
