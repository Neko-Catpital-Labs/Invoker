import { describe, expect, it } from 'vitest';
import {
  hasExplicitDraftIntent,
  isDraftingAuthorized,
} from '../lifecycle.js';

describe('Planning Terminal lifecycle contract', () => {
  it('authorizes only explicit draft intent or confirmation of an assistant draft question', () => {
    expect(hasExplicitDraftIntent('proceed')).toBe(true);
    expect(hasExplicitDraftIntent('submit')).toBe(true);
    expect(hasExplicitDraftIntent('submit it!')).toBe(true);
    expect(hasExplicitDraftIntent('submit to invoker')).toBe(true);
    expect(hasExplicitDraftIntent("don't submit to Slack; submit to Invoker")).toBe(false);
    expect(isDraftingAuthorized('yes', [
      { role: 'assistant', content: 'Would you like me to draft the YAML plan?' },
    ])).toBe(true);
    expect(isDraftingAuthorized('yes', [
      { role: 'assistant', content: 'Here is an explanation.' },
    ])).toBe(false);
  });
});
