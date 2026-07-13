import type { TaskState } from '@invoker/workflow-core';

import { normalizeAutoFixRetryBudget } from './auto-fix-gating.js';

export interface AutoFixAttemptLedgerKey {
  readonly taskId: string;
  readonly generation: number;
  readonly attemptId?: string | null;
}

export type AutoFixAttemptDecision =
  | {
      readonly allowed: true;
      readonly attemptsBefore: number;
      readonly attemptsAfter: number;
      readonly workerRetryBudget: number;
    }
  | {
      readonly allowed: false;
      readonly reason: 'worker-retry-budget-disabled' | 'worker-retry-budget-exhausted';
      readonly attempts: number;
      readonly workerRetryBudget: number;
    };

export interface AutoFixAttemptLedger {
  get(key: AutoFixAttemptLedgerKey): number;
  consume(key: AutoFixAttemptLedgerKey, rawBudget: unknown): AutoFixAttemptDecision;
}

function ledgerMapKey(key: AutoFixAttemptLedgerKey): string {
  return `${key.taskId}\u0000${key.generation}\u0000${key.attemptId ?? ''}`;
}

export function createAutoFixAttemptLedger(): AutoFixAttemptLedger {
  const attemptsByKey = new Map<string, number>();

  return {
    get(key) {
      return attemptsByKey.get(ledgerMapKey(key)) ?? 0;
    },
    consume(key, rawBudget) {
      const workerRetryBudget = normalizeAutoFixRetryBudget(rawBudget);
      const mapKey = ledgerMapKey(key);
      const attempts = attemptsByKey.get(mapKey) ?? 0;

      if (workerRetryBudget <= 0) {
        return {
          allowed: false,
          reason: 'worker-retry-budget-disabled',
          attempts,
          workerRetryBudget,
        };
      }

      if (attempts >= workerRetryBudget) {
        return {
          allowed: false,
          reason: 'worker-retry-budget-exhausted',
          attempts,
          workerRetryBudget,
        };
      }

      const attemptsAfter = attempts + 1;
      attemptsByKey.set(mapKey, attemptsAfter);

      return {
        allowed: true,
        attemptsBefore: attempts,
        attemptsAfter,
        workerRetryBudget,
      };
    },
  };
}

export function autoFixAttemptLedgerKeyFromTask(task: TaskState): AutoFixAttemptLedgerKey {
  return {
    taskId: task.id,
    generation: task.execution.generation ?? 0,
    attemptId: task.execution.selectedAttemptId,
  };
}

export function autoFixAttemptLedgerKeyFromLifecycleEvent(event: {
  readonly taskId: string;
  readonly generation: number;
  readonly attemptId?: string;
}): AutoFixAttemptLedgerKey {
  return {
    taskId: event.taskId,
    generation: event.generation,
    attemptId: event.attemptId,
  };
}
