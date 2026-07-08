import type { TaskState } from '@invoker/workflow-core';

import { normalizeAutoFixRetryBudget } from './auto-fix-gating.js';

/**
 * Runtime-local budget/backoff ledger for the requeue worker.
 *
 * Keyed by task **lineage** (`taskId` + `generation`) rather than attempt id:
 * `retryTask` preserves the generation but starts a fresh attempt, so keying by
 * attempt would reset the budget on every requeue and loop forever. A genuinely
 * new generation (recreate / edit) is a new lineage and starts fresh.
 *
 * The ledger lives in worker-runtime memory (like the auto-fix attempt ledger)
 * and resets when the owner process restarts.
 */
export interface RequeueLedgerKey {
  readonly taskId: string;
  readonly generation: number;
}

export type RequeueDecision =
  | {
      readonly kind: 'requeue';
      readonly attemptsBefore: number;
      readonly attemptsAfter: number;
      readonly budget: number;
    }
  | {
      readonly kind: 'backoff';
      readonly attempts: number;
      readonly budget: number;
      readonly waitMs: number;
    }
  | {
      readonly kind: 'escalate';
      readonly attempts: number;
      readonly budget: number;
    };

export interface RequeueAttemptLedger {
  /** Requeues already submitted for this lineage. */
  attempts(key: RequeueLedgerKey): number;
  /**
   * Decide what to do for a stalled task. On a `requeue` decision the attempt is
   * recorded (count incremented, backoff clock reset); `backoff` and `escalate`
   * are non-mutating. Budget is the max requeues before escalation; `backoffMs`
   * is the minimum spacing between requeues of the same lineage.
   */
  decide(
    key: RequeueLedgerKey,
    budget: number,
    backoffMs: number,
    nowMs: number,
  ): RequeueDecision;
  /** True once `markEscalated` recorded that this lineage was parked to needs_input. */
  hasEscalated(key: RequeueLedgerKey): boolean;
  /** Record that an escalation command was submitted, so we submit it at most once. */
  markEscalated(key: RequeueLedgerKey): void;
}

interface LedgerEntry {
  attempts: number;
  lastRequeueAtMs?: number;
  escalated: boolean;
}

function ledgerMapKey(key: RequeueLedgerKey): string {
  return `${key.taskId}\u0000${key.generation}`;
}

export function createRequeueAttemptLedger(): RequeueAttemptLedger {
  const entries = new Map<string, LedgerEntry>();

  const entryFor = (mapKey: string): LedgerEntry => {
    let entry = entries.get(mapKey);
    if (!entry) {
      entry = { attempts: 0, escalated: false };
      entries.set(mapKey, entry);
    }
    return entry;
  };

  return {
    attempts(key) {
      return entries.get(ledgerMapKey(key))?.attempts ?? 0;
    },
    decide(key, rawBudget, backoffMs, nowMs) {
      const budget = normalizeAutoFixRetryBudget(rawBudget);
      const entry = entryFor(ledgerMapKey(key));

      if (entry.attempts >= budget) {
        return { kind: 'escalate', attempts: entry.attempts, budget };
      }

      if (
        entry.lastRequeueAtMs !== undefined
        && nowMs - entry.lastRequeueAtMs < backoffMs
      ) {
        return {
          kind: 'backoff',
          attempts: entry.attempts,
          budget,
          waitMs: backoffMs - (nowMs - entry.lastRequeueAtMs),
        };
      }

      const attemptsBefore = entry.attempts;
      entry.attempts = attemptsBefore + 1;
      entry.lastRequeueAtMs = nowMs;
      return {
        kind: 'requeue',
        attemptsBefore,
        attemptsAfter: entry.attempts,
        budget,
      };
    },
    hasEscalated(key) {
      return entries.get(ledgerMapKey(key))?.escalated ?? false;
    },
    markEscalated(key) {
      entryFor(ledgerMapKey(key)).escalated = true;
    },
  };
}

export function requeueLedgerKeyFromTask(task: TaskState): RequeueLedgerKey {
  return {
    taskId: task.id,
    generation: task.execution.generation ?? 0,
  };
}
