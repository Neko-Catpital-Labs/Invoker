import { describe, expect, it } from 'vitest';
import {
  derivePlanningTurnResult,
  hasExplicitDraftIntent,
  isDraftingAuthorized,
  PlanningSession,
  SerializedPlanningTurns,
} from '../lifecycle.js';

describe('Planning Terminal lifecycle contract', () => {
  it('authorizes only explicit draft intent or confirmation of an assistant draft question', () => {
    expect(hasExplicitDraftIntent('proceed')).toBe(true);
    expect(isDraftingAuthorized('yes', [
      { role: 'assistant', content: 'Would you like me to draft the YAML plan?' },
    ])).toBe(true);
    expect(isDraftingAuthorized('yes', [
      { role: 'assistant', content: 'Here is an explanation.' },
    ])).toBe(false);
  });

  it('does not expose an unapproved draft as draft_ready', () => {
    expect(derivePlanningTurnResult('discuss options', [], {
      hasDraft: true,
      asksQuestion: false,
      submitted: false,
    })).toEqual({ state: 'discussing', draftingAuthorized: false });
  });

  it('serializes turns in arrival order', async () => {
    const turns = new SerializedPlanningTurns();
    const order: string[] = [];
    await Promise.all([
      turns.run(async () => { order.push('first'); }),
      turns.run(async () => { order.push('second'); }),
    ]);
    expect(order).toEqual(['first', 'second']);
  });

  it('keeps an unapproved draft in the discussing state', async () => {
    const runner = {
      sendMessage: async () => '```yaml\nname: draft\ntasks:\n  - id: task\n    description: Draft\n```',
      getDraftedPlan: () => 'name: draft\ntasks:\n  - id: task\n    description: Draft',
      planSubmitted: false,
    };
    const session = new PlanningSession(runner);
    await expect(session.send('What would this involve?')).resolves.toMatchObject({
      state: 'discussing',
      draftingAuthorized: false,
    });
  });
});
