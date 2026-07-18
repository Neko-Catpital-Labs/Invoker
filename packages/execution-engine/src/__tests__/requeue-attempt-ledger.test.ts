import { describe, expect, it } from 'vitest';

import type { TaskState } from '@invoker/workflow-core';

import {
  createRequeueAttemptLedger,
  requeueLedgerKeyFromTask,
} from '../requeue-attempt-ledger.js';

const BUDGET = 3;
const BACKOFF = 120_000;

function key(taskId: string, generation: number) {
  return { taskId, generation };
}

describe('requeue attempt ledger', () => {
  it('requeues up to the budget, spacing by backoff, then escalates', () => {
    const ledger = createRequeueAttemptLedger();
    const k = key('wf-1/gate', 5);

    // First requeue is immediate (no prior requeue to space from).
    const first = ledger.decide(k, BUDGET, BACKOFF, 0);
    expect(first.kind).toBe('requeue');
    expect(first).toMatchObject({ attemptsAfter: 1, budget: BUDGET });

    // Within the backoff window → hold, do not consume budget.
    const held = ledger.decide(k, BUDGET, BACKOFF, 30_000);
    expect(held.kind).toBe('backoff');
    if (held.kind === 'backoff') expect(held.waitMs).toBe(BACKOFF - 30_000);
    expect(ledger.attempts(k)).toBe(1);

    // After backoff elapses → second and third requeues.
    expect(ledger.decide(k, BUDGET, BACKOFF, BACKOFF).kind).toBe('requeue');
    expect(ledger.decide(k, BUDGET, BACKOFF, BACKOFF * 2).kind).toBe('requeue');
    expect(ledger.attempts(k)).toBe(3);

    // Budget exhausted → escalate, regardless of backoff timing.
    const escalate = ledger.decide(k, BUDGET, BACKOFF, BACKOFF * 3);
    expect(escalate.kind).toBe('escalate');
    if (escalate.kind === 'escalate') expect(escalate.attempts).toBe(BUDGET);
  });

  it('tracks escalation so it is only acted on once', () => {
    const ledger = createRequeueAttemptLedger();
    const k = key('wf-1/gate', 5);
    expect(ledger.hasEscalated(k)).toBe(false);
    ledger.markEscalated(k);
    expect(ledger.hasEscalated(k)).toBe(true);
  });

  it('keys by taskId+generation so a new generation gets a fresh budget', () => {
    const ledger = createRequeueAttemptLedger();
    const gen5 = key('wf-1/gate', 5);
    ledger.decide(gen5, BUDGET, BACKOFF, 0);
    ledger.decide(gen5, BUDGET, BACKOFF, BACKOFF);
    ledger.decide(gen5, BUDGET, BACKOFF, BACKOFF * 2);
    expect(ledger.decide(gen5, BUDGET, BACKOFF, BACKOFF * 3).kind).toBe('escalate');

    // A recreate/edit bumps generation → a genuinely new lineage, fresh budget.
    const gen6 = key('wf-1/gate', 6);
    expect(ledger.attempts(gen6)).toBe(0);
    expect(ledger.decide(gen6, BUDGET, BACKOFF, BACKOFF * 3).kind).toBe('requeue');
  });

  it('with budget 0 escalates immediately (requeue disabled)', () => {
    const ledger = createRequeueAttemptLedger();
    expect(ledger.decide(key('wf-1/gate', 1), 0, BACKOFF, 0).kind).toBe('escalate');
  });

  it('derives the lineage key from a task', () => {
    const task = { id: 'wf-1/gate', execution: { generation: 7 } } as TaskState;
    expect(requeueLedgerKeyFromTask(task)).toEqual({ taskId: 'wf-1/gate', generation: 7 });
  });
});
