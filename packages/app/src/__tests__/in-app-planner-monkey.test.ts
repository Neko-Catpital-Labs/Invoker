import { describe, expect, it, vi } from 'vitest';
import {
  createInAppPlanningChatSessions,
  sendPlanningChatMessage,
} from '../in-app-planner.js';

// A bounded, seeded random ("monkey") pass over the planning terminal's chat
// path — not to prove any one specific behavior (in-app-planner.test.ts
// already does that), but to shake out anything a hand-written scenario
// didn't think to ask, by firing randomized sequences of chat turns at one
// session, with one turn per run deliberately deferred and overlapped with
// the next, and checking pendingSend never lets a later turn's planner call
// start before the deferred one is released.
//
// Uses a single SHARED plannerReplyOverride (bypassing PlanConversation
// entirely, so PlanConversation's own turn lock can't mask a broken
// pendingSend) that records invocation order as calls actually reach it —
// not one fixed override per call. An earlier version of this test gave
// each call its own pre-assigned reply closure; since nothing was shared
// between calls, there was nothing that COULD get swapped regardless of
// serialization, so it passed even with pendingSend deleted. Recording
// real invocation order against a shared log is what actually discriminates.

// ── Tiny seeded PRNG (mulberry32) — no new dependency, reproducible runs ──

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function flushUntil(predicate: () => boolean, maxTicks = 2000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition never became true within maxTicks microtask flushes');
}

const RUN_COUNT = 30;
const SEED = 424242;

describe('in-app-planner monkey pass', () => {
  it(`survives ${RUN_COUNT} randomized chat-turn sequences (one deliberately-deferred, overlapped turn per run) without letting a later turn start early`, async () => {
    const rng = mulberry32(SEED);
    const errors: unknown[] = [];
    const planningCommandBuilder = vi.fn(() => ({ command: 'planner', args: ['prompt'] }));

    for (let run = 0; run < RUN_COUNT; run++) {
      const sessions = createInAppPlanningChatSessions();
      const invocationOrder: string[] = [];

      const first = await sendPlanningChatMessage({
        message: 'seed',
        presetKey: 'codex',
      }, {
        config: {},
        loadGeneratedPlan: vi.fn(),
        sessions,
        planningCommandBuilder,
        plannerReplyOverride: async (formattedMessage) => {
          invocationOrder.push(formattedMessage);
          return 'reply-seed';
        },
      });
      if (!first.ok) {
        errors.push({ run, kind: 'seed-failed', error: first.error });
        continue;
      }

      const turnCount = 3 + Math.floor(rng() * 4); // 3..6 follow-up turns
      const deferAt = 1 + Math.floor(rng() * turnCount); // which turn (1-indexed) to defer this run
      let resolveDeferred: (() => void) | undefined;
      const sharedOverride = (i: number) => async (formattedMessage: string): Promise<string> => {
        if (i === deferAt) {
          return new Promise<string>((resolve) => {
            resolveDeferred = () => {
              invocationOrder.push(formattedMessage);
              resolve(`reply-${i}`);
            };
          });
        }
        invocationOrder.push(formattedMessage);
        return `reply-${i}`;
      };

      const calls: Promise<unknown>[] = [];
      for (let i = 1; i <= turnCount; i++) {
        const call = sendPlanningChatMessage({
          sessionId: first.sessionId,
          message: `msg-${i}`,
        }, {
          config: {},
          loadGeneratedPlan: vi.fn(),
          sessions,
          planningCommandBuilder,
          plannerReplyOverride: sharedOverride(i),
        });
        calls.push(call);
      }

      // While the deferred turn is still pending, no LATER turn's message
      // should have reached the override yet — pendingSend must hold every
      // subsequent call behind it, not let them run ahead.
      await flushUntil(() => resolveDeferred !== undefined);
      const invokedWhileDeferredPending = [...invocationOrder];
      const laterTurnLeaked = invokedWhileDeferredPending.some((m) => {
        const match = /msg-(\d+)/.exec(m);
        return match && Number(match[1]) > deferAt;
      });
      if (laterTurnLeaked) {
        errors.push({ run, kind: 'later-turn-started-before-deferred-released', deferAt, invokedWhileDeferredPending });
      }

      resolveDeferred?.();
      const settled = await Promise.all(calls);

      settled.forEach((raw, idx) => {
        const result = raw as { ok: boolean; reply?: string; error?: string };
        const expected = `reply-${idx + 1}`;
        if (!result.ok || result.reply !== expected) {
          errors.push({ run, turn: idx + 1, deferAt, expected, got: result });
        }
      });

      const session = sessions.get(first.sessionId);
      const userMessages = session?.messages.filter((m) => m.role === 'user').map((m) => m.text) ?? [];
      const expectedUserMessages = ['seed', ...Array.from({ length: turnCount }, (_, i) => `msg-${i + 1}`)];
      if (JSON.stringify(userMessages) !== JSON.stringify(expectedUserMessages)) {
        errors.push({ run, kind: 'history-order-mismatch', deferAt, userMessages, expectedUserMessages });
      }
    }

    expect(errors).toEqual([]);
  });
});
